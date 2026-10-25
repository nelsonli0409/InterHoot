
import assert from "node:assert/strict";

import {
  createCallTranscript,
  getCallTranscript,
  addTranscriptMessage,
  getTranscriptMessages,
  formatCallTranscript,
  removeCallTranscript,
  getActiveTranscriptCount,
} from "./callTranscripts.js";

function runTests() {
  console.log("=== TEST 1: Create Transcript ===");

  const transcript = createCallTranscript("CA111");

  assert.equal(transcript.callSid, "CA111");
  assert.equal(transcript.messages.length, 0);
  assert.equal(getActiveTranscriptCount(), 1);

  console.log("PASS: Transcript created");

  console.log("\n=== TEST 2: Add Messages ===");

  addTranscriptMessage(
    "CA111",
    "agent",
    "Hello! This is InterHoot. May I ask who's calling and why?"
  );

  addTranscriptMessage(
    "CA111",
    "caller",
    "I'm calling from the bank."
  );

  addTranscriptMessage(
    "CA111",
    "agent",
    "What organization are you calling from?"
  );

  const messages = getTranscriptMessages("CA111");

  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, "agent");
  assert.equal(messages[1].role, "caller");
  assert.equal(messages[2].role, "agent");
  assert.equal(typeof messages[0].timestamp, "number");

  console.log("PASS: Messages stored in order");

  console.log("\n=== TEST 3: Format Transcript ===");

  const formatted = formatCallTranscript("CA111");

  console.log(formatted);

  assert.ok(formatted.includes("InterHoot: Hello!"));
  assert.ok(formatted.includes("Caller: I'm calling from the bank."));

  console.log("PASS: Transcript formatted");

  console.log("\n=== TEST 4: Multiple Calls ===");

  createCallTranscript("CA222");

  addTranscriptMessage(
    "CA222",
    "caller",
    "I need to speak with someone."
  );

  assert.equal(
    getTranscriptMessages("CA111").length,
    3
  );

  assert.equal(
    getTranscriptMessages("CA222").length,
    1
  );

  console.log("PASS: Calls have separate transcripts");

  console.log("\n=== TEST 5: Invalid Messages ===");

  assert.throws(() => {
    addTranscriptMessage("CA111", "caller", "   ");
  });

  assert.throws(() => {
    addTranscriptMessage("CA999", "caller", "Hello");
  });

  console.log("PASS: Invalid messages rejected");

  console.log("\n=== TEST 6: Cleanup ===");

  assert.equal(removeCallTranscript("CA111"), true);
  assert.equal(removeCallTranscript("CA222"), true);

  assert.equal(getCallTranscript("CA111"), undefined);
  assert.equal(getActiveTranscriptCount(), 0);

  console.log("PASS: Transcripts cleaned up");

  console.log("\n=== Final Check ===");

  console.log(
    "Active transcripts:",
    getActiveTranscriptCount()
  );

  console.log("ALL TRANSCRIPT TESTS PASSED");
}

runTests();
