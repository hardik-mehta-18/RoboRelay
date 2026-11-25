import mqtt from 'mqtt';

export class Delivery {
  constructor(outbox, omitFields = () => []) {
    this.outbox = outbox;
    this.omitFields = omitFields;
    this.batchSize = 50;
    this.status = 'Unconfigured';
    this.webhookStatus = 'Unconfigured';
  }

  payload(record) {
    const { delivery, ...event } = record;
    const fields = this.omitFields(record.topic + ' ' + record.type);
    if (!fields.length) return JSON.stringify(event);

    const payload = structuredClone(event);
    for (const path of fields) {
      // In a batch the event id is the idempotency key, so it is always sent.
      if (path === 'id' && this.batchSize > 1) continue;
      const keys = path.split('.');
      const field = keys.pop();
      let parent = payload;
      for (const key of keys) {
        parent = parent && Object.hasOwn(parent, key) ? parent[key] : undefined;
      }
      if (parent && typeof parent === 'object' && Object.hasOwn(parent, field)) {
        delete parent[field];
      }
    }
    return JSON.stringify(payload);
  }

  configureWebhook(url, token = '') {
    this.webhook = url;
    this.webhookToken = token;
    this.webhookStatus = url ? 'Waiting for readings' : 'Unconfigured';
    this.webhookRetryAt = 0;
  }

  configure(endpoint, topic) {
    this.client?.end(true);
    this.client = undefined;
    this.endpoint = endpoint;
    this.topic = topic;
    this.status = endpoint ? 'Connecting' : 'Unconfigured';
    if (!endpoint) return;

    const client = mqtt.connect(endpoint, {
      protocolVersion: 5, reconnectPeriod: 3000, connectTimeout: 10000,
      username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD
    });
    this.client = client;
    client.on('connect', () => { if (this.client === client) this.status = 'Connected'; });
    client.on('close', () => { if (this.client === client) this.status = 'Disconnected, retrying'; });
    client.on('error', error => { if (this.client === client) this.status = error.message; });
  }

  async flush() {
    const client = this.client;
    const endpoint = this.endpoint;
    const topic = this.topic;
    const webhook = this.webhook;
    if (this.inFlight || (!endpoint && !webhook) || !this.outbox.pending.length) return;
    if (webhook && !endpoint && Date.now() < this.webhookRetryAt) return;

    this.inFlight = true;
    let progressed = false;
    try {
      const mqttKey = endpoint && 'mqtt:' + endpoint + ':' + topic;
      const webhookKey = webhook && 'webhook:' + webhook;

      if (webhook && this.webhook === webhook && Date.now() >= (this.webhookRetryAt || 0)) {
        // Oldest undelivered readings first: up to batchSize of them, or about 1 MB.
        const indexes = [];
        const payloads = [];
        let size = 0;
        for (let i = 0; i < this.outbox.pending.length && indexes.length < this.batchSize; i++) {
          if (this.outbox.deliveryAt(i)[webhookKey]) continue;
          const payload = this.payload(this.outbox.readAt(i));
          if (payloads.length && size + payload.length > 1000000) break;
          indexes.push(i);
          payloads.push(payload);
          size += payload.length;
        }
        if (indexes.length) {
          try {
            // batchSize 1 sends the plain single-event body, for generic webhooks.
            const single = this.batchSize === 1;
            const response = await fetch(webhook, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(single && { 'Idempotency-Key': JSON.parse(payloads[0]).id }),
                ...(this.webhookToken && { Authorization: 'Bearer ' + this.webhookToken })
              },
              body: single ? payloads[0] : '{"events":[' + payloads.join(',') + ']}',
              redirect: 'error',
              signal: AbortSignal.timeout(15000)
            });
            const result = single ? await response.body?.cancel().catch(() => {}) : await response.json().catch(() => ({}));
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const rejected = result?.rejected || 0;
            // Receivers are expected to ignore a replayed id, so skip the receipt write when MQTT isn't also waiting.
            for (const i of indexes) this.outbox.markDelivered(i, webhookKey, Boolean(endpoint));
            progressed = true;
            if (this.webhook === webhook) this.webhookStatus = rejected ? 'Delivered, but the receiver rejected ' + rejected + ' invalid reading(s)' : 'Delivered';
          } catch (error) {
            if (this.webhook === webhook) {
              this.webhookRetryAt = Date.now() + 3000;
              this.webhookStatus = error.message + ', retrying';
            }
          }
        }
      }

      if (endpoint && this.client === client && client?.connected) {
        const index = this.outbox.pending.findIndex((_, i) =>
          !this.outbox.deliveryAt(i)[mqttKey]);
        if (index >= 0) {
          const record = this.outbox.readAt(index);
          try {
            const payload = this.payload(record);
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                reject(new Error('Broker acknowledgment timed out'));
                if (this.client === client) this.configure(endpoint, topic);
              }, 15000);
              client.publish(topic, payload, { qos: 1 }, (error, packet) => {
                clearTimeout(timer);
                if (error || packet?.reasonCode >= 128) {
                  reject(error || new Error('Broker rejected message: ' + packet.reasonCode));
                } else {
                  resolve();
                }
              });
            });
            record.delivery = { ...record.delivery, [mqttKey]: true };
            this.outbox.updateAt(index, record);
            progressed = true;
            if (this.client === client) this.status = 'Connected';
          } catch (error) {
            if (this.client === client) this.status = error.message;
          }
        }
      }

      if (this.client !== client || this.endpoint !== endpoint || this.topic !== topic ||
          this.webhook !== webhook) return;
      // ponytail: scan cached receipts for this demo. Use per-destination cursors for large queues.
      for (let i = this.outbox.pending.length - 1; i >= 0; i--) {
        const delivery = this.outbox.deliveryAt(i);
        const webhookDelivered = !webhook || delivery[webhookKey];
        const mqttDelivered = !endpoint || delivery[mqttKey];
        if (webhookDelivered && mqttDelivered) {
          this.outbox.acknowledgeAt(i);
        }
      }
    } catch (error) {
      console.error('Outbox delivery failed:', error.message);
      progressed = false;
    } finally {
      this.inFlight = false;
      if (progressed) setImmediate(() => this.flush());
    }
  }
}
