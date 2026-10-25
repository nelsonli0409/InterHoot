
import assert from "node:assert/strict";

import {
  createCallSession,
  getCallSession,
  removeCallSession,
  getActiveCallCount,
} from "./callSessions.js";

import {
  startCallTimeout,
  clearCallTimeout,
  hasCallTimeout,
  getActiveTimeoutCount,
} from "./callTimeouts.js";

import {
  handleCallError,
} from "./callErrorHandler.js";

// Simulate the cleanup performed by media.ts
// when a WebSocket connection closes.
function simulateDisconnect(callSid: string) {
  console.log("WebSocket disconnected:", callSid);

  const timerCancelled = clearCallTimeout(callSid);
  const sessionRemoved = removeCallSession(callSid);

  console.log("Timer cancelled:", timerCancelled);
  console.log("Session removed:", sessionRemoved);
}

async function runTests() {
  console.log("=== TEST 1: Unexpected Disconnect ===");

  createCallSession("CA111");
  startCallTimeout("CA111", 60_000);

  assert.equal(getActiveCallCount(), 1);
  assert.equal(hasCallTimeout("CA111"), true);

  // Pretend the connection suddenly closes
  simulateDisconnect("CA111");

  assert.equal(getCallSession("CA111"), undefined);
  assert.equal(hasCallTimeout("CA111"), false);

  console.log("PASS: Disconnected call cleaned up");

  console.log("\n=== TEST 2: Repeated Cleanup ===");

  // Twilio might send stop and then close.
  // Both events may attempt cleanup.
  simulateDisconnect("CA111");

  assert.equal(getActiveCallCount(), 0);
  assert.equal(getActiveTimeoutCount(), 0);

  console.log("PASS: Repeated cleanup is safe");

  console.log("\n=== TEST 3: One Call Disconnects ===");

  createCallSession("CA222");
  createCallSession("CA333");

  startCallTimeout("CA222", 60_000);
  startCallTimeout("CA333", 60_000);

  simulateDisconnect("CA222");

  assert.equal(getCallSession("CA222"), undefined);
  assert.notEqual(getCallSession("CA333"), undefined);

  assert.equal(hasCallTimeout("CA222"), false);
  assert.equal(hasCallTimeout("CA333"), true);

  console.log("PASS: Other call remains active");

  console.log("\n=== TEST 4: WebSocket Error ===");

  const result = handleCallError(
    "CA333",
    "WEBSOCKET_ERROR",
    new Error("Connection unexpectedly lost")
  );

  assert.equal(result.sessionRemoved, true);
  assert.equal(result.timerCancelled, true);

  console.log("PASS: Error handler cleaned up call");

  console.log("\n=== Final Cleanup Check ===");

  assert.equal(getActiveCallCount(), 0);
  assert.equal(getActiveTimeoutCount(), 0);

  console.log("Active calls:", getActiveCallCount());
  console.log("Active timers:", getActiveTimeoutCount());

  console.log("ALL DISCONNECT TESTS PASSED");
}

runTests().catch((error) => {
  console.error("Disconnect tests failed:", error);
  process.exitCode = 1;
});
