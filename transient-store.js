export class TransientStore {
  constructor({ maxEntries = 1000, ttlMs = 30 * 60_000, now = Date.now } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('Limites de mémoire invalides');
    }
    this.entries = new Map();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.prune();
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}
