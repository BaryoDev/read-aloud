import { WebSocket } from "ws";
import { createHash, randomUUID } from "node:crypto";

// The public "read aloud" endpoint Microsoft Edge itself uses. No API key: a trusted-client token
// plus a time-based Sec-MS-GEC hash. Ported from the reference C# service.
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_URL =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const CHROMIUM_VERSION = "134.0.3124.66";

export interface SynthesizeOptions {
  /** A neural voice, e.g. "en-US-JennyNeural" (default), "en-GB-RyanNeural". */
  voice?: string;
  /** Speaking rate, e.g. "+0%", "-15%", "+30%". */
  rate?: string;
  /** Pitch, e.g. "+0Hz", "-2st", "+10Hz". */
  pitch?: string;
  /** Volume, e.g. "+0%", "-20%". */
  volume?: string;
  /** Audio output format. Default MP3 24kHz. */
  format?: string;
  /** Emit per-word timings for highlighting. Default true. */
  wordBoundaries?: boolean;
  /** Abort the synthesis. */
  signal?: AbortSignal;
}

/** One spoken word and when it is spoken, in milliseconds from the start. */
export interface WordBoundary {
  text: string;
  /** Start offset in ms. */
  offset: number;
  /** Duration in ms. */
  duration: number;
}

export interface SynthesisResult {
  /** The synthesized audio (MP3 by default). */
  audio: Uint8Array;
  /** Per-word timings, empty when wordBoundaries is false. */
  boundaries: WordBoundary[];
  /** The audio MIME type. */
  contentType: string;
}

function secMsGecToken(): string {
  let seconds = Math.floor(Date.now() / 1000);
  seconds = seconds - (seconds % 300); // round down to a 5-minute window
  const windowsTicks = (BigInt(seconds) + 11644473600n) * 10000000n;
  return createHash("sha256")
    .update(`${windowsTicks}${TRUSTED_CLIENT_TOKEN}`)
    .digest("hex")
    .toUpperCase();
}

const timestamp = () => new Date().toISOString();

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Speaks the Edge "read aloud" WebSocket protocol. Server-side only: browsers can't set the
 * required Origin / User-Agent headers, which is why read-aloud ships this engine for your backend.
 */
export class EdgeTTS {
  async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<SynthesisResult> {
    const voice = opts.voice ?? "en-US-JennyNeural";
    const rate = opts.rate ?? "+0%";
    const pitch = opts.pitch ?? "+0Hz";
    const volume = opts.volume ?? "+0%";
    const format = opts.format ?? "audio-24khz-48kbitrate-mono-mp3";
    const wantBoundaries = opts.wordBoundaries ?? true;

    if (!text || !text.trim()) throw new Error("read-aloud: text is empty");

    const connectionId = randomUUID().replace(/-/g, "");
    const url =
      `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${secMsGecToken()}` +
      `&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}` +
      `&ConnectionId=${connectionId}`;

    const ws = new WebSocket(url, {
      headers: {
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent":
          `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
          `Chrome/${CHROMIUM_VERSION} Safari/537.36 Edg/${CHROMIUM_VERSION}`,
      },
    });

    return new Promise<SynthesisResult>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const boundaries: WordBoundary[] = [];
      let settled = false;

      const done = (err?: Error, result?: SynthesisResult) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        err ? reject(err) : resolve(result!);
      };

      opts.signal?.addEventListener("abort", () => done(new Error("read-aloud: aborted")), { once: true });

      ws.on("open", () => {
        ws.send(
          `X-Timestamp:${timestamp()}\r\n` +
            "Content-Type:application/json; charset=utf-8\r\n" +
            "Path:speech.config\r\n\r\n" +
            `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"${wantBoundaries}"},"outputFormat":"${format}"}}}}`,
        );
        const ssml =
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
          `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
          `${escapeXml(text)}</prosody></voice></speak>`;
        ws.send(
          `X-RequestId:${connectionId}\r\n` +
            `X-Timestamp:${timestamp()}\r\n` +
            "Content-Type:application/ssml+xml\r\n" +
            "Path:ssml\r\n\r\n" +
            ssml,
        );
      });

      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          // First 2 bytes are the big-endian header length; audio follows the header.
          const headerLength = (data[0] << 8) | data[1];
          const audioStart = 2 + headerLength;
          if (audioStart < data.length) chunks.push(data.subarray(audioStart));
          return;
        }
        const msg = data.toString("utf8");
        if (wantBoundaries && msg.includes("Path:audio.metadata")) {
          const body = msg.slice(msg.indexOf("\r\n\r\n") + 4);
          try {
            const meta = JSON.parse(body);
            for (const m of meta.Metadata ?? []) {
              if (m.Type === "WordBoundary") {
                boundaries.push({
                  text: m.Data?.text?.Text ?? "",
                  offset: (m.Data?.Offset ?? 0) / 10000, // 100ns ticks -> ms
                  duration: (m.Data?.Duration ?? 0) / 10000,
                });
              }
            }
          } catch {
            /* ignore malformed metadata */
          }
        }
        if (msg.includes("Path:turn.end")) {
          done(undefined, {
            audio: Buffer.concat(chunks),
            boundaries,
            contentType: format.includes("mp3") ? "audio/mpeg" : "application/octet-stream",
          });
        }
      });

      ws.on("error", (err) => done(err instanceof Error ? err : new Error(String(err))));
      ws.on("close", () => {
        if (!settled) {
          chunks.length
            ? done(undefined, { audio: Buffer.concat(chunks), boundaries, contentType: "audio/mpeg" })
            : done(new Error("read-aloud: connection closed before any audio"));
        }
      });
    });
  }
}
