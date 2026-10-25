
import { createConversation } from "./conversation.js";
import { evaluateCall } from "./callController.js";

// Test all three verdicts
function testVerdict(
  testName: string,
  callerResponse: string,
  expectedVerdict: "GREEN" | "YELLOW" | "RED"
) {
  console.log(`\n=== ${testName} ===`);

  // Create a mock conversation
  const conversation = createConversation();

  // Simulate a completed conversation
  conversation.stage = "verdict";
  conversation.callerResponses = [callerResponse];

  // Evaluate the conversation
  const result = evaluateCall(
    conversation,
    "+15551234567"
  );

  console.log("Verdict:", result.verdict);
  console.log("Expected:", expectedVerdict);
  console.log("Generated TwiML:", result.twiml);

  // Check whether the result matches
  if (result.verdict === expectedVerdict) {
    console.log("PASS");
  } else {
    console.log("FAIL");
  }
}

// GREEN test
testVerdict(
  "Normal Caller",
  "Hello, I'm calling to schedule an appointment.",
  "GREEN"
);

// YELLOW test
testVerdict(
  "Suspicious Caller",
  "There's an urgent account problem.",
  "YELLOW"
);

// RED test
testVerdict(
  "High-Risk Caller",
  "Please send money using a gift card.",
  "RED"
);
