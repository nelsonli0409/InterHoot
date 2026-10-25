
import "dotenv/config";
import WebSocket from "ws";

const apiKey = process.env.CARTESIA_API_KEY;

if (!apiKey) {
  throw new Error("CARTESIA_API_KEY is missing from .env");
}

const url = new URL(
  "wss://api.cartesia.ai/stt/websocket"
);

url.searchParams.set("model", "ink-2");
url.searchParams.set("encoding", "pcm_mulaw");
url.searchParams.set("sample_rate", "8000");
url.searchParams.set("language", "en");
url.searchParams.set("cartesia_version", "2026-03-01");

console.log("=== CARTESIA STT WEBSOCKET TEST ===");
console.log("Connecting to Cartesia...");

const ws = new WebSocket(url.toString(), {
  headers: {
    "X-API-Key": apiKey,
  },
  handshakeTimeout: 10000,
});

let connected = false;
let receivedError = false;
let finished = false;

const timeout = setTimeout(() => {
  console.error("FAIL: Connection test timed out");
  receivedError = true;
  process.exitCode = 1;
  ws.terminate();
}, 15000);

ws.on("open", () => {
  connected = true;

  console.log("PASS: WebSocket connection opened");
  console.log("Model: ink-2");
  console.log("Audio format: pcm_mulaw");
  console.log("Sample rate: 8000 Hz");

  // Send the plain text command expected by Cartesia.
  ws.send("close");
});

ws.on("message", (data) => {
  const message = data.toString();

  console.log("Cartesia response:", message);

  try {
    const event = JSON.parse(message);

    if (event.type === "error" || event.error_code) {
      receivedError = true;
      process.exitCode = 1;
    }

    if (event.done === true && !receivedError) {
      finished = true;
      console.log("PASS: Cartesia acknowledged completion");

      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000);
      }
    }
  } catch {
    // Non-JSON messages are logged above.
  }
});

ws.on("unexpected-response", (_request, response) => {
  receivedError = true;
  process.exitCode = 1;

  console.error(
    "FAIL: HTTP handshake status:",
    response.statusCode
  );

  response.resume();
  ws.terminate();
});

ws.on("error", (error) => {
  receivedError = true;
  process.exitCode = 1;

  console.error("FAIL: WebSocket error:", error.message);
});

ws.on("close", (code, reason) => {
  clearTimeout(timeout);

  console.log("WebSocket closed");
  console.log("Close code:", code);

  if (reason.length > 0) {
    console.log("Close reason:", reason.toString());
  }

  if (
    connected &&
    !receivedError &&
    code === 1000
  ) {
    console.log("PASS: Cartesia STT connection test completed");
  } else if (connected && finished && !receivedError) {
    console.log("PASS: Cartesia completed the test");
  } else {
    console.log("FAIL: STT connection test did not complete cleanly");
    process.exitCode = 1;
  }
});
