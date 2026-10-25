
import {
  getCallSession,
  removeCallSession,
} from "./callSessions.js";

// Maximum time allowed for a screening session
export const SCREENING_TIMEOUT_MS = 60_000;

// Store active timeout timers by Call SID
const callTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

// Start a timeout for a call
export function startCallTimeout(
  callSid: string,
  timeoutMs: number = SCREENING_TIMEOUT_MS,
  onTimeout?: (callSid: string) => void
): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("Timeout must be a non-negative number.");
  }

  // Remove an existing timer before starting a new one
  clearCallTimeout(callSid);

  const timer = setTimeout(() => {
    callTimers.delete(callSid);

    const conversation = getCallSession(callSid);

    if (!conversation) {
      return;
    }

    console.log("Call screening timed out:", callSid);

    // Remove the expired conversation
    removeCallSession(callSid);

    // Notify the caller of this function
    onTimeout?.(callSid);
  }, timeoutMs);

  callTimers.set(callSid, timer);
}

// Cancel a call's timeout
export function clearCallTimeout(
  callSid: string
): boolean {
  const timer = callTimers.get(callSid);

  if (!timer) {
    return false;
  }

  clearTimeout(timer);
  callTimers.delete(callSid);

  return true;
}

// Check whether a call has an active timeout
export function hasCallTimeout(
  callSid: string
): boolean {
  return callTimers.has(callSid);
}

// Count active timeout timers
export function getActiveTimeoutCount(): number {
  return callTimers.size;
}
