
import { WebSocketServer } from "ws";
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
  removeScreeningSession,
  getActiveScreeningCount,
} from "../agent/screeningSession.js";

import { applyCallVerdict } from "./callActions.js";

export function setupMediaWebSocket(server: Server) {
  const wss = new WebSocketServer({
    noServer: true,
  });

  // Step 1: Authenticate WebSocket upgrade requests
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
      console.log("WebSocket authentication missing");

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

    console.log(
      "Media WebSocket signature valid:",
      isValid
    );

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

  // Step 2: Handle authenticated connections
  wss.on("connection", (ws) => {
    console.log("Media WebSocket connected");

    let callSid: string | null = null;
    let streamSid: string | null = null;
    let mediaChunkCount = 0;

    let sessionCreated = false;
    let cleanedUp = false;
    let timedOut = false;

    // NEW: Track whether this connection owns
    // a screening session.
    let screeningCreated = false;

    // Step 3: Clean up all owned session resources
    function cleanupSession() {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;

      if (!callSid || !sessionCreated) {
        return;
      }

      clearCallTimeout(callSid);

      // NEW: Remove the screening session and transcript
      if (screeningCreated) {
        removeScreeningSession(callSid);
        screeningCreated = false;

        console.log(
          "Screening session removed:",
          callSid
        );

        console.log(
          "Active screenings:",
          getActiveScreeningCount()
        );
      }

      const removed = removeCallSession(callSid);

      if (removed) {
        console.log(
          "Call session removed:",
          callSid
        );

        console.log(
          "Active calls:",
          getActiveCallCount()
        );
      }

      sessionCreated = false;
    }

    // Step 4: Handle connection errors
    function handleConnectionError(
      errorType: CallErrorType,
      error: unknown
    ) {
      if (cleanedUp) {
        return;
      }

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

      // NEW: Clean up screening resources
      if (screeningCreated) {
        removeScreeningSession(callSid);
        screeningCreated = false;
      }

      const result = handleCallError(
        callSid,
        errorType,
        error
      );

      sessionCreated = false;

      console.log(
        "Call error handled:",
        result.errorType
      );

      ws.close();
    }

    // Step 5: Handle screening timeout
    async function handleScreeningTimeout(
      expiredCallSid: string
    ) {
      if (timedOut || cleanedUp || !sessionCreated) {
        return;
      }

      timedOut = true;

      console.log(
        "Screening timeout reached:",
        expiredCallSid
      );

      try {
        await applyCallVerdict(
          expiredCallSid,
          "YELLOW"
        );

        console.log(
          "Timed-out call disconnected:",
          expiredCallSid
        );
      } catch (error) {
        console.error(
          "Failed to disconnect timed-out call:",
          error
        );

        handleConnectionError(
          "CALL_CONTROL_ERROR",
          error
        );
      }
    }

    // Step 6: Handle Twilio messages
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());

        switch (message.event) {
          case "connected":
            console.log("Twilio stream connected");
            break;

          case "start": {
            if (
              typeof message.start?.callSid !== "string" ||
              typeof message.start?.streamSid !== "string"
            ) {
              handleConnectionError(
                "WEBSOCKET_ERROR",
                new Error(
                  "Invalid Twilio start event"
                )
              );
              break;
            }

            const newCallSid: string =
              message.start.callSid;

            const newStreamSid: string =
              message.start.streamSid;

            if (callSid !== null) {
              handleConnectionError(
                "WEBSOCKET_ERROR",
                new Error(
                  "Duplicate Twilio start event"
                )
              );
              break;
            }

            callSid = newCallSid;
            streamSid = newStreamSid;

            console.log("Call SID:", callSid);
            console.log("Stream SID:", streamSid);

            if (!getCallSession(newCallSid)) {
              createCallSession(newCallSid);
              sessionCreated = true;

              console.log(
                "Call session created:",
                newCallSid
              );

              console.log(
                "Active calls:",
                getActiveCallCount()
              );

              // NEW: Create the screening session
              // and its associated transcript.
              createScreeningSession(newCallSid);
              screeningCreated = true;

              console.log(
                "Screening session created:",
                newCallSid
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
                "Screening timeout started:",
                SCREENING_TIMEOUT_MS / 1000,
                "seconds"
              );
            } else {
              console.error(
                "Call session already exists:",
                newCallSid
              );

              ws.close();
            }

            break;
          }

          case "media":
            mediaChunkCount++;

            if (mediaChunkCount % 50 === 0) {
              console.log(
                "Audio chunks received:",
                mediaChunkCount
              );

              console.log(
                "Track:",
                message.media?.track
              );

              console.log(
                "Audio payload present:",
                Boolean(message.media?.payload)
              );
            }

            // Audio processing will be connected
            // to Cartesia STT in a later step.
            break;

          case "stop":
            console.log("Twilio stream stopped");

            console.log(
              "Total audio chunks:",
              mediaChunkCount
            );

            cleanupSession();
            break;

          default:
            console.log(
              "Unknown event:",
              message.event
            );
        }
      } catch (error) {
        handleConnectionError(
          "WEBSOCKET_ERROR",
          error
        );
      }
    });

    // Step 7: Handle disconnections
    ws.on("close", () => {
      console.log(
        "Media WebSocket disconnected"
      );

      cleanupSession();
    });

    // Step 8: Handle WebSocket errors
    ws.on("error", (error) => {
      handleConnectionError(
        "WEBSOCKET_ERROR",
        error
      );
    });
  });
}
