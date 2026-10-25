
import {
  createConversation,
  getNextAgentLine,
  receiveCallerResponse,
  generateVerdict,
  type ConversationState,
  type CallVerdict,
  type NextLineOptions,
} from "./conversation.js";

import type { ScreeningLanguage } from "./screeningLanguages.js";

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
  callSid: string,
  language?: ScreeningLanguage
): ScreeningSession {
  if (screeningSessions.has(callSid)) {
    throw new Error("Screening session already exists.");
  }

  const conversation = createConversation(language);

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
  callSid: string,
  options?: NextLineOptions
): string {
  const session = screeningSessions.get(callSid);

  if (!session) {
    throw new Error("Screening session not found.");
  }

  const previousStage = session.conversation.stage;
  const previousFollowupCount =
    session.conversation.followupCount;

  const question = getNextAgentLine(
    session.conversation,
    options
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

// Whether the next line is the greeting
export function isAtGreeting(callSid: string): boolean {
  return screeningSessions.get(callSid)?.conversation.stage === "greeting";
}

// When the next line is a new follow-up question (not a clarification
// or the end), how many follow-ups were asked before it. Otherwise null.
export function getFollowUpState(
  callSid: string
): { followUpsAsked: number } | null {
  const conversation = screeningSessions.get(callSid)?.conversation;

  if (
    !conversation ||
    conversation.stage !== "followup" ||
    conversation.waitingForResponse ||
    conversation.needsClarification ||
    conversation.followupCount >= 3
  ) {
    return null;
  }

  return { followUpsAsked: conversation.followupCount };
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
