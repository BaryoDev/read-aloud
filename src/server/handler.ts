import { EdgeTTS, type SynthesizeOptions, type WordBoundary } from "./edge-tts.js";

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
   */
  authorize?: (req: ReadAloudRequest) => boolean | Promise<boolean>;
  /** Restrict which voices callers may request. */
  allowedVoices?: string[];
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

const TAG_RE = /<[^>]+>/g;
const WS_RE = /\s+/g;

function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(TAG_RE, " ")
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
): Promise<ReadAloudResponseBody> {
  const stripHtml = opts.stripHtml ?? true;
  const maxChars = opts.maxChars ?? 8000;

  let text = String(body.text ?? "");
  if (stripHtml) text = stripTags(text);
  text = text.slice(0, maxChars).trim();
  if (!text) throw new HttpError(400, "read-aloud: no text to speak");

  let voice = body.voice ?? opts.defaultVoice;
  if (opts.allowedVoices && voice && !opts.allowedVoices.includes(voice)) {
    throw new HttpError(400, "read-aloud: voice not allowed");
  }

  const engine = new EdgeTTS();
  const result = await engine.synthesize(text, {
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

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * A Web Fetch handler `(Request) => Promise<Response>`. Works anywhere the Fetch API is native:
 * Next.js App Router route handlers, Hono, Bun, Deno, Cloudflare Workers (Node runtime).
 *
 *   // app/api/read-aloud/route.ts
 *   import { createReadAloudHandler } from "@baryodev/read-aloud/server";
 *   export const POST = createReadAloudHandler();
 */
export function createReadAloudHandler(opts: HandlerOptions = {}) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = (await request.json()) as ReadAloudRequest;
      if (opts.authorize && !(await opts.authorize(body))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const payload = await synthesizeFromRequest(body, opts);
      return Response.json(payload, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : "read-aloud: synthesis failed";
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
export function createReadAloudExpressHandler(opts: HandlerOptions = {}) {
  return async (
    req: { body?: unknown },
    res: {
      status: (code: number) => { json: (body: unknown) => void };
      setHeader: (name: string, value: string) => void;
      json: (body: unknown) => void;
    },
  ): Promise<void> => {
    try {
      const body = (req.body ?? {}) as ReadAloudRequest;
      if (opts.authorize && !(await opts.authorize(body))) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const payload = await synthesizeFromRequest(body, opts);
      res.setHeader("Cache-Control", "no-store");
      res.json(payload);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : "read-aloud: synthesis failed";
      res.status(status).json({ error: message });
    }
  };
}
