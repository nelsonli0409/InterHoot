
import {
  getCallSession,
  removeCallSession,
} from "./callSessions.js";

import {
  clearCallTimeout,
} from "./callTimeouts.js";

// Types of errors InterHoot may encounter
export type CallErrorType =
  | "WEBSOCKET_ERROR"
  | "TRANSCRIPTION_ERROR"
  | "DATABASE_ERROR"
  | "AI_ERROR"
  | "CALL_CONTROL_ERROR"
  | "UNKNOWN_ERROR";

// Information returned after handling an error
export type CallErrorResult = {
  callSid: string;
  errorType: CallErrorType;
  message: string;
  sessionRemoved: boolean;
  timerCancelled: boolean;
};

// Safely convert an unknown error into a message
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

// Handle a failure for a specific call
export function handleCallError(
  callSid: string,
  errorType: CallErrorType,
  error: unknown
): CallErrorResult {
  const message = getErrorMessage(error);

  console.error(
    `[${errorType}] Call ${callSid}: ${message}`
  );

  // Cancel any active screening timeout
  const timerCancelled = clearCallTimeout(callSid);

  // Remove the conversation session
  const sessionRemoved = removeCallSession(callSid);

  console.log("Call error cleanup:", {
    callSid,
    timerCancelled,
    sessionRemoved,
  });

  return {
    callSid,
    errorType,
    message,
    sessionRemoved,
    timerCancelled,
  };
}

// Check whether a call still has an active session
export function isCallSessionActive(
  callSid: string
): boolean {
  return getCallSession(callSid) !== undefined;
}
