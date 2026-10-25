
import type { CallVerdict } from "./conversation.js";

import type {
  TranscriptMessage,
} from "./callTranscripts.js";

// Information saved after a screening call
export type CallSummary = {
  callSid: string;
  callerIdentity: string | null;
  callerReason: string | null;
  verdict: CallVerdict;
  verdictReasons: string[];
  summary: string;
  createdAt: number;
};

// Store completed summaries in memory
const callSummaries = new Map<string, CallSummary>();

// Keywords used for mock scam detection
const redFlags = [
  "gift card",
  "send money",
  "password",
  "verification code",
];

const yellowFlags = [
  "suspicious transaction",
  "urgent",
  "account problem",
];

// Generate reasons for a verdict
function getVerdictReasons(
  messages: TranscriptMessage[],
  verdict: CallVerdict
): string[] {
  const callerText = messages
    .filter((message) => message.role === "caller")
    .map((message) => message.text)
    .join(" ")
    .toLowerCase();

  const detectedRedFlags = redFlags.filter((flag) =>
    callerText.includes(flag)
  );

  const detectedYellowFlags = yellowFlags.filter((flag) =>
    callerText.includes(flag)
  );

  if (verdict === "RED") {
    return detectedRedFlags.length > 0
      ? detectedRedFlags.map(
          (flag) => `High-risk phrase detected: ${flag}`
        )
      : ["Call classified as high risk."];
  }

  if (verdict === "YELLOW") {
    return detectedYellowFlags.length > 0
      ? detectedYellowFlags.map(
          (flag) => `Potential risk phrase detected: ${flag}`
        )
      : ["Call requires additional verification."];
  }

  return ["No configured risk phrases detected."];
}

// Create and save a call summary
export function createCallSummary(
  callSid: string,
  messages: TranscriptMessage[],
  verdict: CallVerdict
): CallSummary {
  if (callSummaries.has(callSid)) {
    throw new Error("A summary already exists for this call.");
  }

  if (messages.length === 0) {
    throw new Error("Cannot summarize an empty transcript.");
  }

  const callerMessages = messages.filter(
    (message) => message.role === "caller"
  );

  // The first caller response currently contains
  // their introduction and stated reason.
  const callerIntroduction =
    callerMessages[0]?.text ?? null;

  // Identity and reason are not yet extracted separately.
  const callerIdentity = callerIntroduction;
  const callerReason = callerIntroduction;

  const verdictReasons = getVerdictReasons(
    messages,
    verdict
  );

  const introduction = (
  callerIntroduction ?? "an unidentified caller"
).replace(/[.!?]+$/, "");

const summary =
  `InterHoot screened a call from ${introduction}. ` +
  `The call received a ${verdict} verdict. ` +
  verdictReasons.join(". ") +
  ".";

  const result: CallSummary = {
    callSid,
    callerIdentity,
    callerReason,
    verdict,
    verdictReasons,
    summary,
    createdAt: Date.now(),
  };

  callSummaries.set(callSid, result);

  return result;
}

// Retrieve a saved summary
export function getCallSummary(
  callSid: string
): CallSummary | undefined {
  return callSummaries.get(callSid);
}

// Retrieve all saved summaries
export function getAllCallSummaries(): CallSummary[] {
  return Array.from(callSummaries.values());
}

// Delete a summary
export function removeCallSummary(
  callSid: string
): boolean {
  return callSummaries.delete(callSid);
}

// Count saved summaries
export function getCallSummaryCount(): number {
  return callSummaries.size;
}
