
import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

async function testCartesiaTTS() {
  const apiKey = process.env.CARTESIA_API_KEY;

  if (!apiKey) {
    throw new Error("CARTESIA_API_KEY is missing from .env");
  }

  console.log("=== CARTESIA TEXT-TO-SPEECH TEST ===");

  const transcript =
    "Hello, this is InterHoot. Before I connect your call, " +
    "I need to ask a few quick questions.";

  console.log("Generating speech...");
  console.log("Text:", transcript);

  const response = await fetch(
    "https://api.cartesia.ai/tts/bytes",
    {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Cartesia-Version": "2025-04-16",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: "sonic-3",
        transcript,
        voice: {
          mode: "id",
          id: "a0e99841-438c-4a64-b679-ae501e7d6091",
        },
        language: "en",
        output_format: {
          container: "wav",
          encoding: "pcm_f32le",
          sample_rate: 44100,
        },
      }),
      signal: AbortSignal.timeout(30000),
    }
  );

  console.log("HTTP status:", response.status);

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Cartesia TTS failed (${response.status}): ${errorText}`
    );
  }

  const audio = Buffer.from(await response.arrayBuffer());

  if (audio.length === 0) {
    throw new Error("Cartesia returned empty audio");
  }

  const outputDirectory = join(process.cwd(), "output");

  await mkdir(outputDirectory, { recursive: true });

  const outputPath = join(
    outputDirectory,
    "interhoot-greeting.wav"
  );

  await writeFile(outputPath, audio);

  console.log("PASS: Audio generated successfully");
  console.log("Audio size:", audio.length, "bytes");
  console.log("Saved to:", outputPath);
}

testCartesiaTTS().catch((error) => {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
});
