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
  /** Abort the synthesis. A signal that is already aborted rejects at once. */
  signal?: AbortSignal;
  /** Give up after this many ms (handshake and audio together). Default 30000. 0 turns it off. */
  timeoutMs?: number;
}

/** Engine settings, not per call. */
export interface EdgeTTSOptions {
  /** Replace the service WebSocket URL (no query string). For tests and proxies. */
  endpoint?: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

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

/** The audio MIME type for an output format name. */
export function contentTypeForFormat(format: string): string {
  if (format.includes("mp3")) return "audio/mpeg";
  if (format.startsWith("riff-")) return "audio/wav";
  if (format.startsWith("ogg-")) return "audio/ogg";
  if (format.startsWith("webm-")) return "audio/webm";
  return "application/octet-stream";
}

/** Splits a text frame into its header block and body, and reads the Path header from the block only. */
function parseFrame(msg: string): { path: string | undefined; body: string } {
  const end = msg.indexOf("\r\n\r\n");
  const head = end === -1 ? msg : msg.slice(0, end);
  const body = end === -1 ? "" : msg.slice(end + 4);
  let path: string | undefined;
  for (const line of head.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon !== -1 && line.slice(0, colon).trim().toLowerCase() === "path") {
      path = line.slice(colon + 1).trim();
      break;
    }
  }
  return { path, body };
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

/** Thrown when voice, rate, pitch or volume is not a plain value. Callers should treat it as a 400. */
export class InvalidOptionError extends Error {}

const VOICE_RE = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)+$/;
const PROSODY_RE = /^(default|[+-]?\d+(\.\d+)?(%|Hz|st)?)$/;

function checkOption(name: string, value: string, re: RegExp): string {
  if (typeof value !== "string" || !re.test(value)) {
    throw new InvalidOptionError(`read-aloud: invalid ${name}`);
  }
  return value;
}

/** Checks the options that are set; undefined ones are skipped. Throws InvalidOptionError. */
export function assertOptions(o: { voice?: string; rate?: string; pitch?: string; volume?: string }): void {
  if (o.voice !== undefined) checkOption("voice", o.voice, VOICE_RE);
  if (o.rate !== undefined) checkOption("rate", o.rate, PROSODY_RE);
  if (o.pitch !== undefined) checkOption("pitch", o.pitch, PROSODY_RE);
  if (o.volume !== undefined) checkOption("volume", o.volume, PROSODY_RE);
}

/** Builds the SSML. voice, rate, pitch and volume go into attributes, so they are checked here. */
export function buildSsml(
  text: string,
  voice: string,
  rate: string,
  pitch: string,
  volume: string,
): string {
  checkOption("voice", voice, VOICE_RE);
  checkOption("rate", rate, PROSODY_RE);
  checkOption("pitch", pitch, PROSODY_RE);
  checkOption("volume", volume, PROSODY_RE);
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    `${escapeXml(text)}</prosody></voice></speak>`
  );
}

/**
 * Speaks the Edge "read aloud" WebSocket protocol. Server-side only: browsers can't set the
 * required Origin / User-Agent headers, which is why read-aloud ships this engine for your backend.
 */
export class EdgeTTS {
  private endpoint: string;

  constructor(options: EdgeTTSOptions = {}) {
    this.endpoint = options.endpoint ?? WSS_URL;
  }

  async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<SynthesisResult> {
    const voice = opts.voice ?? "en-US-JennyNeural";
    const rate = opts.rate ?? "+0%";
    const pitch = opts.pitch ?? "+0Hz";
    const volume = opts.volume ?? "+0%";
    const format = opts.format ?? "audio-24khz-48kbitrate-mono-mp3";
    const wantBoundaries = opts.wordBoundaries ?? true;

    if (!text || !text.trim()) throw new Error("read-aloud: text is empty");
    const ssml = buildSsml(text, voice, rate, pitch, volume);
    if (opts.signal?.aborted) throw new Error("read-aloud: aborted");
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const connectionId = randomUUID().replace(/-/g, "");
    const url =
      `${this.endpoint}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${secMsGecToken()}` +
      `&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}` +
      `&ConnectionId=${connectionId}`;

    const ws = new WebSocket(url, {
      ...(timeoutMs > 0 ? { handshakeTimeout: timeoutMs } : {}),
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => done(new Error("read-aloud: aborted"));

      const done = (err?: Error, result?: SynthesisResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        try {
          if (err) ws.terminate();
          else ws.close();
        } catch {
          /* ignore */
        }
        err ? reject(err) : resolve(result!);
      };

      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs > 0) timer = setTimeout(() => done(new Error("read-aloud: timed out")), timeoutMs);

      ws.on("open", () => {
        ws.send(
          `X-Timestamp:${timestamp()}\r\n` +
            "Content-Type:application/json; charset=utf-8\r\n" +
            "Path:speech.config\r\n\r\n" +
            `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"${wantBoundaries}"},"outputFormat":"${format}"}}}}`,
        );
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
        const { path, body } = parseFrame(msg);
        if (wantBoundaries && path === "audio.metadata") {
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
        if (path === "turn.end") {
          done(undefined, {
            audio: Buffer.concat(chunks),
            boundaries,
            contentType: contentTypeForFormat(format),
          });
        }
      });

      ws.on("error", (err) => done(err instanceof Error ? err : new Error(String(err))));
      ws.on("close", () => {
        done(
          new Error(
            chunks.length
              ? "read-aloud: connection closed before the end of the audio"
              : "read-aloud: connection closed before any audio",
          ),
        );
      });
    });
  }
}
