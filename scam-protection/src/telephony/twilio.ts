import { Router } from "express";
import twilio from "twilio";
import { precheckCall } from "./brainClient.js";

const router = Router();

router.post("/voice", async (req, res) => {

	const authToken = process.env.TWILIO_AUTH_TOKEN;
const webhookUrl = process.env.TWILIO_WEBHOOK_URL;
const signature = req.header("X-Twilio-Signature");

	console.log("Twilio webhook received");
	console.log("Request URL:", req.originalUrl);
	console.log("Host:", req.headers.host);
	console.log("Twilio signature present:", Boolean(req.header("X-Twilio-Signature")));

	console.log("Twilio configuration loaded:", {
  authToken: Boolean(authToken),
  webhookUrl: Boolean(webhookUrl),
  signature: Boolean(signature),
});

  if (!authToken || !webhookUrl || !signature) {
    res.status(403).send("Forbidden");
    return;
  }

  const isValid = twilio.validateRequest(
    authToken,
    signature,
    webhookUrl,
    req.body
  );

	console.log("Twilio signature valid:", isValid);

  if (!isValid) {
    res.status(403).send("Invalid Twilio signature");
    return;
  }

  const response = new twilio.twiml.VoiceResponse();

  const callSid = String(req.body.CallSid ?? "");
  const from = String(req.body.From ?? "");

  // Hidden caller IDs and numbers already flagged red are rejected before anyone answers.
  const check = await precheckCall(callSid, from);
  if (check.action === "reject") {
    console.log("Call rejected:", check.reason);
    response.reject();
    res.type("text/xml");
    res.send(response.toString());
    return;
  }

  const connect = response.connect();

  const stream = connect.stream({
    url: process.env.TWILIO_MEDIA_URL ?? "wss://whm4mfbz-3000.usw3.devtunnels.ms/media",
  });

  // The media stream doesn't carry the caller's number, so pass it along.
  stream.parameter({ name: "from", value: from });

  res.type("text/xml");
  res.send(response.toString());
});

export default router;