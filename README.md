<p align="center">
  <img src="./assets/logo.svg" width="96" height="96" alt="read-aloud" />
</p>

<h1 align="center">@baryodev/read-aloud</h1>

<p align="center">
  Add "listen to this article" to any site, using Microsoft Edge's neural voices.<br/>
  A tiny Node engine plus a framework-free browser reader: controller, web component, and word highlighting.
</p>

---

Edge's read-aloud voices are free and good. The catch: a browser can't call the service directly (it needs headers browsers refuse to set), so you need a small server piece. This package ships both halves:

- **Server**: an `EdgeTTS` engine and a drop-in endpoint handler. No API key.
- **Browser**: a headless `ReadAloud` controller you build any UI on, plus an optional button and `<read-aloud>` web component.
- **Highlighting**: per-word timings from the engine drive word highlighting in your article, formatting preserved.

Build your own UI, or use the one included. Both sit on the same controller.

## Install

```bash
npm i @baryodev/read-aloud
```

## 1. Add the endpoint (server)

The Fetch-style handler works in Next.js App Router, Hono, Bun, Deno, and Cloudflare (Node runtime).

```ts
// app/api/read-aloud/route.ts
import { createReadAloudHandler } from "@baryodev/read-aloud/server";

export const POST = createReadAloudHandler();
```

Express / classic Node:

```ts
import express from "express";
import { createReadAloudExpressHandler } from "@baryodev/read-aloud/server";

const app = express();
app.post("/api/read-aloud", express.json(), createReadAloudExpressHandler());
```

Options, all optional:

```ts
createReadAloudHandler({
  defaultVoice: "en-US-JennyNeural",
  defaults: { rate: "+0%", pitch: "+0Hz", volume: "+0%" },
  maxChars: 8000,                // longer text is cut off at this length, not rejected
  stripHtml: true,               // incoming HTML is flattened to text
  wordBoundaries: true,          // send per-word timings for highlighting
  allowedVoices: ["en-US-JennyNeural", "en-GB-RyanNeural"],
  authorize: (body) => body.text.length < 5000, // see below
});
```

`authorize` receives the parsed JSON body (`{ text, voice, rate, pitch, volume }`), not the HTTP request, so it cannot see cookies or headers. Return `false` to answer 401. To gate on a session, check it before calling the handler:

```ts
const readAloud = createReadAloudHandler();

export async function POST(req: Request) {
  if (!(await isSignedIn(req))) return new Response(null, { status: 401 });
  return readAloud(req);
}
```

What the endpoint answers:

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ audio, contentType, boundaries }` | `audio` is base64 MP3. Sent with `Cache-Control: no-store`. |
| 400 | `{ error }` | No text left after stripping, or a voice outside `allowedVoices`. |
| 401 | `{ error: "unauthorized" }` | `authorize` returned `false`. |
| 500 | `{ error }` | The speech service failed, or `authorize` threw. |

## 2. Read the page (browser)

The one-liner: drop a button next to your article.

```ts
import { mountButton } from "@baryodev/read-aloud";

mountButton("#listen", {
  source: "#article",   // read this element's text
  highlight: true,      // light each word as it's spoken
});
```

Or the web component, with no build step and no framework:

```html
<script type="module">
  import { defineReadAloudElement } from "@baryodev/read-aloud";
  defineReadAloudElement();
</script>

<article id="article"> … </article>
<read-aloud for="#article" voice="en-GB-RyanNeural" highlight></read-aloud>
```

Attributes on `<read-aloud>`:

| Attribute | Same as |
| --- | --- |
| `for` (or `source`) | `source` selector |
| `endpoint` | `endpoint` |
| `voice`, `rate`, `pitch`, `volume` | the same options |
| `playback-rate` | `playbackRate` |
| `label` | button text, default "Listen" |
| `highlight` | `highlight: true` |
| `icon-only` | `showText: false` |

The element's `controller` property gives you the underlying `ReadAloud`. Pass a name to `defineReadAloudElement("my-reader")` to register a different tag. The web component always injects the default styles; use `mountButton` with `injectStyle: false` if you need to turn that off.

## 3. Or build your own UI (headless)

`mountButton` and `<read-aloud>` are thin wrappers. The real API is the `ReadAloud` controller. Wire it to whatever buttons, progress bar, or highlight style you want.

```ts
import { createReadAloud } from "@baryodev/read-aloud";

const reader = createReadAloud({
  source: "#article",
  voice: "en-US-JennyNeural",
  rate: "+0%",
  highlight: true,
  onState: (state) => { myButton.dataset.state = state; }, // idle|loading|ready|playing|paused|ended|error
  onWord: (i, word) => { /* your own highlighting */ },
  onProgress: ({ ratio }) => { myScrubber.value = ratio; },
  onError: (err) => toast(err.message),
});

myPlayButton.onclick = () => reader.toggle();
myStopButton.onclick = () => reader.stop();
myScrubber.oninput = () => reader.seek({ ratio: myScrubber.valueAsNumber });
```

Controller surface:

| Member | What it does |
| --- | --- |
| `play()` / `pause()` / `toggle()` | Synthesize if needed, then play/pause. |
| `stop()` | Pause and rewind to the start. |
| `seek(seconds \| { ratio })` | Jump to a time or a 0 to 1 position. |
| `preload()` | Fetch the audio ahead of time (e.g. on hover). |
| `update({ voice, rate, … })` | Change voice/prosody; invalidates cached audio. |
| `destroy()` | Free the audio URL and unwrap highlighting. |
| `state`, `duration`, `currentTime`, `boundaries` | Read-only getters. |
| `audioElement`, `objectUrl` | The `<audio>` element and its blob URL, `null` before the first load. |
| `onState`, `onWord`, `onProgress`, `onReady`, `onEnd`, `onError` | Events. |

### Download the recording

```ts
import { createReadAloud, downloadRecording } from "@baryodev/read-aloud";

await reader.preload();
downloadRecording(reader, "chapter-1.mp3"); // false if nothing is loaded yet
```

## Customization

Everything is a plain option.

```ts
createReadAloud({
  endpoint: "/api/read-aloud",     // your route
  source: () => document.querySelector(".post-body"), // string | element | fn
  text: "Or just pass raw text.",  // skip the DOM entirely
  voice: "en-GB-SoniaNeural",
  rate: "+10%", pitch: "-2st", volume: "+0%",
  playbackRate: 1.25,              // native speed, no re-synthesis
  cache: true,                     // reuse audio across replays
  headers: { Authorization: `Bearer ${token}` },
  credentials: "include",
  highlight: {
    activeClass: "is-reading",     // your CSS instead of the default amber
    wordClass: "ra-word",
    scroll: true, scrollBlock: "center",
    skipSelectors: ["code", "pre", "script", "style", "figure"], // don't highlight these
    injectStyle: false,            // opt out of the built-in highlight CSS
  },
  fetchAudio: async (payload) => myProvider(payload), // swap the transport / TTS provider entirely
});
```

About `skipSelectors`:

- It replaces the default list (`code`, `pre`, `script`, `style`, `[data-read-aloud-skip]`), so repeat the ones you still want.
- It only stops highlighting. The text inside is still read aloud, because the reader reads the element's `innerText`, and highlighting drifts by the number of skipped words. To leave something out of both, pass `text` with that part removed.

Style the shipped button with plain CSS (or pass `injectStyle: false` and start from scratch):

```css
.read-aloud-btn { background: #16a34a; }
.read-aloud-btn[data-state="playing"] { background: #dc2626; }
.read-aloud-word--active { background: #bfdbfe; }
```

## Word highlighting on its own

Have your own audio pipeline but want the highlighting? Use `Highlighter` directly.

```ts
import { Highlighter } from "@baryodev/read-aloud";

const hl = new Highlighter(document.querySelector("#article"), { scroll: true });
hl.prepare();
// as your audio plays:
hl.highlight(wordIndex);
// cleanup:
hl.destroy();
```

## Using the engine directly

The handler is a thin layer over `EdgeTTS`. Use it on its own to pre-render audio, write files, or put it behind your own route.

```ts
import { writeFile } from "node:fs/promises";
import { EdgeTTS } from "@baryodev/read-aloud/server";

const { audio, boundaries, contentType } = await new EdgeTTS().synthesize("Hello there.", {
  voice: "en-GB-RyanNeural",
  rate: "+0%",
  wordBoundaries: true,
  signal: AbortSignal.timeout(30_000),
});
await writeFile("hello.mp3", audio);
```

`boundaries` is `{ text, offset, duration }[]` in milliseconds. Pass a `signal`: the engine has no timeout of its own (see Troubleshooting).

## Content Security Policy

If your site sends a CSP header, the reader needs:

| Directive | Value | Why |
| --- | --- | --- |
| `media-src` | `'self' blob:` | Audio plays from a `blob:` URL made from the fetched bytes. Without it the browser blocks playback and the controller goes to `error` with "audio failed to load". |
| `connect-src` | your endpoint's origin | Only if the endpoint is on another origin. Same-origin is covered by `'self'`. |
| `style-src` | `'unsafe-inline'` | Only if you keep the built-in styles, which are added as a `<style>` element. Otherwise pass `injectStyle: false` to `mountButton` and to `highlight`, and ship the CSS yourself. |

The Edge service is called from your server, so it never appears in the browser's CSP.

## Voices

Any Microsoft neural voice name works, e.g. `en-US-JennyNeural`, `en-US-GuyNeural`, `en-GB-RyanNeural`, `en-GB-SoniaNeural`, `en-AU-NatashaNeural`, `fil-PH-BlessicaNeural`. Restrict what callers may pick with `allowedVoices` on the handler.

## Troubleshooting

- **"audio failed to load" in the browser.** Usually the CSP `media-src` above. Check the console for a CSP violation.
- **"read-aloud: connection closed before any audio".** The service accepted the connection and closed it without sending audio, most often for an unknown voice name or a voice that does not support the language of the text.
- **The request hangs.** The service sometimes accepts the connection and then sends nothing, for example when it rejects the time-based token because the server clock is off. The engine does not time out on its own, so set a timeout on your route or pass `signal` to `EdgeTTS`, and keep the server clock synced.
- **The service drops the socket after the audio.** Seen on some networks: it sends all the audio and the end-of-turn message, then disconnects. The engine has the audio by then and returns it, so this is not an error.
- **It stopped working everywhere.** This is the public endpoint Edge uses, not a contracted API, and Microsoft can change it. Check [rany2/edge-tts](https://github.com/rany2/edge-tts) for a protocol change and open an issue here.

## Notes

- **SSR-safe.** Importing does nothing until you call into it. The controller only touches the DOM in the browser.
- **No API key, no account.** It rides the same public endpoint Edge uses. Be a good citizen: cache, cap length (`maxChars`), and gate it if it's public.
- **Response shape.** The endpoint returns `{ audio: base64, contentType, boundaries }`. Point `fetchAudio` elsewhere to use a different backend.

## License

MIT © BaryoDev
