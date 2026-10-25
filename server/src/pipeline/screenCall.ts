// End-to-end glue for one phone call (test_main): A's telephony server calls these through the HTTP
// routes in ../index.ts. B's brain decides the flag; C's storage and push record it and alert the user.
//
//   precheck()   when the call rings: reject hidden caller IDs and numbers already flagged red
//   screenCall() when A's questions are done: Gemini → CRS caller check → claim check → score,
//                then log to SpacetimeDB, flag the number, and push yellow/red alerts
import { analyzeTurn, forgetCall } from "../brain/gemini.js";
import { recordVerdict, scoreCall, type ScoreInput } from "../brain/score.js";
import type { Flag, GeminiTurn, TranscriptTurn } from "../brain/types.js";
import { normalizeTradeline, verifyClaims } from "../brain/verify.js";
import { checkCaller } from "../crs/callerCheck.js";
import { getTradelines } from "../crs/crs.js";
import { getUserPersona } from "../crs/personas.js";
import { notifyVerdict } from "../push/notify.js";
import { getStore } from "../storage/index.js";
import { getProtectedUser, logFullCall } from "../storage/spacetime.js";

const E164 = /^\+[1-9]\d{6,14}$/;
// Twilio's From for withheld caller ID is "anonymous"; older calls used the digits for ANONYMOUS.
const ANONYMOUS_PLACEHOLDERS = new Set(["+266696687"]);

export const DEFAULT_USER_ID = process.env.PROTECTED_USER_ID || "P20";

export function hasCallerId(from: string): boolean {
  return E164.test(from) && !ANONYMOUS_PLACEHOLDERS.has(from);
}

/** What call_log stores as the caller: the E.164 number, or "anonymous" (the module accepts both). */
const callerForLog = (from: string) => (hasCallerId(from) ? from : "anonymous");

function logAndNotify(args: {
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
}): Promise<void> {
  const caller = callerForLog(args.from);
  const tasks: Promise<unknown>[] = [
    logFullCall({
      call_id: args.callId,
      user_id: args.userId,
      caller_e164: caller,
      started_at: args.startedAt,
      flag: args.flag,
      score: args.score,
      scam_type: args.scamType,
      transcript: args.transcript,
      claims_json: args.claimsJson,
      crs_evidence_json: args.evidenceJson,
      summary: args.summary,
    }).catch((err) => console.error(`[pipeline] log_call failed for ${args.callId}:`, (err as Error).message)),
  ];
  if (args.flag !== "green") {
    tasks.push(
      notifyVerdict({ userId: args.userId, flag: args.flag, callerE164: caller === "anonymous" ? "No caller ID" : caller, summary: args.summary, callId: args.callId })
        .then((r) => console.log(`[pipeline] push for ${args.callId}:`, r === "skipped" ? "skipped" : r.ok ? "sent" : `${r.status} ${r.reason ?? ""}`))
        .catch((err) => console.error(`[pipeline] push failed for ${args.callId}:`, (err as Error).message)),
    );
  }
  return Promise.all(tasks).then(() => undefined);
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
}

export interface ScreenCallResult {
  flag: Flag;
  score: number;
  reasons: string[];
  summary: string;
  /** protected_user.real_phone_e164 from onboarding, for forwarding green calls. */
  forwardTo: string | null;
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
  await logAndNotify({
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
  });

  return { flag, score: result.score, reasons, summary, forwardTo: user?.realPhoneE164 || null };
}
