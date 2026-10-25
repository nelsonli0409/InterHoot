import { Router } from "express";
import twilio from "twilio";

const router = Router();

router.post("/voice", (req, res) => {

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

 const connect = response.connect();

connect.stream({
  url: "wss://8cmsr1nb-3000.usw3.devtunnels.ms/media",
});

  res.type("text/xml");
  res.send(response.toString());
});

export default router;