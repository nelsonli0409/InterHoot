
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
} from "../agent/screeningSession.js";

import { applyCallVerdict } from "./callActions.js";
import { processTwilioAudio } from "./audioProcessor.js";
import { generateSpeech } from "../agent/cartesiaTTS.js";
import { sendAudioToTwilio } from "./sendAudio.js";
import { CartesiaSTT } from "../agent/cartesiaSTT.js";
import { screenWithBrain, toCallVerdict } from "./brainClient.js";

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

      cleanedUp = true;
      turnState = "finished";

      speechController.abort();

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

      speechController.abort();

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

    // Generate and play an InterHoot question.
    async function speak(
      text: string,
      expectedCallSid: string,
      expectedStreamSid: string
    ): Promise<void> {
      if (
        cleanedUp ||
        timedOut ||
        verdictSubmitted
      ) {
        return;
      }

      turnState = "speaking";

      const markName =
        `interhoot-question-${++questionNumber}`;

      expectedPlaybackMark = markName;

      console.log("InterHoot asks:", text);

      try {
        const audio = await generateSpeech(
          text,
          speechController.signal
        );

        if (
          cleanedUp ||
          timedOut ||
          verdictSubmitted ||
          callSid !== expectedCallSid ||
          streamSid !== expectedStreamSid ||
          ws.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        sendAudioToTwilio(
          ws,
          expectedStreamSid,
          audio
        );

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
          speechController.signal.aborted
        ) {
          return;
        }

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
        const nextLine = askNextQuestion(
          expectedCallSid
        );

        // The conversation has finished.
        if (
          nextLine ===
          "Thank you. I have enough information to review this call."
        ) {
          const verdict = getScreeningVerdict(
            expectedCallSid
          );

          console.log("Screening completed.");
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
          });
          const finalVerdict = brain ? toCallVerdict(brain.flag) : verdict;

          console.log("Brain verdict:", brain ? `${brain.flag} (${brain.score})` : "unavailable");

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

        // Ask the next question or clarification.
        await speak(
          nextLine,
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

            createScreeningSession(newCallSid);
            screeningCreated = true;

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

            // Connect Cartesia speech recognition.
            stt = new CartesiaSTT(
              newCallSid,
              (completeResponse) => {
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
              }
            );

            stt.connect();

            // Start InterHoot's greeting.
            void advanceConversation(
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
              verdictSubmitted
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
              !verdictSubmitted
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
