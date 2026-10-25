
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

import assert from "node:assert/strict";

async function runTests() {
  console.log("=== TEST 1: Timeout Expiration ===");

  createCallSession("CA111");

  let timeoutTriggered = false;

  startCallTimeout("CA111", 100, () => {
    timeoutTriggered = true;
    console.log("Timeout callback triggered");
  });

  console.log("Timer created:", hasCallTimeout("CA111"));

  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(timeoutTriggered, true);
  assert.equal(getCallSession("CA111"), undefined);
  assert.equal(hasCallTimeout("CA111"), false);

  console.log("PASS: Expired call cleaned up");

  console.log("\n=== TEST 2: Cancel Timeout ===");

  createCallSession("CA222");

  let cancelledCallbackTriggered = false;

  startCallTimeout("CA222", 100, () => {
    cancelledCallbackTriggered = true;
  });

  clearCallTimeout("CA222");

  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(cancelledCallbackTriggered, false);
  assert.notEqual(getCallSession("CA222"), undefined);

  console.log("PASS: Cancelled timeout did not fire");

  removeCallSession("CA222");

  console.log("\n=== TEST 3: Multiple Calls ===");

  createCallSession("CA333");
  createCallSession("CA444");

  startCallTimeout("CA333", 100);
  startCallTimeout("CA444", 500);

  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(getCallSession("CA333"), undefined);
  assert.notEqual(getCallSession("CA444"), undefined);

  console.log("PASS: Calls have independent timers");

  clearCallTimeout("CA444");
  removeCallSession("CA444");

  console.log("\n=== Final Cleanup Check ===");

  assert.equal(getActiveCallCount(), 0);
  assert.equal(getActiveTimeoutCount(), 0);

  console.log("Active calls:", getActiveCallCount());
  console.log("Active timers:", getActiveTimeoutCount());
  console.log("ALL TIMEOUT TESTS PASSED");
}

runTests().catch((error) => {
  console.error("Timeout tests failed:", error);
  process.exitCode = 1;
});
