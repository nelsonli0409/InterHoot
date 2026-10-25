
import "dotenv/config";

const cartesiaApiKey = process.env.CARTESIA_API_KEY;

if (!cartesiaApiKey) {
  console.error("FAIL: Cartesia API key not found.");
  process.exitCode = 1;
} else {
  console.log("PASS: Cartesia API key loaded successfully.");
  console.log("Ready to configure Cartesia STT.");
}
