
import assert from "node:assert/strict";

import {
  createCallSession,
  getCallSession,
  getActiveCallCount,
} from "./callSessions.js";

import {
  startCallTimeout,
  hasCallTimeout,
  getActiveTimeoutCount,
} from "./callTimeouts.js";

import {
  handleCallError,
  isCallSessionActive,
} from "./callErrorHandler.js";

function runTests() {
  console.log("=== TEST 1: WebSocket Error ===");

  createCallSession("CA111");
  startCallTimeout("CA111", 60_000);

  const result1 = handleCallError(
    "CA111",
    "WEBSOCKET_ERROR",
    new Error("Connection lost")
  );

  assert.equal(result1.sessionRemoved, true);
  assert.equal(result1.timerCancelled, true);
  assert.equal(isCallSessionActive("CA111"), false);
  assert.equal(hasCallTimeout("CA111"), false);

  console.log("PASS: WebSocket error cleaned up");

  console.log("\n=== TEST 2: AI Error ===");

  createCallSession("CA222");
  startCallTimeout("CA222", 60_000);

  const result2 = handleCallError(
    "CA222",
    "AI_ERROR",
    new Error("AI service unavailable")
  );

  assert.equal(result2.sessionRemoved, true);
  assert.equal(result2.timerCancelled, true);
  assert.equal(getCallSession("CA222"), undefined);

  console.log("PASS: AI error cleaned up");

  console.log("\n=== TEST 3: Repeated Cleanup ===");

  const result3 = handleCallError(
    "CA222",
    "UNKNOWN_ERROR",
    new Error("Repeated error")
  );

  assert.equal(result3.sessionRemoved, false);
  assert.equal(result3.timerCancelled, false);

  console.log("PASS: Repeated cleanup is safe");

  console.log("\n=== TEST 4: Database Error ===");

  createCallSession("CA333");
  startCallTimeout("CA333", 60_000);

  const result4 = handleCallError(
    "CA333",
    "DATABASE_ERROR",
    "Database connection failed"
  );

  assert.equal(result4.message, "Database connection failed");
  assert.equal(result4.sessionRemoved, true);
  assert.equal(result4.timerCancelled, true);

  console.log("PASS: Database error cleaned up");

  console.log("\n=== Final Cleanup Check ===");

  assert.equal(getActiveCallCount(), 0);
  assert.equal(getActiveTimeoutCount(), 0);

  console.log("Active calls:", getActiveCallCount());
  console.log("Active timers:", getActiveTimeoutCount());

  console.log("ALL ERROR HANDLER TESTS PASSED");
}

runTests();
