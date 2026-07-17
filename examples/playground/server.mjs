import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EdgeTTS } from "../../dist/server.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3006;
const MAX_CHARS = 8000;
const engine = new EdgeTTS();
const ALLOWED = new Set([
  "en-US-JennyNeural", "en-US-GuyNeural", "en-GB-RyanNeural",
  "en-GB-SoniaNeural", "en-AU-NatashaNeural", "fil-PH-BlessicaNeural",
]);

const strip = (html) =>
  html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

const cache = {};
async function serveFile(res, name, type) {
  cache[name] ??= await readFile(join(__dir, name));
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=300" });
  res.end(cache[name]);
}
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 2_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const path = pathname.replace(/^\/read-aloud/, "") || "/";
  try {
    if (req.method === "GET" && (path === "/" || path === ""))
      return serveFile(res, "index.html", "text/html; charset=utf-8");
    if (req.method === "GET" && path === "/read-aloud.js")
      return serveFile(res, "read-aloud.js", "text/javascript; charset=utf-8");

    if (req.method === "POST" && path === "/api/speak") {
      const { text = "", voice } = JSON.parse((await readBody(req)) || "{}");
      const clean = strip(String(text)).slice(0, MAX_CHARS).trim();
      if (!clean) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end('{"error":"no text to speak"}');
      }
      const v = ALLOWED.has(voice) ? voice : "en-US-JennyNeural";
      const result = await engine.synthesize(clean, { voice: v, wordBoundaries: true });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(
        JSON.stringify({
          audio: Buffer.from(result.audio).toString("base64"),
          contentType: result.contentType,
          boundaries: result.boundaries,
        }),
      );
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`read-aloud demo listening on 127.0.0.1:${PORT}`));
