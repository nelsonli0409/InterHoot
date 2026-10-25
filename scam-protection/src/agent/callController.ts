
import {
  generateVerdict,
  type ConversationState,
  type CallVerdict,
} from "./conversation.js";

import { buildVerdictTwiml } from "../telephony/callActions.js";

export type CallDecision = {
  verdict: CallVerdict;
  twiml: string;
};

export function evaluateCall(
  conversation: ConversationState,
  protectedNumber?: string
): CallDecision {
  // Step 1: Make sure the conversation is finished
  if (conversation.stage !== "verdict") {
    throw new Error("Conversation is not finished yet.");
  }

  // Step 2: Generate a verdict
  const verdict = generateVerdict(conversation);

  // Step 3: Generate Twilio instructions
  const twiml = buildVerdictTwiml(
    verdict,
    protectedNumber
  );

  // Step 4: Return the result
  return {
    verdict,
    twiml,
  };
}
