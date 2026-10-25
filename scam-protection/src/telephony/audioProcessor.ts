
export interface TwilioAudioChunk {
  track: string;
  payload: string;
}

export function processTwilioAudio(
  chunk: TwilioAudioChunk
): Buffer {
  if (chunk.track !== "inbound") {
    throw new Error("Expected inbound audio track");
  }

  if (
    typeof chunk.payload !== "string" ||
    chunk.payload.length === 0
  ) {
    throw new Error("Missing audio payload");
  }

  // Twilio sends G.711 mu-law audio encoded in Base64.
  const audioBuffer = Buffer.from(
    chunk.payload,
    "base64"
  );

  if (audioBuffer.length === 0) {
    throw new Error("Decoded audio is empty");
  }

  return audioBuffer;
}
