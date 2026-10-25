// server/src/crs/personas.ts — sandbox persona request bodies
//
// Loads server/scripts/crs-personas.json (filled from the CRS MCP get_test_data
// tool during B1). Fake sandbox identities only, never real people.

import { readFileSync } from "node:fs";
import type { PersonaBody, TuBody, UserPersona } from "./crs.js";

interface PersonaEntry {
  phone?: string;
  tuBody?: TuBody;
  fraudFinderBody?: PersonaBody;
}

// Same relative path from src/crs/ (tsx) and dist/crs/ (built): ../../scripts/
const FILE = new URL("../../scripts/crs-personas.json", import.meta.url);

const entries = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>).filter(
    ([key]) => !key.startsWith("_"), // skip "_comment"
  ),
) as Record<string, PersonaEntry>;

/** Fraud Finder bodies keyed by persona phone, e.g. "5550101013" → P13's body. */
export const callerBodies: Record<string, PersonaBody> = {};
for (const entry of Object.values(entries)) {
  const body = entry.fraudFinderBody;
  if (body) callerBodies[entry.phone ?? body.phoneNumber] = body;
}

/** The protected user persona (P20 by default) for tradeline pulls. */
export function getUserPersona(id = "P20"): UserPersona {
  const tuBody = entries[id]?.tuBody;
  if (!tuBody) throw new Error(`No tuBody for ${id} in crs-personas.json`);
  return { id, tuBody };
}
