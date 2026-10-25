
import assert from "node:assert/strict";

import {
  createScreeningSession,
  askNextQuestion,
  submitCallerResponse,
  getScreeningVerdict,
  getScreeningTranscript,
  removeScreeningSession,
} from "./screeningSession.js";

import {
  createCallSummary,
  getCallSummary,
  getAllCallSummaries,
  removeCallSummary,
  getCallSummaryCount,
} from "./callSummaries.js";

function testCall(
  callSid: string,
  introduction: string,
  expectedVerdict: "GREEN" | "YELLOW" | "RED"
) {
  createScreeningSession(callSid);

  // Initial greeting
  askNextQuestion(callSid);
  submitCallerResponse(callSid, introduction);

  // Three follow-up questions
  for (let i = 0; i < 3; i++) {
    askNextQuestion(callSid);

    submitCallerResponse(
      callSid,
      "I can provide additional information."
    );
  }

  // Advance to verdict stage
  askNextQuestion(callSid);

  const verdict = getScreeningVerdict(callSid);

  assert.equal(verdict, expectedVerdict);

  const transcript = getScreeningTranscript(callSid);

  const summary = createCallSummary(
    callSid,
    transcript,
    verdict
  );

  console.log("Verdict:", summary.verdict);
  console.log("Summary:", summary.summary);
  console.log("Reasons:", summary.verdictReasons);

  assert.equal(summary.verdict, expectedVerdict);
  assert.equal(summary.callSid, callSid);
  assert.ok(summary.summary.length > 0);
  assert.ok(summary.verdictReasons.length > 0);

  // Remove the active screening session.
  // The saved summary should remain available.
  removeScreeningSession(callSid);

  assert.notEqual(getCallSummary(callSid), undefined);

  console.log("PASS:", expectedVerdict, "summary created");
}

function runTests() {
  console.log("=== TEST 1: GREEN Summary ===");

  testCall(
    "CA111",
    "My name is John. I'm calling about a routine appointment.",
    "GREEN"
  );

  console.log("\n=== TEST 2: YELLOW Summary ===");

  testCall(
    "CA222",
    "I'm calling about an urgent account problem.",
    "YELLOW"
  );

  console.log("\n=== TEST 3: RED Summary ===");

  testCall(
    "CA333",
    "I need your verification code to access your account.",
    "RED"
  );

  console.log("\n=== TEST 4: Summary Storage ===");

  assert.equal(getCallSummaryCount(), 3);

  const summaries = getAllCallSummaries();

  assert.equal(summaries.length, 3);

  console.log("PASS: Summaries retained after calls");

  console.log("\n=== TEST 5: Duplicate Prevention ===");

  const existingSummary = getCallSummary("CA111");

  assert.notEqual(existingSummary, undefined);

  assert.throws(() => {
    createCallSummary(
      "CA111",
      [
        {
          role: "caller",
          text: "Another message",
          timestamp: Date.now(),
        },
      ],
      "GREEN"
    );
  });

  console.log("PASS: Duplicate summary rejected");

  console.log("\n=== TEST 6: Cleanup ===");

  assert.equal(removeCallSummary("CA111"), true);
  assert.equal(removeCallSummary("CA222"), true);
  assert.equal(removeCallSummary("CA333"), true);

  assert.equal(getCallSummaryCount(), 0);

  console.log("PASS: Summary storage cleaned up");

  console.log("\n=== Final Check ===");
  console.log("Saved summaries:", getCallSummaryCount());
  console.log("ALL CALL SUMMARY TESTS PASSED");
}

runTests();
