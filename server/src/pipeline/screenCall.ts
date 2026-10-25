// End-to-end glue for one phone call (test_main): A's telephony server calls these through the HTTP
// routes in ../index.ts. B's brain decides the flag; C's storage and push record it and alert the user.
//
//   precheck()       when the call rings: reject hidden caller IDs and numbers already flagged red
//   getUserLanguage() before the greeting: protected_user.language (A7)
//   nextTurn()       before each follow-up: Gemini's next_agent_line (A5)
//   screenCall()     when A's questions are done: Gemini → CRS caller check → claim check → score,
//                    then log to SpacetimeDB and the JSONL copy, flag the number, and push yellow/red alerts
//   addCallMessage() yellow calls only: the caller's message joins the log, then the push goes out
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTurn, forgetCall } from "../brain/gemini.js";
import { recordVerdict, scoreCall, type ScoreInput } from "../brain/score.js";
import type { Flag, GeminiTurn, TranscriptTurn } from "../brain/types.js";
import { normalizeTradeline, verifyClaims } from "../brain/verify.js";
import { checkCaller } from "../crs/callerCheck.js";
import { getTradelines } from "../crs/crs.js";
import { getUserPersona } from "../crs/personas.js";
import { notifyVerdict } from "../push/notify.js";
import { getStore } from "../storage/index.js";
import { getProtectedUser, logFullCall, type FullCallLog } from "../storage/spacetime.js";

const E164 = /^\+[1-9]\d{6,14}$/;
// Twilio's From for withheld caller ID is "anonymous"; older calls used the digits for ANONYMOUS.
const ANONYMOUS_PLACEHOLDERS = new Set(["+266696687"]);

export const DEFAULT_USER_ID = process.env.PROTECTED_USER_ID || "P20";

export function hasCallerId(from: string): boolean {
  return E164.test(from) && !ANONYMOUS_PLACEHOLDERS.has(from);
}

/** What call_log stores as the caller: the E.164 number, or "anonymous" (the module accepts both). */
const callerForLog = (from: string) => (hasCallerId(from) ? from : "anonymous");

// Build guide section 5 (redundancy): every call_log row is also appended here, one JSON object per line.
// A call can appear twice (a yellow call is logged again once the caller's message arrives); the last line wins.
const callLogJsonl = () =>
  process.env.CALL_LOG_JSONL || fileURLToPath(new URL("../../data/call-log.jsonl", import.meta.url));

async function appendJsonl(row: FullCallLog): Promise<void> {
  const file = callLogJsonl();
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ ...row, logged_at: new Date().toISOString() })}\n`);
}

interface LogArgs {
  callId: string;
  userId: string;
  from: string;
  flag: Flag;
  score: number;
  scamType: string;
  transcript: string;
  claimsJson: string;
  evidenceJson: string;
  summary: string;
  startedAt: number;
}

function writeLog(row: FullCallLog): Promise<void> {
  return Promise.all([
    logFullCall(row).catch((err) => console.error(`[pipeline] log_call failed for ${row.call_id}:`, (err as Error).message)),
    appendJsonl(row).catch((err) => console.error(`[pipeline] JSONL copy failed for ${row.call_id}:`, (err as Error).message)),
  ]).then(() => undefined);
}

function push(row: FullCallLog): Promise<void> {
  const caller = row.caller_e164 === "anonymous" ? "No caller ID" : row.caller_e164;
  return notifyVerdict({ userId: row.user_id, flag: row.flag, callerE164: caller, summary: row.summary, callId: row.call_id })
    .then((r) => console.log(`[pipeline] push for ${row.call_id}:`, r === "skipped" ? "skipped" : r.ok ? "sent" : `${r.status} ${r.reason ?? ""}`))
    .catch((err) => console.error(`[pipeline] push failed for ${row.call_id}:`, (err as Error).message));
}

// Yellow calls (build guide section 7): the agent takes a message before hanging up, and the push waits
// for it. If the message never comes (the caller hangs up, or A's server is down), the push goes anyway.
const MESSAGE_WAIT_MS = 90_000;
const pendingMessages = new Map<string, { row: FullCallLog; timer: ReturnType<typeof setTimeout> }>();

function holdPush(row: FullCallLog): void {
  const timer = setTimeout(() => {
    pendingMessages.delete(row.call_id);
    void push(row);
  }, MESSAGE_WAIT_MS);
  pendingMessages.set(row.call_id, { row, timer });
}

/** Adds the caller's message to a yellow call's log and sends its push. False if no message was expected. */
export async function addCallMessage(callId: string, message: string): Promise<boolean> {
  const pending = pendingMessages.get(callId);
  if (!pending) return false;
  pendingMessages.delete(callId);
  clearTimeout(pending.timer);
  let row = pending.row;
  const text = message.trim().slice(0, 1000);
  if (text) {
    row = {
      ...row,
      summary: `${row.summary}\nCaller's message: "${text}"`,
      transcript: `${row.transcript}\nCaller (message): ${text}`.trim(),
    };
    await writeLog(row);
  }
  await push(row);
  return true;
}

function logAndNotify(args: LogArgs, opts: { holdPushForMessage?: boolean } = {}): Promise<void> {
  const row: FullCallLog = {
    call_id: args.callId,
    user_id: args.userId,
    caller_e164: callerForLog(args.from),
    started_at: args.startedAt,
    flag: args.flag,
    score: args.score,
    scam_type: args.scamType,
    transcript: args.transcript,
    claims_json: args.claimsJson,
    crs_evidence_json: args.evidenceJson,
    summary: args.summary,
  };
  const tasks: Promise<void>[] = [writeLog(row)];
  if (args.flag !== "green") {
    if (opts.holdPushForMessage) holdPush(row);
    else tasks.push(push(row));
  }
  return Promise.all(tasks).then(() => undefined);
}

// protected_user.language from onboarding, cached for a minute (A asks before every greeting).
const languageCache = new Map<string, { language: string; at: number }>();

export async function getUserLanguage(userId = DEFAULT_USER_ID): Promise<string> {
  const hit = languageCache.get(userId);
  if (hit && Date.now() - hit.at < 60_000) return hit.language;
  try {
    const language = (await getProtectedUser(userId))?.language || "en";
    languageCache.set(userId, { language, at: Date.now() });
    return language;
  } catch (err) {
    console.error(`[pipeline] protected_user lookup failed for ${userId}:`, (err as Error).message);
    return "en";
  }
}

export interface NextTurnResult {
  nextAgentLine: string;
  callerLanguage: string;
  scamProbability: number;
}

/** A5: Gemini writes the agent's next follow-up question from the conversation so far. */
export async function nextTurn(
  callId: string,
  transcript: TranscriptTurn[],
  followUpsAsked: number,
  userId = DEFAULT_USER_ID,
): Promise<NextTurnResult> {
  const userLanguage = await getUserLanguage(userId);
  const turn = await analyzeTurn({ transcript, userLanguage, followUpsAsked, callId });
  return { nextAgentLine: turn.next_agent_line, callerLanguage: turn.caller_language, scamProbability: turn.scam_probability };
}

export interface PrecheckResult {
  action: "reject" | "screen";
  reason: string;
}

/** Decides before the call is answered. Logging and the push happen in the background. */
export async function precheck(callId: string, from: string, userId = DEFAULT_USER_ID): Promise<PrecheckResult> {
  const startedAt = Date.now();
  if (!hasCallerId(from)) {
    const summary = "Blocked: the caller hid their number.";
    void logAndNotify({ callId, userId, from, flag: "red", score: 1, scamType: "other", transcript: "", claimsJson: "[]", evidenceJson: JSON.stringify({ rule: "no_caller_id" }), summary, startedAt });
    return { action: "reject", reason: "no caller ID" };
  }
  const flagged = await getStore().getFlaggedNumber(from).catch(() => null);
  if (flagged?.flag === "red") {
    const summary = "Blocked: this number was already flagged as a scam.";
    void getStore().upsertFlaggedNumber(from, "red", flagged.reason || summary).catch(() => undefined);
    void logAndNotify({ callId, userId, from, flag: "red", score: 1, scamType: "other", transcript: "", claimsJson: "[]", evidenceJson: JSON.stringify({ rule: "repeat_red", previous_reason: flagged.reason, hit_count: flagged.hit_count }), summary, startedAt });
    return { action: "reject", reason: "repeat red number" };
  }
  return { action: "screen", reason: "" };
}

export interface ScreenCallInput {
  callId: string;
  from: string;
  transcript: TranscriptTurn[];
  userId?: string;
  startedAt?: number;
  /** A's rule-based verdict, used if the AI step fails. */
  fallbackFlag?: Flag;
  /** Log this flag no matter what the brain says (A's timeout path ends the call as yellow). */
  forceFlag?: Flag;
  /** A will take a message on a yellow call, so hold the push until addCallMessage(). */
  deferYellowNotify?: boolean;
}

export interface ScreenCallResult {
  flag: Flag;
  score: number;
  reasons: string[];
  summary: string;
  /** protected_user.real_phone_e164 from onboarding, for forwarding green calls. */
  forwardTo: string | null;
  /** True when the push is waiting for the caller's message (yellow, with deferYellowNotify). */
  messagePending: boolean;
}

const NEUTRAL_TURN: GeminiTurn = {
  caller_language: "",
  claimed_identity: "",
  scam_type: "none",
  claims: [],
  pressure_tactics: [],
  scam_probability: 0,
  next_agent_line: "",
  user_summary: "",
};

export async function screenCall(input: ScreenCallInput): Promise<ScreenCallResult> {
  const userId = input.userId ?? DEFAULT_USER_ID;
  const startedAt = input.startedAt ?? Date.now();
  const user = await getProtectedUser(userId).catch(() => null);
  const userLanguage = user?.language || "en";
  const transcriptText = input.transcript.map((t) => `${t.speaker === "agent" ? "Agent" : "Caller"}: ${t.text}`).join("\n");
  const callerText = input.transcript.filter((t) => t.speaker === "caller").map((t) => t.text).join("\n");

  // B4: one Gemini pass over the whole conversation.
  let gemini: GeminiTurn | null = null;
  try {
    const followUpsAsked = Math.max(0, input.transcript.filter((t) => t.speaker === "agent").length - 1);
    gemini = await analyzeTurn({ transcript: input.transcript, userLanguage, followUpsAsked, callId: input.callId });
  } catch (err) {
    console.error(`[pipeline] Gemini failed for ${input.callId}:`, (err as Error).message);
  } finally {
    forgetCall(input.callId);
  }

  // B2/B3: caller CRS signals (only for aliased demo numbers) and the user's tradelines.
  const [callerCheck, tradelines] = await Promise.all([
    checkCaller(input.from).catch(() => null),
    getTradelines(getUserPersona(userId))
      .then((lines) => lines.map(normalizeTradeline))
      .catch((err) => {
        console.error(`[pipeline] tradelines unavailable for ${userId}:`, (err as Error).message);
        return [];
      }),
  ]);
  const signals = callerCheck?.status === "checked" ? callerCheck.signals : null;
  const reverseLookupMismatch =
    signals && (signals.reverseNoRecord != null || signals.reverseOwnerMismatch != null)
      ? Boolean(signals.reverseNoRecord || signals.reverseOwnerMismatch)
      : null;

  const turn = gemini ?? NEUTRAL_TURN;
  const verify = verifyClaims(turn.claims, tradelines);
  const scoreInput: ScoreInput = {
    callId: input.callId,
    userId,
    callerE164: input.from,
    gemini: turn,
    verify,
    fraudFinderScore: signals?.fraudScore ?? null,
    reverseLookupMismatch,
    transcriptText: callerText,
  };

  // B6: score. Without Gemini the score means little, so A's rule-based flag decides instead.
  const result = await scoreCall(scoreInput);
  let flag: Flag = result.flag;
  const reasons = [...result.reasons];
  if (!gemini) {
    flag = input.fallbackFlag ?? "yellow";
    reasons.unshift("The AI check was unavailable, so the basic screening rules decided.");
  }
  if (input.forceFlag) flag = input.forceFlag;
  const summary = turn.user_summary || reasons[0] || "Screened call.";

  // C: flag the number and store red scripts (B's recordVerdict), then the full row the app shows.
  await recordVerdict(scoreInput, { ...result, flag, reasons }).catch((err) =>
    console.error(`[pipeline] recordVerdict failed for ${input.callId}:`, (err as Error).message),
  );
  const messagePending = flag === "yellow" && Boolean(input.deferYellowNotify);
  await logAndNotify(
    {
      callId: input.callId,
      userId,
      from: input.from,
      flag,
      score: result.score,
      scamType: turn.scam_type,
      transcript: transcriptText,
      claimsJson: JSON.stringify(turn.claims),
      evidenceJson: JSON.stringify({ evidence: verify.evidence, reasons, caller: signals, breakdown: result.breakdown }),
      summary,
      startedAt,
    },
    { holdPushForMessage: messagePending },
  );

  return { flag, score: result.score, reasons, summary, forwardTo: user?.realPhoneE164 || null, messagePending };
}
