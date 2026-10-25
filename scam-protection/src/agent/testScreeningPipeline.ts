
import {
  createCallSession,
  getCallSession,
  removeCallSession,
  getActiveCallCount,
} from "./callSessions.js";

import {
  getNextAgentLine,
  receiveCallerResponse,
  type CallVerdict,
} from "./conversation.js";

import { evaluateCall } from "./callController.js";

// Simulate an entire call screening conversation
function simulateCall(
  callSid: string,
  callerResponses: string[],
  expectedVerdict: CallVerdict
): void {
  console.log(`\n=== Testing ${expectedVerdict} Call ===`);

  // Step 1: Create a new call session
  const conversation = createCallSession(callSid);

  console.log("Call session created:", callSid);

  // Step 2: Begin the conversation
  let agentLine = getNextAgentLine(conversation);

  console.log("InterHoot:", agentLine);

  // Step 3: Simulate caller responses
  for (const response of callerResponses) {
    receiveCallerResponse(conversation, response);

    console.log("Caller:", response);

    agentLine = getNextAgentLine(conversation);

    console.log("InterHoot:", agentLine);
  }

  // Step 4: Check whether the conversation is finished
  if (conversation.stage !== "verdict") {
    throw new Error(
      `Conversation did not reach verdict stage. Current stage: ${conversation.stage}`
    );
  }

  // Step 5: Generate verdict and Twilio instructions
  const result = evaluateCall(
    conversation,
    "+15551234567"
  );

  console.log("Generated verdict:", result.verdict);
  console.log("Expected verdict:", expectedVerdict);
  console.log("Generated TwiML:", result.twiml);

  // Step 6: Verify the result
  if (result.verdict !== expectedVerdict) {
    throw new Error(
      `Expected ${expectedVerdict}, got ${result.verdict}`
    );
  }

  console.log("PASS: Correct verdict generated");

  // Step 7: Remove the call session
  removeCallSession(callSid);

  console.log("Call session removed:", callSid);
  console.log("Active calls:", getActiveCallCount());
}

// Four responses: identity + three follow-up answers
simulateCall(
  "CA111",
  [
    "Hello, I'm calling to schedule an appointment.",
    "I'm calling from the dental office.",
    "I need to confirm an appointment time.",
    "You can reach our office using our public phone number.",
  ],
  "GREEN"
);

simulateCall(
  "CA222",
  [
    "I'm calling about an urgent account problem.",
    "I'm from customer support.",
    "We need to discuss an account issue.",
    "You can call our support department.",
  ],
  "YELLOW"
);

simulateCall(
  "CA333",
  [
    "I'm calling because you need to send money.",
    "I'm from the payment department.",
    "You must purchase a gift card.",
    "Please provide the verification code.",
  ],
  "RED"
);

// Final verification
console.log("\n=== Final Session Check ===");

if (getActiveCallCount() !== 0) {
  throw new Error("Some call sessions were not cleaned up.");
}

console.log("All sessions cleaned up.");
console.log("ALL SCREENING TESTS PASSED");
