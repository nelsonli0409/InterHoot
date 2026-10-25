# InterHoot

InterHoot answers phone calls before they reach an older or immigrant user. It screens each caller by voice in the user's language, checks the caller's claims against the user's credit file, and flags the call green, yellow or red. Green calls ring through. Yellow callers leave a message, and the user gets a push. Red callers are hung up on, and their number is blocked on the iPhone and rejected from then on.

## How a call works

1. The caller dials the InterHoot Twilio number. `scam-protection/` answers. It rejects hidden caller IDs and numbers already flagged red, so those calls never ring.
2. The agent greets in the user's language, then in English. It asks who's calling and why.
3. Gemini reads the conversation after each answer and writes the next follow-up question in the caller's language. There are three follow-ups. If Gemini is slow or down, the agent asks A's fixed questions instead.
4. The brain (`server/`) scores the call. It uses Gemini's analysis, a CRS check on the caller (demo aliases only), the claims checked against the user's CRS tradelines, call history, and known scam scripts.
5. What happens next depends on the flag:
   - **Green:** "Connecting you now", then the call is forwarded to the user's phone.
   - **Yellow:** the agent takes a short message and hangs up. The user gets a Time Sensitive push with the summary and the message.
   - **Red:** the call ends, and the user gets a push. The app reloads its Call Directory list so the number is blocked, and future calls get `<Reject>`.
6. Every call is written to SpacetimeDB (`call_log`, `flagged_number`) and to a JSONL copy on the server. The iOS app reads both tables.

| Folder | What | Owner |
| --- | --- | --- |
| `scam-protection/` | Telephony server (port 3000): Twilio webhook and media stream, Cartesia STT and TTS, the conversation loop | A |
| `server/` | Brain service (127.0.0.1:3001): Gemini, CRS, scoring (B), plus SpacetimeDB storage and APNs push (C) | B, C |
| `stdb/spacetimedb/` | SpacetimeDB module: tables and reducers | C |
| `ios/interhoot/` | SwiftUI app and Call Directory extension | C |

## Setup

You need Node 20+, the SpacetimeDB CLI, Xcode, a Twilio number, and keys for Cartesia, Gemini and the CRS sandbox.

1. **Keys.** Copy `.env.example` to `.env` in the repo root and fill it in. `.env`, `*.p8` and `.mcp.json` are gitignored. Never commit keys, paste them in chat, or put them in screenshots.
2. **Database.** Publish the module once: `cd stdb/spacetimedb && spacetime publish interhoot`. The database is `interhoot` on Maincloud.
3. **Brain.** Run `cd server && npm install && npm run dev`. It reads `../.env` and listens on `127.0.0.1:$BRAIN_PORT` (3001).
4. **Telephony.** Run `cd scam-protection && npm install && DOTENV_CONFIG_PATH=../.env npm run dev`. It listens on `$PORT` (3000).
5. **Tunnel.** Expose port 3000 over HTTPS, for example with a dev tunnel. Then:
   - Set `TWILIO_WEBHOOK_URL=https://<tunnel>/twilio/voice` and `TWILIO_MEDIA_URL=wss://<tunnel>/media` in `.env`. They're used to check Twilio's signatures.
   - In the Twilio console, set the number's "A call comes in" webhook to `https://<tunnel>/twilio/voice` (HTTP POST).
6. **iPhone.**
   - Open `ios/interhoot/interhoot.xcodeproj`, then build and run on the iPhone.
   - Finish onboarding: demo identity, language, and the phone number green calls are forwarded to.
   - Allow notifications.
   - Turn on InterHoot under Settings > Apps > Phone > Call Blocking & Identification.
7. **Demo aliases.** Map each teammate's demo phone to a CRS sandbox persona phone, for example P13 `5550101013` (scammer) or P01 `5550101001` (dentist):

   ```sh
   curl -X POST https://maincloud.spacetimedb.com/v1/database/interhoot/call/set_demo_caller_alias \
     -H 'Content-Type: application/json' -d '["+1XXXXXXXXXX","5550101013"]'
   ```

   `DEMO_SCAMMER_PHONE` and `DEMO_DENTIST_PHONE` in `.env` are the fallback.

**Checks:**
- `curl localhost:3000/health` checks the telephony server.
- `curl 127.0.0.1:3001/health` checks the brain.
- `cd scam-protection && npm test` runs the conversation, call-action and simulated-call tests.

## Cartesia features used

| Feature | Where | How |
| --- | --- | --- |
| Ink 2 realtime STT with built-in turn detection (`wss://api.cartesia.ai/stt/turns/websocket`) | `scam-protection/src/agent/cartesiaSTT.ts` | Used when the user's language is en, fr, hi, ja or es. Twilio's audio goes in unchanged (`pcm_mulaw`, 8000 Hz). Each `turn.end` event is one caller answer. |
| Ink Whisper realtime STT (`wss://api.cartesia.ai/stt/websocket`) | same file | Used for every other language. Also the automatic fallback if Ink 2 fails during a call. `CARTESIA_STT_MODEL` forces either model. |
| Sonic 3 TTS (`POST /tts/bytes`) | `scam-protection/src/agent/cartesiaTTS.ts` | Raw `pcm_mulaw` 8000 Hz audio, played straight into the Twilio stream, with a mark after each line. The `language` is set per line: the greeting in the user's language plus English, and Gemini's questions in the caller's language. |

## CRS endpoints used

All calls go to the CRS sandbox at `https://api-sandbox.stitchcredit.com/api`, in `server/src/crs/crs.ts`.

| Endpoint | Used for |
| --- | --- |
| `POST /users/login` | One login per server run. The token is reused. A failed login stops further attempts, because repeated failures lock the account. |
| `POST /transunion/credit-report/standard/tu-prequal-fico9` | The protected user's tradelines (persona P20). Loaded once at startup, from the saved copy in `server/scripts/out/` when there is one. Claims like "you owe Chase $4,000" are checked against them. |
| `POST /accurate-append/reverse` | Reverse phone lookup on the caller's alias persona: no record, or an owner mismatch, raises the score. |
| `POST /fraud-finder/fraud-finder` | Fraud score, line type and carrier for the caller's alias persona. |

## Data rule: persona aliases

- **No real phone number or real person's data is ever sent to CRS.**
- A caller's real number is first mapped to a sandbox persona phone through the `demo_caller_alias` table, or `.env` as a fallback.
- Callers with no alias skip the CRS caller check.
- As a second guard, `crs.ts` refuses any phone that isn't a sandbox persona phone (`55501010xx`).
- The protected user is the sandbox persona P20, shown in the app as a "demo identity".
- `demo_caller_alias` is a public table, so it holds only the teammates' demo phones. Clear it after the demo.

## Where call logs live

- SpacetimeDB `call_log` (one row per call, replaced by call id) and `flagged_number`, on Maincloud.
- A JSONL copy on the server at `server/data/call-log.jsonl`, or `CALL_LOG_JSONL`. It's gitignored, because it holds transcripts.
  - A yellow call appears twice: once at the verdict, and again with the caller's message. The last line wins.

## Known limitations

- **No access to call audio on iOS.** The app can't hear calls. That's why callers dial the InterHoot Twilio number, which does the screening, instead of the user's own number.
- **Call Directory limits:**
  - It blocks and labels numbers only, so the server rejects calls with no caller ID instead.
  - iOS never blocks numbers in the user's Contacts or recent outgoing calls.
- **Fraud Finder needs an email.** A phone call doesn't give us one, so it runs only for aliased demo personas, using each persona's email from the sandbox data.
- **Live Caller ID Lookup isn't used.** Blocking comes from the list the app syncs into its Call Directory extension.
- **Languages:**
  - The greeting, fixed questions and message prompt exist in English, Spanish, Russian and Korean. Other user languages get these lines in English, while Gemini's questions still follow the caller's language.
  - Twilio speaks the closing line, in English.
- **TTS model.** TTS uses `sonic-3`, not `sonic-3.6`. Sonic 3 has no Urdu, so Urdu lines fall back to English.
- **Silence while Gemini thinks.** The caller hears silence while Gemini writes the next question: up to `BRAIN_TURN_TIMEOUT_MS` (5 seconds), after which the fixed question is asked.
- **Not built yet:**
  - The Claude fallback (`LLM_PROVIDER=claude`).
  - The app's SwiftData offline copy.
  - The Time Sensitive notification capability in Xcode.
