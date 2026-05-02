/**
 * Cancellation contract — manages in-flight turns and provides confirmed
 * cancellation per the plan's state machine:
 *
 *   interrupt_requested → cancel_requested → cancel_confirmed | cancel_failed
 *
 * Each in-flight turn registers an AbortController. Cancel calls abort();
 * the per-provider adapter is expected to emit `cancel_confirmed` once the
 * harness acknowledges. If 2 s pass with no confirmation, we surface
 * `cancel_failed` and the gate marks the harness "in unknown state."
 */

export interface InFlightTurn {
  correlation_id: string;
  abortController: AbortController;
  /** Promise that resolves with `cancel_confirmed` or rejects on timeout. */
  cancelPromise?: Promise<void>;
  resolveCancel?: () => void;
  rejectCancel?: (err: Error) => void;
}

export class CancellationRegistry {
  private readonly inflight = new Map<string, InFlightTurn>();

  constructor(private readonly confirmTimeoutMs: number = 2000) {}

  register(correlation_id: string): InFlightTurn {
    const abortController = new AbortController();
    const turn: InFlightTurn = { correlation_id, abortController };
    this.inflight.set(correlation_id, turn);
    return turn;
  }

  /** Called when the runTurn iterator finishes normally or with error. */
  unregister(correlation_id: string): void {
    this.inflight.delete(correlation_id);
  }

  current(correlation_id: string): InFlightTurn | undefined {
    return this.inflight.get(correlation_id);
  }

  hasInflight(): boolean {
    return this.inflight.size > 0;
  }

  /**
   * Request cancel of a turn. Returns a promise that resolves when the adapter
   * emits `cancel_confirmed`, or rejects on timeout.
   */
  cancel(correlation_id: string): Promise<void> {
    const turn = this.inflight.get(correlation_id);
    if (!turn) {
      return Promise.resolve();
    }

    if (turn.cancelPromise) {
      return turn.cancelPromise;
    }

    const promise = new Promise<void>((resolve, reject) => {
      turn.resolveCancel = resolve;
      turn.rejectCancel = reject;
    });

    turn.cancelPromise = promise;
    turn.abortController.abort();

    setTimeout(() => {
      if (turn.rejectCancel) {
        turn.rejectCancel(
          new Error(`cancel_confirmed timeout for ${correlation_id}`),
        );
      }
    }, this.confirmTimeoutMs).unref();

    return promise;
  }

  /** Adapter emitted cancel_confirmed — resolve the pending cancel promise. */
  confirmCancel(correlation_id: string): void {
    const turn = this.inflight.get(correlation_id);
    if (!turn) return;
    turn.resolveCancel?.();
  }
}
