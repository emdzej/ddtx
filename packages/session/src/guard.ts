/**
 * Gates that stand between a click and bytes on a live vehicle.
 *
 * The Qt app needs none of this: a desktop process is always foregrounded, only
 * one copy holds the serial port, and a blocking write cannot be interrupted
 * half-way. A browser tab breaks all three assumptions —
 *
 *  - it can be **backgrounded**, where timers are throttled to the point that an
 *    ISO-TP sequence can stall between frames;
 *  - a **second tab** can hold a port grant for the same adapter and interleave
 *    with the first;
 *  - it can be **closed** mid-write, with no chance to put the ECU back in a
 *    sane session.
 *
 * A stalled read is a wrong number on screen. A stalled *write* to an airbag
 * controller or an immobiliser is a vehicle that needs recovering, so writes are
 * off unless explicitly enabled and every gate agrees (docs/plan.md §6.3).
 */

export type GateRefusal =
  /** Writes have not been enabled. The default. */
  | "writes-disabled"
  /** No vehicle on the other end — demo mode has nothing to protect. */
  | "not-live"
  /** The tab is hidden or minimised, so timers may be throttled. */
  | "not-visible"
  /** Another tab or window holds the adapter. */
  | "lock-unavailable"
  /** The operator declined the confirmation. */
  | "declined";

export interface GateDecision {
  allowed: boolean;
  refusal?: GateRefusal;
  /** Plain-language reason, suitable for showing as-is. */
  reason?: string;
}

const REASONS: Record<GateRefusal, string> = {
  "writes-disabled": "Writing is turned off. Enable it in the toolbar first.",
  "not-live": "No vehicle is connected, so there is nothing to write to.",
  "not-visible":
    "This tab is in the background. Bring it to the front before writing — a hidden tab's timers are throttled and can stall a write part-way.",
  "lock-unavailable":
    "Another ddtx tab is using this adapter. Close it, or disconnect there first.",
  declined: "Cancelled.",
};

export interface WriteGateOptions {
  /** Has the operator turned writing on? */
  writesEnabled: boolean;
  /** Is a real vehicle attached, as opposed to demo mode? */
  live: boolean;
  /** Injected for tests; defaults to the Page Visibility API. */
  isVisible?: () => boolean;
}

/**
 * Check everything that does not need to ask the operator.
 *
 * Deliberately synchronous and side-effect free, so a UI can call it on every
 * render to decide whether a control is even enabled — the refusal reason is what
 * a disabled button's tooltip should say.
 */
export function checkWriteGates(options: WriteGateOptions): GateDecision {
  const visible =
    options.isVisible?.() ??
    (typeof document === "undefined" ? true : document.visibilityState === "visible");

  if (!options.writesEnabled) return refuse("writes-disabled");
  if (!options.live) return refuse("not-live");
  if (!visible) return refuse("not-visible");
  return { allowed: true };
}

function refuse(refusal: GateRefusal): GateDecision {
  return { allowed: false, refusal, reason: REASONS[refusal] };
}

/** The message for a refusal, for callers that produce their own. */
export function refusalReason(refusal: GateRefusal): string {
  return REASONS[refusal];
}

/** Name of the Web Lock held for the duration of a write. */
export const ADAPTER_LOCK = "ddtx.adapter";

type LockManagerLike = {
  request<T>(
    name: string,
    options: { mode?: "exclusive" | "shared"; ifAvailable?: boolean },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T>;
};

/**
 * Run `write` while holding an exclusive lock on the adapter.
 *
 * `ifAvailable` rather than queueing: a write that waits for another tab to
 * finish would surprise the operator, who pressed a button and saw nothing
 * happen. Failing immediately with a reason is the honest behaviour.
 *
 * Where Web Locks is missing the write proceeds — the lock is defence against a
 * second tab, not the primary gate, and refusing everything on an older browser
 * would be worse than the risk it removes.
 */
export async function withAdapterLock<T>(
  write: () => Promise<T>,
  locks?: LockManagerLike,
): Promise<{ ran: true; value: T } | { ran: false; refusal: GateRefusal }> {
  const manager =
    locks ??
    (typeof navigator === "undefined"
      ? undefined
      : (navigator as unknown as { locks?: LockManagerLike }).locks);

  if (manager === undefined) return { ran: true, value: await write() };

  return manager.request(ADAPTER_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (lock === null) return { ran: false, refusal: "lock-unavailable" as const };
    return { ran: true as const, value: await write() };
  });
}

/**
 * The prompt to show before a button sends.
 *
 * A database button carries its own `messages`, and where it does they are the
 * authored warning — "Attention, effacement des pannes mémorisées !" — so they are
 * used verbatim rather than replaced with something generic. Where it carries
 * none, the fallback names the requests instead of asking a vague "are you sure",
 * because what is about to happen is the thing worth showing.
 */
export function confirmationPrompt(
  buttonLabel: string,
  messages: readonly string[],
  requestNames: readonly string[],
): string {
  const authored = messages.filter((message) => message.trim().length > 0);
  if (authored.length > 0) return authored.join("\n");

  if (requestNames.length === 0) return `Run “${buttonLabel}”?`;
  return `Run “${buttonLabel}”?\n\nThis sends: ${requestNames.join(", ")}`;
}
