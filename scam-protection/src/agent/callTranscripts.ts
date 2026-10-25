
export type TranscriptRole = "agent" | "caller";

export type TranscriptMessage = {
  role: TranscriptRole;
  text: string;
  timestamp: number;
};

export type CallTranscript = {
  callSid: string;
  messages: TranscriptMessage[];
};

// Store transcripts by Twilio Call SID
const transcripts = new Map<string, CallTranscript>();

// Create a transcript when a call starts
export function createCallTranscript(
  callSid: string
): CallTranscript {
  if (transcripts.has(callSid)) {
    throw new Error(
      "A transcript already exists for this call."
    );
  }

  const transcript: CallTranscript = {
    callSid,
    messages: [],
  };

  transcripts.set(callSid, transcript);

  return transcript;
}

// Retrieve an existing transcript
export function getCallTranscript(
  callSid: string
): CallTranscript | undefined {
  return transcripts.get(callSid);
}

// Add a new message to the transcript
export function addTranscriptMessage(
  callSid: string,
  role: TranscriptRole,
  text: string
): TranscriptMessage {
  const transcript = transcripts.get(callSid);

  if (!transcript) {
    throw new Error(
      "No transcript exists for this call."
    );
  }

  const trimmedText = text.trim();

  if (!trimmedText) {
    throw new Error(
      "Transcript message cannot be empty."
    );
  }

  const message: TranscriptMessage = {
    role,
    text: trimmedText,
    timestamp: Date.now(),
  };

  transcript.messages.push(message);

  return message;
}

// Return a copy of all messages
export function getTranscriptMessages(
  callSid: string
): TranscriptMessage[] {
  const transcript = transcripts.get(callSid);

  if (!transcript) {
    return [];
  }

  return transcript.messages.map((message) => ({
    ...message,
  }));
}

// Convert the transcript into readable text
export function formatCallTranscript(
  callSid: string
): string {
  const messages = getTranscriptMessages(callSid);

  return messages
    .map((message) => {
      const speaker =
        message.role === "agent"
          ? "InterHoot"
          : "Caller";

      return `${speaker}: ${message.text}`;
    })
    .join("\n");
}

// Delete a transcript
export function removeCallTranscript(
  callSid: string
): boolean {
  return transcripts.delete(callSid);
}

// Count active transcripts
export function getActiveTranscriptCount(): number {
  return transcripts.size;
}
