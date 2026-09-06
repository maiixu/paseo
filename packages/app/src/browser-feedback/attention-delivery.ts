// An unsuccessful attempt must remain retryable. Concurrent copies share one attempt.
export class AttentionDelivery {
  private accepted = new Set<string>();
  private pending = new Map<string, Promise<boolean>>();

  async deliver(id: string, send: () => Promise<boolean>): Promise<boolean> {
    if (this.accepted.has(id)) return true;
    const pending = this.pending.get(id);
    if (pending) return pending;
    const attempt = Promise.resolve()
      .then(send)
      .then((accepted) => {
        if (accepted) {
          this.accepted.add(id);
          if (this.accepted.size > 1000) {
            const oldest = this.accepted.values().next().value;
            if (oldest !== undefined) this.accepted.delete(oldest);
          }
        }
        return accepted;
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, attempt);
    return attempt;
  }
}
