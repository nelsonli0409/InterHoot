// B6: turn all signals into one score and a RED / YELLOW / GREEN flag (build guide section 8).
//
//   score = 0.40 × gemini.scam_probability
//         + 0.25 × (crs_contradiction ? 1 : 0)
//         + 0.15 × (fraud_finder.risk.score / 100)
//         + 0.10 × (reverse_lookup_mismatch_or_no_record ? 1 : 0)
//         + 0.10 × max(script_similarity, repeat_or_velocity_hit)
//
//   RED    if score ≥ 0.70, OR exact repeat of a red number, OR (crs_contradiction AND payment pressure)
//   YELLOW if 0.35 ≤ score < 0.70
//   GREEN  otherwise, or if the number is in the user's allow list
//
// Repeat, velocity and scam_pattern data come from the Store interface (SpacetimeDB later,
// in-memory stub now). The prototype's phrase rules add reasons; by default they don't move the score.

import { getStore, type Store } from "../storage/index.js";
import { detectRisks, SEVERITY_VALUE } from "./phraseRules.js";
import type { Flag, GeminiTurn, PressureTactic, Verdict } from "./types.js";
import type { VerifyResult } from "./verify.js";

export const WEIGHTS = { gemini: 0.4, crs: 0.25, fraudFinder: 0.15, reverseLookup: 0.1, pattern: 0.1 } as const;
export const RED_THRESHOLD = 0.7;
export const YELLOW_THRESHOLD = 0.35;

const PAYMENT_PRESSURE: PressureTactic[] = ["gift_card", "wire", "crypto"];
const VELOCITY_WINDOW_MS = Number(process.env.VELOCITY_WINDOW_HOURS ?? 24) * 3_600_000;
const VELOCITY_MIN_USERS = Number(process.env.VELOCITY_MIN_USERS ?? 3);
const SIMILARITY_REASON_AT = 0.85; // only mention similarity in reasons[] when it's a strong match

// Off unless the team agrees: when "true", phrase-rule severity competes inside the existing
// 0.10 max() slot. Weights and thresholds stay exactly as written above.
const phraseRulesInScore = () => process.env.PHRASE_RULES_IN_SCORE === "true";

export interface ScoreInput {
  callId: string;
  userId: string;
  callerE164: string;
  gemini: GeminiTurn;
  verify: VerifyResult;
  /** fraud_finder risk.score, 0–100. null if the call failed or was skipped. */
  fraudFinderScore: number | null;
  /** Reverse lookup: owner doesn't match the claimed identity, or no record. null if unknown. */
  reverseLookupMismatch: boolean | null;
  /** Full caller-side transcript text, for embeddings and phrase rules. */
  transcriptText: string;
  allowList?: string[];
}

export interface ScoreResult extends Verdict {
  breakdown: {
    gemini: number;
    crs: number;
    fraudFinder: number;
    reverseLookup: number;
    pattern: number;
    scriptSimilarity: number;
    repeatOrVelocityHit: number;
    phraseRuleValue: number;
  };
  embedding: number[] | null; // reuse when logging a red call to scam_pattern
}

// ---- Embeddings + cosine similarity -----------------------------------------------------

export type Embedder = (text: string) => Promise<number[]>;

/** gemini-embedding-2 at 768 dimensions (build guide section 6). */
export const geminiEmbed: Embedder = async (text) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-2";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ content: { parts: [{ text }] }, output_dimensionality: 768 }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Gemini embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body: any = await res.json();
  const values = body?.embedding?.values ?? body?.embeddings?.[0]?.values;
  if (!Array.isArray(values)) throw new Error("Gemini embed response had no values");
  return values;
};

// Embeddings cached by exact transcript text, so scoring and logging the same call embed it once.
const embedCaches = new WeakMap<Embedder, Map<string, Promise<number[]>>>();
const EMBED_CACHE_MAX = 200;

function cachedEmbed(embed: Embedder, text: string): Promise<number[]> {
  let cache = embedCaches.get(embed);
  if (!cache) embedCaches.set(embed, (cache = new Map()));
  const key = text.trim();
  let pending = cache.get(key);
  if (!pending) {
    pending = embed(key);
    cache.set(key, pending);
    const c = cache;
    pending.catch(() => c.delete(key));
    if (cache.size > EMBED_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }
  return pending;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ---- Scoring -------------------------------------------------------------------------------

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Call once per phone call, at the end (each call may make one embedding request). */
export async function scoreCall(
  input: ScoreInput,
  opts: { store?: Store; embed?: Embedder; now?: number } = {},
): Promise<ScoreResult> {
  const store = opts.store ?? getStore();
  const embed = opts.embed ?? geminiEmbed;
  const now = opts.now ?? Date.now();
  const reasons: string[] = [];
  const { gemini, verify } = input;

  // Storage-backed checks run in parallel. Each one degrades to "no signal" on failure,
  // so a SpacetimeDB or embedding hiccup never blocks a verdict.
  const [flagged, distinctUsers, similarity] = await Promise.all([
    store.getFlaggedNumber(input.callerE164).catch(() => null),
    store.countDistinctUsersForCaller(input.callerE164, now - VELOCITY_WINDOW_MS).catch(() => 0),
    (async () => {
      const patterns = await store.listScamPatterns();
      if (patterns.length === 0 || !input.transcriptText.trim()) return { value: 0, embedding: null as number[] | null, best: null as string | null };
      const emb = await cachedEmbed(embed, input.transcriptText);
      let value = 0;
      let best: string | null = null;
      for (const p of patterns) {
        const s = cosine(emb, p.embedding);
        if (s > value) {
          value = s;
          best = p.scam_type;
        }
      }
      return { value: Math.max(0, Math.min(1, value)), embedding: emb, best };
    })().catch(() => ({ value: 0, embedding: null, best: null })),
  ]);

  const exactRedRepeat = flagged?.flag === "red";
  const repeatHit = flagged != null && flagged.flag !== "green";
  const velocityHit = distinctUsers >= VELOCITY_MIN_USERS;
  const repeatOrVelocityHit = repeatHit || velocityHit ? 1 : 0;

  // Phrase rules (prototype): always reported, only scored if the team turns it on.
  const signals = detectRisks(input.transcriptText);
  const phraseRuleValue = signals.reduce((m, s) => Math.max(m, SEVERITY_VALUE[s.severity]), 0);
  const patternSlot = Math.max(
    similarity.value,
    repeatOrVelocityHit,
    phraseRulesInScore() ? phraseRuleValue : 0,
  );

  const parts = {
    gemini: WEIGHTS.gemini * gemini.scam_probability,
    crs: WEIGHTS.crs * (verify.crs_contradiction ? 1 : 0),
    fraudFinder: WEIGHTS.fraudFinder * (Math.min(100, Math.max(0, input.fraudFinderScore ?? 0)) / 100),
    reverseLookup: WEIGHTS.reverseLookup * (input.reverseLookupMismatch ? 1 : 0),
    pattern: WEIGHTS.pattern * patternSlot,
  };
  const score = round(parts.gemini + parts.crs + parts.fraudFinder + parts.reverseLookup + parts.pattern);

  const paymentPressure = gemini.pressure_tactics.some((t) => PAYMENT_PRESSURE.includes(t));
  const allowListed = input.allowList?.includes(input.callerE164) ?? false;

  let flag: Flag;
  if (allowListed) flag = "green";
  else if (exactRedRepeat || score >= RED_THRESHOLD || (verify.crs_contradiction && paymentPressure)) flag = "red";
  else if (score >= YELLOW_THRESHOLD) flag = "yellow";
  else flag = "green";

  // reasons[]: plain English, most important first. The app shows these.
  if (allowListed) reasons.push("This number is on your allow list.");
  if (exactRedRepeat) reasons.push("This number was already flagged as a scam.");
  if (verify.crs_contradiction && paymentPressure)
    reasons.push("The caller's debt claim doesn't match your credit file, and they asked for an unusual payment method.");
  reasons.push(...verify.evidence);
  if (gemini.scam_type !== "none") reasons.push(`Looks like a ${gemini.scam_type.replace(/_/g, " ")} scam (AI estimate ${Math.round(gemini.scam_probability * 100)}%).`);
  if (gemini.pressure_tactics.length) reasons.push(`Pressure tactics: ${gemini.pressure_tactics.join(", ").replace(/_/g, " ")}.`);
  if (input.fraudFinderScore != null && input.fraudFinderScore >= 70) reasons.push(`The caller's number has a high fraud risk score (${input.fraudFinderScore}/100).`);
  if (input.reverseLookupMismatch) reasons.push("The number isn't registered to who the caller says they are.");
  if (repeatHit && !exactRedRepeat) reasons.push("This number has called before and was flagged.");
  if (velocityHit) reasons.push(`This number has called ${distinctUsers} InterHoot users recently.`);
  if (similarity.value >= SIMILARITY_REASON_AT)
    reasons.push(`The script closely matches a known ${(similarity.best ?? "scam").replace(/_/g, " ")} call.`);
  for (const s of signals)
    reasons.push(`Phrase rule "${s.ruleId}" (${s.severity}): "${s.matchedPhrases.join('", "')}".`);

  return {
    flag,
    score,
    reasons,
    call_id: input.callId,
    breakdown: {
      ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v)])) as typeof parts,
      scriptSimilarity: round(similarity.value),
      repeatOrVelocityHit,
      phraseRuleValue,
    },
    embedding: similarity.embedding,
  };
}

/** After a verdict: log the call, flag the number, and store red scripts as new scam_patterns. */
export async function recordVerdict(
  input: ScoreInput,
  result: ScoreResult,
  opts: { store?: Store; embed?: Embedder; now?: number } = {},
): Promise<void> {
  const store = opts.store ?? getStore();
  const now = opts.now ?? Date.now();
  await store.recordCall({ call_id: input.callId, user_id: input.userId, caller_e164: input.callerE164, started_at: now, flag: result.flag });
  if (result.flag === "green") return;
  await store.upsertFlaggedNumber(input.callerE164, result.flag, result.reasons[0] ?? "");
  if (result.flag === "red" && input.transcriptText.trim()) {
    const embedding = result.embedding ?? (await cachedEmbed(opts.embed ?? geminiEmbed, input.transcriptText).catch(() => null));
    if (embedding) {
      await store.addScamPattern({ id: `${input.callId}-p`, embedding, scam_type: input.gemini.scam_type, source_call_id: input.callId });
    }
  }
}