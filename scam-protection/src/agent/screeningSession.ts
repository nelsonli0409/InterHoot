
import {
  createConversation,
  getNextAgentLine,
  receiveCallerResponse,
  generateVerdict,
  type ConversationState,
  type CallVerdict,
} from "./conversation.js";

import {
  createCallTranscript,
  addTranscriptMessage,
  getTranscriptMessages,
  removeCallTranscript,
  type TranscriptMessage,
} from "./callTranscripts.js";

// Represents one complete screening session
export type ScreeningSession = {
  callSid: string;
  conversation: ConversationState;
};

// Store active screening sessions
const screeningSessions = new Map<string, ScreeningSession>();

// Start a new screening session
export function createScreeningSession(
  callSid: string
): ScreeningSession {
  if (screeningSessions.has(callSid)) {
    throw new Error("Screening session already exists.");
  }

  const conversation = createConversation();

  createCallTranscript(callSid);

  const session: ScreeningSession = {
    callSid,
    conversation,
  };

  screeningSessions.set(callSid, session);

  return session;
}

// Generate the next question and record it
export function askNextQuestion(
  callSid: string
): string {
  const session = screeningSessions.get(callSid);

  if (!session) {
    throw new Error("Screening session not found.");
  }

  const previousStage = session.conversation.stage;
  const previousFollowupCount =
    session.conversation.followupCount;

  const question = getNextAgentLine(
    session.conversation
  );

  // Record only newly generated questions.
  // Don't record internal waiting messages.
  const isNewQuestion =
    (previousStage === "greeting" ||
      (previousStage === "followup" &&
        session.conversation.followupCount >
          previousFollowupCount));

  if (isNewQuestion) {
    addTranscriptMessage(callSid, "agent", question);
  }

  return question;
}

// Process a caller response and record it
export function submitCallerResponse(
  callSid: string,
  response: string
): void {
  const session = screeningSessions.get(callSid);

  if (!session) {
    throw new Error("Screening session not found.");
  }

  const wasWaiting =
    session.conversation.waitingForResponse;

  const trimmedResponse = response.trim();

  receiveCallerResponse(
    session.conversation,
    trimmedResponse
  );

  // Only record accepted responses
  if (wasWaiting && trimmedResponse) {
    addTranscriptMessage(
      callSid,
      "caller",
      trimmedResponse
    );
  }
}

// Generate the final screening verdict
export function getScreeningVerdict(
  callSid: string
): CallVerdict {
  const session = screeningSessions.get(callSid);

  if (!session) {
    throw new Error("Screening session not found.");
  }

  return generateVerdict(session.conversation);
}

// Retrieve the screening transcript
export function getScreeningTranscript(
  callSid: string
): TranscriptMessage[] {
  return getTranscriptMessages(callSid);
}

// Clean up a completed screening session
export function removeScreeningSession(
  callSid: string
): boolean {
  removeCallTranscript(callSid);

  return screeningSessions.delete(callSid);
}

// Count active screening sessions
export function getActiveScreeningCount(): number {
  return screeningSessions.size;
}
