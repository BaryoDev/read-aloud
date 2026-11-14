import { AzureSpeechTTS, type AzureSpeechOptions } from "./azure-tts.js";
import { EdgeTTS, InvalidOptionError, assertOptions, type SynthesisResult, type SynthesizeOptions, type WordBoundary } from "./edge-tts.js";

export interface HandlerOptions {
  /** Voice used when the request doesn't specify one. */
  defaultVoice?: string;
  /** Default rate/pitch/volume applied when the request omits them. */
  defaults?: Pick<SynthesizeOptions, "rate" | "pitch" | "volume" | "format">;
  /** Cap on characters synthesized per request. Default 8000. */
  maxChars?: number;
  /** Strip HTML tags from incoming text before speaking. Default true. */
  stripHtml?: boolean;
  /** Include per-word timings in the response for highlighting. Default true. */
  wordBoundaries?: boolean;
  /**
   * Guard a request before it runs — return false (or throw) to reject.
   * Use it for auth, rate limiting, or allow-listing voices.
   * The first argument is the parsed JSON body. The second is the incoming
   * request (a `Request` for the Fetch handler, the Express `req` for the
   * Express handler), for headers, cookies or the IP. The body is already
   * consumed, so do not read it from the request again.
   *
   *   Fetch:   authorize: (body, request) => request.headers.get("authorization") === `Bearer ${token}`
   *   Express: authorize: (body, req) => req.headers.authorization === `Bearer ${token}`
   */
  authorize?: (body: ReadAloudRequest, request?: any) => boolean | Promise<boolean>;
  /** Restrict which voices callers may request. Also checked against the default voice. */
  allowedVoices?: string[];
  /** Largest request body the Fetch handler reads, in bytes. Bigger answers 413. Default 262144. */
  maxBodyBytes?: number;
  /** Give up on the speech service after this many ms. Default 30000. 0 turns it off. */
  timeoutMs?: number;
  /** Called with the real error before a 500 goes out. The caller only sees a fixed message. */
  onError?: (error: unknown) => void;
  /**
   * Which built-in engine to use. Default "edge", or "azure" when `azure` is set.
   * "azure" reads AZURE_SPEECH_KEY and AZURE_SPEECH_REGION when `azure` leaves them out.
   * The environment is never read for the default Edge engine.
   */
  backend?: "edge" | "azure";
  /** Azure AI Speech settings. Setting this selects the Azure backend. */
  azure?: AzureSpeechOptions;
  /** Use your own engine instead of the built-in one. Wins over `backend` and `azure`. */
  engine?: { synthesize: (text: string, opts?: SynthesizeOptions) => Promise<SynthesisResult> };
}

export interface ReadAloudRequest {
  text: string;
  voice?: string;
  rate?: string;
  pitch?: string;
  volume?: string;
}

/** JSON body returned to the browser client. */
export interface ReadAloudResponseBody {
  /** base64-encoded audio (MP3 by default). */
  audio: string;
  contentType: string;
  boundaries: WordBoundary[];
}

const DEFAULT_VOICE = "en-US-JennyNeural";
const DEFAULT_MAX_BODY_BYTES = 262_144;
const WS_RE = /\s+/g;
const SCRIPT_CLOSE_RE = /<\/script>/gi;
const STYLE_CLOSE_RE = /<\/style>/gi;

/** Index just past the end of a script or style element opened at `i`, or -1 when it is not one that closes. */
function skipRawElement(html: string, i: number, tagEnd: number, closed: { script: boolean; style: boolean }): number {
  const m = /^<(script|style)(?=[\s/>])/i.exec(html.slice(i, Math.min(tagEnd + 1, i + 9)));
  if (!m) return -1;
  const name = m[1].toLowerCase() as "script" | "style";
  if (closed[name]) return -1;
  const re = name === "script" ? SCRIPT_CLOSE_RE : STYLE_CLOSE_RE;
  re.lastIndex = tagEnd + 1;
  const close = re.exec(html);
  if (!close) {
    closed[name] = true; // no closing tag anywhere after this point, so none after a later one either
    return -1;
  }
  return close.index + close[0].length;
}

/**
 * Flattens HTML to text in one forward pass. Tags become a space, script and style elements are
 * dropped with their content when they close. Every search moves forward only, so the cost is
 * linear in the input whatever the markup looks like.
 */
function stripTags(html: string): string {
  const out: string[] = [];
  const closed = { script: false, style: false };
  let noMoreGt = false;
  let i = 0;
  let textStart = 0;
  while (i < html.length) {
    if (html.charCodeAt(i) !== 60 /* < */ || noMoreGt) {
      i++;
      continue;
    }
    const gt = html.indexOf(">", i + 1);
    if (gt === -1) {
      noMoreGt = true;
      break;
    }
    if (gt === i + 1) {
      i++; // "<>" is not a tag
      continue;
    }
    out.push(html.slice(textStart, i), " ");
    const skip = skipRawElement(html, i, gt, closed);
    i = textStart = skip === -1 ? gt + 1 : skip;
  }
  out.push(html.slice(textStart));
  return out
    .join("")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(WS_RE, " ")
    .trim();
}

async function synthesizeFromRequest(
  body: ReadAloudRequest,
  opts: HandlerOptions,
  signal?: AbortSignal,
): Promise<ReadAloudResponseBody> {
  const stripHtml = opts.stripHtml ?? true;
  const maxChars = opts.maxChars ?? 8000;

  let text = String(body.text ?? "");
  if (stripHtml) text = stripTags(text);
  text = text.slice(0, maxChars).trim();
  if (!text) throw new HttpError(400, "read-aloud: no text to speak");

  const voice = body.voice ?? opts.defaultVoice;
  if (opts.allowedVoices && !opts.allowedVoices.includes(voice ?? DEFAULT_VOICE)) {
    throw new HttpError(400, "read-aloud: voice not allowed");
  }

  const engine = opts.engine ?? new EdgeTTS();
  const result = await engine.synthesize(text, {
    signal,
    timeoutMs: opts.timeoutMs,
    voice,
    rate: body.rate ?? opts.defaults?.rate,
    pitch: body.pitch ?? opts.defaults?.pitch,
    volume: body.volume ?? opts.defaults?.volume,
    format: opts.defaults?.format,
    wordBoundaries: opts.wordBoundaries ?? true,
  });

  return {
    audio: Buffer.from(result.audio).toString("base64"),
    contentType: result.contentType,
    boundaries: result.boundaries,
  };
}

/** Host-set defaults are checked once at setup, so a typo fails at startup, not on every request. */
function checkDefaults(opts: HandlerOptions): HandlerOptions {
  assertOptions({
    voice: opts.defaultVoice,
    rate: opts.defaults?.rate,
    pitch: opts.defaults?.pitch,
    volume: opts.defaults?.volume,
  });
  if (opts.engine) return opts;
  const backend = opts.backend ?? (opts.azure ? "azure" : "edge");
  if (backend === "azure") return { ...opts, engine: new AzureSpeechTTS(opts.azure) };
  return opts;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Maps an error to a status and a message that is safe to show. Only our own errors keep their text. */
function describe(err: unknown, opts: HandlerOptions): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  if (err instanceof InvalidOptionError) return { status: 400, message: err.message };
  try {
    opts.onError?.(err);
  } catch {
    /* a failing hook must not change the answer */
  }
  return { status: 500, message: "read-aloud: synthesis failed" };
}

function asBody(value: unknown): ReadAloudRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "read-aloud: body must be a JSON object");
  }
  return value as ReadAloudRequest;
}

/** Reads the body as JSON, stopping at `max` bytes. */
async function readJson(request: Request, max: number): Promise<ReadAloudRequest> {
  const tooBig = () => new HttpError(413, "read-aloud: request body too large");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw tooBig();

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw tooBig();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "read-aloud: invalid JSON");
  }
  return asBody(parsed);
}

/**
 * A Web Fetch handler `(Request) => Promise<Response>`. Works anywhere the Fetch API is native:
 * Next.js App Router route handlers, Hono, Bun, Deno, Cloudflare Workers (Node runtime).
 *
 *   // app/api/read-aloud/route.ts
 *   import { createReadAloudHandler } from "@baryodev/read-aloud/server";
 *   export const POST = createReadAloudHandler();
 */
export function createReadAloudHandler(options: HandlerOptions = {}) {
  const opts = checkDefaults(options);
  return async (request: Request): Promise<Response> => {
    try {
      const body = await readJson(request, opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (opts.authorize && !(await opts.authorize(body, request))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const payload = await synthesizeFromRequest(body, opts, request.signal);
      return Response.json(payload, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (err) {
      const { status, message } = describe(err, opts);
      return Response.json({ error: message }, { status });
    }
  };
}

/**
 * An Express/Connect handler `(req, res) => void` for classic Node servers.
 *
 *   import { createReadAloudExpressHandler } from "@baryodev/read-aloud/server";
 *   app.post("/api/read-aloud", express.json(), createReadAloudExpressHandler());
 */
export function createReadAloudExpressHandler(options: HandlerOptions = {}) {
  const opts = checkDefaults(options);
  return async (
    req: { body?: unknown },
    res: {
      status: (code: number) => { json: (body: unknown) => void };
      setHeader: (name: string, value: string) => void;
      json: (body: unknown) => void;
      on?: (event: "close", listener: () => void) => unknown;
      off?: (event: "close", listener: () => void) => unknown;
      writableFinished?: boolean;
    },
  ): Promise<void> => {
    // Aborts the synthesis when the client goes away before the answer is sent.
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on?.("close", onClose);
    try {
      const body = asBody(req.body ?? {});
      if (opts.authorize && !(await opts.authorize(body, req))) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const payload = await synthesizeFromRequest(body, opts, controller.signal);
      res.setHeader("Cache-Control", "no-store");
      res.json(payload);
    } catch (err) {
      const { status, message } = describe(err, opts);
      res.status(status).json({ error: message });
    } finally {
      res.off?.("close", onClose);
    }
  };
}
