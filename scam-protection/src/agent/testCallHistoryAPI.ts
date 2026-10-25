
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import callsRouter from "../routes/calls.js";

import {
  createCallSummary,
  removeCallSummary,
} from "./callSummaries.js";

import type {
  TranscriptMessage,
} from "./callTranscripts.js";

async function runTests() {
  const app = express();

  // Use the same routes as the real backend
  app.use("/calls", callsRouter);

  // Start a temporary server and wait until it is ready
  const server: Server = await new Promise<Server>(
    (resolve, reject) => {
      const testServer = app.listen(0, "127.0.0.1");

      testServer.once("listening", () => {
        resolve(testServer);
      });

      testServer.once("error", reject);
    }
  );

  try {
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("Could not determine test server port.");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    console.log("=== TEST 1: Create Sample Summaries ===");

    const samples = [
      {
        callSid: "CA_TEST_GREEN",
        verdict: "GREEN" as const,
        text: "I'm calling about an appointment.",
      },
      {
        callSid: "CA_TEST_YELLOW",
        verdict: "YELLOW" as const,
        text: "This is an urgent account problem.",
      },
      {
        callSid: "CA_TEST_RED",
        verdict: "RED" as const,
        text: "Please send money using a gift card.",
      },
    ];

    // Create three sample call summaries
    for (const sample of samples) {
      const messages: TranscriptMessage[] = [
        {
          role: "caller",
          text: sample.text,
          timestamp: Date.now(),
        },
      ];

      createCallSummary(
        sample.callSid,
        messages,
        sample.verdict
      );
    }

    console.log("PASS: Three summaries created");

    console.log("\n=== TEST 2: GET /calls ===");

    const callsResponse = await fetch(`${baseUrl}/calls`);

    assert.equal(callsResponse.status, 200);

    const calls = (await callsResponse.json()) as Array<{
      callSid: string;
      verdict: string;
    }>;

    assert.equal(calls.length, 3);

    console.log("PASS: Retrieved three summaries");

    console.log("\n=== TEST 3: GET /calls/stats ===");

    const statsResponse = await fetch(
      `${baseUrl}/calls/stats`
    );

    assert.equal(statsResponse.status, 200);

    const stats = (await statsResponse.json()) as {
      totalCalls: number;
      green: number;
      yellow: number;
      red: number;
    };

    assert.deepEqual(stats, {
      totalCalls: 3,
      green: 1,
      yellow: 1,
      red: 1,
    });

    console.log("PASS: Statistics are correct");

    console.log("\n=== TEST 4: GET /calls/:callSid ===");

    const singleResponse = await fetch(
      `${baseUrl}/calls/CA_TEST_RED`
    );

    assert.equal(singleResponse.status, 200);

    const singleCall = (await singleResponse.json()) as {
      callSid: string;
      verdict: string;
    };

    assert.equal(singleCall.callSid, "CA_TEST_RED");
    assert.equal(singleCall.verdict, "RED");

    console.log("PASS: Retrieved RED call");

    console.log("\n=== TEST 5: Unknown Call ===");

    const missingResponse = await fetch(
      `${baseUrl}/calls/CA_UNKNOWN`
    );

    assert.equal(missingResponse.status, 404);

    console.log("PASS: Unknown call returns 404");

    console.log("\nALL CALL HISTORY API TESTS PASSED");
  } finally {
    // Remove the test summaries from memory
    removeCallSummary("CA_TEST_GREEN");
    removeCallSummary("CA_TEST_YELLOW");
    removeCallSummary("CA_TEST_RED");

    // Close the temporary server if it is running
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  }
}

// Run the tests and report unexpected errors
runTests().catch((error) => {
  console.error("Call History API tests failed:", error);
  process.exitCode = 1;
});
