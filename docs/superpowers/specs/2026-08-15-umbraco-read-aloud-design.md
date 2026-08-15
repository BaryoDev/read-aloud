# BaryoDev.Umbraco.ReadAloud

Design, 15 August 2026.

An Umbraco package that adds "listen to this article" to a site, using Microsoft Edge's neural
voices, with the audio generated and cached on the site's own server.

It is the CMS-side sibling of [`@baryodev/read-aloud`](https://www.npmjs.com/package/@baryodev/read-aloud),
which is published and framework-agnostic. The browser half is reused; the server half is ported
from TypeScript to C#.

## Why this exists

There is no text-to-speech package on the Umbraco Marketplace. Searching 906 packages for "text
to speech", "read aloud" or "audio" returns only generic fallbacks, which on that search engine
is the signature of nothing matching.

Meanwhile Medium charges **$5 a month or $50 a year** for its Listen button, and its own help
centre states: *"You must have a Medium account with an active membership subscription in order
to listen to stories."* The voices this uses are free.

## The four decisions

| Decision | Choice |
|---|---|
| Integration | `appsettings.json` only for v1. Per-page override deferred |
| Audio storage | Disk cache under `App_Data`. No database, no migration |
| Text source | **Server reads the published property**, not browser-sends-text |
| Generation | **Lazy**, on first request. Nothing happens on publish |

Server-side reading is the one a framework-agnostic package cannot do, and it is what makes the
cache self-invalidating. Lazy generation is what keeps an unofficial endpoint from being hammered
by a full site republish.

## Architecture

| Component | Responsibility |
|---|---|
| `IReadAloudEngine` | The seam. One method: text plus voice in, audio plus word timings out |
| `EdgeTtsEngine` | Default implementation. Port of the 181-line TypeScript engine |
| `AzureSpeechEngine` | Official fallback, opt-in by configuration |
| `IAudioCache` / `DiskAudioCache` | One `.mp3` and one `.json` per key, under `App_Data` |
| `ContentTextResolver` | Reads the configured property from published content, strips markup |
| `ReadAloudController` | `GET /read-aloud/{nodeKey}` at the site root |
| `readaloud.js` | Compiled from the existing client TypeScript. Served as one file, no build step for the site owner |
| Property editor | Per-page override. A plain custom element, `uui-*` components only |

### Request flow

```
Reader presses Listen
  GET /read-aloud/{nodeKey}?voice=en-GB-SoniaNeural
    resolve node -> read configured property -> strip to text
    key = sha256(text + voice + rate + pitch)
    hit  -> stream mp3 + timings
    miss -> synthesize (~2s) -> write both -> stream
```

The key includes the text, so **editing a page changes the key**. A stale recording can never be
served and nothing needs to invalidate anything. Orphaned files are the only cost, and deleting
the folder is always safe.

### Configuration precedence

**v1 is configuration only.** `appsettings.json`, then the built-in default.

A per-page editor override was designed and deliberately deferred, so the precedence rule is
already settled for when it arrives: page override, then config, then default, with a page value
counting only when explicitly set, since empty means "inherit" rather than "off". Deferring it
keeps v1 free of any backoffice extension and any schema of its own.

## The endpoint is unofficial, and users must be told

**This is the single biggest risk in the product and it will be stated plainly in the README, in
the Marketplace description, and in the backoffice.** Not buried in a FAQ.

The Edge read-aloud service is what the Edge browser itself calls. It is **not a supported
Microsoft API**. There is no contract, no SLA, no rate card, and no commitment that it will look
the same next year. Microsoft could change or close it without notice, and would owe nobody an
explanation.

**It is unsupported, but it is neither obscure nor new.** Measured 15 August 2026:

| | |
|---|---|
| `edge-tts` on PyPI | 14,645,228 downloads/month |
| `node-edge-tts` on npm | 8,603,847 downloads/month |
| `msedge-tts` on npm | 152,785/month |
| `rany2/edge-tts` on GitHub | 11,727 stars, 1,078 forks |
| First released | May 2021, still actively maintained |

Roughly 23 million downloads a month across those, and five years of this integration path being
used at scale without Microsoft closing it.

That is worth stating alongside the warning, because it is the difference between "a clever hack"
and "a widely used path with a long track record". It still proves nothing about tomorrow.
Popularity is not a contract, and one could argue heavy use makes eventual rate limiting more
likely rather than less. The five-year record is why building on it is reasonable; the absence of
a contract is why both fallbacks below are wired in rather than optional.

Wording to use, roughly: *"This uses the same free endpoint Microsoft Edge uses for its own
read-aloud feature. It is not a supported Microsoft API and could change or stop working without
notice. If you need a guarantee, configure the Azure Speech provider, which is the same voices
with a contract and a bill."*

### Two fallback layers

**1. Azure Speech, configured.** Official, supported, SLA-backed, same neural voices. Swapping is
a config change, because everything above `IReadAloudEngine` is unaware of which implementation is
running. This is the answer for anyone who needs a guarantee.

```json
"BaryoDev": {
  "ReadAloud": {
    "Provider": "AzureSpeech",
    "AzureSpeech": { "SubscriptionKey": "...", "Region": "southeastasia" }
  }
}
```

**2. The browser's own speech synthesis, automatic.** When the server returns `503`, the client
falls back to `window.speechSynthesis`, which is built into every modern browser, costs nothing
and needs no server. Quality is noticeably worse and word timings come from `boundary` events
rather than the engine, so highlighting is less precise. It is a degradation, not a replacement,
and the client says so in its status rather than pretending nothing changed.

That gives three tiers: free and good, paid and guaranteed, free and always available.

## Failure behaviour

- **The reader never sees a broken control.** On failure the endpoint returns `503`, the client
  attempts browser synthesis, and if that is unavailable it hides the button. A button that
  cannot play is worse than no button.
- **Publishing is never affected**, a free consequence of lazy generation.
- **Failures log once with the cause**, not once per request.
- **One synthesis per cache key at a time.** Two hundred simultaneous readers of a new article
  must not open two hundred WebSockets; the rest wait and are served the same result.
- **Nothing is cached on failure**, so a transient error cannot poison a key.

## Configuration

All optional, all with working defaults.

```json
"BaryoDev": {
  "ReadAloud": {
    "Enabled": true,
    "DocumentTypes": [ "article", "blogPost" ],
    "PropertyAlias": "bodyText",
    "DefaultVoice": "en-GB-SoniaNeural",
    "AllowedVoices": [ "en-GB-SoniaNeural", "en-US-JennyNeural", "fil-PH-BlessicaNeural" ],
    "MaxChars": 8000,
    "CachePath": "App_Data/BaryoDev/ReadAloud",
    "RateLimitPerMinute": 20
  }
}
```

## Privacy

**Nothing is stored about a listener.** No table, no migration, no identity, no IP. The only
state is derived audio on disk. This is the same guarantee the PWA package makes, and it is the
reason to choose this over a hosted service.

## Non-goals for v1

Named explicitly so they do not get built early.

- **The per-page editor override.** Designed above, deferred. It needs a property editor and a
  precedence rule, and neither is required to ship something useful. **Extension point:** the
  controller already resolves the node before reading the property, so an override is a lookup on
  that node ahead of falling back to config. No restructuring.
- **Listen counts.** Wanted later, and it is the PWA package's argument transplanted: count
  listens in your own database with no listener identity, where Medium and any hosted service
  would hold that data themselves. **Extension point:** the controller already knows the node key
  and voice on every request, so this is one call at the point audio is served, plus one table and
  one migration. No restructuring.
- Voice previewing in the backoffice.
- Bulk or scheduled pre-generation. Deliberately excluded; it is what makes eager generation
  dangerous on an unofficial endpoint.
- Reading anything other than a single configured property. Block lists and composed content are
  a later problem.
- Downloading the audio as a file. The npm package has it; it is not needed here yet.

## Testing

Follows the PWA package's approach.

- **A real Umbraco on SQLite**, not a mocked host. Property resolution, route registration and
  config binding only work under a real boot; a test double passes with all three broken.
- **The engine is tested against recorded frames**, so the suite never depends on Microsoft being
  reachable. A separate, explicitly-tagged test hits the live endpoint and is excluded from CI.
- **Cache behaviour is tested directly**: a miss writes, a hit does not re-synthesize, a failure
  writes nothing, and concurrent requests for one key produce one synthesis.
- **CI runs against Umbraco 16, 17 and 18**, as the PWA package does. Those versions differ more
  than expected, so a difference needs a conditional rather than a version bump.

## Playground

A **separate container** on the existing Oracle VM, not the PWA demo instance. That demo's claim
is that anything working there works because of that one package, and installing a second spoils
it. Same pattern as `umbraco-pwa-demo`: own container, own port, behind nginx.

**The demo needs published content**, which is a real difference from the PWA fixture. That site
deliberately has nothing published, which is what produced the `StartUrl` bug. This package reads
a property off a published node, so the demo must have a genuine article, and the test fixture
must publish one too.

## Open questions

- Which Umbraco property editor type the override uses, and whether the voice list is fetched from
  the engine or configured.
- Whether the client is bundled into the package as a compiled asset or reuses the published npm
  build. Bundling keeps "no build step" true for the site owner.
