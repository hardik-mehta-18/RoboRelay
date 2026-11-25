import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync,
  readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function writeJson(path, value) {
  const fd = openSync(path + '.tmp', 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(path + '.tmp', path);
}

export class Outbox {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.pending = readdirSync(directory).filter(name => name.endsWith('.json')).sort();
    this.receipts = new Map();
    this.sequence = Math.max(0, ...this.pending.slice(-1).map(name => Number(name.split('-')[0])));
  }

  append(record) {
    const id = randomUUID();
    const name = String(++this.sequence).padStart(16, '0') + '-' + id + '.json';
    writeJson(join(this.directory, name), { id, ...record });
    this.pending.push(name);
    this.receipts.set(name, {});
  }

  readAt(index) {
    return JSON.parse(readFileSync(join(this.directory, this.pending[index]), 'utf8'));
  }

  deliveryAt(index) {
    const name = this.pending[index];
    if (!this.receipts.has(name)) this.receipts.set(name, this.readAt(index).delivery || {});
    return this.receipts.get(name);
  }

  updateAt(index, record) {
    const name = this.pending[index];
    writeJson(join(this.directory, name), record);
    this.receipts.set(name, record.delivery);
  }

  // persist=false keeps the receipt in memory only: a crash re-sends, and the server drops the repeat.
  markDelivered(index, key, persist = true) {
    const delivery = { ...this.deliveryAt(index), [key]: true };
    if (persist) this.updateAt(index, { ...this.readAt(index), delivery });
    else this.receipts.set(this.pending[index], delivery);
  }

  acknowledgeAt(index) {
    const name = this.pending[index];
    unlinkSync(join(this.directory, name));
    this.receipts.delete(name);
    this.pending.splice(index, 1);
  }
}
