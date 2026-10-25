// B5: compare the caller's claims[] (from Gemini) with the protected user's tradelines
// (P20 DOLORES WHITCOMB in the demo) and explain the result in plain English.
//
// Matching: fuzzy creditor name, open vs closed status, and a balance tolerance.

import type { Claim, Tradeline } from "./types.js";

export interface VerifyResult {
  crs_contradiction: boolean;
  evidence: string[]; // shown in the app's call detail screen
}

// Balance tolerance: a claimed amount within max($50, 15%) of the file counts as matching.
const ABS_TOLERANCE = 50;
const REL_TOLERANCE = 0.15;

// Common ways callers and credit files spell the same creditor.
const CREDITOR_ALIASES: Record<string, string[]> = {
  chase: ["jpmcb", "jpmorgan", "jp morgan", "chase bank", "chase card"],
  "capital one": ["cap one", "capone", "capital 1"],
  "bank of america": ["bofa", "boa", "bk of amer", "bank amer"],
  "wells fargo": ["wf", "wfbna", "wells"],
  citibank: ["citi", "cbna", "citicards"],
  "american express": ["amex", "amer exp"],
  discover: ["discover bank", "dfs"],
  synchrony: ["syncb", "synchrony bank"],
};

const STOP_WORDS = new Set(["bank", "na", "n", "a", "usa", "card", "cards", "services", "financial", "inc", "corp", "co", "the", "of", "credit"]);

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function canonical(name: string): string {
  const n = normalize(name);
  for (const [canon, aliases] of Object.entries(CREDITOR_ALIASES)) {
    if (n === canon || n.includes(canon) || aliases.some((a) => n === a || n.includes(a))) return canon;
  }
  return n;
}

function tokens(name: string): Set<string> {
  return new Set(normalize(name).split(" ").filter((t) => t && !STOP_WORDS.has(t)));
}

/** True when two creditor names plausibly refer to the same company. */
export function creditorMatches(claimed: string, onFile: string): boolean {
  if (!claimed.trim() || !onFile.trim()) return false;
  const a = canonical(claimed);
  const b = canonical(onFile);
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = tokens(claimed);
  const tb = tokens(onFile);
  for (const t of ta) if (t.length >= 3 && tb.has(t)) return true;
  return false;
}

function withinTolerance(claimed: number, actual: number): boolean {
  return Math.abs(claimed - actual) <= Math.max(ABS_TOLERANCE, REL_TOLERANCE * Math.abs(actual));
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function describeClaim(c: Claim): string {
  const what = c.account_type ? `${c.creditor} ${c.account_type}`.trim() : c.creditor || "account";
  const amt = c.amount != null ? ` of ${usd(c.amount)}` : "";
  switch (c.claim) {
    case "past_due":
      return `a past-due ${what}${amt}`;
    case "fraud_on_account":
      return `fraud on a ${what}`;
    case "owed_tax":
      return `an unpaid tax bill${amt}`;
    default:
      return `an issue with a ${what}${amt}`;
  }
}

/** Check one claim. Returns whether it contradicts the file and an evidence sentence. */
function checkClaim(c: Claim, tradelines: Tradeline[]): { contradiction: boolean; evidence: string } {
  const lead = `Caller claimed ${describeClaim(c)}.`;

  if (c.claim === "owed_tax") {
    return { contradiction: false, evidence: `${lead} Tax debts aren't on a credit file, so the file can't confirm or deny it.` };
  }
  if (!c.creditor.trim()) {
    return { contradiction: false, evidence: `${lead} The caller didn't name a creditor, so there's nothing to check.` };
  }

  const matches = tradelines.filter((t) => creditorMatches(c.creditor, t.creditor));
  const name = c.creditor;

  if (matches.length === 0) {
    // A named debt or account that simply doesn't exist on the file.
    if (c.claim === "past_due" || c.claim === "fraud_on_account") {
      return { contradiction: true, evidence: `${lead} No ${name} account is on file.` };
    }
    return { contradiction: false, evidence: `${lead} No ${name} account is on file.` };
  }

  const open = matches.filter((t) => t.status !== "closed");
  if (open.length === 0) {
    const yes = c.claim === "past_due" || c.claim === "fraud_on_account";
    return { contradiction: yes, evidence: `${lead} The only ${name} account on file is closed.` };
  }

  if (c.claim === "past_due") {
    const pastDue = open.map((t) => t.pastDue ?? 0);
    const anyPastDue = pastDue.some((p) => p > 0);
    if (!anyPastDue) {
      return { contradiction: true, evidence: `${lead} The open ${name} account on file shows nothing past due.` };
    }
    if (c.amount != null) {
      const amounts = open.flatMap((t) => [t.pastDue, t.balance]).filter((x): x is number => x != null && x > 0);
      if (!amounts.some((a) => withinTolerance(c.amount!, a))) {
        const shown = Math.max(...pastDue);
        return {
          contradiction: true,
          evidence: `${lead} The file shows ${usd(shown)} past due on ${name}, which doesn't match.`,
        };
      }
    }
    return { contradiction: false, evidence: `${lead} The file does show a past-due ${name} account.` };
  }

  return { contradiction: false, evidence: `${lead} An open ${name} account is on file, so the claim is possible.` };
}

/** B5 entry point. */
export function verifyClaims(claims: Claim[], tradelines: Tradeline[]): VerifyResult {
  if (claims.length === 0) return { crs_contradiction: false, evidence: [] };
  const results = claims.map((c) => checkClaim(c, tradelines));
  return {
    crs_contradiction: results.some((r) => r.contradiction),
    evidence: results.map((r) => r.evidence),
  };
}

// ---------------------------------------------------------------------------
// Tradeline normalization. P20's real report shape is still unverified (step B1),
// so this reads the field names CRS/TransUnion files commonly use and falls back
// gracefully. Once B1's saved JSON is in hand, tighten these picks to the real keys.

function pick(obj: any, keys: string[]): any {
  for (const k of keys) {
    const v = k.split(".").reduce((o, part) => (o == null ? undefined : o[part]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function normalizeTradeline(raw: any): Tradeline {
  const creditor = String(pick(raw, ["creditorName", "creditor", "subscriberName", "subscriber.name", "memberName", "name"]) ?? "");
  const accountType = String(pick(raw, ["loanType", "accountType", "accountTypeDescription", "portfolioType", "type"]) ?? "");
  const statusRaw = String(pick(raw, ["accountStatusType", "accountStatus", "status", "accountCondition", "openClosed"]) ?? "").toLowerCase();
  const closedDate = pick(raw, ["accountClosedDate", "dateClosed", "closedDate"]);
  let status: Tradeline["status"] = "unknown";
  if (closedDate || /closed|paid|transferred|inactive|^c$/.test(statusRaw)) status = "closed";
  else if (/open|current|active|^o$/.test(statusRaw)) status = "open";
  return {
    creditor,
    accountType,
    status,
    balance: toNumber(pick(raw, ["currentBalanceAmount", "currentBalance", "balance", "balanceAmount"])),
    pastDue: toNumber(pick(raw, ["pastDueAmount", "pastDue", "amountPastDue"])),
  };
}