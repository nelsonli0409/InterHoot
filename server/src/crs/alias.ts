// server/src/crs/alias.ts — demo_caller_alias storage (task B3)
//
// Maps a real caller ID (E.164) to a sandbox persona phone (10 digits).
// Callers go through the AliasStore interface, so the in-memory map can be
// swapped for C's SpacetimeDB bindings without touching anything else.

export interface AliasStore {
  /** Persona phone (e.g. "5550101013") for a real E.164 number, or null if none. */
  getAlias(e164: string): Promise<string | null>;
}

/** Normalize to +1XXXXXXXXXX so "+1 (415) 555-0000" and "4155550000" match. */
export function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.startsWith("+") ? `+${digits}` : raw;
}

export class InMemoryAliasStore implements AliasStore {
  private readonly map = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [real, persona] of Object.entries(seed)) this.map.set(toE164(real), persona);
  }

  async getAlias(e164: string): Promise<string | null> {
    return this.map.get(toE164(e164)) ?? null;
  }
}

// Persona phones from the CRS sandbox.
export const PERSONA_PHONES = {
  P13_KAYLA_BRENNAN: "5550101013", // "scammer": risk 88, VoIP, prepaid, no reverse-lookup record
  P01: "5550101001", // "dentist": clean caller
} as const;

// Teammates' real numbers stay in .env (gitignored), never in source.
function seedFromEnv(): Record<string, string> {
  const seed: Record<string, string> = {};
  if (process.env.DEMO_SCAMMER_PHONE) seed[process.env.DEMO_SCAMMER_PHONE] = PERSONA_PHONES.P13_KAYLA_BRENNAN;
  if (process.env.DEMO_DENTIST_PHONE) seed[process.env.DEMO_DENTIST_PHONE] = PERSONA_PHONES.P01;
  return seed;
}

/** The active store. Swap this one line for a SpacetimeDB-backed store later. */
export let aliasStore: AliasStore = new InMemoryAliasStore(seedFromEnv());

export function setAliasStore(store: AliasStore): void {
  aliasStore = store;
}

/*
 * Later, once C hands over the generated bindings (shape is a guess until then):
 *
 * export class SpacetimeAliasStore implements AliasStore {
 *   constructor(private readonly conn: DbConnection) {}
 *   async getAlias(e164: string) {
 *     const row = this.conn.db.demoCallerAlias.realE164.find(toE164(e164));
 *     return row?.personaPhone ?? null;
 *   }
 * }
 * setAliasStore(new SpacetimeAliasStore(conn));
 */