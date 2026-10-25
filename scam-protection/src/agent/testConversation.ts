
import {
  createConversation,
  getNextAgentLine,
  receiveCallerResponse,
  generateVerdict,
} from "./conversation.js";

// ========================================
// TEST 1: Complete conversation
// ========================================

console.log("=== TEST 1: Full Conversation ===");

const conversation = createConversation();

// Greeting
console.log("Agent:", getNextAgentLine(conversation));

// Caller introduces themselves
receiveCallerResponse(
  conversation,
  "I'm John from ABC Bank."
);

// First follow-up
console.log("Agent:", getNextAgentLine(conversation));

// Verify that the agent waits
console.log("Agent:", getNextAgentLine(conversation));

// Caller answers first follow-up
receiveCallerResponse(
  conversation,
  "I'm calling from ABC Bank."
);

// Second follow-up
console.log("Agent:", getNextAgentLine(conversation));

// Caller answers second follow-up
receiveCallerResponse(
  conversation,
  "There's a suspicious transaction."
);

// Third follow-up
console.log("Agent:", getNextAgentLine(conversation));

// Caller answers third follow-up
receiveCallerResponse(
  conversation,
  "You can reach us through our official website."
);

// Finish conversation
console.log("Agent:", getNextAgentLine(conversation));

// Display conversation information
console.log("Final stage:", conversation.stage);
console.log("Follow-up count:", conversation.followupCount);
console.log("Waiting:", conversation.waitingForResponse);
console.log("Caller responses:", conversation.callerResponses);

// Generate the verdict
console.log("Verdict:", generateVerdict(conversation));

// ========================================
// TEST 2: All three verdict categories
// ========================================

console.log("\n=== TEST 2: All Verdicts ===");

const testCases = [
  {
    name: "Normal caller",
    response: "I'm calling to confirm a dentist appointment.",
    expected: "GREEN",
  },
  {
    name: "Potentially suspicious caller",
    response: "There is an urgent account problem.",
    expected: "YELLOW",
  },
  {
    name: "High-risk caller",
    response: "Please give me your verification code.",
    expected: "RED",
  },
];

for (const testCase of testCases) {
  // Create a fresh conversation
  const testConversation = createConversation();

  // Simulate a completed conversation
  testConversation.stage = "verdict";
  testConversation.callerResponses = [
    testCase.response,
  ];

  // Generate verdict
  const verdict = generateVerdict(testConversation);

  // Check whether the verdict matches
  const passed = verdict === testCase.expected;

  console.log(
    `${testCase.name}: ${verdict} (expected: ${testCase.expected})`
  );

  console.log(passed ? "PASS" : "FAIL");
}
