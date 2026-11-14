import {
  DEFAULT_TIMEOUT_MS,
  InvalidOptionError,
  buildSsml,
  contentTypeForFormat,
  type SynthesisResult,
  type SynthesizeOptions,
} from "./edge-tts.js";

/** Azure AI Speech settings. The key is a secret: it is only ever sent as a request header. */
export interface AzureSpeechOptions {
  /** Speech resource key. Falls back to the AZURE_SPEECH_KEY environment variable. */
  key?: string;
  /** Speech resource region, e.g. "eastus". Falls back to AZURE_SPEECH_REGION. */
  region?: string;
  /**
   * Replace the full REST URL, for proxies and sovereign clouds. Must be https (http only for
   * localhost), with no credentials or fragment. When set, `region` is ignored.
   */
  endpoint?: string;
  /** Largest audio response read, in bytes. Default 16 MiB. A bigger answer is an error. */
  maxAudioBytes?: number;
  /** Sent as the User-Agent header. Default "baryodev-read-aloud". Under 255 characters. */
  userAgent?: string;
}

export const DEFAULT_MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const DEFAULT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const REGION_RE = /^[a-z0-9]+$/;
const FORMAT_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;
// Characters XML 1.0 cannot carry. Azure answers 400 for them, so they are dropped.
// eslint-disable-next-line no-control-regex
const XML_INVALID_RE = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]", "g");

/**
 * Text to speech through the Azure AI Speech REST API. Same `synthesize` shape as `EdgeTTS`.
 * The REST API returns no word timings, so `boundaries` is always empty.
 */
export class AzureSpeechTTS {
  readonly #key: string;
  private readonly url: string;
  private readonly maxAudioBytes: number;
  private readonly userAgent: string;

  constructor(options: AzureSpeechOptions = {}) {
    const key = options.key ?? process.env.AZURE_SPEECH_KEY;
    if (!key || typeof key !== "string") throw new Error("read-aloud: azure speech key is not set");
    // A key with CR, LF or other control characters cannot be a valid header value.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(key)) throw new Error("read-aloud: azure speech key is not valid");
    this.#key = key;

    if (options.endpoint !== undefined) {
      let u: URL;
      try {
        u = new URL(options.endpoint);
      } catch {
        throw new Error("read-aloud: azure endpoint is not a valid URL");
      }
      const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
      if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
        throw new Error("read-aloud: azure endpoint must be https (http only for localhost)");
      }
      if (u.username || u.password || u.hash) {
        throw new Error("read-aloud: azure endpoint must not hold credentials or a fragment");
      }
      this.url = u.toString();
    } else {
      const region = options.region ?? process.env.AZURE_SPEECH_REGION;
      if (!region || !REGION_RE.test(region)) throw new Error("read-aloud: azure speech region is not set or not valid");
      this.url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    }

    const max = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    if (!Number.isSafeInteger(max) || max <= 0) {
      throw new Error("read-aloud: azure maxAudioBytes must be a positive integer");
    }
    this.maxAudioBytes = max;
    const ua = options.userAgent ?? "baryodev-read-aloud";
    if (ua.length >= 255 || /[^\x20-\x7E]/.test(ua)) throw new Error("read-aloud: azure user agent is not valid");
    this.userAgent = ua;
  }

  async synthesize(text: string, opts: SynthesizeOptions = {}): Promise<SynthesisResult> {
    const voice = opts.voice ?? "en-US-JennyNeural";
    const rate = opts.rate ?? "+0%";
    const pitch = opts.pitch ?? "+0Hz";
    const volume = opts.volume ?? "+0%";
    const format = opts.format ?? DEFAULT_FORMAT;
    if (typeof format !== "string" || !FORMAT_RE.test(format)) {
      throw new InvalidOptionError("read-aloud: invalid format");
    }

    const clean = typeof text === "string" ? text.replace(XML_INVALID_RE, "") : "";
    if (!clean.trim()) throw new Error("read-aloud: text is empty");
    const ssml = buildSsml(clean, voice, rate, pitch, volume);
    if (opts.signal?.aborted) throw new Error("read-aloud: aborted");

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let reason: "timeout" | "abort" | undefined;
    const onAbort = () => {
      reason = "abort";
      controller.abort();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            reason = "timeout";
            controller.abort();
          }, timeoutMs)
        : undefined;

    try {
      let res: Response;
      try {
        res = await fetch(this.url, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": this.#key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": format,
            "User-Agent": this.userAgent,
          },
          body: ssml,
          redirect: "error", // never forward the key to another host
          signal: controller.signal,
        });
      } catch {
        throw this.failure(reason);
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`read-aloud: azure speech answered ${res.status}`);
      }

      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > this.maxAudioBytes) {
        await res.body?.cancel().catch(() => {});
        throw new Error("read-aloud: azure speech audio too large");
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > this.maxAudioBytes) {
              await reader.cancel().catch(() => {});
              throw new Error("read-aloud: azure speech audio too large");
            }
            chunks.push(value);
          }
        }
      } catch (err) {
        if (reason) throw this.failure(reason);
        if (err instanceof Error && err.message === "read-aloud: azure speech audio too large") throw err;
        throw new Error("read-aloud: azure speech connection failed");
      }
      if (total === 0) throw new Error("read-aloud: azure speech returned no audio");

      const audio = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        audio.set(c, at);
        at += c.byteLength;
      }
      return { audio, boundaries: [], contentType: contentTypeForFormat(format) };
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  private failure(reason: "timeout" | "abort" | undefined): Error {
    if (reason === "timeout") return new Error("read-aloud: timed out");
    if (reason === "abort") return new Error("read-aloud: aborted");
    return new Error("read-aloud: azure speech request failed");
  }
}
