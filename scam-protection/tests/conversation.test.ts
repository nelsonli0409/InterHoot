
import {
  describe,
  it,
  expect,
} from "vitest";

import {
  createConversation,
  getNextAgentLine,
  receiveCallerResponse,
  generateVerdict,
  type ConversationState,
} from "../src/agent/conversation.js";

// Complete a conversation with four caller responses.
function completeConversation(
  responses: [string, string, string, string]
): ConversationState {
  const conversation = createConversation();

  // Greeting and introduction
  getNextAgentLine(conversation);
  receiveCallerResponse(conversation, responses[0]);

  // Three follow-up questions
  for (let i = 1; i < responses.length; i++) {
    getNextAgentLine(conversation);
    receiveCallerResponse(conversation, responses[i]);
  }

  // Transition to verdict stage
  getNextAgentLine(conversation);

  return conversation;
}

const validResponses: [
  string,
  string,
  string,
  string
] = [
  "Hello, I'm Alex calling about an appointment.",
  "Westside Dental",
  "I'm calling to confirm an appointment for next week.",
  "415-555-1234",
];

describe("Conversation initialization", () => {
  it("starts in the greeting stage", () => {
    const conversation = createConversation();

    expect(conversation.stage).toBe("greeting");
    expect(conversation.followupCount).toBe(0);
    expect(conversation.callerResponses).toEqual([]);
    expect(conversation.unverifiedAnswers).toBe(0);
  });

  it("starts by asking for caller identification", () => {
    const conversation = createConversation();

    const question = getNextAgentLine(conversation);

    expect(question).toContain("who's calling");
    expect(conversation.stage).toBe("identifying");
    expect(conversation.waitingForResponse).toBe(true);
  });
});

describe("Conversation flow", () => {
  it("moves from identification to follow-up", () => {
    const conversation = createConversation();

    getNextAgentLine(conversation);

    receiveCallerResponse(
      conversation,
      "I'm Alex calling about an appointment."
    );

    expect(conversation.stage).toBe("followup");
    expect(conversation.callerResponses).toHaveLength(1);
    expect(conversation.waitingForResponse).toBe(false);
  });

  it("asks three follow-up questions", () => {
    const conversation = completeConversation(
      validResponses
    );

    expect(conversation.followupCount).toBe(3);
    expect(conversation.stage).toBe("verdict");
    expect(conversation.callerResponses).toHaveLength(4);
  });

  it("ignores an unexpected response", () => {
    const conversation = createConversation();

    receiveCallerResponse(
      conversation,
      "This should be ignored"
    );

    expect(conversation.callerResponses).toHaveLength(0);
  });
});

describe("Answer validation", () => {
  it("accepts a valid organization", () => {
    const conversation = createConversation();

    getNextAgentLine(conversation);
    receiveCallerResponse(
      conversation,
      validResponses[0]
    );

    getNextAgentLine(conversation);
    receiveCallerResponse(
      conversation,
      "Westside Dental"
    );

    expect(conversation.needsClarification).toBe(false);
    expect(conversation.clarificationAttempts).toBe(0);
  });

  it("requests clarification for a short organization", () => {
    const conversation = createConversation();

    getNextAgentLine(conversation);
    receiveCallerResponse(
      conversation,
      validResponses[0]
    );

    getNextAgentLine(conversation);
    receiveCallerResponse(conversation, "A");

    expect(conversation.needsClarification).toBe(true);
    expect(conversation.clarificationAttempts).toBe(1);

    const nextQuestion = getNextAgentLine(conversation);

    expect(nextQuestion).toContain(
      "name of the organization"
    );
  });

  it("marks an answer unverified after three failed attempts", () => {
    const conversation = createConversation();

    getNextAgentLine(conversation);
    receiveCallerResponse(
      conversation,
      validResponses[0]
    );

    // Ask organization question.
    getNextAgentLine(conversation);

    for (let attempt = 0; attempt < 3; attempt++) {
      receiveCallerResponse(conversation, "A");

      if (attempt < 2) {
        getNextAgentLine(conversation);
      }
    }

    expect(conversation.unverifiedAnswers).toBe(1);
    expect(conversation.needsClarification).toBe(false);
    expect(conversation.clarificationAttempts).toBe(0);
  });

  it("accepts a phone number with at least ten digits", () => {
    const conversation = completeConversation(
      validResponses
    );

    expect(conversation.unverifiedAnswers).toBe(0);
    expect(conversation.stage).toBe("verdict");
  });
});

describe("Verdict generation", () => {
  it("returns GREEN for a completed low-risk test call", () => {
    const conversation = completeConversation(
      validResponses
    );

    expect(generateVerdict(conversation)).toBe("GREEN");
  });

  it("returns RED when the caller requests a password", () => {
    const responses = [...validResponses] as [
      string,
      string,
      string,
      string
    ];

    responses[2] =
      "I need your password to access your account.";

    const conversation = completeConversation(responses);

    expect(generateVerdict(conversation)).toBe("RED");
  });

  it("returns YELLOW for a suspicious transaction", () => {
    const responses = [...validResponses] as [
      string,
      string,
      string,
      string
    ];

    responses[2] =
      "I'm calling about a suspicious transaction.";

    const conversation = completeConversation(responses);

    expect(generateVerdict(conversation)).toBe("YELLOW");
  });

  it("prioritizes RED over YELLOW indicators", () => {
    const responses = [...validResponses] as [
      string,
      string,
      string,
      string
    ];

    responses[2] =
      "There is an urgent problem. Please send money.";

    const conversation = completeConversation(responses);

    expect(generateVerdict(conversation)).toBe("RED");
  });

  it("returns YELLOW when answers remain unverified", () => {
    const conversation = completeConversation(
      validResponses
    );

    conversation.unverifiedAnswers = 1;

    expect(generateVerdict(conversation)).toBe("YELLOW");
  });

  it("rejects verdict generation before screening ends", () => {
    const conversation = createConversation();

    expect(() => generateVerdict(conversation)).toThrow(
      "Conversation is not ready for a verdict."
    );
  });
});
