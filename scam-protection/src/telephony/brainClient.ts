// Calls the InterHoot brain service (server/, default http://127.0.0.1:3001) from the telephony server.
// Every call has a timeout and returns null on failure, so a brain problem never drops a phone call.
import type { CallVerdict } from "../agent/conversation.js";
import type { TranscriptMessage } from "../agent/callTranscripts.js";

const brainUrl = () =>
  (process.env.BRAIN_URL ?? `http://127.0.0.1:${process.env.BRAIN_PORT ?? 3001}`).replace(/\/$/, "");

// Twilio's From for withheld caller ID is "anonymous"; +266696687 is the older digit placeholder.
export function hasCallerId(from: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(from) && from !== "+266696687";
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(`${brainUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.error(`Brain ${path} returned ${res.status}:`, (await res.text()).slice(0, 200));
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    console.error(`Brain ${path} unavailable:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export type PrecheckResult = { action: "reject" | "screen"; reason: string };

/** Before answering: reject hidden caller IDs and numbers already flagged red. */
export async function precheckCall(callSid: string, from: string): Promise<PrecheckResult> {
  const result = await post<PrecheckResult>("/precheck", { callSid, from }, 2_500);
  if (result) return result;
  // Brain down: still block hidden caller IDs, screen everything else.
  return hasCallerId(from)
    ? { action: "screen", reason: "brain unavailable" }
    : { action: "reject", reason: "no caller ID" };
}

export type ScreenResult = {
  flag: "green" | "yellow" | "red";
  score: number;
  reasons: string[];
  summary: string;
  forwardTo: string | null;
};

/** After the questions: B's scoring decides the verdict, and the call is logged and pushed. */
export async function screenWithBrain(args: {
  callSid: string;
  from: string;
  transcript: TranscriptMessage[];
  fallbackVerdict: CallVerdict;
  forceVerdict?: CallVerdict;
  startedAt: number;
}): Promise<ScreenResult | null> {
  return post<ScreenResult>(
    "/screen-call",
    {
      callSid: args.callSid,
      from: args.from,
      transcript: args.transcript.map(({ role, text }) => ({ role, text })),
      fallbackFlag: args.fallbackVerdict.toLowerCase(),
      forceFlag: args.forceVerdict?.toLowerCase(),
      startedAt: args.startedAt,
    },
    20_000,
  );
}

export const toCallVerdict = (flag: ScreenResult["flag"]): CallVerdict =>
  flag.toUpperCase() as CallVerdict;
