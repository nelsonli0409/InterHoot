
import assert from "node:assert/strict";
import { processTwilioAudio } from "./audioProcessor.js";

// Test 1: Valid audio
console.log("=== TEST 1: Valid Audio ===");

const originalAudio = Buffer.from([255, 127, 0, 128]);

const decodedAudio = processTwilioAudio({
  track: "inbound",
  payload: originalAudio.toString("base64"),
});

assert.deepEqual(decodedAudio, originalAudio);

console.log("PASS: Audio decoded correctly");

// Test 2: Missing audio payload
console.log("\n=== TEST 2: Missing Payload ===");

assert.throws(
  () =>
    processTwilioAudio({
      track: "inbound",
      payload: "",
    }),
  /Missing audio payload/
);

console.log("PASS: Missing payload rejected");

// Test 3: Wrong audio track
console.log("\n=== TEST 3: Wrong Track ===");

assert.throws(
  () =>
    processTwilioAudio({
      track: "outbound",
      payload: originalAudio.toString("base64"),
    }),
  /Expected inbound audio track/
);

console.log("PASS: Wrong track rejected");

console.log("\nALL AUDIO PROCESSOR TESTS PASSED");
