
import "dotenv/config";

import { applyCallVerdict } from "./telephony/callActions.js";

// Read the protected destination from .env.
const protectedNumber = process.env.PROTECTED_PHONE_NUMBER;

// Require a specific active Twilio Call SID.
// This prevents the script from selecting a random call.
const callSid = process.argv[2];

async function testGreenForwarding(): Promise<void> {
  if (!protectedNumber) {
    throw new Error(
      "PROTECTED_PHONE_NUMBER is missing from .env"
    );
  }

  if (!/^\+[1-9]\d{1,14}$/.test(protectedNumber)) {
    throw new Error(
      "PROTECTED_PHONE_NUMBER must use E.164 format"
    );
  }

  if (!callSid || !/^CA[a-f0-9]{32}$/i.test(callSid)) {
    throw new Error(
      "Provide a valid Twilio Call SID as the first argument."
    );
  }

  console.log("Starting controlled GREEN forwarding test.");
  console.log("Call SID:", callSid);
  console.log("Forwarding destination:", protectedNumber);

  // Explicit test only: does not modify generateVerdict().
  await applyCallVerdict(
    callSid,
    "GREEN",
    protectedNumber
  );

  console.log("GREEN forwarding instructions sent to Twilio.");
}

testGreenForwarding().catch((error) => {
  console.error("GREEN forwarding test failed:", error);
  process.exitCode = 1;
});
