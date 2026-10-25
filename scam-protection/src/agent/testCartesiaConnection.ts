
import "dotenv/config";

async function testCartesiaConnection() {
  const apiKey = process.env.CARTESIA_API_KEY;

  if (!apiKey) {
    throw new Error("CARTESIA_API_KEY is missing");
  }

  console.log("=== CARTESIA CONNECTION TEST ===");

  const response = await fetch(
    "https://api.cartesia.ai/voices",
    {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        "Cartesia-Version": "2025-04-16",
      },
      signal: AbortSignal.timeout(10000),
    }
  );

  console.log("HTTP status:", response.status);

  if (!response.ok) {
    throw new Error(
      `Cartesia API request failed (${response.status})`
    );
  }

  console.log("PASS: Cartesia API connection successful");
  console.log("PASS: API key accepted");
}

testCartesiaConnection().catch((error) => {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
});
