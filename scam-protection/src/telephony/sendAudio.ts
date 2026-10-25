
import WebSocket from "ws";

export function sendAudioToTwilio(
  ws: WebSocket,
  streamSid: string,
  audio: Buffer
): void {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("Twilio WebSocket is not open");
  }

  if (!streamSid) {
    throw new Error("Missing Twilio stream SID");
  }

  if (audio.length === 0) {
    throw new Error("Cannot send empty audio");
  }

  // Cartesia already returned raw 8 kHz mu-law audio.
  const message = {
    event: "media",
    streamSid,
    media: {
      payload: audio.toString("base64"),
    },
  };

  ws.send(JSON.stringify(message));

  // Twilio acknowledges this after playback finishes.
  ws.send(
    JSON.stringify({
      event: "mark",
      streamSid,
      mark: {
        name: "interhoot-greeting",
      },
    })
  );

  console.log(
    "Sent audio to Twilio:",
    audio.length,
    "bytes"
  );
}
