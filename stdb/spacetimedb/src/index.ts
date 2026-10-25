// InterHoot SpacetimeDB module (build guide C1).
// Tables mirror server/src/contract.ts. Ids and timestamps are strings, as in the contract;
// callers pass timestamps as ISO 8601 strings. SpacetimeDB stores `e164` columns as `e_164`;
// SQL accepts both spellings, and the generated TypeScript bindings use camelCase accessors.
import { schema, table, t, SenderError } from 'spacetimedb/server';

const protectedUser = table(
  { name: 'protected_user', public: true },
  {
    id: t.string().primaryKey(),
    display_name: t.string(),
    language: t.string(),
    crs_persona_id: t.string(),
    real_phone_e164: t.string(),
    apns_token: t.string(),
  }
);

const callLog = table(
  { name: 'call_log', public: true },
  {
    id: t.string().primaryKey(), // the Twilio CallSid, also the verdict's call_id
    user_id: t.string().index('btree'),
    caller_e164: t.string().index('btree'),
    started_at: t.string(),
    flag: t.string(),
    score: t.f64(),
    scam_type: t.string(),
    transcript: t.string(),
    claims_json: t.string(),
    crs_evidence_json: t.string(),
    summary: t.string(),
  }
);

const flaggedNumber = table(
  { name: 'flagged_number', public: true },
  {
    e164: t.string().primaryKey(),
    flag: t.string(),
    first_seen: t.string(),
    last_seen: t.string(),
    hit_count: t.u32(),
    reason: t.string(),
  }
);

const scamPattern = table(
  { name: 'scam_pattern', public: true },
  {
    id: t.string().primaryKey(),
    embedding: t.array(t.f64()), // gemini-embedding-2, 768 dimensions
    scam_type: t.string(),
    source_call_id: t.string(),
  }
);

const demoCallerAlias = table(
  { name: 'demo_caller_alias', public: true },
  {
    real_e164: t.string().primaryKey(),
    persona_phone: t.string(),
  }
);

const spacetimedb = schema({ protectedUser, callLog, flaggedNumber, scamPattern, demoCallerAlias });
export default spacetimedb;

const FLAGS = ['green', 'yellow', 'red'];
const SCAM_TYPES = ['none', 'irs_tax', 'debt_collection', 'bank_fraud', 'grandparent', 'tech_support', 'prize', 'other'];
const E164 = /^\+[1-9]\d{6,14}$/;

function requireFlag(flag: string) {
  if (!FLAGS.includes(flag)) throw new SenderError(`flag must be green, yellow or red, got "${flag}"`);
}

function requireE164(phone: string) {
  if (!E164.test(phone)) throw new SenderError(`not an E.164 number: "${phone}"`);
}

// Written by the server at the end of each call. Calling it again with the same id replaces the row.
export const log_call = spacetimedb.reducer(
  {
    id: t.string(),
    user_id: t.string(),
    caller_e164: t.string(),
    started_at: t.string(),
    flag: t.string(),
    score: t.f64(),
    scam_type: t.string(),
    transcript: t.string(),
    claims_json: t.string(),
    crs_evidence_json: t.string(),
    summary: t.string(),
  },
  (ctx, row) => {
    requireFlag(row.flag);
    requireE164(row.caller_e164);
    if (!SCAM_TYPES.includes(row.scam_type)) throw new SenderError(`unknown scam_type "${row.scam_type}"`);
    if (row.score < 0 || row.score > 1) throw new SenderError('score must be between 0 and 1');
    if (ctx.db.callLog.id.find(row.id)) ctx.db.callLog.id.update(row);
    else ctx.db.callLog.insert(row);
  }
);

// Adds a number or refreshes it: sets the flag and reason, bumps hit_count and last_seen.
export const upsert_flagged_number = spacetimedb.reducer(
  { e164: t.string(), flag: t.string(), reason: t.string(), seen_at: t.string() },
  (ctx, { e164, flag, reason, seen_at }) => {
    requireE164(e164);
    requireFlag(flag);
    const existing = ctx.db.flaggedNumber.e164.find(e164);
    if (existing) {
      ctx.db.flaggedNumber.e164.update({
        ...existing,
        flag,
        reason,
        last_seen: seen_at,
        hit_count: existing.hit_count + 1,
      });
    } else {
      ctx.db.flaggedNumber.insert({ e164, flag, reason, first_seen: seen_at, last_seen: seen_at, hit_count: 1 });
    }
  }
);

// Creates or edits the protected user's settings. Keeps an APNs token that was already registered.
export const set_user_prefs = spacetimedb.reducer(
  {
    id: t.string(),
    display_name: t.string(),
    language: t.string(),
    crs_persona_id: t.string(),
    real_phone_e164: t.string(),
  },
  (ctx, prefs) => {
    requireE164(prefs.real_phone_e164);
    const existing = ctx.db.protectedUser.id.find(prefs.id);
    if (existing) ctx.db.protectedUser.id.update({ ...existing, ...prefs });
    else ctx.db.protectedUser.insert({ ...prefs, apns_token: '' });
  }
);

export const register_apns_token = spacetimedb.reducer(
  { user_id: t.string(), apns_token: t.string() },
  (ctx, { user_id, apns_token }) => {
    const user = ctx.db.protectedUser.id.find(user_id);
    if (!user) throw new SenderError(`no protected_user with id "${user_id}"; call set_user_prefs first`);
    ctx.db.protectedUser.id.update({ ...user, apns_token });
  }
);

// Empties the blocked-number list (test cleanup). Leaves call_log and protected_user alone.
export const clear_flagged_numbers = spacetimedb.reducer({}, (ctx) => {
  const rows = Array.from(ctx.db.flaggedNumber.iter());
  for (const row of rows) ctx.db.flaggedNumber.delete(row);
});

// The "Not a scam" button: the number stays on record but goes green, so it is no longer blocked.
export const mark_false_positive = spacetimedb.reducer(
  { e164: t.string() },
  (ctx, { e164 }) => {
    const existing = ctx.db.flaggedNumber.e164.find(e164);
    if (!existing) throw new SenderError(`${e164} is not in flagged_number`);
    ctx.db.flaggedNumber.e164.update({ ...existing, flag: 'green', reason: 'user marked not a scam' });
  }
);

// Not in the guide's reducer list: needed to store an embedding for every red call (guide section 8).
export const add_scam_pattern = spacetimedb.reducer(
  { id: t.string(), embedding: t.array(t.f64()), scam_type: t.string(), source_call_id: t.string() },
  (ctx, row) => {
    if (!SCAM_TYPES.includes(row.scam_type)) throw new SenderError(`unknown scam_type "${row.scam_type}"`);
    if (ctx.db.scamPattern.id.find(row.id)) ctx.db.scamPattern.id.update(row);
    else ctx.db.scamPattern.insert(row);
  }
);

// Not in the guide's reducer list: maps a real demo phone to a CRS persona phone, so no real number reaches CRS.
export const set_demo_caller_alias = spacetimedb.reducer(
  { real_e164: t.string(), persona_phone: t.string() },
  (ctx, row) => {
    requireE164(row.real_e164);
    if (ctx.db.demoCallerAlias.real_e164.find(row.real_e164)) ctx.db.demoCallerAlias.real_e164.update(row);
    else ctx.db.demoCallerAlias.insert(row);
  }
);
