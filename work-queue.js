// Small in-memory queue: serialize one sender, bound global work, reject overload before ACK.
export class WorkQueue {
  constructor({ concurrency = 4, capacity = 36 } = {}) {
    this.concurrency = concurrency;
    this.capacity = capacity;
    this.active = new Set();
    this.pending = [];
  }

  canAccept(count) {
    return this.active.size + this.pending.length + count <= this.capacity;
  }

  add(key, task) {
    if (!this.canAccept(1)) throw new Error('File de traitement saturée');
    this.pending.push({ key, task });
    this.drain();
  }

  drain() {
    while (this.active.size < this.concurrency) {
      const index = this.pending.findIndex(item => !this.active.has(item.key));
      if (index === -1) break;
      const [{ key, task }] = this.pending.splice(index, 1);
      this.active.add(key);
      Promise.resolve().then(task).catch(() => {
        console.error('Échec du traitement Messenger');
      }).finally(() => {
        this.active.delete(key);
        this.drain();
      });
    }
  }
}
