// Simulated call through media.ts: Twilio's WebSocket events are faked, and Cartesia,
// the brain and Twilio's REST API are mocked. Checks the order of the call flow only.
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import twilio from "twilio";
import WebSocket from "ws";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  stts: [] as { language?: string; onUtterance: (text: string) => void; audio: number }[],
  speech: [] as { text: string; language: string }[],
  verdicts: [] as { callSid: string; verdict: string; forwardTo?: string }[],
  messages: [] as { callSid: string; message: string }[],
  turns: [] as { followUpsAsked: number }[],
  turnReply: null as null | { nextAgentLine: string; callerLanguage: string; scamProbability: number },
  screenReply: null as null | Record<string, unknown>,
  screenArgs: [] as Record<string, unknown>[],
  language: "en",
}));

vi.mock("../src/agent/cartesiaTTS.js", () => ({
  generateSpeech: async (text: string, _signal: AbortSignal, language = "en") => {
    mocks.speech.push({ text, language });
    return Buffer.from([0xff, 0xff, 0xff, 0xff]);
  },
}));

vi.mock("../src/agent/cartesiaSTT.js", () => ({
  CartesiaSTT: class {
    entry: { language?: string; onUtterance: (text: string) => void; audio: number };
    constructor(_sid: string, onUtterance: (text: string) => void, options: { language?: string } = {}) {
      this.entry = { language: options.language, onUtterance, audio: 0 };
      mocks.stts.push(this.entry);
    }
    connect() {}
    sendAudio() {
      this.entry.audio++;
    }
    close() {}
  },
}));

vi.mock("../src/telephony/callActions.js", () => ({
  applyCallVerdict: async (callSid: string, verdict: string, forwardTo?: string) => {
    mocks.verdicts.push({ callSid, verdict, forwardTo });
  },
}));

vi.mock("../src/telephony/brainClient.js", () => ({
  getCallContext: async () => ({ language: mocks.language }),
  nextTurn: async (args: { followUpsAsked: number }) => {
    mocks.turns.push({ followUpsAsked: args.followUpsAsked });
    return mocks.turnReply;
  },
  screenWithBrain: async (args: Record<string, unknown>) => {
    mocks.screenArgs.push(args);
    return mocks.screenReply;
  },
  sendCallMessage: async (callSid: string, message: string) => {
    mocks.messages.push({ callSid, message });
    return true;
  },
  toCallVerdict: (flag: string) => flag.toUpperCase(),
}));

import { setupMediaWebSocket } from "../src/telephony/media.js";

const AUTH_TOKEN = "test-auth-token";
let server: Server;
let mediaUrl: string;

beforeAll(async () => {
  server = createServer();
  setupMediaWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  mediaUrl = `ws://127.0.0.1:${port}/media`;
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.TWILIO_MEDIA_URL = mediaUrl;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  mocks.stts.length = 0;
  mocks.speech.length = 0;
  mocks.verdicts.length = 0;
  mocks.messages.length = 0;
  mocks.turns.length = 0;
  mocks.screenArgs.length = 0;
});

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

// Opens a fake Twilio stream and returns helpers to play back marks and send caller audio.
async function startCall(callSid: string) {
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, mediaUrl, {});
  const ws = new WebSocket(mediaUrl, { headers: { "x-twilio-signature": signature } });
  const marks: string[] = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.event === "mark" && message.mark.name.startsWith("interhoot-question-")) {
      marks.push(message.mark.name);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ event: "connected" }));
  ws.send(JSON.stringify({
    event: "start",
    start: { callSid, streamSid: `MZ${callSid}`, customParameters: { from: "+14155550100" } },
  }));

  let played = 0;
  // Waits for the next line, "plays" it, and sends one audio frame so STT gets something.
  const hearNextLine = async () => {
    await until(() => marks.length > played, `line ${played + 1}`);
    const name = marks[played++];
    ws.send(JSON.stringify({ event: "mark", mark: { name } }));
    await new Promise((r) => setTimeout(r, 20));
    ws.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: Buffer.from([0xff, 0xff]).toString("base64") } }));
    await new Promise((r) => setTimeout(r, 20));
  };
  return { ws, hearNextLine };
}

describe("simulated call through media.ts", () => {
  it("Spanish user: bilingual greeting, Gemini follow-ups, yellow message, then hang up", async () => {
    mocks.language = "es";
    mocks.turnReply = { nextAgentLine: "¿De qué banco llama?", callerLanguage: "es", scamProbability: 0.5 };
    mocks.screenReply = { flag: "yellow", score: 0.5, reasons: [], summary: "s", forwardTo: null, messagePending: true };

    const { ws, hearNextLine } = await startCall("CA1");

    await hearNextLine();
    expect(mocks.speech.map((s) => s.language)).toEqual(["es", "en"]);
    expect(mocks.stts[0].language).toBe("es");

    mocks.stts[0].onUtterance("Hola, llamo del banco sobre su tarjeta.");
    for (let i = 0; i < 3; i++) {
      await hearNextLine();
      expect(mocks.speech.at(-1)).toEqual({ text: "¿De qué banco llama?", language: "es" });
      mocks.stts[0].onUtterance(`Respuesta ${i + 1}`);
    }
    expect(mocks.turns.map((t) => t.followUpsAsked)).toEqual([0, 1, 2]);

    // Verdict: yellow, so the agent asks for a message on a fresh STT connection.
    await hearNextLine();
    expect(mocks.screenArgs[0].deferYellowNotify).toBe(true);
    expect(mocks.speech.at(-1)?.language).toBe("es");
    expect(mocks.stts).toHaveLength(2);
    expect(mocks.stts[1].audio).toBeGreaterThan(0);
    mocks.stts[1].onUtterance("Llámeme al banco, por favor.");

    await until(() => mocks.verdicts.length === 1, "the verdict");
    expect(mocks.messages).toEqual([{ callSid: "CA1", message: "Llámeme al banco, por favor." }]);
    expect(mocks.verdicts[0].verdict).toBe("YELLOW");
    ws.close();
  });

  it("brain without Gemini: A's fixed English questions, green, no message", async () => {
    mocks.language = "en";
    mocks.turnReply = null;
    mocks.screenReply = { flag: "green", score: 0.1, reasons: [], summary: "s", forwardTo: "+14155550199", messagePending: false };

    const { ws, hearNextLine } = await startCall("CA2");

    await hearNextLine();
    expect(mocks.speech).toEqual([{ text: "Hello! This is InterHoot. May I ask who's calling and why?", language: "en" }]);

    const answers = ["Hi, this is Dr. Lee's dental office.", "Dental Care Clinic", "To confirm your cleaning appointment tomorrow.", "Our number is 415 555 0199."];
    mocks.stts[0].onUtterance(answers[0]);
    for (let i = 1; i < answers.length; i++) {
      await hearNextLine();
      mocks.stts[0].onUtterance(answers[i]);
    }
    expect(mocks.speech.slice(1).map((s) => s.text)).toEqual([
      "What organization are you calling from?",
      "Can you explain why you need to contact this person?",
      "Is there an official phone number where your organization can be reached?",
    ]);

    await until(() => mocks.verdicts.length === 1, "the verdict");
    expect(mocks.verdicts[0]).toEqual({ callSid: "CA2", verdict: "GREEN", forwardTo: "+14155550199" });
    expect(mocks.messages).toEqual([]);
    expect(mocks.stts).toHaveLength(1);
    ws.close();
  });

  it("Gemini ends the questions early: no more questions, the score decides (yellow here), message taken", async () => {
    mocks.language = "en";
    mocks.turnReply = { nextAgentLine: "Thank you. Mr. Slavny will review his statements and call the bank directly.", callerLanguage: "en", scamProbability: 0.2 };
    mocks.screenReply = { flag: "yellow", score: 0.2, reasons: [], summary: "s", forwardTo: null, messagePending: true };

    const { ws, hearNextLine } = await startCall("CA4");
    await hearNextLine();
    mocks.stts[0].onUtterance("Hi, this is the bank. Your monthly statement is ready.");

    // The next line is the message prompt, not Gemini's closing line or another question.
    await hearNextLine();
    expect(mocks.turns).toHaveLength(1);
    expect(mocks.screenArgs[0].noGreen).toBeUndefined();
    expect(mocks.screenArgs[0].fallbackVerdict).toBe("YELLOW");
    expect(mocks.speech.map((s) => s.text)).not.toContain(mocks.turnReply.nextAgentLine);
    expect(mocks.stts).toHaveLength(2);
    mocks.stts[1].onUtterance("Please call us back.");

    await until(() => mocks.verdicts.length === 1, "the verdict");
    expect(mocks.messages).toEqual([{ callSid: "CA4", message: "Please call us back." }]);
    expect(mocks.verdicts[0].verdict).toBe("YELLOW");
    ws.close();
  });

  it("caller hangs up while leaving a message: the message call still goes out", async () => {
    mocks.language = "en";
    mocks.turnReply = { nextAgentLine: "Which account is this about?", callerLanguage: "en", scamProbability: 0.6 };
    mocks.screenReply = { flag: "yellow", score: 0.5, reasons: [], summary: "s", forwardTo: null, messagePending: true };

    const { ws, hearNextLine } = await startCall("CA3");
    await hearNextLine();
    mocks.stts[0].onUtterance("You won a prize.");
    for (let i = 0; i < 3; i++) {
      await hearNextLine();
      mocks.stts[0].onUtterance("I can't say.");
    }
    await until(() => mocks.stts.length === 2, "the message prompt");
    ws.send(JSON.stringify({ event: "stop" }));

    await until(() => mocks.messages.length === 1, "the message call");
    expect(mocks.messages[0]).toEqual({ callSid: "CA3", message: "" });
    ws.close();
  });
});
