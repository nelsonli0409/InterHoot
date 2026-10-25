// server/src/crs/callerCheck.ts — the only entry point the brain uses for caller CRS checks.
//
// Rule: if the caller has no alias, CRS is skipped entirely. A real phone
// number can never reach reverseLookup or fraudFinder from here.

import { aliasStore } from "./alias.js";
import { reverseLookup, fraudFinder, type PersonaBody, type ReverseLookupResult, type FraudFinderResult } from "./crs.js";
import { callerBodies } from "./personas.js";

/** Ready-made inputs for score.ts (B6). null = that call failed. */
export interface CallerSignals {
  reverseNoRecord: boolean | null; // P13: true
  /** Number is registered to someone other than the persona. P12: true (RAJESH MENON, not VICTOR ANAND). */
  reverseOwnerMismatch: boolean | null;
  fraudScore: number | null; // 0–100. P13 88, P12 85, P01 11
  voip: boolean | null;
  prepaid: boolean | null;
  phoneOwnerMatch: boolean | null;
}

export type CallerCheck =
  | { status: "skipped"; reason: "no_alias" }
  | {
      status: "checked";
      personaPhone: string;
      signals: CallerSignals;
      reverse: ReverseLookupResult | null;
      fraud: FraudFinderResult | null;
      errors: string[];
    };

/**
 * @param callerE164    Twilio's From number (real; never sent to CRS)
 * @param personaBodies Fraud Finder bodies keyed by persona phone; defaults to crs-personas.json
 */
export async function checkCaller(
  callerE164: string,
  personaBodies: Record<string, PersonaBody> = callerBodies,
): Promise<CallerCheck> {
  const personaPhone = await aliasStore.getAlias(callerE164);
  if (!personaPhone) return { status: "skipped", reason: "no_alias" };
  if (personaBodies !== callerBodies) return runChecks(personaPhone, personaBodies); // custom bodies: no cache

  // Sandbox answers never change, so each persona is checked once per server run.
  // Results with errors aren't kept, so a later call can try again.
  let pending = callerCache.get(personaPhone);
  if (!pending) {
    pending = runChecks(personaPhone, personaBodies);
    callerCache.set(personaPhone, pending);
    pending.then(
      (r) => {
        if (r.status === "checked" && r.errors.length > 0) callerCache.delete(personaPhone);
      },
      () => callerCache.delete(personaPhone),
    );
  }
  return pending;
}

const callerCache = new Map<string, Promise<CallerCheck>>();

async function runChecks(personaPhone: string, personaBodies: Record<string, PersonaBody>): Promise<CallerCheck> {
  // Run both in parallel; one failing shouldn't sink the other.
  const body = personaBodies[personaPhone];
  const [rev, fraud] = await Promise.allSettled([
    reverseLookup(personaPhone),
    body ? fraudFinder(body) : Promise.reject(new Error(`no persona body for ${personaPhone}`)),
  ]);

  const errors: string[] = [];
  if (rev.status === "rejected") errors.push(`reverseLookup: ${(rev.reason as Error).message}`);
  if (fraud.status === "rejected") errors.push(`fraudFinder: ${(fraud.reason as Error).message}`);

  const reverse = rev.status === "fulfilled" ? rev.value : null;
  const ff = fraud.status === "fulfilled" ? fraud.value : null;

  return {
    status: "checked",
    personaPhone,
    signals: {
      reverseNoRecord: reverse ? reverse.noRecord : null,
      reverseOwnerMismatch: reverse && body ? !reverse.noRecord && !ownerIsPersona(reverse, body) : null,
      fraudScore: ff?.score ?? null,
      voip: ff?.lineType ? ff.lineType.toLowerCase() === "voip" : null,
      prepaid: ff?.prepaid ?? null,
      phoneOwnerMatch: ff?.phoneOwnerMatch ?? null,
    },
    reverse,
    fraud: ff,
    errors,
  };
}

function ownerIsPersona(reverse: ReverseLookupResult, body: PersonaBody): boolean {
  const norm = (s?: string) => (s ?? "").trim().toUpperCase();
  return reverse.records.some(
    (r) => norm(r.firstName) === norm(body.firstName) && norm(r.lastName) === norm(body.lastName),
  );
}
