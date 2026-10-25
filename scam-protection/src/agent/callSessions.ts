
import {
  createConversation,
  type ConversationState,
} from "./conversation.js";

// Store active call sessions in memory
const callSessions = new Map<string, ConversationState>();

// Create a new session for a call
export function createCallSession(
  callSid: string
): ConversationState {
  if (callSessions.has(callSid)) {
    throw new Error("A session already exists for this call.");
  }

  const conversation = createConversation();

  callSessions.set(callSid, conversation);

  return conversation;
}

// Retrieve an existing call session
export function getCallSession(
  callSid: string
): ConversationState | undefined {
  return callSessions.get(callSid);
}

// Remove a session after a call ends
export function removeCallSession(
  callSid: string
): boolean {
  return callSessions.delete(callSid);
}

// Count active sessions
export function getActiveCallCount(): number {
  return callSessions.size;
}
