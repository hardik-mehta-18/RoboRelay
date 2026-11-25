import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import rcl from 'rclnodejs';
import { Outbox, writeJson } from './outbox.js';
import { Delivery } from './delivery.js';
import { createMessageFields } from './message-fields.js';

const port = Number(process.env.PORT || 8780);
const agentId = process.env.AGENT_ID || 'rover-agent';
const DEFAULT_MIN_INTERVAL_MS = 1000; // per topic; 0 forwards every message
const DEFAULT_BATCH_SIZE = 50; // readings per webhook request; 1 = one plain event per request
const configPath = resolve('data/config.json');
const outbox = new Outbox(resolve('data/outbox'));
let config = { endpoint: '', mqttTopic: 'robots/' + agentId + '/telemetry', selected: [] };
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const delivery = new Delivery(outbox, id => config.omitFields?.[id] || []);
const messageFields = createMessageFields(type => new rcl.MessageIntrospector(type).schema.fields);

await rcl.init();
const node = new rcl.Node('oro_telemetry_bridge');
node.spin();
delivery.configure(config.endpoint, config.mqttTopic);
delivery.configureWebhook(config.webhookUrl || '',
  typeof config.webhookToken === 'string' ? config.webhookToken : process.env.WEBHOOK_TOKEN || '');
delivery.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
const subscriptions = new Map();
const lastSeen = new Map();
const failures = new Map();
let topics = [];
let storageError = '';

function refresh() {
  const publishersByTopic = new Map();
  topics = node.getTopicNamesAndTypes().flatMap(({ name, types }) => {
    const publishers = node.getPublishersInfoByTopic(name);
    publishersByTopic.set(name, publishers);
    return publishers.length
      ? types.map(type => ({ name, type, id: name + ' ' + type }))
      : [];
  }).sort((a, b) => a.id.localeCompare(b.id));

  for (const [id, subscription] of subscriptions) {
    if (config.selected.includes(id)) continue;
    node.destroySubscription(subscription.handle);
    subscriptions.delete(id);
  }
  failures.clear();
  for (const id of config.selected) {
    const [name, type] = id.split(' ');
    const publishers = (publishersByTopic.get(name) || [])
      .filter(publisher => publisher.topic_type === type);
    const reliable = !publishers.length || publishers.every(publisher =>
      publisher.qos_profile?.reliability ===
        rcl.QoS.ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE
    );
    const qos = reliable ? rcl.QoS.profileDefault : rcl.QoS.profileSensorData;
    const existing = subscriptions.get(id);
    if (existing?.qos === qos) continue;
    if (existing) {
      node.destroySubscription(existing.handle);
      subscriptions.delete(id);
    }
    try {
      const subscription = node.createSubscription(type, name, {
        qos,
        serializationMode: 'json'
      }, message => {
        // Latest value wins: drop samples that arrive sooner than the per-topic minimum interval.
        const now = Date.now();
        if (now - (lastSeen.get(id) || 0) < (config.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) return;
        lastSeen.set(id, now);
        try {
          messageFields.observe(id, type, message);
          outbox.append({ agentId, topic: name, type, receivedAt: new Date().toISOString(), message });
          storageError = '';
        } catch (error) {
          storageError = error.message;
          return;
        }
        // No flush here: the 400 ms timer below sends what has accumulated as one batch.
      });
      subscriptions.set(id, { handle: subscription, qos });
    } catch (error) {
      failures.set(id, error.message);
    }
  }
}

// Node and service snapshot: sent as a reserved event when either list changes, and
// every minute as a heartbeat. Rovscope stores it as the robot's current lists.
const NODE_HEARTBEAT_MS = 60000;
// Every ROS node serves these; listing them would bury the services a robot offers.
const PARAMETER_SERVICE = /\/(get_parameters|get_parameter_types|set_parameters|set_parameters_atomically|list_parameters|describe_parameters|get_type_description)$/;
let nodes = [];
let services = [];
let nodesSentKey = '';
let nodesSentAt = 0;

function refreshNodes() {
  nodes = node.getNodeNamesAndNamespaces()
    .map(({ name, namespace }) => (namespace === '/' ? '/' : namespace + '/') + name)
    .filter(name => name !== '/oro_telemetry_bridge' && !name.split('/').pop().startsWith('_'))
    .sort();
  // Hidden names (a segment starting with "_") are ROS internals such as action plumbing.
  services = node.getServiceNamesAndTypes()
    .filter(({ name }) => !PARAMETER_SERVICE.test(name) && !name.split('/').some(part => part.startsWith('_')))
    .map(({ name, types }) => ({ name, type: types[0] || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Every topic with a publisher, and whether it is being forwarded. Rovscope picks the sensors out of it.
  const discovered = topics.map(({ name, type, id }) => ({ name, type, forwarded: config.selected.includes(id) }));
  const key = nodes.join('\n') + '\n\u0000' + services.map(s => s.name + ' ' + s.type).join('\n') +
    '\n\u0000' + discovered.map(t => t.name + ' ' + t.type + ' ' + t.forwarded).join('\n');
  const due = key !== nodesSentKey || Date.now() - nodesSentAt >= NODE_HEARTBEAT_MS;
  if (!due || !(config.webhookUrl || config.endpoint)) return;
  try {
    outbox.append({ agentId, topic: '/rovscope/nodes', type: 'rovscope/NodeList',
      receivedAt: new Date().toISOString(), message: { nodes, services, topics: discovered } });
    nodesSentKey = key;
    nodesSentAt = Date.now();
  } catch (error) {
    storageError = error.message;
  }
}

refresh();
refreshNodes();
setInterval(refresh, 2000);
setInterval(refreshNodes, 2000);
setInterval(() => delivery.flush(), 400);
const page = readFileSync(new URL('../public/index.html', import.meta.url));

function respond(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function save(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 65536) throw new Error('Settings are too large');
  }
  const { endpoint, mqttTopic, selected, webhookUrl = config.webhookUrl || '',
    webhookToken: submittedToken, clearWebhookToken = false,
    omitFields = config.omitFields || {},
    minIntervalMs = config.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE } = JSON.parse(body);
  if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 60000 ||
      !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('Minimum interval must be 0–60000 ms and batch size 1–100');
  }
  if (typeof endpoint !== 'string' || typeof mqttTopic !== 'string' ||
      !mqttTopic.trim() || /[+#\u0000]/.test(mqttTopic) ||
      !Array.isArray(selected) ||
      selected.some(id => !config.selected.includes(id) && !topics.some(topic => topic.id === id))) {
    throw new Error('Enter a valid MQTT topic and select discovered ROS topics');
  }
  if (endpoint) {
    const url = new URL(endpoint);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'mqtts:' || (local && url.protocol === 'mqtt:')) ||
        !url.hostname || url.username || url.password || url.search || url.hash ||
        (url.pathname && url.pathname !== '/')) {
      throw new Error('Use mqtts:// for a remote broker or mqtt://localhost for local development. Set credentials in .env.');
    }
  }
  if (typeof webhookUrl !== 'string') throw new Error('Enter a valid webhook URL');
  if (webhookUrl) {
    const url = new URL(webhookUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error('Use an HTTP or HTTPS webhook URL without embedded credentials');
    }
  }
  if (typeof clearWebhookToken !== 'boolean' ||
      (submittedToken !== undefined && (typeof submittedToken !== 'string' ||
        (submittedToken && !/^[A-Za-z0-9._~+/-]+=*$/.test(submittedToken.trim())) ||
        submittedToken.length > 4096))) {
    throw new Error('Enter a valid bearer token or clear the saved token');
  }
  const currentToken = typeof config.webhookToken === 'string'
    ? config.webhookToken
    : process.env.WEBHOOK_TOKEN || '';
  const webhookToken = clearWebhookToken
    ? ''
    : submittedToken?.trim() || currentToken;
  const fieldPath = /^(?:id|agentId|topic|type|receivedAt|message(?:\.[A-Za-z_]\w*)*)$/;
  if (!omitFields || typeof omitFields !== 'object' || Array.isArray(omitFields) ||
      Object.entries(omitFields).some(([id, fields]) =>
        !/^\/[\w/]+ [\w/]+$/.test(id) || !Array.isArray(fields) ||
        fields.some(field => typeof field !== 'string' || !fieldPath.test(field)))) {
    throw new Error('Use field paths such as message.linear.x for nested fields');
  }
  const next = { endpoint, mqttTopic, webhookUrl, webhookToken, selected: [...new Set(selected)], omitFields, minIntervalMs, batchSize };
  writeJson(configPath, next);
  delivery.batchSize = batchSize;
  if (endpoint !== config.endpoint || mqttTopic !== config.mqttTopic) {
    delivery.configure(endpoint, mqttTopic);
  }
  config = next;
  if (delivery.webhook !== webhookUrl || delivery.webhookToken !== webhookToken) {
    delivery.configureWebhook(webhookUrl, webhookToken);
  }
  refresh();
}

createServer(async (req, res) => {
  const allowedHosts = ['localhost:' + port, '127.0.0.1:' + port];
  if (!allowedHosts.includes(req.headers.host) ||
      (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) {
    return respond(res, 403, { error: 'Local dashboard only' });
  }
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' });
    return res.end(page);
  }
  if (req.method === 'GET' && req.url === '/api/status') {
    const visible = new Map(topics.map(({ id, type }) => [id, type]));
    for (const id of config.selected) visible.set(id, id.split(' ')[1]);
    const fields = Object.fromEntries([...visible].map(([id, type]) => [id, messageFields.get(id, type)]));
    const { webhookToken, ...safeConfig } = config;
    return respond(res, 200, { config: { ...safeConfig,
      webhookTokenConfigured: Boolean(webhookToken ||
        (webhookToken === undefined && process.env.WEBHOOK_TOKEN)) }, topics, nodes, services, active: [...subscriptions.keys()],
      fields, failures: Object.fromEntries(failures), queued: outbox.pending.length,
      delivery: delivery.status, webhook: delivery.webhookStatus, storageError,
      domain: process.env.ROS_DOMAIN_ID || '0' });
  }
  if (req.method === 'POST' && req.url === '/api/config') {
    if (req.headers['content-type'] !== 'application/json') {
      return respond(res, 415, { error: 'Expected JSON' });
    }
    try {
      await save(req);
      return respond(res, 200, { saved: true });
    } catch (error) {
      return respond(res, 400, { error: error.message });
    }
  }
  respond(res, 404, { error: 'Not found' });
}).listen(port, '0.0.0.0', () => console.log('Dashboard at http://localhost:' + port));
