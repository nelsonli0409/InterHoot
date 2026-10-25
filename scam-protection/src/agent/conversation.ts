
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

  // Answer validation
  clarificationAttempts: number;
  needsClarification: boolean;
  unverifiedAnswers: number;
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

    clarificationAttempts: 0,
    needsClarification: false,
    unverifiedAnswers: 0,
  };
}

// Check whether an answer satisfies the question.
// These checks validate basic format, not caller identity.
function isValidAnswer(
  questionIndex: number,
  answer: string
): boolean {
  const text = answer.toLowerCase().trim();

  if (!text) {
    return false;
  }

  // Question 1: Organization
  if (questionIndex === 0) {
    return text.length >= 3;
  }

  // Question 2: Reason for calling
  if (questionIndex === 1) {
    return text.length >= 10;
  }

  // Question 3: Official phone number
  if (questionIndex === 2) {
    const digits = text.replace(/\D/g, "");

    return digits.length >= 10;
  }

  return false;
}

// Generate InterHoot's next line
export function getNextAgentLine(
  conversation: ConversationState
): string {
  // Initial greeting
  if (conversation.stage === "greeting") {
    conversation.stage = "identifying";
    conversation.waitingForResponse = true;

    return "Hello! This is InterHoot. May I ask who's calling and why?";
  }

  // Wait for the caller's introduction
  if (conversation.stage === "identifying") {
    return "Waiting for caller response...";
  }

  // Follow-up questions
  if (conversation.stage === "followup") {
    if (conversation.waitingForResponse) {
      return "Waiting for caller response...";
    }

    // Repeat the current question if clarification is needed.
    if (conversation.needsClarification) {
      conversation.needsClarification = false;
      conversation.waitingForResponse = true;

      const clarificationQuestions = [
        "Could you please tell me the name of the organization you are calling from?",
        "Could you explain the specific reason for your call?",
        "Could you provide an official phone number for your organization, including the area code?",
      ];

      const questionIndex = conversation.followupCount - 1;

      return clarificationQuestions[questionIndex];
    }

    const questions = [
      "What organization are you calling from?",
      "Can you explain why you need to contact this person?",
      "Is there an official phone number where your organization can be reached?",
    ];

    // Ask the next follow-up question.
    if (conversation.followupCount < questions.length) {
      const question = questions[conversation.followupCount];

      conversation.followupCount++;
      conversation.waitingForResponse = true;

      return question;
    }

    // All follow-up questions have been processed.
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

  // Ignore empty or unexpected responses.
  if (!answer || !conversation.waitingForResponse) {
    return;
  }

  // Store caller introduction.
  if (conversation.stage === "identifying") {
    conversation.callerReason = answer;
    conversation.callerResponses.push(answer);

    conversation.waitingForResponse = false;
    conversation.stage = "followup";

    return;
  }

  // Process follow-up answers.
  if (conversation.stage === "followup") {
    const questionIndex = conversation.followupCount - 1;

    // Save every answer for risk assessment.
    conversation.callerResponses.push(answer);

    const valid = isValidAnswer(questionIndex, answer);

    if (valid) {
      conversation.clarificationAttempts = 0;
      conversation.needsClarification = false;
      conversation.waitingForResponse = false;

      console.log(
        "Caller answer accepted for question:",
        questionIndex + 1
      );

      return;
    }

    conversation.clarificationAttempts++;

    console.log(
      "Caller answer needs clarification:",
      questionIndex + 1,
      "Attempt:",
      conversation.clarificationAttempts
    );

    if (conversation.clarificationAttempts <= 2) {
      conversation.needsClarification = true;
      conversation.waitingForResponse = false;
      return;
    }

    // Move on after repeated unsuccessful answers,
    // but record that the question was not verified.
    conversation.unverifiedAnswers++;

    conversation.clarificationAttempts = 0;
    conversation.needsClarification = false;
    conversation.waitingForResponse = false;

    console.log(
      "Question marked unverified:",
      questionIndex + 1
    );
  }
}

// Generate a preliminary, rule-based call verdict.
// This is not a substitute for identity verification.

export function generateVerdict(
  conversation: ConversationState
): CallVerdict {
  if (conversation.stage !== "verdict") {
    throw new Error(
      "Conversation is not ready for a verdict."
    );
  }

  // Combine all caller responses.
  const transcript = conversation.callerResponses
    .join(" ")
    .toLowerCase();

  // High-risk keywords.
  const redFlags = [
    "gift card",
    "send money",
    "password",
    "verification code",
    "one time code",
    "one-time code",
    "otp",
    "wire transfer",
    "transfer money",
    "bank login",
    "social security number",
  ];

  // Potentially suspicious keywords.
  const yellowFlags = [
    "suspicious transaction",
    "unauthorized transaction",
    "fraudulent transaction",
    "urgent",
    "account problem",
    "account balance",
    "bank account",
    "citibank",
    "bank of russia",
    "account number",
    "security alert",
  ];

  // RED: High-risk indicators detected.
  if (
    redFlags.some((flag) =>
      transcript.includes(flag)
    )
  ) {
    console.log("Screening verdict: RED");
    return "RED";
  }

  // YELLOW: Suspicious indicators detected.
  if (
    yellowFlags.some((flag) =>
      transcript.includes(flag)
    )
  ) {
    console.log("Screening verdict: YELLOW");
    return "YELLOW";
  }

  // YELLOW: Caller failed to answer a question
  // after the allowed clarification attempts.
  if (conversation.unverifiedAnswers > 0) {
    console.log(
      "Unverified answers:",
      conversation.unverifiedAnswers
    );

    return "YELLOW";
  }

  // YELLOW: Missing screening responses.
  // There should be at least four:
  // one introduction and three follow-up answers.
  if (conversation.callerResponses.length < 4) {
    console.log("Incomplete screening responses.");
    return "YELLOW";
  }

  // GREEN: All screening checks passed.
  // WARNING: This is for controlled testing only.
  // It does not independently verify caller identity.
  console.log(
    "Screening verdict: GREEN (test approval)"
  );

  return "GREEN";
}
