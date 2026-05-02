/**
 * Suppresses outbound events whose correlation_id has been cancelled.
 *
 * After a `cancel` or `submit_with_steer` cancels a turn, late events from the
 * harness for that correlation_id are dropped at the daemon (preferred) and
 * dropped again at the orchestrator (defense-in-depth). Implementation is a
 * small ring buffer of recently-cancelled IDs.
 */

export class StaleSuppression {
  private readonly cancelled: string[] = [];

  constructor(private readonly capacity: number = 64) {}

  markCancelled(correlation_id: string): void {
    if (this.cancelled.includes(correlation_id)) return;
    this.cancelled.push(correlation_id);
    if (this.cancelled.length > this.capacity) {
      this.cancelled.shift();
    }
  }

  isStale(correlation_id: string): boolean {
    return this.cancelled.includes(correlation_id);
  }
}
