
import assert from "node:assert/strict";

import {
  createScreeningSession,
  askNextQuestion,
  submitCallerResponse,
  getScreeningVerdict,
  getScreeningTranscript,
  removeScreeningSession,
  getActiveScreeningCount,
} from "./screeningSession.js";

function runTests() {
  console.log("=== TEST 1: Create Screening Session ===");

  createScreeningSession("CA111");

  assert.equal(getActiveScreeningCount(), 1);

  console.log("PASS: Screening session created");

  console.log("\n=== TEST 2: Record Conversation ===");

  const greeting = askNextQuestion("CA111");
  console.log("Agent:", greeting);

  submitCallerResponse(
    "CA111",
    "My name is John. I'm calling from the bank."
  );

  for (let i = 0; i < 3; i++) {
    const question = askNextQuestion("CA111");
    console.log("Agent:", question);

    submitCallerResponse(
      "CA111",
      "I'm calling about a regular customer inquiry."
    );
  }

  // Move conversation to verdict stage
  askNextQuestion("CA111");

  const transcript = getScreeningTranscript("CA111");

  assert.equal(transcript.length, 8);
  assert.equal(transcript[0].role, "agent");
  assert.equal(transcript[1].role, "caller");

  console.log("PASS: Conversation recorded");

  console.log("\n=== TEST 3: Generate Verdict ===");

  const verdict = getScreeningVerdict("CA111");

  assert.equal(verdict, "GREEN");

  console.log("Verdict:", verdict);
  console.log("PASS: Verdict generated");

  console.log("\n=== TEST 4: Cleanup ===");

  assert.equal(removeScreeningSession("CA111"), true);
  assert.equal(getActiveScreeningCount(), 0);

  console.log("PASS: Screening session removed");

  console.log("\n=== Final Check ===");

  console.log(
    "Active screening sessions:",
    getActiveScreeningCount()
  );

  console.log("ALL SCREENING SESSION TESTS PASSED");
}

runTests();
