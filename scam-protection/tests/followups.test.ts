import {
  describe,
  it,
  expect,
} from "vitest";

import {
  createConversation,
  getNextAgentLine,
  receiveCallerResponse,
} from "../src/agent/conversation.js";

import {
  getGreetingParts,
  toScreeningLanguage,
} from "../src/agent/screeningLanguages.js";

import { chooseSttModel, whisperUrl } from "../src/agent/cartesiaSTT.js";

describe("Gemini follow-ups and languages", () => {
  it("greets in the user's language, then English", () => {
    const conversation = createConversation("es");

    expect(getNextAgentLine(conversation)).toBe(
      "¡Hola! Soy InterHoot. ¿Me puede decir quién llama y por qué? " +
        "Hello! This is InterHoot. May I ask who's calling and why?"
    );

    expect(getGreetingParts("es").map((part) => part.language)).toEqual(["es", "en"]);
    expect(getGreetingParts("en")).toHaveLength(1);
  });

  it("asks Gemini's line instead of the fixed question, and takes any answer to it", () => {
    const conversation = createConversation();

    getNextAgentLine(conversation);
    receiveCallerResponse(conversation, "Hi, this is Chase about your card.");

    const line = getNextAgentLine(conversation, {
      followUp: "Which card are you calling about?",
    });

    expect(line).toBe("Which card are you calling about?");

    // Too short for A's organization rule, but Gemini's question has no format rule.
    receiveCallerResponse(conversation, "Visa");

    expect(conversation.needsClarification).toBe(false);
    expect(conversation.followupCount).toBe(1);
  });

  it("falls back to the fixed question in the caller's language", () => {
    const conversation = createConversation("es");

    getNextAgentLine(conversation);
    receiveCallerResponse(conversation, "Hola, llamo del banco.");

    expect(getNextAgentLine(conversation, { language: "es" })).toBe(
      "¿De qué organización llama?"
    );
  });

  it("keeps A's English questions and checks when there is no Gemini line", () => {
    const conversation = createConversation();

    getNextAgentLine(conversation);
    receiveCallerResponse(conversation, "Hello, it's the dentist.");

    expect(getNextAgentLine(conversation)).toBe(
      "What organization are you calling from?"
    );

    receiveCallerResponse(conversation, "ab");

    expect(conversation.needsClarification).toBe(true);
  });

  it("maps language codes", () => {
    expect(toScreeningLanguage("es-MX")).toBe("es");
    expect(toScreeningLanguage("zh")).toBeNull();
  });

  it("picks ink-2 for its five languages and ink-whisper otherwise", () => {
    delete process.env.CARTESIA_STT_MODEL;

    expect(chooseSttModel("es")).toBe("ink-2");
    expect(chooseSttModel("en")).toBe("ink-2");
    expect(chooseSttModel("ko")).toBe("ink-whisper");
    expect(chooseSttModel(undefined)).toBe("ink-whisper");

    process.env.CARTESIA_STT_MODEL = "ink-whisper";
    expect(chooseSttModel("es")).toBe("ink-whisper");
    delete process.env.CARTESIA_STT_MODEL;
  });

  it("tells ink-whisper which language to listen for", () => {
    expect(new URL(whisperUrl("ru")).searchParams.get("language")).toBe("ru");
    expect(new URL(whisperUrl("ko-KR")).searchParams.get("language")).toBe("ko");
    expect(new URL(whisperUrl(undefined)).searchParams.get("language")).toBe("en");
  });
});
