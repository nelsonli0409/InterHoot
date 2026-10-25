
export type ConversationStage =
  | "greeting"
  | "identifying"
  | "followup"
  | "verdict";

export type CallVerdict = "GREEN" | "YELLOW" | "RED";

export type ConversationState = {
  stage: ConversationStage;
  callerName: string | null;
  callerReason: string | null;
  followupCount: number;
  waitingForResponse: boolean;
  callerResponses: string[];
};

// Create a new conversation
export function createConversation(): ConversationState {
  return {
    stage: "greeting",
    callerName: null,
    callerReason: null,
    followupCount: 0,
    waitingForResponse: false,
    callerResponses: [],
  };
}

// Generate InterHoot's next line
export function getNextAgentLine(
  conversation: ConversationState
): string {
  // Greeting
  if (conversation.stage === "greeting") {
    conversation.stage = "identifying";
    conversation.waitingForResponse = true;

    return "Hello! This is InterHoot. May I ask who's calling and why?";
  }

  // Wait for the caller to introduce themselves
  if (conversation.stage === "identifying") {
    return "Waiting for caller response...";
  }

  // Follow-up questions
  if (conversation.stage === "followup") {
    if (conversation.waitingForResponse) {
      return "Waiting for caller response...";
    }

    const questions = [
      "What organization are you calling from?",
      "Can you explain why you need to contact this person?",
      "Is there an official phone number where your organization can be reached?",
    ];

    // Ask the next follow-up question
    if (conversation.followupCount < questions.length) {
      const question = questions[conversation.followupCount];

      conversation.followupCount++;
      conversation.waitingForResponse = true;

      return question;
    }

    // All follow-up questions have been answered
    conversation.stage = "verdict";

    return "Thank you. I have enough information to review this call.";
  }

  return "The conversation is ready for a verdict.";
}

// Receive and store caller responses
export function receiveCallerResponse(
  conversation: ConversationState,
  response: string
): void {
  const answer = response.trim();

  // Ignore empty or unexpected responses
  if (!answer || !conversation.waitingForResponse) {
    return;
  }

  // Store the caller's introduction
  if (conversation.stage === "identifying") {
    conversation.callerReason = answer;
    conversation.callerResponses.push(answer);

    conversation.waitingForResponse = false;
    conversation.stage = "followup";

    return;
  }

  // Store follow-up answers
  if (conversation.stage === "followup") {
    conversation.callerResponses.push(answer);
    conversation.waitingForResponse = false;
  }
}

// Generate a mock call verdict
export function generateVerdict(
  conversation: ConversationState
): CallVerdict {
  if (conversation.stage !== "verdict") {
    throw new Error("Conversation is not ready for a verdict.");
  }

  // Combine all caller responses
  const transcript = conversation.callerResponses
    .join(" ")
    .toLowerCase();

  // High-risk keywords
  const redFlags = [
    "gift card",
    "send money",
    "password",
    "verification code",
  ];

  // Potentially suspicious keywords
  const yellowFlags = [
    "suspicious transaction",
    "urgent",
    "account problem",
  ];

  // Check for RED indicators first
  if (redFlags.some((flag) => transcript.includes(flag))) {
    return "RED";
  }

  // Check for YELLOW indicators
  if (yellowFlags.some((flag) => transcript.includes(flag))) {
    return "YELLOW";
  }

  // No matching keywords
  return "GREEN";
}
