
import "dotenv/config";
import type {
  ScreeningLanguage,
} from "./screeningLanguages.js";

const CARTESIA_TTS_URL =
  "https://api.cartesia.ai/tts/bytes";

const VOICE_ID =
  "a0e99841-438c-4a64-b679-ae501e7d6091";

export async function generateSpeech(
  text: string,
  signal?: AbortSignal,
  language: ScreeningLanguage = "en"
): Promise<Buffer> {
  const apiKey = process.env.CARTESIA_API_KEY;

  if (!apiKey) {
    throw new Error("CARTESIA_API_KEY is missing");
  }

  if (!text.trim()) {
    throw new Error("Speech text cannot be empty");
  }

  const response = await fetch(CARTESIA_TTS_URL, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Cartesia-Version": "2025-04-16",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: "sonic-3",
      transcript: text,
      voice: {
        mode: "id",
        id: VOICE_ID,
      },
      language,
      output_format: {
        container: "raw",
        encoding: "pcm_mulaw",
        sample_rate: 8000,
      },
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Cartesia TTS error ${response.status}: ${errorText}`
    );
  }

  const audio = Buffer.from(
    await response.arrayBuffer()
  );

  if (audio.length === 0) {
    throw new Error("Cartesia returned empty audio");
  }

  return audio;
}
