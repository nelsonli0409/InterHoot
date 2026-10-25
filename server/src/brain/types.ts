// Shared types for the brain (B4–B6). These mirror the contracts agreed in Step 0:
// the Gemini output schema (build guide section 6) and the verdict JSON.

export type ScamType =
  | "none"
  | "irs_tax"
  | "debt_collection"
  | "bank_fraud"
  | "grandparent"
  | "tech_support"
  | "prize"
  | "other";

export type ClaimKind = "past_due" | "fraud_on_account" | "owed_tax" | "other";

export type PressureTactic =
  | "urgency"
  | "secrecy"
  | "threat_arrest"
  | "gift_card"
  | "wire"
  | "crypto"
  | "remote_access";

export interface Claim {
  creditor: string;
  amount: number | null; // null when the caller named no amount
  account_type: string;
  claim: ClaimKind;
}

/** One Gemini response, sent after each caller turn (section 6 schema). */
export interface GeminiTurn {
  caller_language: string;
  claimed_identity: string;
  scam_type: ScamType;
  claims: Claim[];
  pressure_tactics: PressureTactic[];
  scam_probability: number; // 0–1
  next_agent_line: string; // in caller_language, short (TTS is billed per character)
  user_summary: string; // in the protected user's language
}

export interface TranscriptTurn {
  speaker: "agent" | "caller";
  text: string;
}

/** A tradeline normalized from the CRS credit report (see normalizeTradeline in verify.ts). */
export interface Tradeline {
  creditor: string;
  accountType: string;
  status: "open" | "closed" | "unknown";
  balance: number | null;
  pastDue: number | null;
}

export type Flag = "green" | "yellow" | "red";

/** The verdict contract handed to Programmer A and logged for Programmer C. */
export interface Verdict {
  flag: Flag;
  score: number;
  reasons: string[];
  call_id: string;
}