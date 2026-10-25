
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
  removeScreeningSession,
  getActiveScreeningCount,
} from "../agent/screeningSession.js";

import { applyCallVerdict } from "./callActions.js";
import { processTwilioAudio } from "./audioProcessor.js";
import { generateSpeech } from "../agent/cartesiaTTS.js";
import { sendAudioToTwilio } from "./sendAudio.js";
import { CartesiaSTT } from "../agent/cartesiaSTT.js";

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

    const urlsToCheck = [
      mediaUrl,
      mediaUrl.endsWith("/")
        ? mediaUrl
        : `${mediaUrl}/`,
    ];

    const isValid = urlsToCheck.some((url) =>
      twilio.validateRequest(
        authToken,
        signature,
        url,
        {}
      )
    );

    console.log("Media WebSocket signature valid:", isValid);

    if (!isValid) {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    console.log("Media WebSocket connected");

    let callSid: string | null = null;
    let streamSid: string | null = null;

    let stt: CartesiaSTT | null = null;
    let mediaChunkCount = 0;

    let sessionCreated = false;
    let screeningCreated = false;
    let cleanedUp = false;
    let timedOut = false;

    let turnState: TurnState = "starting";
    let questionNumber = 0;
    let expectedPlaybackMark: string | null = null;

    const speechController = new AbortController();

    // Twilio playback marks are used to know
    // when InterHoot has finished speaking.
    async function speak(
      text: string,
      expectedCallSid: string,
      expectedStreamSid: string
    ): Promise<void> {
      if (
        cleanedUp ||
        timedOut ||
        turnState === "finished"
      ) {
        return;
      }

      turnState = "speaking";
      questionNumber++;

      const markName = `interhoot-question-${questionNumber}`;
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
          callSid !== expectedCallSid ||
          streamSid !== expectedStreamSid ||
          ws.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        // Existing sendAudioToTwilio() sends audio
        // and its default playback marker.
        sendAudioToTwilio(
          ws,
          expectedStreamSid,
          audio
        );

        // Send our own unique marker after the audio.
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

        console.error(
          "Speech generation failed:",
          error
        );

        handleConnectionError(
          "WEBSOCKET_ERROR",
          error
        );
      }
    }

    // Ask the next scripted screening question.
    async function advanceConversation(
      expectedCallSid: string,
      expectedStreamSid: string
    ): Promise<void> {
      if (
        cleanedUp ||
        timedOut ||
        !screeningCreated
      ) {
        return;
      }

      turnState = "processing";

      try {
        const nextLine = askNextQuestion(expectedCallSid);

        if (
          nextLine ===
          "Thank you. I have enough information to review this call."
        ) {
          turnState = "finished";

          const verdict = getScreeningVerdict(
            expectedCallSid
          );

          console.log("Screening completed.");
          console.log("Screening verdict:", verdict);

          await applyCallVerdict(
            expectedCallSid,
            verdict
          );

          return;
        }

        if (
          nextLine === "Waiting for caller response..." ||
          nextLine === "The conversation is ready for a verdict."
        ) {
          console.log(
            "Conversation cannot advance:",
            nextLine
          );
          return;
        }

        await speak(
          nextLine,
          expectedCallSid,
          expectedStreamSid
        );
      } catch (error) {
        if (cleanedUp || timedOut) {
          return;
        }

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

        console.log(
          "Screening session removed:",
          callSid
        );
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
          "WebSocket error without session:",
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

    // The 60-second deadline is never reset.
    async function handleScreeningTimeout(
      expiredCallSid: string
    ): Promise<void> {
      if (
        timedOut ||
        cleanedUp ||
        !sessionCreated ||
        callSid !== expiredCallSid
      ) {
        return;
      }

      timedOut = true;
      turnState = "finished";

      console.log(
        "Hard 60-second screening timeout:",
        expiredCallSid
      );

      // Cancel any ongoing speech generation.
      speechController.abort();

      stt?.close();
      stt = null;

      // Clear queued Twilio audio.
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

      try {
        // YELLOW is the existing timeout verdict.
        await applyCallVerdict(
          expiredCallSid,
          "YELLOW"
        );

        console.log(
          "Timed-out screening terminated:",
          expiredCallSid
        );

        ws.close();
      } catch (error) {
        console.error(
          "Timeout termination failed:",
          error
        );

        handleConnectionError(
          "CALL_CONTROL_ERROR",
          error
        );
      }
    }

    ws.on("message", (data) => {
      if (cleanedUp) return;

      try {
        const message = JSON.parse(data.toString());

        switch (message.event) {
          case "connected": {
            console.log("Twilio stream connected");
            break;
          }

          case "start": {
            const newCallSid = message.start?.callSid;
            const newStreamSid = message.start?.streamSid;

            if (
              typeof newCallSid !== "string" ||
              !newCallSid ||
              typeof newStreamSid !== "string" ||
              !newStreamSid ||
              callSid !== null
            ) {
              handleConnectionError(
                "WEBSOCKET_ERROR",
                new Error("Invalid Twilio start event")
              );
              break;
            }

            callSid = newCallSid;
            streamSid = newStreamSid;

            console.log("Call SID:", callSid);
            console.log("Stream SID:", streamSid);

            if (getCallSession(newCallSid)) {
              console.error(
                "Duplicate call session:",
                newCallSid
              );

              ws.close();
              break;
            }

            createCallSession(newCallSid);
            sessionCreated = true;

            createScreeningSession(newCallSid);
            screeningCreated = true;

            console.log(
              "Active calls:",
              getActiveCallCount()
            );

            console.log(
              "Active screenings:",
              getActiveScreeningCount()
            );

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

            stt = new CartesiaSTT(
              newCallSid,
              (completeResponse) => {
                if (
                  cleanedUp ||
                  timedOut ||
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

            // Start with the scripted greeting.
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
              timedOut
            ) {
              break;
            }

            const audioBuffer = processTwilioAudio({
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

            // Forward audio only when listening.
            if (turnState === "listening") {
              stt?.sendAudio(audioBuffer);
            }

            break;
          }

          case "mark": {
            const receivedMark = message.mark?.name;

            if (
              typeof receivedMark === "string" &&
              receivedMark === expectedPlaybackMark &&
              turnState === "speaking" &&
              !timedOut
            ) {
              console.log(
                "InterHoot playback completed:",
                receivedMark
              );

              expectedPlaybackMark = null;
              turnState = "listening";

              console.log(
                "InterHoot is now listening..."
              );
            }

            break;
          }

          case "stop": {
            console.log("Twilio stream stopped");

            console.log(
              "Total audio chunks:",
              mediaChunkCount
            );

            cleanupSession();
            break;
          }

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
      console.log("Media WebSocket disconnected");
      cleanupSession();
    });

    ws.on("error", (error) => {
      handleConnectionError(
        "WEBSOCKET_ERROR",
        error
      );
    });
  });
}
