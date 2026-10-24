/**
 * B1 throwaway: one CRS login, P20 TransUnion pull, tradeline shape check,
 * reverse lookup + Fraud Finder for P13 / P12 / P01, then a team report.
 *
 * Run from /server:
 *   npx tsx --env-file=.env scripts/crs-smoke.ts
 *
 * Needs CRS_USERNAME / CRS_PASSWORD in .env, and scripts/crs-personas.json
 * (copy crs-personas.example.json and paste the bodies from the CRS MCP
 * get_test_data tool). Outputs land in scripts/out/ — gitignore that folder.
 *
 * Safety rails:
 *  - Logs in AT MOST once per run and never retries a failed login
 *    (repeated failed logins silently disable the account).
 *  - Reuses a cached token from out/.crs-token if present; on 401 it deletes
 *    the cache and stops instead of re-logging in.
 *  - Refuses to send any body containing a phone number that isn't a sandbox
 *    persona phone (55501010NN), so real data can't reach the real vendor.
 */

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const TOKEN_FILE = join(OUT, ".crs-token");
const PERSONAS_FILE = join(HERE, "crs-personas.json");

const BASE = (process.env.CRS_BASE_URL ?? "https://api-sandbox.stitchcredit.com/api").replace(/\/$/, "");
const EP = {
  login: "/users/login",
  tu: "/transunion/credit-report/standard/tu-prequal-fico9",
  reverse: "/accurate-append/reverse",
  fraud: "/fraud-finder/fraud-finder",
};

// What the build guide says we should see. The report compares against these.
const EXPECT: Record<string, { reverse: string; fraud: string }> = {
  P13: { reverse: "no record", fraud: "risk ~88, VoIP, prepaid" },
  P12: { reverse: "different person (RAJESH MENON)", fraud: "(not stated)" },
  P01: { reverse: "(not stated; benign 'dentist' persona)", fraud: "(not stated; expect low)" },
};
const CALLERS = ["P13", "P12", "P01"] as const;

type Json = any;
type Persona = { phone?: string; tuBody?: Json; fraudFinderBody?: Json };

const personaPhone = (id: string) => `55501010${id.slice(1).padStart(2, "0")}`;
const isPersonaPhone = (p: string) => {
  const d = p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const m = /^55501010(\d\d)$/.exec(d);
  return !!m && +m[1] >= 1 && +m[1] <= 20;
};

// ---------- helpers ----------
function walk(node: Json, visit: (key: string, value: Json, path: string) => void, path = "$") {
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const p = Array.isArray(node) ? `${path}[${k}]` : `${path}.${k}`;
      visit(k, v, p);
      walk(v, visit, p);
    }
  }
}

function assertPersonaOnly(label: string, body: Json) {
  const bad: string[] = [];
  walk(body, (k, v, p) => {
    if (/phone/i.test(k) && (typeof v === "string" || typeof v === "number") && String(v).trim()) {
      if (!isPersonaPhone(String(v))) bad.push(`${p}=${v}`);
    }
  });
  if (bad.length) throw new Error(`${label}: non-persona phone(s) in body, refusing to send: ${bad.join(", ")}`);
}

/** CRS returns errors as HTTP 200, so look for any non-empty errorMessages anywhere. */
function findErrorMessages(body: Json): string[] {
  const found: string[] = [];
  walk(body, (k, v) => {
    if (/^errorMessages?$/i.test(k) && v != null && !(Array.isArray(v) && v.length === 0) && v !== "") {
      found.push(typeof v === "string" ? v : JSON.stringify(v));
    }
  });
  return found;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

async function save(name: string, data: unknown) {
  await writeFile(join(OUT, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

class AuthExpired extends Error {}

async function post(token: string | null, label: string, path: string, body: Json) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  const requestId =
    res.headers.get("RequestID") ?? res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? null;

  // Keep exactly what we sent and got, per the guide.
  await save(`${slug(label)}.request.json`, body);
  await save(`${slug(label)}.response.json`, { status: res.status, requestId, body: json });

  if (res.status === 401 && token) throw new AuthExpired(`${label}: 401`);
  return { status: res.status, requestId, json, errors: findErrorMessages(json) };
}

// ---------- login (once, never retried) ----------
async function getToken(): Promise<string> {
  if (existsSync(TOKEN_FILE)) {
    const t = (await readFile(TOKEN_FILE, "utf8")).trim();
    if (t) { console.log("• Reusing cached CRS token (no login)."); return t; }
  }
  const { CRS_USERNAME: username, CRS_PASSWORD: password } = process.env;
  if (!username || !password) throw new Error("CRS_USERNAME / CRS_PASSWORD missing from env. Not attempting login.");

  console.log("• Logging in to CRS (single attempt)…");
  const res = await fetch(BASE + EP.login, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  let json: Json = {};
  try { json = JSON.parse(text); } catch {}
  const token = json?.token ?? json?.accessToken ?? json?.data?.token;
  if (!res.ok || !token) {
    throw new Error(
      `Login failed (HTTP ${res.status}). NOT retrying — repeated failures disable the account. ` +
      `Check credentials with the CRS booth before running again. Body: ${text.slice(0, 300)}`,
    );
  }
  await writeFile(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

// ---------- tradeline shape ----------
const pick = (o: Json, re: RegExp) => {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (re.test(k) && v != null && v !== "" && typeof v !== "object") return { key: k, value: v };
    if (re.test(k) && v && typeof v === "object") {
      const inner = Object.values(v).find((x) => typeof x === "string" && x);
      if (inner) return { key: `${k}.*`, value: inner };
    }
  }
  return null;
};

function inspectTradelines(report: Json) {
  let arrPath = ""; let tradelines: Json[] = [];
  walk(report, (k, v, p) => {
    if (!tradelines.length && /trade ?lines?/i.test(k) && Array.isArray(v) && v.length) { tradelines = v; arrPath = p; }
  });
  const rows = tradelines.map((t) => ({
    creditor: pick(t, /creditor|subscriber|member.?name|lender|company|^name$/i),
    status: pick(t, /status|condition|open.?closed|account.?rating|closed/i),
    dateClosed: pick(t, /date.?closed|closed.?date/i),
    balance: pick(t, /^balance|current.?balance|balance.?amount/i),
    pastDue: pick(t, /past.?due/i),
    type: pick(t, /account.?type|portfolio|loan.?type|industry/i),
  }));
  const keys = [...new Set(tradelines.flatMap((t) => Object.keys(t ?? {})))].sort();
  const allNamed = rows.length > 0 && rows.every((r) => r.creditor);
  const allStatus = rows.length > 0 && rows.every((r) => r.status || r.dateClosed);
  return { arrPath, count: tradelines.length, keys, rows, ok: allNamed && allStatus, allNamed, allStatus };
}

// ---------- reverse / fraud summaries ----------
function summarizeReverse(json: Json) {
  const names: string[] = [];
  walk(json, (k, v, _p) => {
    if (/^(full.?name|name)$/i.test(k) && typeof v === "string") names.push(v);
    if (/first.?name/i.test(k) && typeof v === "string") names.push(v);
  });
  const empty = !names.length;
  return empty ? "no record (no name in response)" : [...new Set(names)].slice(0, 3).join(" / ");
}

function summarizeFraud(json: Json) {
  const get = (re: RegExp) => { let out: Json; walk(json, (k, v) => { if (out === undefined && re.test(k) && typeof v !== "object") out = v; }); return out; };
  const score = get(/^score$/i);
  const parts = [
    score !== undefined ? `risk ${score}` : "risk score not found",
    get(/line.?type/i), get(/carrier/i),
    (() => { const p = get(/prepaid/i); return p === undefined ? undefined : `prepaid=${p}`; })(),
    (() => { const m = get(/owner.?match|name.?match/i); return m === undefined ? undefined : `ownerMatch=${m}`; })(),
  ].filter((x) => x !== undefined && x !== "");
  return { score: typeof score === "number" ? score : Number(score), text: parts.join(", ") };
}

// ---------- main ----------
async function main() {
  await mkdir(OUT, { recursive: true });
  if (!existsSync(PERSONAS_FILE)) {
    throw new Error(`Missing ${PERSONAS_FILE}. Copy crs-personas.example.json and paste the persona bodies from get_test_data.`);
  }
  const personas: Record<string, Persona> = JSON.parse(await readFile(PERSONAS_FILE, "utf8"));
  const lines: string[] = [];
  const problems: string[] = [];
  const log = (s = "") => { console.log(s); lines.push(s); };

  // Validate everything before spending the login.
  if (JSON.stringify(personas).includes('"_paste"')) {
    throw new Error("crs-personas.json still has _paste placeholders. Fill in the real persona bodies from get_test_data first.");
  }
  const p20 = personas.P20?.tuBody;
  if (!p20) throw new Error("crs-personas.json: P20.tuBody is missing.");
  assertPersonaOnly("P20 TU body", p20);
  for (const id of CALLERS) {
    const ph = personas[id]?.phone ?? personaPhone(id);
    if (!isPersonaPhone(ph)) throw new Error(`${id} phone ${ph} is not a persona phone.`);
    if (personas[id]?.fraudFinderBody) assertPersonaOnly(`${id} Fraud Finder body`, personas[id].fraudFinderBody);
  }

  let token = await getToken();

  try {
    log(`# CRS B1 check — ${new Date().toISOString()}`);
    log(`Base: ${BASE}`);
    log();

    // 1. P20 TransUnion
    log("## P20 TransUnion (tu-prequal-fico9)");
    const tu = await post(token, "p20-tu-report", EP.tu, p20);
    log(`HTTP ${tu.status} · RequestID ${tu.requestId ?? "(none)"}`);
    if (tu.errors.length) {
      log(`❌ errorMessages present (despite HTTP ${tu.status}):`);
      tu.errors.forEach((e) => log(`  - ${e}`));
      problems.push("P20 TU report returned errorMessages");
    } else if (tu.status >= 400) {
      log(`❌ HTTP ${tu.status}${tu.status === 403 ? " — product role may be off (ask CRS booth)" : ""}`);
      problems.push(`P20 TU report HTTP ${tu.status}`);
    } else {
      log("✅ No errorMessages.");
      const tl = inspectTradelines(tu.json);
      log(`Tradelines: ${tl.count} at \`${tl.arrPath || "(not found)"}\``);
      if (tl.count) {
        log(`Fields seen: ${tl.keys.join(", ")}`);
        log();
        log("| # | creditor | status / closed | balance | past due | type |");
        log("|---|---|---|---|---|---|");
        tl.rows.forEach((r, i) => {
          const f = (x: { key: string; value: Json } | null) => (x ? `${x.value} (\`${x.key}\`)` : "—");
          log(`| ${i + 1} | ${f(r.creditor)} | ${f(r.status)}${r.dateClosed ? ` · closed ${r.dateClosed.value}` : ""} | ${f(r.balance)} | ${f(r.pastDue)} | ${f(r.type)} |`);
        });
        log();
      }
      if (tl.ok) log("✅ Shape OK: every tradeline has a creditor name and a status/closed indicator — verify.ts can match on these.");
      else {
        log(`⚠️ Shape NOT confirmed: creditor names on all=${tl.allNamed}, status on all=${tl.allStatus}. Check out/p20-tu-report.response.json by hand.`);
        problems.push("P20 tradeline shape not confirmed");
      }
    }
    log();

    // 2. Callers
    log("## Caller personas");
    log("| Persona | Phone | Reverse lookup | Expected | Fraud Finder | Expected |");
    log("|---|---|---|---|---|---|");
    for (const id of CALLERS) {
      const phone = (personas[id]?.phone ?? personaPhone(id)).replace(/\D/g, "").slice(-10);

      const rev = await post(token, `${id}-reverse`, EP.reverse, { phoneNumber: phone });
      let revText = rev.errors.length ? `❌ errors: ${rev.errors.join("; ")}` : rev.status >= 400 ? `❌ HTTP ${rev.status}` : summarizeReverse(rev.json);
      if (rev.errors.length || rev.status >= 400) problems.push(`${id} reverse lookup failed`);

      let ffText = "skipped (no fraudFinderBody)";
      const ffBody = personas[id]?.fraudFinderBody;
      if (ffBody) {
        const ff = await post(token, `${id}-fraud-finder`, EP.fraud, ffBody);
        if (ff.errors.length) { ffText = `❌ errors: ${ff.errors.join("; ")}`; problems.push(`${id} Fraud Finder errors`); }
        else if (ff.status >= 400) { ffText = `❌ HTTP ${ff.status}`; problems.push(`${id} Fraud Finder HTTP ${ff.status}`); }
        else ffText = summarizeFraud(ff.json).text;
      } else problems.push(`${id} Fraud Finder skipped`);

      log(`| ${id} | ${phone} | ${revText} | ${EXPECT[id].reverse} | ${ffText} | ${EXPECT[id].fraud} |`);
    }
    log();

    log("## Summary");
    if (problems.length) problems.forEach((p) => log(`- ⚠️ ${p}`));
    else log("- ✅ All calls clean. Endpoints, auth and P20 tradeline shape confirmed for crs.ts / verify.ts.");
    log();
    log("Raw requests/responses (with RequestIDs) are in `server/scripts/out/`.");
  } catch (e) {
    if (e instanceof AuthExpired) {
      await rm(TOKEN_FILE, { force: true });
      throw new Error(`${e.message}. Cached token cleared — rerun once to log in fresh. Not re-logging in automatically.`);
    }
    throw e;
  } finally {
    if (lines.length) await save("crs-b1-report.md", lines.join("\n") + "\n");
  }

  console.log(`\nReport for the team: ${join(OUT, "crs-b1-report.md")}`);
}

main().catch((e) => {
  console.error(`\n✖ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});