const ONLINE_CACHE_WAIT_MS = 1000;

/** Optional cache reads cannot hold an online host's authoritative requests open. */
export class OptionalCacheReader {
  private online = false;
  private abandoned = false;
  private pending = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private releaseAbandoned!: () => void;
  private readonly abandonment = new Promise<undefined>((resolve) => {
    this.releaseAbandoned = () => resolve(undefined);
  });

  setOnline(online: boolean): void {
    this.online = online;
    this.updateDeadline();
  }

  read<T>(read: () => Promise<T>): Promise<T | undefined> {
    if (this.abandoned) return Promise.resolve(undefined);
    this.pending += 1;
    this.updateDeadline();
    return Promise.race([
      Promise.resolve()
        .then(read)
        .catch(() => {
          this.abandon("error");
          return undefined;
        }),
      this.abandonment,
    ]).finally(() => {
      this.pending -= 1;
      this.updateDeadline();
    });
  }

  private updateDeadline(): void {
    if (!this.online || this.pending === 0 || this.abandoned) {
      clearTimeout(this.timer);
      this.timer = undefined;
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => this.abandon("timeout"), ONLINE_CACHE_WAIT_MS);
    }
  }

  private abandon(reason: "timeout" | "error"): void {
    if (this.abandoned) return;
    this.abandoned = true;
    this.updateDeadline();
    console.warn("[ReplicaCache] Optional cache read unavailable", {
      reason,
      action: "continue_with_daemon_snapshot",
    });
    this.releaseAbandoned();
  }
}
