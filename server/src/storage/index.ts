// Storage interface shared by B3 (demo_caller_alias lookup) and B6 (repeat, velocity and
// scam_pattern checks). Everything that will live in SpacetimeDB goes through here, so the
// brain doesn't care whether it's talking to Maincloud or to the in-memory stub below.
//
// When Programmer C hands over the generated TypeScript bindings (C1), add a
// SpacetimeStore that implements this same interface and swap it in via getStore().

import type { Flag } from "../brain/types.js";

export interface FlaggedNumber {
  e164: string;
  flag: Flag;
  first_seen: number; // ms epoch
  last_seen: number;
  hit_count: number;
  reason: string;
}

export interface ScamPattern {
  id: string;
  embedding: number[];
  scam_type: string;
  source_call_id: string;
}

export interface CallRecord {
  call_id: string;
  user_id: string;
  caller_e164: string;
  started_at: number; // ms epoch
  flag: Flag;
}

export interface Store {
  // B3
  getPersonaPhone(realE164: string): Promise<string | null>;

  // B6: exact repeat check (flagged_number)
  getFlaggedNumber(e164: string): Promise<FlaggedNumber | null>;
  // B6: velocity check (distinct user_id per caller_e164 in call_log within a window)
  countDistinctUsersForCaller(callerE164: string, sinceMs: number): Promise<number>;
  // B6: script similarity (scam_pattern)
  listScamPatterns(): Promise<ScamPattern[]>;

  // Writes the brain needs after a verdict (C's reducers will back these later)
  recordCall(rec: CallRecord): Promise<void>;
  upsertFlaggedNumber(e164: string, flag: Flag, reason: string): Promise<void>;
  addScamPattern(p: ScamPattern): Promise<void>;
}

/** In-memory stub. Good enough for the B7 text harness and for local dev. */
export class MemoryStore implements Store {
  aliases = new Map<string, string>();
  flagged = new Map<string, FlaggedNumber>();
  calls: CallRecord[] = [];
  patterns: ScamPattern[] = [];

  async getPersonaPhone(realE164: string) {
    return this.aliases.get(realE164) ?? null;
  }
  async getFlaggedNumber(e164: string) {
    return this.flagged.get(e164) ?? null;
  }
  async countDistinctUsersForCaller(callerE164: string, sinceMs: number) {
    const users = new Set(
      this.calls.filter((c) => c.caller_e164 === callerE164 && c.started_at >= sinceMs).map((c) => c.user_id),
    );
    return users.size;
  }
  async listScamPatterns() {
    return this.patterns;
  }
  async recordCall(rec: CallRecord) {
    this.calls.push(rec);
  }
  async upsertFlaggedNumber(e164: string, flag: Flag, reason: string) {
    const now = Date.now();
    const prev = this.flagged.get(e164);
    this.flagged.set(e164, {
      e164,
      flag,
      reason,
      first_seen: prev?.first_seen ?? now,
      last_seen: now,
      hit_count: (prev?.hit_count ?? 0) + 1,
    });
  }
  async addScamPattern(p: ScamPattern) {
    this.patterns.push(p);
  }
}

let store: Store = new MemoryStore();
export const getStore = (): Store => store;
export const setStore = (s: Store): void => {
  store = s;
};