/**
 * Internal adapter event types — what harness adapters emit *before* the
 * adapter-protocol server wraps them with correlation_id + target.
 *
 * Mirrors the wire-protocol HarnessEvent (in @overwatch/shared/protocol)
 * minus the routing fields. The adapter-protocol server takes one of these,
 * stamps the correlation_id and target, and ships it to the cloud orchestrator
 * as a wire-protocol HarnessEvent.
 *
 * Adapters MUST NOT silently drop wire events. Anything that doesn't map to a
 * Tier-1 canonical type is emitted as a `provider_event`.
 */

export type AdapterEvent =
  // Tier 1 — canonical cross-provider events
  | {
      type: "session_init";
      session_id?: string;
      tools?: string[];
      model?: string;
      raw: unknown;
    }
  | { type: "text_delta"; text: string; raw: unknown }
  | { type: "reasoning_delta"; text: string; raw: unknown }
  | { type: "assistant_message"; text: string; raw: unknown }
  | {
      type: "tool_lifecycle";
      phase: "start" | "progress" | "complete";
      name: string;
      tool_use_id?: string;
      input?: unknown;
      result?: unknown;
      raw: unknown;
    }
  | {
      type: "session_end";
      subtype: "success" | "error";
      result?: string;
      cost_usd?: number;
      usage?: { input?: number; output?: number; [k: string]: unknown };
      raw: unknown;
    }
  | { type: "error"; message: string; raw: unknown }
  | { type: "cancel_confirmed"; raw?: unknown }
  | {
      type: "agent_busy";
      phase: "compaction" | "tool" | "system";
      reason?: string;
      raw: unknown;
    }
  | { type: "agent_idle"; raw: unknown }
  // Tier 2 — provider-specific passthrough
  | {
      type: "provider_event";
      provider: string;
      kind: string;
      payload?: Record<string, unknown>;
      raw: unknown;
    };

/**
 * Adapter capability declarations. Used by the cloud orchestrator's
 * pre-flight certification matrix and by the mobile UI's harness picker
 * to decide whether to flag a provider as 'experimental'.
 */
export interface AdapterCapabilities {
  /** Provider supports confirmed active-turn cancellation within 2s. */
  supports_confirmed_cancellation: boolean;
  /** Provider can survive interrupted turns without context corruption. */
  survives_interruption: boolean;
  /** Provider emits exactly one session_end per turn. */
  reliable_session_end: boolean;
  /** Provider has been pre-flight certified (passes all five checks). */
  voice_certified: boolean;
}
