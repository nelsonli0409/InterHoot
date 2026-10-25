
import "dotenv/config";
import WebSocket from "ws";

import { TranscriptAccumulator } from "./transcriptAccumulator.js";

type TranscriptEvent = {
  type?: string;
  text?: string;
  transcript?: string;
  is_final?: boolean;
  final?: boolean;
  language?: string;
  language_code?: string;
  [key: string]: unknown;
};

export class CartesiaSTT {
  private ws: WebSocket | null = null;

  // Buffer audio while Cartesia connects.
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private readonly maxPendingBytes = 16_000;

  private stopped = false;

  // Collect finalized transcription fragments.
  private accumulator = new TranscriptAccumulator();

  private hasPendingSpeech = false;

  // Wait 2.5 seconds after the latest finalized fragment.
  private utteranceTimer:
    ReturnType<typeof setTimeout> | null = null;

  private readonly utterancePauseMs = 3000;

  constructor(
    private readonly callSid: string,
    private readonly onUtterance?: (text: string) => void
  ) {}

  connect(): void {
    const apiKey = process.env.CARTESIA_API_KEY;

    if (!apiKey) {
      console.error(
        "Cartesia STT unavailable: CARTESIA_API_KEY is missing"
      );
      return;
    }

    const url = new URL(
      "wss://api.cartesia.ai/stt/websocket"
    );

    // Experiment with multilingual transcription.
    url.searchParams.set("model", "ink-whisper");
    url.searchParams.set("encoding", "pcm_mulaw");
    url.searchParams.set("sample_rate", "8000");

    // Intentionally omit the language parameter.
    // We need to verify whether this endpoint
    // accepts it and identifies languages.
    url.searchParams.set(
      "cartesia_version",
      "2026-03-01"
    );

    const ws = new WebSocket(url.toString(), {
      headers: {
        "X-API-Key": apiKey,
      },
    });

    this.ws = ws;

    ws.on("open", () => {
      if (this.stopped) {
        ws.close();
        return;
      }

      console.log(
        "Cartesia STT connected:",
        this.callSid
      );

      // Send buffered audio after connecting.
      for (const chunk of this.pending) {
        ws.send(chunk, { binary: true });
      }

      this.pending = [];
      this.pendingBytes = 0;
    });

    ws.on("message", (raw) => {
      if (this.stopped) {
        return;
      }

      try {
        const event = JSON.parse(
          raw.toString()
        ) as TranscriptEvent;

        // Log the complete response so we can
        // investigate language detection.
        console.log(
          "Cartesia STT event:",
          JSON.stringify(event, null, 2)
        );

        if (event.type === "error") {
          console.error(
            "Cartesia STT error event:",
            event
          );
          return;
        }

        // Inspect possible language metadata.
        // These fields are not yet confirmed.
        if (typeof event.language === "string") {
          console.log(
            "Cartesia reported language:",
            event.language
          );
        }

        if (typeof event.language_code === "string") {
          console.log(
            "Cartesia reported language code:",
            event.language_code
          );
        }

        const text =
          typeof event.text === "string"
            ? event.text
            : typeof event.transcript === "string"
              ? event.transcript
              : "";

        const isFinal =
          event.is_final === true ||
          event.final === true ||
          event.type === "final_transcript";

        // Ignore partial transcription updates.
        if (!isFinal || !text.trim()) {
          return;
        }

        this.accumulator.addFragment(text);
        this.hasPendingSpeech = true;

        console.log("STT fragment:", text);

        // Reset the pause timer when a new
        // finalized fragment arrives.
        if (this.utteranceTimer !== null) {
          clearTimeout(this.utteranceTimer);
          this.utteranceTimer = null;
        }

        this.utteranceTimer = setTimeout(() => {
          this.utteranceTimer = null;

          if (
            !this.stopped &&
            this.hasPendingSpeech
          ) {
            this.submitUtterance();
          }
        }, this.utterancePauseMs);
      } catch (error) {
        console.error(
          "Cartesia STT message processing error:",
          error
        );
      }
    });

    ws.on("error", (error) => {
      console.error(
        "Cartesia STT WebSocket error:",
        error.message
      );
    });

    ws.on("close", (code, reason) => {
      console.log(
        "Cartesia STT disconnected:",
        this.callSid,
        code,
        reason.toString()
      );

      this.clearUtteranceTimer();

      this.pending = [];
      this.pendingBytes = 0;

      this.accumulator.clear();
      this.hasPendingSpeech = false;
    });
  }

  // Send the complete caller response to media.ts.
  private submitUtterance(): void {
    if (this.stopped) {
      return;
    }

    const text = this.accumulator.flush();

    this.hasPendingSpeech = false;

    if (!text) {
      return;
    }

    console.log(
      "Complete caller response:",
      text
    );

    try {
      this.onUtterance?.(text);
    } catch (error) {
      console.error(
        "Caller utterance callback failed:",
        error
      );
    }
  }

  // Cancel a pending utterance timer.
  private clearUtteranceTimer(): void {
    if (this.utteranceTimer !== null) {
      clearTimeout(this.utteranceTimer);
      this.utteranceTimer = null;
    }
  }

  // Send Twilio audio to Cartesia STT.
  sendAudio(audio: Buffer): void {
    if (this.stopped || audio.length === 0) {
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(audio, {
        binary: true,
      });
      return;
    }

    if (
      this.ws?.readyState !== WebSocket.CONNECTING
    ) {
      return;
    }

    this.pending.push(audio);
    this.pendingBytes += audio.length;

    // Prevent unlimited buffering.
    while (
      this.pendingBytes > this.maxPendingBytes &&
      this.pending.length > 0
    ) {
      const dropped = this.pending.shift()!;

      this.pendingBytes -= dropped.length;
    }
  }

  // Stop transcription and release resources.
  close(): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;

    this.clearUtteranceTimer();

    this.pending = [];
    this.pendingBytes = 0;

    this.accumulator.clear();
    this.hasPendingSpeech = false;

    const ws = this.ws;

    if (!ws) {
      return;
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send("finalize");
      ws.send("done");
      ws.close();
    } else if (
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.terminate();
    }
  }
}
