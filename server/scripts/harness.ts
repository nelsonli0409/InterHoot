/**
 * B7: text test harness. Runs the scripted calls in harness-calls.ts through the real brain,
 * B4 (gemini.ts) → B5 (verify.ts) → B6 (score.ts), with no phone, Twilio or Cartesia.
 *
 *   npm run harness                         all scenarios
 *   npm run harness -- --only red-debt      one scenario (comma-separate for several)
 *   npm run harness -- --verbose            per-turn Gemini output, evidence, reasons
 *   npm run harness -- --weights gemini=0.5,crs=0.2 --red 0.65 --yellow 0.3
 *   npm run harness -- --phrase-rules on    let phrase rules compete in the 0.10 pattern slot
 *   npm run harness -- --shared-store       one store for all calls, in order: red calls become
 *                                           scam_patterns, so later scripts test similarity
 *   npm run harness -- --fresh              ignore cached Gemini answers
 *   npm run harness -- --live-crs           real sandbox calls through checkCaller (default: B1's saved answers)
 *   npm run harness -- --rpm 15             Gemini requests per minute (default 5, the free-tier limit)
 *   npm run harness -- --timeout 60         seconds to wait for each Gemini answer (default 30)
 *
 * Tuning loop: the first run asks Gemini once per caller turn and caches every answer in
 * scripts/out/harness-cache/. Re-runs with different --weights or thresholds are instant and
 * free. When a set of weights passes, copy it into WEIGHTS in src/brain/score.ts.
 *
 * Requests are spaced to stay under --rpm, and a 429 waits for the delay Gemini asks for and
 * retries. A turn that fails is not cached, so just run the harness again to pick up where it
 * stopped. Each fresh answer's latency is shown, since a live call only waits 8 s per turn.
 *
 * Data rule: callers are fictional 555-01xx numbers aliased to sandbox personas. Nothing here
 * sends a real number to CRS, and by default nothing reaches CRS at all.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeTurn, geminiModel, sanitizeTurn } from "../src/brain/gemini.js";
import {
  RED_THRESHOLD,
  WEIGHTS,
  YELLOW_THRESHOLD,
  geminiEmbed,
  recordVerdict,
  scoreCall,
  type Embedder,
  type ScoreInput,
  type ScoreResult,
  type Weights,
} from "../src/brain/score.js";
import type { Flag, GeminiTurn, Tradeline as BrainTradeline, TranscriptTurn } from "../src/brain/types.js";
import { normalizeTradeline, verifyClaims, type VerifyResult } from "../src/brain/verify.js";
import { InMemoryAliasStore, setAliasStore } from "../src/crs/alias.js";
import { checkCaller } from "../src/crs/callerCheck.js";
import { getTradelines, type PersonaBody } from "../src/crs/crs.js";
import { callerBodies, getUserPersona } from "../src/crs/personas.js";
import { MemoryStore, type Store } from "../src/storage/index.js";
import { SCENARIOS, type Scenario } from "./harness-calls.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CACHE = join(OUT, "harness-cache");
const PROTECTED_USER = "P20";
const PERSONA_PHONE = { P13: "5550101013", P12: "5550101012", P01: "5550101001" } as const;

// ---- CLI ------------------------------------------------------------------------------------

interface Opts {
  only: string[] | null;
  verbose: boolean;
  fresh: boolean;
  liveCrs: boolean;
  sharedStore: boolean;
  weights: Weights;
  red: number;
  yellow: number;
  rpm: number;
  timeoutSec: number;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    only: null,
    verbose: false,
    fresh: false,
    liveCrs: false,
    sharedStore: false,
    weights: { ...WEIGHTS },
    red: RED_THRESHOLD,
    yellow: YELLOW_THRESHOLD,
    rpm: Number(process.env.HARNESS_RPM) || 5,
    timeoutSec: 30,
  };
  const num = (flag: string, v: string | undefined) => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) die(`${flag} needs a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--only": o.only = (next() ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--verbose": case "-v": o.verbose = true; break;
      case "--fresh": o.fresh = true; break;
      case "--live-crs": o.liveCrs = true; break;
      case "--shared-store": o.sharedStore = true; break;
      case "--red": o.red = num(a, next()); break;
      case "--yellow": o.yellow = num(a, next()); break;
      case "--rpm": o.rpm = num(a, next()); if (o.rpm <= 0) die("--rpm must be above 0"); break;
      case "--timeout": o.timeoutSec = num(a, next()); break;
      case "--phrase-rules": {
        const v = next();
        if (v !== "on" && v !== "off") die("--phrase-rules takes on or off");
        process.env.PHRASE_RULES_IN_SCORE = v === "on" ? "true" : "false";
        break;
      }
      case "--weights":
        for (const pair of (next() ?? "").split(",")) {
          const [k, v] = pair.split("=").map((s) => s.trim());
          if (!(k in o.weights)) die(`unknown weight "${k}" (use ${Object.keys(WEIGHTS).join(", ")})`);
          o.weights[k as keyof Weights] = num(`--weights ${k}`, v);
        }
        break;
      case "--help": case "-h":
        console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
        process.exit(0);
      default:
        die(`unknown option ${a} (try --help)`);
    }
  }
  return o;
}

function die(msg: string): never {
  console.error(`harness: ${msg}`);
  process.exit(2);
}

// ---- Disk caches (Gemini answers and embeddings) ----------------------------------------------

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

function readJson<T>(file: string): T | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

let geminiRequests = 0;
let geminiCacheHits = 0;
const latencies: number[] = [];
const turnLatency = new WeakMap<GeminiTurn, number>(); // fresh answers only

// ---- Rate limiting ---------------------------------------------------------------------------

let rpm = 5;
let nextSlot = 0; // earliest time the next Gemini request may start
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One-line progress on stderr (TTY only), cleared before each result row. */
function status(text: string): void {
  if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K\x1b[2m${text}\x1b[0m`);
}
function clearStatus(): void {
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[2K");
}

/**
 * Run one Gemini request inside the per-minute budget. On a 429, wait for the delay Gemini
 * asks for (or 20 s) and retry, up to 4 tries. Timeouts are not retried: a timed-out request
 * still counts against the quota, and the fix is a longer --timeout, not another try.
 */
async function throttled<T>(label: string, fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  for (let attempt = 1; ; attempt++) {
    const wait = nextSlot - Date.now();
    if (wait > 0) {
      status(`${label}: waiting ${Math.ceil(wait / 1000)}s (${rpm} requests/min)`);
      await sleep(wait);
    }
    nextSlot = Date.now() + 60_000 / rpm;
    geminiRequests++;
    status(`${label}: asking Gemini…`);
    const t0 = Date.now();
    try {
      return { value: await fn(), ms: Date.now() - t0 };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if ((err as Error).name === "TimeoutError" || /aborted due to timeout/i.test(msg)) {
        throw new Error(`Gemini didn't answer within ${Math.round((Date.now() - t0) / 1000)}s (try --timeout 60, or GEMINI_MODEL=gemini-3.5-flash-lite)`);
      }
      if (!/Gemini (embed )?429/.test(msg) || attempt >= 4) throw err;
      const sec = Number(msg.match(/retry in ([\d.]+)\s*s/i)?.[1] ?? msg.match(/retryDelay\W+(\d+)/)?.[1] ?? 20);
      nextSlot = Date.now() + (sec + 1) * 1000;
      status(`${label}: rate limited, retrying in ${Math.ceil(sec + 1)}s`);
    }
  }
}

/** analyzeTurn, cached on disk by everything that shapes the prompt. */
async function cachedAnalyze(
  scenarioId: string,
  transcript: TranscriptTurn[],
  userLanguage: string,
  followUpsAsked: number,
  fresh: boolean,
): Promise<GeminiTurn> {
  const key = hash({ model: geminiModel(), transcript, userLanguage, followUpsAsked });
  const file = join(CACHE, `${scenarioId}-t${transcript.length}-${key}.json`);
  if (!fresh) {
    const hit = readJson<GeminiTurn>(file);
    if (hit) {
      geminiCacheHits++;
      return sanitizeTurn(hit);
    }
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set and this turn isn't cached yet (run with ../.env)");
  }
  const label = `${scenarioId} turn ${transcript.filter((t) => t.speaker === "caller").length}`;
  const { value: turn, ms } = await throttled(label, () => analyzeTurn({ transcript, userLanguage, followUpsAsked }));
  latencies.push(ms);
  turnLatency.set(turn, ms);
  writeJson(file, turn);
  return turn;
}

const diskEmbed: Embedder = async (text) => {
  const file = join(CACHE, `embed-${hash({ model: process.env.GEMINI_EMBED_MODEL || "gemini-embedding-2", text })}.json`);
  const hit = readJson<number[]>(file);
  if (hit) return hit;
  const { value: values } = await throttled("embedding", () => geminiEmbed(text));
  writeJson(file, values);
  return values;
};

// ---- CRS caller signals ----------------------------------------------------------------------

interface CallerCrs {
  source: "saved" | "live" | "skipped";
  fraudScore: number | null;
  reverseMismatch: boolean | null; // no record, or registered to someone else
  note: string;
}

/** B1's saved sandbox answers (scripts/out/pNN-*.response.json). Same answers the live sandbox gives. */
function savedCallerCrs(persona: keyof typeof PERSONA_PHONE): CallerCrs {
  const id = persona.toLowerCase();
  const rev = readJson<any>(join(OUT, `${id}-reverse.response.json`));
  const ff = readJson<any>(join(OUT, `${id}-fraud-finder.response.json`));
  if (!rev || !ff) die(`missing scripts/out/${id}-*.response.json; run scripts/crs-smoke.ts once, or use --live-crs`);
  const body: PersonaBody | undefined = callerBodies[PERSONA_PHONE[persona]];
  const records: any[] = (rev.body ?? rev)?.data?.records ?? [];
  const norm = (s?: string) => (s ?? "").trim().toUpperCase();
  const ownerIsPersona = records.some((r) => body && norm(r.firstName) === norm(body.firstName) && norm(r.lastName) === norm(body.lastName));
  const score = (ff.body ?? ff)?.risk?.score;
  const noRecord = records.length === 0;
  return {
    source: "saved",
    fraudScore: typeof score === "number" ? score : null,
    reverseMismatch: noRecord || !ownerIsPersona,
    note: noRecord ? "no reverse record" : ownerIsPersona ? "owner matches" : `owner ${records[0]?.firstName} ${records[0]?.lastName}`,
  };
}

async function liveCallerCrs(s: Scenario): Promise<CallerCrs> {
  const check = await checkCaller(s.callerE164);
  if (check.status === "skipped") return { source: "skipped", fraudScore: null, reverseMismatch: null, note: "no alias" };
  if (check.errors.length) console.warn(`  [crs] ${s.id}: ${check.errors.join("; ")}`);
  const { reverseNoRecord, reverseOwnerMismatch, fraudScore } = check.signals;
  const mismatch = reverseNoRecord == null && reverseOwnerMismatch == null ? null : Boolean(reverseNoRecord || reverseOwnerMismatch);
  return { source: "live", fraudScore, reverseMismatch: mismatch, note: reverseNoRecord ? "no reverse record" : reverseOwnerMismatch ? "owner mismatch" : "owner matches" };
}

async function callerCrs(s: Scenario, opts: Opts): Promise<CallerCrs> {
  if (!s.persona) return { source: "skipped", fraudScore: null, reverseMismatch: null, note: "no alias" };
  return opts.liveCrs ? liveCallerCrs(s) : savedCallerCrs(s.persona);
}

async function loadTradelines(opts: Opts): Promise<BrainTradeline[]> {
  const saved = [join(OUT, `tradelines-${PROTECTED_USER}.json`), join(OUT, `${PROTECTED_USER.toLowerCase()}-tu-report.response.json`)];
  if (!opts.liveCrs && !saved.some(existsSync)) {
    die(`no saved ${PROTECTED_USER} credit report in scripts/out/; run scripts/crs-smoke.ts once, or use --live-crs`);
  }
  // getTradelines reads the saved copy first and only pulls live if there is none.
  const raw = await getTradelines(getUserPersona(PROTECTED_USER));
  return raw.map(normalizeTradeline);
}

// ---- Run one scenario --------------------------------------------------------------------------

interface Outcome {
  scenario: Scenario;
  ok: boolean;
  error?: string;
  result?: ScoreResult;
  turns: GeminiTurn[];
  verify?: VerifyResult;
  crs?: CallerCrs;
  ruleRed?: boolean;
}

async function runScenario(s: Scenario, tradelines: BrainTradeline[], store: Store, opts: Opts): Promise<Outcome> {
  const transcript: TranscriptTurn[] = [];
  const turns: GeminiTurn[] = [];
  try {
    for (const t of s.turns) {
      transcript.push(t);
      if (t.speaker !== "caller") continue;
      // A5's loop: greeting + "who's calling?" is agent turn 1; everything after is a follow-up.
      const followUps = Math.max(0, transcript.filter((x) => x.speaker === "agent").length - 1);
      turns.push(await cachedAnalyze(s.id, [...transcript], s.userLanguage, followUps, opts.fresh));
    }
    const final = turns.at(-1);
    if (!final) throw new Error("scenario has no caller turns");

    const crs = await callerCrs(s, opts);
    const verify = verifyClaims(final.claims, tradelines);
    const input: ScoreInput = {
      callId: `harness-${s.id}`,
      userId: PROTECTED_USER,
      callerE164: s.callerE164,
      gemini: final,
      verify,
      fraudFinderScore: crs.fraudScore,
      reverseLookupMismatch: crs.reverseMismatch,
      transcriptText: s.turns.filter((t) => t.speaker === "caller").map((t) => t.text).join("\n"),
    };
    const result = await scoreCall(input, {
      store,
      embed: diskEmbed,
      weights: opts.weights,
      redThreshold: opts.red,
      yellowThreshold: opts.yellow,
    });
    if (opts.sharedStore) await recordVerdict(input, result, { store, embed: diskEmbed });
    return {
      scenario: s,
      ok: result.flag === s.expect,
      result,
      turns,
      verify,
      crs,
      ruleRed: result.flag === "red" && result.score < opts.red,
    };
  } catch (err) {
    return { scenario: s, ok: false, error: (err as Error).message, turns };
  }
}

// ---- Output ------------------------------------------------------------------------------------

const tty = process.stdout.isTTY;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const COLOR: Record<Flag, (s: string) => string> = { red: paint("31"), yellow: paint("33"), green: paint("32") };
const dim = paint("2");
const bold = paint("1");
const f2 = (n: number) => n.toFixed(2);

/** How far the score sits inside its expected band (negative = wrong side). */
function margin(o: Outcome, opts: Opts): string {
  const r = o.result!;
  if (o.ruleRed && o.scenario.expect === "red") return "rule";
  switch (o.scenario.expect) {
    case "red": return f2(r.score - opts.red);
    case "yellow": return f2(Math.min(r.score - opts.yellow, opts.red - r.score));
    case "green": return f2(opts.yellow - r.score);
  }
}

function printRow(o: Outcome, opts: Opts): void {
  clearStatus();
  const s = o.scenario;
  const exp = COLOR[s.expect](s.expect.padEnd(6));
  if (o.error) {
    console.log(`${paint("31")("ERROR")} ${s.id.padEnd(16)} ${exp} ${o.error}`);
    return;
  }
  const r = o.result!;
  const b = r.breakdown;
  const traj = o.turns.map((t) => f2(t.scam_probability)).join("→");
  console.log(
    [
      o.ok ? paint("32")("PASS ") : paint("31")("FAIL "),
      s.id.padEnd(16),
      exp,
      COLOR[r.flag](r.flag.padEnd(6)),
      f2(r.score).padStart(5),
      margin(o, opts).padStart(6),
      "  ",
      [f2(b.gemini), f2(b.crs), f2(b.fraudFinder), f2(b.reverseLookup), f2(b.pattern)].join("  "),
      "  ",
      dim(`p ${traj}`),
    ].join(" "),
  );
}

function printDetail(o: Outcome): void {
  if (!o.result) return;
  const last = o.turns.at(-1)!;
  const pad = "      ";
  console.log(dim(`${pad}${o.scenario.title}`));
  o.turns.forEach((t, i) =>
    console.log(
      dim(`${pad}turn ${i + 1}: p=${f2(t.scam_probability)} ${t.scam_type}`) +
        dim(turnLatency.has(t) ? ` (${(turnLatency.get(t)! / 1000).toFixed(1)}s)` : " (cached)") +
        (t.pressure_tactics.length ? dim(` [${t.pressure_tactics.join(", ")}]`) : "") +
        dim(` → "${t.next_agent_line}"`),
    ),
  );
  console.log(`${pad}lang ${last.caller_language} · claimed "${last.claimed_identity}" · CRS ${o.crs!.source}: ${o.crs!.note}` +
    (o.crs!.fraudScore != null ? `, risk ${o.crs!.fraudScore}` : ""));
  if (last.claims.length) console.log(`${pad}claims ${JSON.stringify(last.claims)}`);
  console.log(`${pad}summary (${o.scenario.userLanguage}): ${last.user_summary}`);
  for (const reason of o.result.reasons) console.log(`${pad}· ${reason}`);
  console.log();
}

// ---- Main --------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  rpm = opts.rpm;
  // Generous on purpose: here we want to see how long Gemini takes, not cut it off at the live 8 s.
  process.env.GEMINI_TIMEOUT_MS = String(opts.timeoutSec * 1000);
  const scenarios = opts.only ? SCENARIOS.filter((s) => opts.only!.includes(s.id)) : SCENARIOS;
  if (opts.only && scenarios.length !== opts.only.length) {
    const known = new Set(SCENARIOS.map((s) => s.id));
    die(`unknown scenario ${opts.only.filter((id) => !known.has(id)).join(", ")} (have: ${[...known].join(", ")})`);
  }

  // Aliases for --live-crs: fictional caller numbers → persona phones (same table B3 reads).
  setAliasStore(
    new InMemoryAliasStore(
      Object.fromEntries(scenarios.filter((s) => s.persona).map((s) => [s.callerE164, PERSONA_PHONE[s.persona!]])),
    ),
  );

  const tradelines = await loadTradelines(opts);
  const w = opts.weights;
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  console.log(
    bold("InterHoot B7 harness") +
      dim(` · ${geminiModel()} · CRS ${opts.liveCrs ? "live" : "saved"} · ${PROTECTED_USER} ${tradelines.length} tradelines` +
        ` · phrase rules ${process.env.PHRASE_RULES_IN_SCORE === "true" ? "scored" : "reasons only"}` +
        (opts.sharedStore ? " · shared store" : "") +
        ` · ${opts.rpm} req/min, ${opts.timeoutSec}s timeout`),
  );
  console.log(
    dim(`weights gemini ${w.gemini} crs ${w.crs} ff ${w.fraudFinder} rev ${w.reverseLookup} pattern ${w.pattern}` +
      ` (sum ${f2(sum)}) · red ≥ ${opts.red} · yellow ≥ ${opts.yellow}`),
  );
  if (Math.abs(sum - 1) > 0.001) console.log(paint("33")(`note: weights sum to ${f2(sum)}, not 1`));
  console.log(dim(`\n      ${"scenario".padEnd(16)} ${"expect".padEnd(6)} ${"got".padEnd(6)} score margin    gem   crs   ff    rev   pat`));

  const store: Store = new MemoryStore();
  const outcomes: Outcome[] = [];
  for (const s of scenarios) {
    const o = await runScenario(s, tradelines, opts.sharedStore ? store : new MemoryStore(), opts);
    outcomes.push(o);
    printRow(o, opts);
    if (opts.verbose || !o.ok) printDetail(o);
  }

  const passed = outcomes.filter((o) => o.ok).length;
  console.log(
    `\n${passed === outcomes.length ? paint("32")(bold(`${passed}/${outcomes.length} passed`)) : paint("31")(bold(`${passed}/${outcomes.length} passed`))}` +
      dim(` · Gemini ${geminiRequests} requests, ${geminiCacheHits} cached`),
  );
  if (latencies.length) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)] / 1000;
    const max = sorted.at(-1)! / 1000;
    const slow = latencies.filter((ms) => ms > 8_000).length;
    const line = `Gemini latency: median ${p50.toFixed(1)}s, max ${max.toFixed(1)}s`;
    console.log(slow ? paint("33")(`${line}. ${slow} of ${latencies.length} took over 8s, which a live call would time out on`) : dim(line));
  }

  // The one structural limit worth seeing every run: with no CRS alias, only Gemini and the
  // pattern slot can add to the score.
  const unaliasedMax = w.gemini + w.pattern;
  if (unaliasedMax < opts.yellow) {
    console.log(paint("33")(`note: an unaliased caller tops out at ${f2(unaliasedMax)} (gemini + pattern), below yellow ${opts.yellow}`));
  } else if (w.gemini < opts.yellow) {
    console.log(dim(`note: an unaliased caller needs a pattern hit to reach yellow (gemini alone maxes at ${f2(w.gemini)})`));
  }

  writeJson(join(OUT, "harness-last.json"), {
    ranAt: new Date().toISOString(),
    model: geminiModel(),
    weights: w,
    red: opts.red,
    yellow: opts.yellow,
    results: outcomes.map((o) => ({
      id: o.scenario.id,
      expect: o.scenario.expect,
      flag: o.result?.flag ?? null,
      ok: o.ok,
      error: o.error ?? null,
      score: o.result?.score ?? null,
      breakdown: o.result?.breakdown ?? null,
      reasons: o.result?.reasons ?? [],
      turns: o.turns,
      crs: o.crs ?? null,
    })),
  });
  console.log(dim(`full results: scripts/out/harness-last.json`));
  process.exitCode = passed === outcomes.length ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
