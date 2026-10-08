'use strict';

// Firestore en memoria para pruebas locales (sin emulador, sin Java, sin credenciales).
// Conserva instancias de FakeTimestamp porque server.js llama toMillis()/toDate().

class FakeTimestamp {
  constructor(ms) { this._ms = ms; }
  static fromMillis(ms) { return new FakeTimestamp(ms); }
  static fromDate(date) { return new FakeTimestamp(date.getTime()); }
  toMillis() { return this._ms; }
  toDate() { return new Date(this._ms); }
}

function clone(value) {
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value._ms);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  }
  return value;
}

class FakeDocumentSnapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = value !== undefined;
    this._value = value;
  }
  data() { return this._value === undefined ? undefined : clone(this._value); }
}

class FakeDocumentReference {
  constructor(db, path) {
    this._db = db;
    this.path = path;
    this.id = path.split('/').at(-1);
  }
  async get() { return new FakeDocumentSnapshot(this, this._db._data.get(this.path)); }
  async set(value, options) {
    const current = this._db._data.get(this.path);
    const next = options && options.merge ? { ...(current || {}), ...clone(value) } : clone(value);
    this._db._data.set(this.path, next);
  }
  async update(value) {
    if (!this._db._data.has(this.path)) throw new Error(`missing document ${this.path}`);
    await this.set(value, { merge: true });
  }
  async delete() { this._db._data.delete(this.path); }
}

class FakeQuery {
  constructor(collection, filters = [], max = Infinity) {
    this.collection = collection;
    this.filters = filters;
    this.max = max;
  }
  where(field, operator, value) {
    if (operator !== '==') throw new Error(`unsupported operator ${operator}`);
    return new FakeQuery(this.collection, [...this.filters, [field, value]], this.max);
  }
  limit(max) { return new FakeQuery(this.collection, this.filters, max); }
  async get() {
    const docs = [];
    const prefix = `${this.collection.path}/`;
    for (const [path, value] of this.collection._db._data.entries()) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
      if (!this.filters.every(([field, expected]) => value && value[field] === expected)) continue;
      docs.push(new FakeDocumentSnapshot(new FakeDocumentReference(this.collection._db, path), value));
      if (docs.length >= this.max) break;
    }
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class FakeCollectionReference extends FakeQuery {
  constructor(db, path) {
    super({ _db: db, path });
    this._db = db;
    this.path = path;
    this.collection = this;
  }
  doc(id) { return new FakeDocumentReference(this._db, `${this.path}/${id}`); }
}

class FakeFirestore {
  constructor(seed = {}) {
    this._data = new Map(Object.entries(seed).map(([path, value]) => [path, clone(value)]));
  }
  collection(name) { return new FakeCollectionReference(this, name); }
  batch() {
    const operaciones = [];
    const lote = {
      set: (ref, value, options) => { operaciones.push(() => ref.set(value, options)); return lote; },
      update: (ref, value) => { operaciones.push(() => ref.update(value)); return lote; },
      delete: ref => { operaciones.push(() => ref.delete()); return lote; },
      commit: async () => { for (const operacion of operaciones) await operacion(); }
    };
    return lote;
  }
  value(path) { return clone(this._data.get(path)); }
}

module.exports = { FakeFirestore, FakeTimestamp };
