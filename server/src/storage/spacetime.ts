// Build guide C1/B6 glue: a Store (see ./index.ts) backed by the SpacetimeDB module, over its HTTP API.
// Reads use POST /v1/database/<db>/sql, writes use POST /v1/database/<db>/call/<reducer>.
// Turn it on with: setStore(new SpacetimeStore()). It needs no key: the module's tables and reducers are public.
import type { Flag } from "../brain/types.js";
import type { CallRecord, FlaggedNumber, ScamPattern, Store } from "./index.js";

const E164 = /^\+[1-9]\d{6,14}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const baseUrl = () => process.env.SPACETIMEDB_URI ?? "https://maincloud.spacetimedb.com";
const database = () => process.env.SPACETIMEDB_DATABASE ?? "interhoot";

type Row = Record<string, unknown>;

async function sql(query: string): Promise<Row[]> {
  const res = await fetch(`${baseUrl()}/v1/database/${database()}/sql`, { method: "POST", body: query });
  if (!res.ok) throw new Error(`SpacetimeDB SQL failed (${res.status}): ${await res.text()}`);
  const sets = (await res.json()) as { schema: { elements: { name: { some?: string } }[] }; rows: unknown[][] }[];
  const first = sets[0];
  if (!first) return [];
  const names = first.schema.elements.map((element) => element.name.some ?? "");
  return first.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

async function call(reducer: string, args: unknown[]): Promise<void> {
  const res = await fetch(`${baseUrl()}/v1/database/${database()}/call/${reducer}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`SpacetimeDB reducer ${reducer} failed (${res.status}): ${await res.text()}`);
}

// These values are placed in SQL text, so only plain phone numbers and ids get through.
function requireE164(value: string): string {
  if (!E164.test(value)) throw new Error(`Not an E.164 number: "${value}"`);
  return value;
}

/** Everything the app shows about a finished call. recordCall() writes a bare row; this fills in the rest. */
export interface FullCallLog {
  call_id: string;
  user_id: string;
  caller_e164: string;
  started_at: number; // ms epoch
  flag: Flag;
  score: number; // 0 to 1
  scam_type: string; // none, irs_tax, debt_collection, bank_fraud, grandparent, tech_support, prize, other
  transcript: string;
  claims_json: string;
  crs_evidence_json: string;
  summary: string;
}

/** Writes (or replaces, by call_id) the call_log row the iOS app reads. */
export async function logFullCall(row: FullCallLog): Promise<void> {
  if (!SAFE_ID.test(row.call_id)) throw new Error(`Unsafe call id: "${row.call_id}"`);
  await call("log_call", [
    row.call_id,
    row.user_id,
    row.caller_e164,
    new Date(row.started_at).toISOString(),
    row.flag,
    row.score,
    row.scam_type,
    row.transcript,
    row.claims_json,
    row.crs_evidence_json,
    row.summary,
  ]);
}

/** The protected user's settings from onboarding, or null if the row doesn't exist. */
export async function getProtectedUser(userId: string): Promise<{ language: string; realPhoneE164: string } | null> {
  if (!SAFE_ID.test(userId)) return null;
  const rows = await sql(`SELECT language, real_phone_e164 FROM protected_user WHERE id = '${userId}'`);
  const row = rows[0];
  if (!row) return null;
  return { language: String(row.language ?? ""), realPhoneE164: String(row.real_phone_e_164 ?? row.real_phone_e164 ?? "") };
}

export class SpacetimeStore implements Store {
  async getPersonaPhone(realE164: string): Promise<string | null> {
    if (!E164.test(realE164)) return null;
    const rows = await sql(`SELECT persona_phone FROM demo_caller_alias WHERE real_e164 = '${realE164}'`);
    return (rows[0]?.persona_phone as string | undefined) ?? null;
  }

  async getFlaggedNumber(e164: string): Promise<FlaggedNumber | null> {
    if (!E164.test(e164)) return null;
    const rows = await sql(`SELECT * FROM flagged_number WHERE e164 = '${e164}'`);
    const row = rows[0];
    if (!row) return null;
    return {
      e164,
      flag: row.flag as Flag,
      first_seen: Date.parse(row.first_seen as string),
      last_seen: Date.parse(row.last_seen as string),
      hit_count: Number(row.hit_count),
      reason: row.reason as string,
    };
  }

  async countDistinctUsersForCaller(callerE164: string, sinceMs: number): Promise<number> {
    if (!E164.test(callerE164)) return 0;
    const rows = await sql(`SELECT user_id, started_at FROM call_log WHERE caller_e164 = '${callerE164}'`);
    const users = new Set(
      rows.filter((row) => Date.parse(row.started_at as string) >= sinceMs).map((row) => row.user_id as string),
    );
    return users.size;
  }

  async listScamPatterns(): Promise<ScamPattern[]> {
    const rows = await sql("SELECT * FROM scam_pattern");
    return rows.map((row) => ({
      id: row.id as string,
      embedding: row.embedding as number[],
      scam_type: row.scam_type as string,
      source_call_id: row.source_call_id as string,
    }));
  }

  async recordCall(rec: CallRecord): Promise<void> {
    // The Store interface only carries the basics, so the rest is blank until logFullCall() replaces the row.
    await logFullCall({
      ...rec,
      score: 0,
      scam_type: "none",
      transcript: "",
      claims_json: "[]",
      crs_evidence_json: "{}",
      summary: "",
    });
  }

  async upsertFlaggedNumber(e164: string, flag: Flag, reason: string): Promise<void> {
    await call("upsert_flagged_number", [requireE164(e164), flag, reason, new Date().toISOString()]);
  }

  async addScamPattern(p: ScamPattern): Promise<void> {
    await call("add_scam_pattern", [p.id, p.embedding, p.scam_type, p.source_call_id]);
  }
}
