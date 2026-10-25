import "dotenv/config";
import twilio from "twilio";
import type { CallVerdict } from "../agent/conversation.js";

const UNCONNECTED_CLOSING_MESSAGE =
  "Thank you for calling InterHoot. We are unable to connect your call at this time. Goodbye!";

export function buildVerdictTwiml(
  verdict: CallVerdict,
  protectedNumber?: string
): string {
  const response = new twilio.twiml.VoiceResponse();

  if (verdict === "GREEN") {
    if (protectedNumber) {
      response.say("Your call has been approved. Connecting you now.");
      response.dial(protectedNumber);
    } else {
      response.say(
        "Thank you for calling InterHoot! Your call has been successfully screened. " +
          "We're unable to connect you at this time. " +
          "We appreciate your patience. Have a wonderful day. Goodbye!"
      );
      response.hangup();
    }
    return response.toString();
  }

  if (verdict === "YELLOW" || verdict === "RED") {
    response.say(UNCONNECTED_CLOSING_MESSAGE);
    response.hangup();
    return response.toString();
  }

  throw new Error("Unknown call verdict.");
}

export function createTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error("Missing Twilio credentials.");
  }

  return twilio(accountSid, authToken);
}

export async function applyCallVerdict(
  callSid: string,
  verdict: CallVerdict,
  protectedNumber?: string
): Promise<void> {
  const client = createTwilioClient();
  const twiml = buildVerdictTwiml(verdict, protectedNumber);
  const updatedCall = await client.calls(callSid).update({ twiml });
  console.log("Call updated:", updatedCall.sid);
  console.log("Verdict applied:", verdict);
}
