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

/** Before the greeting: the protected user's language from onboarding (A7). */
export async function getCallContext(callSid: string): Promise<{ language: string } | null> {
  return post<{ language: string }>("/call-context", { callSid }, 1_500);
}

export type TurnResult = {
  nextAgentLine: string;
  callerLanguage: string;
  scamProbability: number;
};

// The caller hears silence while Gemini thinks, so give up early and ask the fixed question.
const turnTimeoutMs = () => Number(process.env.BRAIN_TURN_TIMEOUT_MS) || 5_000;

/** Before each follow-up: Gemini's next question (A5). null means ask the fixed question. */
export async function nextTurn(args: {
  callSid: string;
  transcript: TranscriptMessage[];
  followUpsAsked: number;
}): Promise<TurnResult | null> {
  const result = await post<TurnResult>(
    "/turn",
    {
      callSid: args.callSid,
      transcript: args.transcript.map(({ role, text }) => ({ role, text })),
      followUpsAsked: args.followUpsAsked,
    },
    turnTimeoutMs(),
  );
  return typeof result?.nextAgentLine === "string" ? result : null;
}

/** Yellow calls: the caller's message (empty if none) goes into the log, then the push is sent. */
export async function sendCallMessage(callSid: string, message: string): Promise<boolean> {
  const result = await post<{ ok: boolean }>("/call-message", { callSid, message }, 5_000);
  return result?.ok === true;
}

export type ScreenResult = {
  flag: "green" | "yellow" | "red";
  score: number;
  reasons: string[];
  summary: string;
  forwardTo: string | null;
  /** Yellow: the brain holds the push until sendCallMessage(). */
  messagePending?: boolean;
};

/** After the questions: B's scoring decides the verdict, and the call is logged and pushed. */
export async function screenWithBrain(args: {
  callSid: string;
  from: string;
  transcript: TranscriptMessage[];
  fallbackVerdict: CallVerdict;
  forceVerdict?: CallVerdict;
  startedAt: number;
  /** Set when A will take a message on a yellow call and then call sendCallMessage(). */
  deferYellowNotify?: boolean;
  /** Gemini ended the questions early: never put the call through (green becomes yellow). */
  noGreen?: boolean;
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
      deferYellowNotify: args.deferYellowNotify === true,
      noGreen: args.noGreen === true,
    },
    20_000,
  );
}

export const toCallVerdict = (flag: ScreenResult["flag"]): CallVerdict =>
  flag.toUpperCase() as CallVerdict;
