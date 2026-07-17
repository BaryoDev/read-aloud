<p align="center">
  <img src="./assets/logo.svg" width="96" height="96" alt="read-aloud" />
</p>

<h1 align="center">@baryodev/read-aloud</h1>

<p align="center">
  Add "listen to this article" to any site, using Microsoft Edge's neural voices.<br/>
  A tiny Node engine plus a framework-free browser reader — controller, web component, and word highlighting.
</p>

---

Edge's read-aloud voices are free and good. The catch: a browser can't call the service directly (it needs headers browsers refuse to set), so you need a small server piece. This package ships both halves and gets out of your way:

- **Server** — a `EdgeTTS` engine and a drop-in endpoint handler. No API key.
- **Browser** — a headless `ReadAloud` controller you build any UI on, plus an optional button and `<read-aloud>` web component.
- **Highlighting** — per-word timings from the engine drive word highlighting in your article, formatting preserved.

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

Options — all optional:

```ts
createReadAloudHandler({
  defaultVoice: "en-US-JennyNeural",
  defaults: { rate: "+0%", pitch: "+0Hz", volume: "+0%" },
  maxChars: 8000,
  stripHtml: true,               // incoming HTML is flattened to text
  allowedVoices: ["en-US-JennyNeural", "en-GB-RyanNeural"],
  authorize: (req) => isSignedIn(req), // gate synthesis (auth, rate limit)
});
```

## 2. Read the page (browser)

The one-liner: drop a button next to your article.

```ts
import { mountButton } from "@baryodev/read-aloud";

mountButton("#listen", {
  source: "#article",   // read this element's text
  highlight: true,      // light each word as it's spoken
});
```

Or the web component — no build step, no framework:

```html
<script type="module">
  import { defineReadAloudElement } from "@baryodev/read-aloud";
  defineReadAloudElement();
</script>

<article id="article"> … </article>
<read-aloud for="#article" voice="en-GB-RyanNeural" highlight></read-aloud>
```

## 3. Or build your own UI (headless)

`mountButton` and `<read-aloud>` are thin wrappers. The real API is the `ReadAloud` controller — wire it to whatever buttons, progress bar, or highlight style you want.

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
| `seek(seconds \| { ratio })` | Jump to a time or a 0–1 position. |
| `preload()` | Fetch the audio ahead of time (e.g. on hover). |
| `update({ voice, rate, … })` | Change voice/prosody; invalidates cached audio. |
| `destroy()` | Free the audio URL and unwrap highlighting. |
| `state`, `duration`, `currentTime`, `boundaries` | Read-only getters. |
| `onState`, `onWord`, `onProgress`, `onReady`, `onEnd`, `onError` | Events. |

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
    skipSelectors: ["code", "pre", "figure"], // don't read/highlight these
    injectStyle: false,            // opt out of the built-in highlight CSS
  },
  fetchAudio: async (payload) => myProvider(payload), // swap the transport / TTS provider entirely
});
```

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

## Voices

Any Microsoft neural voice name works, e.g. `en-US-JennyNeural`, `en-US-GuyNeural`, `en-GB-RyanNeural`, `en-GB-SoniaNeural`, `en-AU-NatashaNeural`, `fil-PH-BlessicaNeural`. Restrict what callers may pick with `allowedVoices` on the handler.

## Notes

- **SSR-safe.** Importing does nothing until you call into it. The controller only touches the DOM in the browser.
- **No API key, no account.** It rides the same public endpoint Edge uses. Be a good citizen: cache, cap length (`maxChars`), and gate with `authorize` if it's public.
- **Response shape.** The endpoint returns `{ audio: base64, contentType, boundaries }`. Point `fetchAudio` elsewhere to use a different backend.

## License

MIT © BaryoDev
