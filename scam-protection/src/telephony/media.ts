
import WebSocket, { WebSocketServer } from "ws";
import type { Server } from "http";
import twilio from "twilio";

import {
  createCallSession,
  getCallSession,
  removeCallSession,
  getActiveCallCount,
} from "../agent/callSessions.js";

import {
  startCallTimeout,
  clearCallTimeout,
  SCREENING_TIMEOUT_MS,
} from "../agent/callTimeouts.js";

import {
  handleCallError,
  type CallErrorType,
} from "../agent/callErrorHandler.js";

import {
  createScreeningSession,
  askNextQuestion,
  submitCallerResponse,
  getScreeningVerdict,
  getScreeningTranscript,
  removeScreeningSession,
  getActiveScreeningCount,
  isAtGreeting,
  getFollowUpState,
} from "../agent/screeningSession.js";

import type { CallVerdict, NextLineOptions } from "../agent/conversation.js";

import {
  baseLanguage,
  getGreetingParts,
  messagePrompts,
  toScreeningLanguage,
  TTS_LANGUAGES,
  type ScreeningLanguage,
  type SpeechPart,
} from "../agent/screeningLanguages.js";

import { applyCallVerdict } from "./callActions.js";
import { processTwilioAudio } from "./audioProcessor.js";
import { generateSpeech } from "../agent/cartesiaTTS.js";
import { sendAudioToTwilio } from "./sendAudio.js";
import { CartesiaSTT } from "../agent/cartesiaSTT.js";
import {
  getCallContext,
  nextTurn,
  screenWithBrain,
  sendCallMessage,
  toCallVerdict,
} from "./brainClient.js";

// How long a yellow caller gets to leave a message after the prompt starts.
const MESSAGE_LISTEN_MS = 30_000;

// Question marks in the scripts Gemini writes in (Latin, CJK full-width, Arabic).
const QUESTION_MARK = /[?？؟]/;

type TurnState =
  | "starting"
  | "speaking"
  | "listening"
  | "processing"
  | "finished";

export function setupMediaWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/media") {
      socket.destroy();
      return;
    }

    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const mediaUrl = process.env.TWILIO_MEDIA_URL;
    const signature = req.headers["x-twilio-signature"];

    if (
      !authToken ||
      !mediaUrl ||
      typeof signature !== "string"
    ) {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"
      );
      socket.destroy();
      return;
    }

    const urls = [
      mediaUrl,
      mediaUrl.endsWith("/") ? mediaUrl : `${mediaUrl}/`,
    ];

    const valid = urls.some((url) =>
      twilio.validateRequest(authToken, signature, url, {})
    );

    console.log("Media WebSocket signature valid:", valid);

    if (!valid) {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req)
    );
  });

  wss.on("connection", (ws) => {
    console.log("Media WebSocket connected");

    let callSid: string | null = null;
    let streamSid: string | null = null;
    let stt: CartesiaSTT | null = null;
    // Caller's number, passed by /twilio/voice as a <Parameter>.
    let callerFrom = "";
    const callStartedAt = Date.now();

    // protected_user.language, read from the brain before the greeting (A7).
    let userLanguage = "en";
    // The caller's language as Gemini last heard it, when there are fixed lines for it.
    let callerLanguage: ScreeningLanguage | null = null;

    // Yellow calls: the agent takes a message after the verdict.
    let takingMessage = false;
    let finishMessage: ((text: string) => void) | null = null;
    const messageController = new AbortController();

    let mediaChunkCount = 0;
    let sessionCreated = false;
    let screeningCreated = false;
    let cleanedUp = false;
    let timedOut = false;
    let verdictSubmitted = false;

    let turnState: TurnState = "starting";
    let questionNumber = 0;
    let expectedPlaybackMark: string | null = null;

    const speechController = new AbortController();

    // Clean up all resources associated with this call.
    function cleanupSession(): void {
      if (cleanedUp) return;

      // Hand back whatever message we have so the push still goes out.
      finishMessage?.("");

      cleanedUp = true;
      turnState = "finished";

      speechController.abort();
      messageController.abort();

      stt?.close();
      stt = null;

      if (!callSid || !sessionCreated) return;

      clearCallTimeout(callSid);

      if (screeningCreated) {
        removeScreeningSession(callSid);
        screeningCreated = false;
      }

      removeCallSession(callSid);
      sessionCreated = false;

      console.log(
        "Active screenings:",
        getActiveScreeningCount()
      );

      console.log(
        "Active calls:",
        getActiveCallCount()
      );
    }

    // Handle an error during call screening.
    function handleConnectionError(
      errorType: CallErrorType,
      error: unknown
    ): void {
      if (cleanedUp) return;

      finishMessage?.("");

      speechController.abort();
      messageController.abort();

      stt?.close();
      stt = null;

      if (!callSid || !sessionCreated) {
        console.error(
          "WebSocket error without owned session:",
          error
        );

        cleanedUp = true;
        ws.close();
        return;
      }

      cleanedUp = true;
      turnState = "finished";

      clearCallTimeout(callSid);

      if (screeningCreated) {
        removeScreeningSession(callSid);
        screeningCreated = false;
      }

      handleCallError(callSid, errorType, error);

      sessionCreated = false;
      ws.close();
    }

    // Stop any queued Twilio audio playback.
    function clearPlayback(): void {
      if (
        streamSid &&
        ws.readyState === WebSocket.OPEN
      ) {
        ws.send(
          JSON.stringify({
            event: "clear",
            streamSid,
          })
        );
      }
    }

    // End a screening that exceeds its maximum duration.
    async function handleScreeningTimeout(
      expiredCallSid: string
    ): Promise<void> {
      if (
        timedOut ||
        cleanedUp ||
        verdictSubmitted ||
        !sessionCreated ||
        callSid !== expiredCallSid
      ) {
        return;
      }

      timedOut = true;
      turnState = "finished";
      expectedPlaybackMark = null;

      console.log(
        "Hard screening timeout:",
        SCREENING_TIMEOUT_MS / 1000,
        "seconds"
      );

      speechController.abort();

      stt?.close();
      stt = null;

      clearPlayback();

      // Log the timed-out call as yellow (copy the transcript before cleanup removes it).
      void screenWithBrain({
        callSid: expiredCallSid,
        from: callerFrom,
        transcript: getScreeningTranscript(expiredCallSid),
        fallbackVerdict: "YELLOW",
        forceVerdict: "YELLOW",
        startedAt: callStartedAt,
      });

      try {
        await applyCallVerdict(
          expiredCallSid,
          "YELLOW"
        );

        console.log(
          "Timed-out screening disconnected:",
          expiredCallSid
        );

        ws.close();
      } catch (error) {
        console.error(
          "Failed to terminate timed-out call:",
          error
        );

        handleConnectionError(
          "CALL_CONTROL_ERROR",
          error
        );
      }
    }

    // Cartesia TTS for one part. A language Cartesia rejects is retried in English.
    async function synthesize(
      part: SpeechPart,
      signal: AbortSignal
    ): Promise<Buffer> {
      try {
        return await generateSpeech(part.text, signal, part.language);
      } catch (error) {
        if (part.language === "en" || signal.aborted) throw error;

        console.error(
          `TTS failed in ${part.language}, retrying in English:`,
          error instanceof Error ? error.message : error
        );

        return generateSpeech(part.text, signal, "en");
      }
    }

    // Generate and play an InterHoot line (one or more language parts).
    async function speak(
      parts: SpeechPart[],
      expectedCallSid: string,
      expectedStreamSid: string,
      signal: AbortSignal = speechController.signal
    ): Promise<void> {
      if (
        cleanedUp ||
        timedOut ||
        (verdictSubmitted && !takingMessage)
      ) {
        return;
      }

      turnState = "speaking";

      const markName =
        `interhoot-question-${++questionNumber}`;

      expectedPlaybackMark = markName;

      console.log(
        "InterHoot asks:",
        parts.map((part) => `[${part.language}] ${part.text}`).join(" ")
      );

      try {
        const audio = await Promise.all(
          parts.map((part) => synthesize(part, signal))
        );

        if (
          cleanedUp ||
          timedOut ||
          (verdictSubmitted && !takingMessage) ||
          callSid !== expectedCallSid ||
          streamSid !== expectedStreamSid ||
          ws.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        for (const chunk of audio) {
          sendAudioToTwilio(
            ws,
            expectedStreamSid,
            chunk
          );
        }

        // Wait until Twilio finishes playing this question.
        ws.send(
          JSON.stringify({
            event: "mark",
            streamSid: expectedStreamSid,
            mark: {
              name: markName,
            },
          })
        );

        console.log(
          "InterHoot audio sent. Waiting for playback:",
          markName
        );
      } catch (error) {
        if (
          cleanedUp ||
          timedOut ||
          signal.aborted
        ) {
          return;
        }

        handleConnectionError(
          "WEBSOCKET_ERROR",
          error
        );
      }
    }

    function openStt(
      sid: string,
      onUtterance: (text: string) => void
    ): CartesiaSTT {
      const client = new CartesiaSTT(sid, onUtterance, {
        language: userLanguage,
      });

      client.connect();

      return client;
    }

    // Yellow calls (build guide section 7): ask for a short message and
    // wait for one answer, or MESSAGE_LISTEN_MS. Resolves with the text.
    function takeMessage(
      expectedCallSid: string,
      expectedStreamSid: string
    ): Promise<string> {
      return new Promise((resolve) => {
        const language = callerLanguage ?? "en";

        let done = false;

        const finish = (text: string) => {
          if (done) return;

          done = true;
          clearTimeout(timer);

          takingMessage = false;
          finishMessage = null;
          turnState = "finished";
          expectedPlaybackMark = null;

          stt?.close();
          stt = null;

          resolve(text);
        };

        const timer = setTimeout(() => finish(""), MESSAGE_LISTEN_MS);

        takingMessage = true;
        finishMessage = finish;

        stt = openStt(expectedCallSid, (text) => {
          if (takingMessage && turnState === "listening") {
            console.log("Caller message:", text);
            finish(text);
          }
        });

        void speak(
          [{ text: messagePrompts[language], language }],
          expectedCallSid,
          expectedStreamSid,
          messageController.signal
        );
      });
    }

    // A5: Gemini writes the follow-up questions. Without a usable line
    // (slow, down, or a language TTS can't speak), A's fixed question is used.
    // A line with no question mark is Gemini's closing line: it has enough,
    // so the questions end and the score decides the call.
    async function chooseFollowUp(
      expectedCallSid: string,
      followUpsAsked: number
    ): Promise<{ options: NextLineOptions; language: string; closing: boolean }> {
      const turn = await nextTurn({
        callSid: expectedCallSid,
        transcript: getScreeningTranscript(expectedCallSid),
        followUpsAsked,
      });

      const spoken = baseLanguage(turn?.callerLanguage);

      callerLanguage = toScreeningLanguage(spoken) ?? callerLanguage;

      const fixedLanguage = callerLanguage ?? "en";

      const line = turn?.nextAgentLine.trim() ?? "";

      if (line && !QUESTION_MARK.test(line)) {
        console.log("Gemini ended screening early:", line);

        return {
          options: { language: fixedLanguage },
          language: fixedLanguage,
          closing: true,
        };
      }

      if (line && TTS_LANGUAGES.has(spoken)) {
        return {
          options: { followUp: line, language: fixedLanguage },
          language: spoken,
          closing: false,
        };
      }

      return {
        options: { language: fixedLanguage },
        language: fixedLanguage,
        closing: false,
      };
    }

    // End the questions and act on the verdict. B's scoring decides; A's
    // rule-based verdict is the fallback. endedEarly: Gemini had enough and
    // stopped the questions (its closing line isn't spoken); the score still
    // decides, and yellow if the brain is down.
    async function finishScreening(
      expectedCallSid: string,
      expectedStreamSid: string,
      endedEarly = false
    ): Promise<void> {
      const verdict: CallVerdict = endedEarly
        ? "YELLOW"
        : getScreeningVerdict(expectedCallSid);

      console.log("Screening completed.", endedEarly ? "(ended early by Gemini)" : "");
      console.log("Screening verdict:", verdict);

      verdictSubmitted = true;
      turnState = "finished";
      expectedPlaybackMark = null;

      speechController.abort();

      stt?.close();
      stt = null;

      clearPlayback();

      // B's scoring (Gemini + CRS + history) makes the final call and logs it to the app.
      // A's rule-based verdict above is the fallback if the brain is unavailable.
      const brain = await screenWithBrain({
        callSid: expectedCallSid,
        from: callerFrom,
        transcript: getScreeningTranscript(expectedCallSid),
        fallbackVerdict: verdict,
        startedAt: callStartedAt,
        deferYellowNotify: true,
      });
      const finalVerdict = brain ? toCallVerdict(brain.flag) : verdict;

      console.log("Brain verdict:", brain ? `${brain.flag} (${brain.score})` : "unavailable");

      // YELLOW: take a message first. The brain sends the push with it.
      if (finalVerdict === "YELLOW" && brain?.messagePending) {
        const message = cleanedUp
          ? ""
          : await takeMessage(expectedCallSid, expectedStreamSid);

        const sent = await sendCallMessage(expectedCallSid, message);

        console.log(
          "Caller message:",
          message ? `"${message}"` : "(none)",
          sent ? "saved" : "not saved"
        );
      }

      // GREEN automatically forwards to the protected number.
      // YELLOW and RED end the call.
      await applyCallVerdict(
        expectedCallSid,
        finalVerdict,
        brain?.forwardTo || process.env.PROTECTED_PHONE_NUMBER
      );

      clearCallTimeout(expectedCallSid);

      console.log(
        "Final call action applied:",
        finalVerdict
      );
    }

    // A7: read the user's language, then start STT and the greeting.
    async function beginScreening(
      newCallSid: string,
      newStreamSid: string
    ): Promise<void> {
      const context = await getCallContext(newCallSid);

      if (cleanedUp || timedOut || callSid !== newCallSid) return;

      userLanguage = baseLanguage(context?.language) || "en";

      console.log("Protected user's language:", userLanguage);

      try {
        createScreeningSession(
          newCallSid,
          toScreeningLanguage(userLanguage) ?? "en"
        );
        screeningCreated = true;

        // Connect Cartesia speech recognition.
        stt = openStt(newCallSid, (completeResponse) => {
          if (
            cleanedUp ||
            timedOut ||
            verdictSubmitted ||
            !screeningCreated ||
            turnState !== "listening"
          ) {
            console.log(
              "STT response ignored:",
              completeResponse
            );
            return;
          }

          turnState = "processing";

          console.log(
            "Caller response:",
            completeResponse
          );

          submitCallerResponse(
            newCallSid,
            completeResponse
          );

          console.log(
            "Caller response saved"
          );

          void advanceConversation(
            newCallSid,
            newStreamSid
          );
        });

        // Start InterHoot's greeting.
        void advanceConversation(
          newCallSid,
          newStreamSid
        );
      } catch (error) {
        handleConnectionError(
          "WEBSOCKET_ERROR",
          error
        );
      }
    }

    // Move to the next question or apply the final verdict.
    async function advanceConversation(
      expectedCallSid: string,
      expectedStreamSid: string
    ): Promise<void> {
      if (
        cleanedUp ||
        timedOut ||
        verdictSubmitted ||
        !screeningCreated
      ) {
        return;
      }

      turnState = "processing";

      try {
        const greeting = isAtGreeting(expectedCallSid);
        const followUp = getFollowUpState(expectedCallSid);

        let options: NextLineOptions = {};
        // Clarifications exist only in English.
        let lineLanguage = "en";

        if (followUp) {
          const choice = await chooseFollowUp(
            expectedCallSid,
            followUp.followUpsAsked
          );

          if (cleanedUp || timedOut || verdictSubmitted) return;

          // Gemini has enough: skip the remaining questions, go to the verdict.
          if (choice.closing) {
            await finishScreening(expectedCallSid, expectedStreamSid, true);
            return;
          }

          options = choice.options;
          lineLanguage = choice.language;
        }

        const nextLine = askNextQuestion(
          expectedCallSid,
          options
        );

        // The conversation has finished.
        if (
          nextLine ===
          "Thank you. I have enough information to review this call."
        ) {
          await finishScreening(expectedCallSid, expectedStreamSid);
          return;
        }

        // These messages indicate an unexpected conversation state.
        if (
          nextLine === "Waiting for caller response..." ||
          nextLine ===
            "The conversation is ready for a verdict."
        ) {
          console.error(
            "Unexpected conversation state:",
            nextLine
          );

          handleConnectionError(
            "WEBSOCKET_ERROR",
            new Error(nextLine)
          );

          return;
        }

        // Ask the next question or clarification. The greeting is in
        // the user's language, then English.
        const parts: SpeechPart[] = greeting
          ? getGreetingParts(toScreeningLanguage(userLanguage) ?? "en")
          : [{ text: nextLine, language: lineLanguage }];

        await speak(
          parts,
          expectedCallSid,
          expectedStreamSid
        );
      } catch (error) {
        if (cleanedUp || timedOut) return;

        console.error(
          "Conversation advancement failed:",
          error
        );

        handleConnectionError(
          "CALL_CONTROL_ERROR",
          error
        );
      }
    }

    // Process incoming Twilio WebSocket events.
    ws.on("message", (data) => {
      if (cleanedUp) return;

      try {
        const message = JSON.parse(
          data.toString()
        );

        switch (message.event) {
          case "connected":
            console.log(
              "Twilio stream connected"
            );
            break;

          case "start": {
            const newCallSid =
              message.start?.callSid;

            const newStreamSid =
              message.start?.streamSid;

            if (
              typeof newCallSid !== "string" ||
              !newCallSid ||
              typeof newStreamSid !== "string" ||
              !newStreamSid ||
              callSid !== null
            ) {
              handleConnectionError(
                "WEBSOCKET_ERROR",
                new Error(
                  "Invalid Twilio start event"
                )
              );
              break;
            }

            callSid = newCallSid;
            streamSid = newStreamSid;

            const fromParameter = message.start?.customParameters?.from;
            callerFrom = typeof fromParameter === "string" ? fromParameter : "";

            console.log(
              "Call SID:",
              newCallSid
            );

            console.log(
              "Stream SID:",
              newStreamSid
            );

            if (getCallSession(newCallSid)) {
              console.error(
                "Call session already exists:",
                newCallSid
              );

              ws.close();
              break;
            }

            createCallSession(newCallSid);
            sessionCreated = true;

            // Start the overall screening deadline.
            startCallTimeout(
              newCallSid,
              SCREENING_TIMEOUT_MS,
              (expiredCallSid) => {
                void handleScreeningTimeout(
                  expiredCallSid
                );
              }
            );

            console.log(
              "Screening deadline:",
              SCREENING_TIMEOUT_MS / 1000,
              "seconds"
            );

            // Language, then STT and the greeting (see beginScreening).
            void beginScreening(
              newCallSid,
              newStreamSid
            );

            break;
          }

          case "media": {
            if (
              !sessionCreated ||
              !screeningCreated ||
              timedOut ||
              (verdictSubmitted && !takingMessage)
            ) {
              break;
            }

            const audioBuffer =
              processTwilioAudio({
                track: message.media?.track,
                payload: message.media?.payload,
              });

            mediaChunkCount++;

            if (mediaChunkCount % 50 === 0) {
              console.log(
                "Audio chunks processed:",
                mediaChunkCount
              );
            }

            // Only send caller audio to STT while listening.
            if (turnState === "listening") {
              stt?.sendAudio(audioBuffer);
            }

            break;
          }

          case "mark": {
            const markName =
              message.mark?.name;

            if (
              typeof markName === "string" &&
              markName === expectedPlaybackMark &&
              turnState === "speaking" &&
              !timedOut &&
              (!verdictSubmitted || takingMessage)
            ) {
              expectedPlaybackMark = null;
              turnState = "listening";

              console.log(
                "InterHoot playback completed:",
                markName
              );

              console.log(
                "InterHoot is now listening..."
              );
            }

            break;
          }

          case "stop":
            console.log(
              "Twilio stream stopped"
            );

            console.log(
              "Total audio chunks:",
              mediaChunkCount
            );

            cleanupSession();
            break;

          default:
            break;
        }
      } catch (error) {
        handleConnectionError(
          "WEBSOCKET_ERROR",
          error
        );
      }
    });

    ws.on("close", () => {
      console.log(
        "Media WebSocket disconnected"
      );

      cleanupSession();
    });

    ws.on("error", (error) =>
      handleConnectionError(
        "WEBSOCKET_ERROR",
        error
      )
    );
  });
}
