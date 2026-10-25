
import "dotenv/config";
import express from "express";
import { setupMediaWebSocket } from "./telephony/media.js";
import twilioRouter from "./telephony/twilio.js";
import { detectRisks } from "./riskDetector.js";

const app = express();

const PORT = Number(process.env.PORT) || 3000;

// Allow Express to read Twilio's form data
app.use("/twilio", express.urlencoded({ extended: false }));

// Register Twilio routes
app.use("/twilio", twilioRouter);

// Allow Express to read JSON requests
app.use(express.json());

// Health check endpoint
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "scam-protection-api"
  });
});

// Scam detection endpoint
app.post("/analyze", (req, res) => {
  const transcript = req.body?.transcript;

  if (typeof transcript !== "string" || transcript.trim() === "") {
    res.status(400).json({
      error: "Please provide a non-empty transcript."
    });
    return;
  }

  const signals = detectRisks(transcript);

  res.status(200).json({
    riskDetected: signals.length > 0,
    signals
  });
});

const server = app.listen(PORT, () => {
  console.log(`Scam protection backend running on port ${PORT}`);
});

setupMediaWebSocket(server);
