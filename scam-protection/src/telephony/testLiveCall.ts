
import "dotenv/config";
import { applyCallVerdict } from "./callActions.js";
import type { CallVerdict } from "../agent/conversation.js";

// Read arguments from PowerShell
const callSid = process.argv[2];
const verdict = process.argv[3];
const protectedNumber = process.argv[4];
const confirmation = process.argv[5];

// Validate the Call SID
if (!callSid || !/^CA[a-f0-9]{32}$/i.test(callSid)) {
  console.error("Please provide a valid Call SID.");
  process.exit(1);
}

// Validate the verdict
if (
  verdict !== "GREEN" &&
  verdict !== "YELLOW" &&
  verdict !== "RED"
) {
  console.error("Verdict must be GREEN, YELLOW, or RED.");
  process.exit(1);
}

// GREEN requires a destination number
if (
  verdict === "GREEN" &&
  (!protectedNumber || !/^\+[1-9]\d{1,14}$/.test(protectedNumber))
) {
  console.error("GREEN requires a valid destination number.");
  process.exit(1);
}

// Require explicit confirmation
if (!process.argv.includes("--confirm")) {
  console.error("Add --confirm to proceed.");
  process.exit(1);
}

async function main() {
  try {
    await applyCallVerdict(
      callSid,
      verdict as CallVerdict,
      verdict === "GREEN" ? protectedNumber : undefined
    );

    console.log(`${verdict} verdict applied successfully.`);
  } catch (error) {
    console.error("Failed to update call:", error);
    process.exitCode = 1;
  }
}

main();

