// server/src/crs/crs.ts — CRS sandbox client (task B2)
//
// - TokenManager: logs in once, re-logs in once on a 401, and latches after a
//   failed login so we never hammer /users/login (repeated failed logins
//   silently disable the sandbox account).
// - reverseLookup(personaPhone), fraudFinder(personaBody), getTradelines(userPersona)
// - Tradelines are cached per persona and preloaded at startup.
//
// Response shapes below were confirmed against live sandbox calls in B1
// (server/scripts/out/). Uses Node 20's built-in fetch. No new dependencies.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Disk cache in server/scripts/out/ (gitignored, shared with scripts/crs-smoke.ts).
// It survives `tsx watch` restarts, so saving a file never triggers a new CRS login
// or credit pull. Same relative path from src/crs/ (tsx) and dist/crs/ (built).
const CACHE_DIR = fileURLToPath(new URL("../../scripts/out/", import.meta.url));
const TOKEN_FILE = join(CACHE_DIR, ".crs-token");
const LOGIN_LOCK_FILE = join(CACHE_DIR, ".crs-login-locked");

function readCache(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

function writeCache(file: string, data: string): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, data, { mode: 0o600 });
  } catch (err) {
    console.warn(`[crs] could not write cache ${file}: ${(err as Error).message}`);
  }
}

const BASE_URL = (process.env.CRS_BASE_URL ?? "https://api-sandbox.stitchcredit.com/api").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 10_000;

/** Sandbox persona phones are 5550101001–5550101020. Anything else must never reach CRS. */
const PERSONA_PHONE = /^55501010(0[1-9]|1\d|20)$/;

export class CrsError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message);
    this.name = "CrsError";
  }
}

// ---------------------------------------------------------------------------
// Request and response types (from B1)
// ---------------------------------------------------------------------------

export interface PostalAddress {
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
}

/** TransUnion request body for the protected user (crs-personas.json → tuBody). */
export interface TuBody {
  firstName: string;
  lastName: string;
  ssn: string;
  addresses: (PostalAddress & { borrowerResidencyType: string })[];
}

/** The protected user: a persona id (cache key) plus its TransUnion body. */
export interface UserPersona {
  id: string; // e.g. "P20"
  tuBody: TuBody;
}

/** Fraud Finder request body for a caller persona (crs-personas.json → fraudFinderBody). */
export interface PersonaBody {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  email: string; // required by Fraud Finder
  ipAddress: string;
  address: PostalAddress;
}

/**
 * One tradeline from the TU report (body.tradelines[]). Amounts and counts
 * come back as strings, e.g. "4000". P20's six are all accountStatusType
 * "Paid" with an accountClosedDate.
 */
export interface Tradeline {
  creditorName: string;
  accountIdentifier?: string;
  accountType?: string; // "Revolving" | "Installment"
  loanType?: string; // e.g. "CreditCard"
  businessType?: string; // e.g. "Banking"
  accountStatusType?: string; // e.g. "Paid"
  accountOpenedDate?: string;
  accountClosedDate?: string; // present ⇒ the account is closed
  accountPaidDate?: string;
  lastActivityDate?: string;
  currentBalanceAmount?: string;
  highBalanceAmount?: string;
  pastDueAmount?: string;
  currentRatingType?: string; // e.g. "AsAgreed"
  derogatoryDataIndicator?: boolean;
  [field: string]: unknown;
}

export interface ReverseLookupRecord {
  firstName?: string;
  lastName?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

export interface ReverseLookupResult {
  noRecord: boolean; // P13 (and P04) return no record
  records: ReverseLookupRecord[];
  raw: unknown;
}

export interface FraudFinderResult {
  score: number | null; // risk.score 0–100
  lineType: string | null; // risk.phone.line_type, e.g. "voip" | "mobile"
  carrier: string | null;
  prepaid: boolean | null;
  /** risk.phone.owner first AND last name match the persona. P01 true, P12/P13 false. */
  phoneOwnerMatch: boolean | null;
  raw: unknown;
}

// ---------------------------------------------------------------------------
// 1. Token manager
// ---------------------------------------------------------------------------

export class TokenManager {
  // Reuse the last good token across restarts (a stale one costs one re-login on its first 401).
  private token: string | null = readCache(TOKEN_FILE)?.trim() || null;
  private inFlight: Promise<string> | null = null; // shared by concurrent callers
  // A rejected login is persisted to disk, so restarts can't keep retrying bad credentials.
  private fatal: CrsError | null = existsSync(LOGIN_LOCK_FILE)
    ? new CrsError(
        `CRS logins are locked after a rejected login (${(readCache(LOGIN_LOCK_FILE) ?? "").trim()}). ` +
          "Fix CRS_USERNAME / CRS_PASSWORD, delete server/scripts/out/.crs-login-locked, then restart.",
      )
    : null;

  constructor(
    private readonly username = process.env.CRS_USERNAME,
    private readonly password = process.env.CRS_PASSWORD,
  ) {}

  /** Returns the cached token, logging in only if we have none. */
  async getToken(): Promise<string> {
    if (this.token) return this.token;
    return this.login();
  }

  /**
   * Called when an API request gets a 401. Drops the token (only if it is the
   * one that failed, so parallel 401s trigger a single re-login) and logs in again.
   */
  async refresh(staleToken: string): Promise<string> {
    if (this.token === staleToken) {
      this.token = null;
      writeCache(TOKEN_FILE, ""); // don't reload the dead token on the next restart
    }
    return this.getToken();
  }

  private login(): Promise<string> {
    if (this.fatal) throw this.fatal; // latched: never retry a rejected login
    if (this.inFlight) return this.inFlight; // someone is already logging in

    this.inFlight = (async () => {
      if (!this.username || !this.password) {
        throw this.latch(new CrsError("CRS_USERNAME / CRS_PASSWORD are not set"), false);
      }

      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/users/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: this.username, password: this.password }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // Network error or timeout: the server never judged our credentials,
        // so don't latch. We also don't retry here; the next request will.
        throw new CrsError(`CRS login network error: ${(err as Error).message}`);
      }

      if (!res.ok) {
        // The server rejected the login. Latch so nothing retries it in a loop.
        throw this.latch(
          new CrsError(`CRS login rejected (HTTP ${res.status}); fix credentials, delete server/scripts/out/.crs-login-locked, then restart`, res.status),
        );
      }

      const data = (await res.json().catch(() => null)) as { token?: string } | null;
      if (!data?.token) throw this.latch(new CrsError("CRS login returned no token", res.status, data));

      this.token = data.token;
      writeCache(TOKEN_FILE, data.token);
      return data.token;
    })().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  /** Stop all further logins. persist=true also writes the lock to disk so restarts honor it. */
  private latch(err: CrsError, persist = true): CrsError {
    this.fatal = err;
    if (persist) writeCache(LOGIN_LOCK_FILE, `${new Date().toISOString()} ${err.message}\n`);
    console.error(`[crs] ${err.message} — further logins disabled${persist ? " (lock saved to disk)" : " until restart"}`);
    return err;
  }
}

export const tokens = new TokenManager();

// ---------------------------------------------------------------------------
// 2. Authenticated POST with a single re-login on 401
// ---------------------------------------------------------------------------

async function crsPost<T>(path: string, body: unknown): Promise<{ data: T; requestId: string | null }> {
  const send = (token: string) =>
    fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  let token = await tokens.getToken();
  let res = await send(token);

  if (res.status === 401) {
    token = await tokens.refresh(token); // one re-login…
    res = await send(token); // …and one retry. A second 401 is an error, not a loop.
  }

  const data = (await res.json().catch(() => null)) as T;
  if (!res.ok) {
    // 403 usually means the product role (ROLE_AA / ROLE_ATDATA / ROLE_TU_CR) is off.
    throw new CrsError(`CRS ${path} failed (HTTP ${res.status})`, res.status, data);
  }
  return { data, requestId: res.headers.get("RequestID") ?? res.headers.get("requestid") };
}

function toPersonaPhone(raw: string): string {
  const phone = raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (!PERSONA_PHONE.test(phone)) {
    // Defense in depth behind the alias table: refuse anything that isn't a persona.
    throw new CrsError("Refusing CRS call for non-persona number");
  }
  return phone;
}

// ---------------------------------------------------------------------------
// 3. Reverse phone lookup (AccurateAppend)
// ---------------------------------------------------------------------------

export async function reverseLookup(personaPhone: string): Promise<ReverseLookupResult> {
  const phoneNumber = toPersonaPhone(personaPhone);
  const { data } = await crsPost<{
    success?: boolean;
    message?: string;
    data?: { records?: ReverseLookupRecord[] };
  }>("/accurate-append/reverse", { phoneNumber });

  if (data?.success === false) throw new CrsError(`Reverse lookup failed: ${data.message ?? "unknown"}`, 200, data);

  const records = Array.isArray(data?.data?.records) ? data.data.records : [];
  return { noRecord: records.length === 0, records, raw: data };
}

// ---------------------------------------------------------------------------
// 4. Fraud Finder (AtData)
// ---------------------------------------------------------------------------

interface FraudFinderResponse {
  risk?: {
    score?: number;
    phone?: {
      line_type?: string;
      carrier?: string;
      prepaid?: boolean;
      owner?: { first_name_match?: string; last_name_match?: string };
    };
  };
}

export async function fraudFinder(personaBody: PersonaBody): Promise<FraudFinderResult> {
  toPersonaPhone(personaBody.phoneNumber); // same guard: the body's phone must be a persona's
  const { data } = await crsPost<FraudFinderResponse>("/fraud-finder/fraud-finder", personaBody);

  const risk = data?.risk;
  const phone = risk?.phone;
  const owner = phone?.owner;
  return {
    score: typeof risk?.score === "number" ? risk.score : null,
    lineType: phone?.line_type ?? null,
    carrier: phone?.carrier ?? null,
    prepaid: typeof phone?.prepaid === "boolean" ? phone.prepaid : null,
    phoneOwnerMatch: owner ? owner.first_name_match === "match" && owner.last_name_match === "match" : null,
    raw: data,
  };
}

// ---------------------------------------------------------------------------
// 5. Tradelines (TransUnion soft pull), cached
// ---------------------------------------------------------------------------

const tradelineCache = new Map<string, Promise<Tradeline[]>>();

export function getTradelines(userPersona: UserPersona): Promise<Tradeline[]> {
  const cached = tradelineCache.get(userPersona.id);
  if (cached) return cached;

  // The sandbox file never changes, so a saved copy is as good as a fresh pull.
  // Set CRS_REFRESH_TRADELINES=true to force one live pull (it then re-saves the copy).
  const fromDisk = process.env.CRS_REFRESH_TRADELINES === "true" ? null : readTradelinesFromDisk(userPersona.id);
  if (fromDisk) {
    const ready = Promise.resolve(fromDisk);
    tradelineCache.set(userPersona.id, ready);
    return ready;
  }

  const pending = pullTradelines(userPersona);
  tradelineCache.set(userPersona.id, pending);
  // Don't cache a failure forever; a later call can try again.
  pending.catch(() => tradelineCache.delete(userPersona.id));
  return pending;
}

/** Call once at server startup so the first phone call doesn't wait on a credit pull. */
export async function preloadTradelines(userPersona: UserPersona): Promise<void> {
  try {
    const lines = await getTradelines(userPersona);
    console.log(`[crs] cached ${lines.length} tradelines for ${userPersona.id}`);
  } catch (err) {
    console.error(`[crs] tradeline preload failed for ${userPersona.id}:`, (err as Error).message);
  }
}

const tradelineFile = (id: string) => join(CACHE_DIR, `tradelines-${id}.json`);

/** Saved tradelines: our own cache file, else B1's raw report from scripts/crs-smoke.ts. */
function readTradelinesFromDisk(id: string): Tradeline[] | null {
  try {
    const own = readCache(tradelineFile(id));
    if (own) {
      const lines = JSON.parse(own);
      if (Array.isArray(lines)) return lines;
    }
    const b1 = readCache(join(CACHE_DIR, `${id.toLowerCase()}-tu-report.response.json`));
    if (b1) {
      const body = JSON.parse(b1)?.body;
      const errors = body?.errorMessages;
      if (Array.isArray(body?.tradelines) && !(Array.isArray(errors) && errors.length > 0)) return body.tradelines;
    }
  } catch (err) {
    console.warn(`[crs] ignoring unreadable tradeline cache for ${id}: ${(err as Error).message}`);
  }
  return null;
}

async function pullTradelines(userPersona: UserPersona): Promise<Tradeline[]> {
  const { data, requestId } = await crsPost<{ errorMessages?: unknown; tradelines?: Tradeline[] }>(
    "/transunion/credit-report/standard/tu-prequal-fico9",
    userPersona.tuBody,
  );

  // Credit-report errors come back as HTTP 200, so check errorMessages first.
  const errors = data?.errorMessages;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new CrsError(`Credit report error (RequestID ${requestId}): ${JSON.stringify(errors)}`, 200, data);
  }

  // Confirmed in B1: the array sits at the top level of the response body.
  if (!Array.isArray(data?.tradelines)) {
    throw new CrsError(`No tradelines array in credit report (RequestID ${requestId})`, 200, data);
  }
  writeCache(tradelineFile(userPersona.id), JSON.stringify(data.tradelines, null, 2));
  return data.tradelines;
}
