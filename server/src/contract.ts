// Shared contract between Programmer A (call pipeline), B (brain + CRS) and C (data + iOS).
// Source: build guide sections 3.3 (tables), 3.4 (Gemini schema) and the verdict JSON from Step 0 item 4.
// Types only, no runtime code. Change a shape here first, then tell the other two.

export type Flag = "green" | "yellow" | "red";

export type ScamType =
  | "none"
  | "irs_tax"
  | "debt_collection"
  | "bank_fraud"
  | "grandparent"
  | "tech_support"
  | "prize"
  | "other";

export type PressureTactic =
  | "urgency"
  | "secrecy"
  | "threat_arrest"
  | "gift_card"
  | "wire"
  | "crypto"
  | "remote_access";

export type ClaimKind = "past_due" | "fraud_on_account" | "owed_tax" | "other";

export interface Claim {
  creditor: string;
  amount: number;
  account_type: string;
  claim: ClaimKind;
}

// Gemini structured output (guide 3.4). B returns this to A after each caller turn.
export interface GeminiTurnResult {
  caller_language: string;
  claimed_identity: string;
  scam_type: ScamType;
  claims: Claim[];
  pressure_tactics: PressureTactic[];
  scam_probability: number; // 0 to 1
  next_agent_line: string; // in caller_language
  user_summary: string; // in the protected user's language
}

// Final answer from B to A at the end of a call, and what C stores (guide Step 0 item 4).
export interface Verdict {
  flag: Flag;
  score: number; // 0 to 1, see the scoring rule in guide section 8
  reasons: string[];
  call_id: string;
}

// SpacetimeDB tables (guide section 5). Field names match the guide; ids and timestamps are strings.
export interface ProtectedUser {
  id: string;
  display_name: string;
  language: string;
  crs_persona_id: string;
  real_phone_e164: string;
  apns_token: string;
}

export interface CallLog {
  id: string;
  user_id: string;
  caller_e164: string;
  started_at: string;
  flag: Flag;
  score: number;
  scam_type: ScamType;
  transcript: string;
  claims_json: string; // JSON of Claim[]
  crs_evidence_json: string;
  summary: string;
}

export interface FlaggedNumber {
  e164: string; // primary key
  flag: Flag;
  first_seen: string;
  last_seen: string;
  hit_count: number;
  reason: string; // seeded numbers (build guide C9) use the source name here and flag "yellow"
}

export interface ScamPattern {
  id: string;
  embedding: number[]; // gemini-embedding-2, 768 dimensions
  scam_type: ScamType;
  source_call_id: string;
}

export interface DemoCallerAlias {
  real_e164: string;
  persona_phone: string; // CRS persona number, so no real number reaches CRS
}
