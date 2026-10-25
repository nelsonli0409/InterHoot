
import twilio from "twilio";
import type { CallVerdict } from "../agent/conversation.js";

export function buildVerdictTwiml(
  verdict: CallVerdict,
  protectedNumber?: string
): string {
  const response = new twilio.twiml.VoiceResponse();

  if (verdict === "GREEN") {
    if (!protectedNumber) {
      throw new Error(
        "A protected phone number is required for GREEN calls."
      );
    }

    response.say(
      "Your call has been approved. Connecting you now."
    );

    response.dial(protectedNumber);

    return response.toString();
  }

  if (verdict === "YELLOW") {
    response.say(
      "We cannot connect your call at this time. Goodbye."
    );

    response.hangup();

    return response.toString();
  }

  if (verdict === "RED") {
    response.say(
      "This call cannot be connected. Goodbye."
    );

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

  // Generate instructions based on the verdict
  const twiml = buildVerdictTwiml(
    verdict,
    protectedNumber
  );

  // Update the active Twilio call
  const updatedCall = await client.calls(callSid).update({
    twiml,
  });

  console.log("Call updated:", updatedCall.sid);
  console.log("Verdict applied:", verdict);
}
