import express from "express";
import { aliasStore, setAliasStore, toE164 } from "./crs/alias.js";
import { preloadTradelines } from "./crs/crs.js";
import { getUserPersona } from "./crs/personas.js";
import type { Flag, TranscriptTurn } from "./brain/types.js";
import { addCallMessage, DEFAULT_USER_ID, getUserLanguage, nextTurn, precheck, screenCall } from "./pipeline/screenCall.js";
import { setStore } from "./storage/index.js";
import { SpacetimeStore } from "./storage/spacetime.js";

// The brain service. A's telephony server (scam-protection/, port 3000) calls it on localhost.
// It listens on BRAIN_PORT so both servers can share one .env with PORT=3000.
const app = express();
const PORT = Number(process.env.BRAIN_PORT) || 3001;

// Repeat, velocity and scam_pattern checks, call logs and flagged numbers all go to SpacetimeDB.
const store = new SpacetimeStore();
setStore(store);

// B3: demo aliases come from the demo_caller_alias table; the .env numbers (DEMO_*_PHONE) are the fallback.
const envAliases = aliasStore;
setAliasStore({
  async getAlias(e164) {
    const fromTable = await store.getPersonaPhone(toE164(e164)).catch((err) => {
      console.error("[alias] demo_caller_alias lookup failed:", (err as Error).message);
      return null;
    });
    return fromTable ?? envAliases.getAlias(e164);
  },
});

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "interhoot-server" });
});

const FLAGS: Flag[] = ["green", "yellow", "red"];
const asFlag = (v: unknown): Flag | undefined => (FLAGS.includes(v as Flag) ? (v as Flag) : undefined);

const toTurns = (transcript: unknown[]): TranscriptTurn[] =>
  transcript
    .filter((m: any) => (m?.role === "agent" || m?.role === "caller") && typeof m?.text === "string")
    .map((m: any) => ({ speaker: m.role, text: m.text }));

// Before the greeting: { callSid } → { language } (protected_user.language, A7)
app.post("/call-context", async (_req, res) => {
  res.json({ language: await getUserLanguage(DEFAULT_USER_ID) });
});

// Before each follow-up: { callSid, transcript: [{ role, text }], followUpsAsked } → Gemini's next line (A5)
app.post("/turn", async (req, res) => {
  const { callSid, transcript, followUpsAsked } = req.body ?? {};
  if (typeof callSid !== "string" || !callSid || !Array.isArray(transcript)) {
    res.status(400).json({ error: "callSid and transcript are required" });
    return;
  }
  try {
    res.json(await nextTurn(callSid, toTurns(transcript), Number(followUpsAsked) || 0));
  } catch (err) {
    console.error(`[turn] ${callSid}:`, (err as Error).message);
    res.status(502).json({ error: (err as Error).message });
  }
});

// Yellow calls, after the verdict: { callSid, message } → the message joins the log and the push goes out
app.post("/call-message", async (req, res) => {
  const { callSid, message } = req.body ?? {};
  if (typeof callSid !== "string" || !callSid) {
    res.status(400).json({ error: "callSid is required" });
    return;
  }
  res.json({ ok: await addCallMessage(callSid, typeof message === "string" ? message : "") });
});

// When the call rings: { callSid, from } → { action: "reject" | "screen", reason }
app.post("/precheck", async (req, res) => {
  const { callSid, from } = req.body ?? {};
  if (typeof callSid !== "string" || !callSid) {
    res.status(400).json({ error: "callSid is required" });
    return;
  }
  res.json(await precheck(callSid, typeof from === "string" ? from : ""));
});

// When A's questions are done: { callSid, from, transcript: [{ role, text }], fallbackFlag?, forceFlag?, deferYellowNotify? }
app.post("/screen-call", async (req, res) => {
  const { callSid, from, transcript, fallbackFlag, forceFlag, startedAt, deferYellowNotify } = req.body ?? {};
  if (typeof callSid !== "string" || !callSid || !Array.isArray(transcript)) {
    res.status(400).json({ error: "callSid and transcript are required" });
    return;
  }
  try {
    res.json(
      await screenCall({
        callId: callSid,
        from: typeof from === "string" ? from : "",
        transcript: toTurns(transcript),
        fallbackFlag: asFlag(fallbackFlag),
        forceFlag: asFlag(forceFlag),
        startedAt: typeof startedAt === "number" ? startedAt : undefined,
        deferYellowNotify: deferYellowNotify === true,
      }),
    );
  } catch (err) {
    console.error(`[screen-call] ${callSid}:`, (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Localhost only: nothing outside this machine needs the brain directly.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`InterHoot brain listening on 127.0.0.1:${PORT}`);
  // B2: pull the protected user's tradelines once; the sandbox file never changes.
  void preloadTradelines(getUserPersona(DEFAULT_USER_ID));
});
