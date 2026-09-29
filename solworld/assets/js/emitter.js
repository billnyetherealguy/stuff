// Tiny event emitter shared by the registry, wallet and map controllers.
export class Emitter {
  constructor() {
    this._listeners = new Map();
  }

  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  emit(type, payload) {
    for (const fn of [...(this._listeners.get(type) || [])]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[solworld] ${type} listener failed`, err);
      }
    }
  }
}
