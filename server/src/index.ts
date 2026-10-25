import express from "express";
import { preloadTradelines } from "./crs/crs.js";
import { getUserPersona } from "./crs/personas.js";
import type { Flag, TranscriptTurn } from "./brain/types.js";
import { DEFAULT_USER_ID, precheck, screenCall } from "./pipeline/screenCall.js";
import { setStore } from "./storage/index.js";
import { SpacetimeStore } from "./storage/spacetime.js";

// The brain service. A's telephony server (scam-protection/, port 3000) calls it on localhost.
// It listens on BRAIN_PORT so both servers can share one .env with PORT=3000.
const app = express();
const PORT = Number(process.env.BRAIN_PORT) || 3001;

// Repeat, velocity and scam_pattern checks, call logs and flagged numbers all go to SpacetimeDB.
setStore(new SpacetimeStore());

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "interhoot-server" });
});

const FLAGS: Flag[] = ["green", "yellow", "red"];
const asFlag = (v: unknown): Flag | undefined => (FLAGS.includes(v as Flag) ? (v as Flag) : undefined);

// When the call rings: { callSid, from } → { action: "reject" | "screen", reason }
app.post("/precheck", async (req, res) => {
  const { callSid, from } = req.body ?? {};
  if (typeof callSid !== "string" || !callSid) {
    res.status(400).json({ error: "callSid is required" });
    return;
  }
  res.json(await precheck(callSid, typeof from === "string" ? from : ""));
});

// When A's questions are done: { callSid, from, transcript: [{ role, text }], fallbackFlag?, forceFlag? }
app.post("/screen-call", async (req, res) => {
  const { callSid, from, transcript, fallbackFlag, forceFlag, startedAt } = req.body ?? {};
  if (typeof callSid !== "string" || !callSid || !Array.isArray(transcript)) {
    res.status(400).json({ error: "callSid and transcript are required" });
    return;
  }
  const turns: TranscriptTurn[] = transcript
    .filter((m: any) => (m?.role === "agent" || m?.role === "caller") && typeof m?.text === "string")
    .map((m: any) => ({ speaker: m.role, text: m.text }));
  try {
    res.json(
      await screenCall({
        callId: callSid,
        from: typeof from === "string" ? from : "",
        transcript: turns,
        fallbackFlag: asFlag(fallbackFlag),
        forceFlag: asFlag(forceFlag),
        startedAt: typeof startedAt === "number" ? startedAt : undefined,
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
