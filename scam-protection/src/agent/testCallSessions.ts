
import {
  createCallSession,
  getCallSession,
  removeCallSession,
  getActiveCallCount,
} from "./callSessions.js";

// TEST 1: Create two separate calls
console.log("=== TEST 1: Create Sessions ===");

const callA = createCallSession("CA111");
const callB = createCallSession("CA222");

console.log("Active calls:", getActiveCallCount());

// TEST 2: Store different caller responses
console.log("\n=== TEST 2: Separate Conversations ===");

callA.callerResponses.push("I'm calling from a bank.");
callB.callerResponses.push("I'm calling about an appointment.");

console.log(
  "Call A responses:",
  getCallSession("CA111")?.callerResponses
);

console.log(
  "Call B responses:",
  getCallSession("CA222")?.callerResponses
);

// TEST 3: Remove one session
console.log("\n=== TEST 3: Remove Session ===");

removeCallSession("CA111");

console.log("Active calls:", getActiveCallCount());
console.log("Call A exists:", getCallSession("CA111") !== undefined);
console.log("Call B exists:", getCallSession("CA222") !== undefined);

// Clean up
removeCallSession("CA222");
