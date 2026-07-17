import { Highlighter, type HighlightOptions } from "./highlight.js";
import type {
  FetchPayload,
  FetchResult,
  ReadAloudState,
  WordBoundary,
} from "./types.js";

export interface ReadAloudOptions {
  /** Your synthesis endpoint. Default "/api/read-aloud". */
  endpoint?: string;
  /** Explicit text to read. Takes priority over `source`. */
  text?: string | (() => string);
  /**
   * Read text from the DOM: a selector, an element, or a function returning either.
   * Required if you want highlighting.
   */
  source?: string | HTMLElement | (() => string | HTMLElement | null);
  voice?: string;
  rate?: string;
  pitch?: string;
  volume?: string;
  /** Highlight words as they're spoken. Needs `source` to resolve to an element. */
  highlight?: boolean | HighlightOptions;
  /** Reuse audio across replays of the same text/voice. Default true. */
  cache?: boolean;
  /** Native playback speed (does not re-synthesize). 1 = normal. */
  playbackRate?: number;
  /** Extra headers on the fetch (e.g. auth). */
  headers?: Record<string, string>;
  /** Fetch credentials mode. Default "same-origin". */
  credentials?: RequestCredentials;
  /** Replace the default transport entirely (bring your own backend/provider). */
  fetchAudio?: (payload: FetchPayload) => Promise<FetchResult>;

  onState?: (state: ReadAloudState, previous: ReadAloudState) => void;
  onWord?: (index: number, boundary: WordBoundary) => void;
  onProgress?: (progress: { currentTime: number; duration: number; ratio: number }) => void;
  onReady?: () => void;
  onEnd?: () => void;
  onError?: (error: Error) => void;
}

interface Loaded {
  url: string;
  boundaries: WordBoundary[];
  key: string;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toBytes(audio: FetchResult["audio"]): Uint8Array {
  if (typeof audio === "string") return base64ToBytes(audio);
  if (audio instanceof Uint8Array) return audio;
  return new Uint8Array(audio);
}

/**
 * Headless read-aloud controller. Drives an `<audio>` element and emits state/word/progress
 * events. Build any UI on top, or use the shipped button/web-component which wrap this.
 */
export class ReadAloud {
  private opts: ReadAloudOptions;
  private audioEl: HTMLAudioElement | null = null;
  private highlighter: Highlighter | null = null;
  private loaded: Loaded | null = null;
  private _state: ReadAloudState = "idle";
  private wordIndex = -1;
  private loadPromise: Promise<void> | null = null;
  private currentAbort: AbortController | null = null;

  constructor(opts: ReadAloudOptions = {}) {
    this.opts = opts;
  }

  get state(): ReadAloudState {
    return this._state;
  }

  get boundaries(): WordBoundary[] {
    return this.loaded?.boundaries ?? [];
  }

  get audioElement(): HTMLAudioElement | null {
    return this.audioEl;
  }

  /** The current audio object URL, or null before load. Handy for a "download recording" link. */
  get objectUrl(): string | null {
    return this.loaded?.url ?? null;
  }

  get duration(): number {
    return this.audioEl?.duration || 0;
  }

  get currentTime(): number {
    return this.audioEl?.currentTime || 0;
  }

  /** Load audio without playing (e.g. warm the cache on hover). */
  async preload(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.load().finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  async play(): Promise<void> {
    try {
      await this.preload();
      const el = this.audioEl;
      if (!el) return;
      if (this.opts.playbackRate) el.playbackRate = this.opts.playbackRate;
      await el.play();
    } catch (err) {
      this.fail(err);
    }
  }

  pause(): void {
    this.audioEl?.pause();
  }

  async toggle(): Promise<void> {
    if (this._state === "playing") this.pause();
    else await this.play();
  }

  stop(): void {
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.currentTime = 0;
    }
    this.highlighter?.clear();
    this.wordIndex = -1;
    this.setState("ready");
  }

  /** Seek to a time in seconds, or a 0..1 ratio via `{ ratio }`. */
  seek(to: number | { ratio: number }): void {
    if (!this.audioEl) return;
    const secs =
      typeof to === "number" ? to : (this.audioEl.duration || 0) * clamp01(to.ratio);
    this.audioEl.currentTime = secs;
  }

  /** Change voice/prosody for the next play. Invalidates cached audio. */
  update(patch: Partial<Pick<ReadAloudOptions, "voice" | "rate" | "pitch" | "volume" | "text">>): void {
    this.opts = { ...this.opts, ...patch };
    this.invalidate();
  }

  /** Free the audio URL, unwrap highlights, drop listeners. */
  destroy(): void {
    this.currentAbort?.abort();
    this.invalidate();
    this.highlighter?.destroy();
    this.highlighter = null;
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.removeAttribute("src");
      this.audioEl = null;
    }
  }

  // --- internals ---

  private setState(next: ReadAloudState): void {
    if (next === this._state) return;
    const prev = this._state;
    this._state = next;
    this.opts.onState?.(next, prev);
  }

  private fail(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.setState("error");
    this.opts.onError?.(error);
  }

  private invalidate(): void {
    if (this.loaded) {
      URL.revokeObjectURL(this.loaded.url);
      this.loaded = null;
    }
  }

  private resolveText(): { text: string; element: HTMLElement | null } {
    if (this.opts.text != null) {
      const t = typeof this.opts.text === "function" ? this.opts.text() : this.opts.text;
      return { text: t, element: this.resolveElement() };
    }
    const el = this.resolveElement();
    return { text: el ? (el.innerText ?? el.textContent ?? "") : "", element: el };
  }

  private resolveElement(): HTMLElement | null {
    const src = this.opts.source;
    if (!src || typeof document === "undefined") return null;
    const value = typeof src === "function" ? src() : src;
    if (!value) return null;
    if (typeof value === "string") return document.querySelector<HTMLElement>(value);
    return value;
  }

  private cacheKey(text: string): string {
    const { voice, rate, pitch, volume } = this.opts;
    return `${voice ?? ""}|${rate ?? ""}|${pitch ?? ""}|${volume ?? ""}|${text}`;
  }

  private async load(): Promise<void> {
    const { text, element } = this.resolveText();
    if (!text.trim()) throw new Error("read-aloud: no text to read");

    const key = this.cacheKey(text);
    const useCache = this.opts.cache ?? true;
    if (useCache && this.loaded?.key === key && this.audioEl) return;
    if (!useCache) this.invalidate();

    this.setState("loading");
    this.currentAbort?.abort();
    const abort = new AbortController();
    this.currentAbort = abort;

    const payload: FetchPayload = {
      text,
      voice: this.opts.voice,
      rate: this.opts.rate,
      pitch: this.opts.pitch,
      volume: this.opts.volume,
    };

    const result = this.opts.fetchAudio
      ? await this.opts.fetchAudio(payload)
      : await this.defaultFetch(payload, abort.signal);

    const bytes = toBytes(result.audio);
    const blob = new Blob([bytes as BlobPart], { type: result.contentType ?? "audio/mpeg" });
    const url = URL.createObjectURL(blob);

    this.invalidate();
    this.loaded = { url, boundaries: result.boundaries ?? [], key };

    this.setupAudio(url);
    this.setupHighlighter(element);
    this.setState("ready");
    this.opts.onReady?.();
  }

  private async defaultFetch(payload: FetchPayload, signal: AbortSignal): Promise<FetchResult> {
    const res = await fetch(this.opts.endpoint ?? "/api/read-aloud", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.opts.headers },
      credentials: this.opts.credentials ?? "same-origin",
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`read-aloud: endpoint returned ${res.status} ${detail}`.trim());
    }
    return (await res.json()) as FetchResult;
  }

  private setupAudio(url: string): void {
    if (!this.audioEl) {
      this.audioEl = typeof Audio !== "undefined" ? new Audio() : null;
      if (!this.audioEl) throw new Error("read-aloud: Audio is not available (server render?)");
      this.audioEl.preload = "auto";
      this.audioEl.addEventListener("playing", () => this.setState("playing"));
      this.audioEl.addEventListener("pause", () => {
        if (this.audioEl && this.audioEl.currentTime < this.audioEl.duration) {
          if (this._state === "playing") this.setState("paused");
        }
      });
      this.audioEl.addEventListener("ended", () => {
        this.setState("ended");
        this.highlighter?.clear();
        this.wordIndex = -1;
        this.opts.onEnd?.();
      });
      this.audioEl.addEventListener("timeupdate", () => this.onTimeUpdate());
      this.audioEl.addEventListener("error", () => this.fail(new Error("read-aloud: audio failed to load")));
    }
    if (this.opts.playbackRate) this.audioEl.playbackRate = this.opts.playbackRate;
    this.audioEl.src = url;
  }

  private setupHighlighter(element: HTMLElement | null): void {
    if (!this.opts.highlight || !element) return;
    const hlOpts = typeof this.opts.highlight === "object" ? this.opts.highlight : {};
    if (this.highlighter) this.highlighter.destroy();
    this.highlighter = new Highlighter(element, hlOpts);
    this.highlighter.prepare();
  }

  private onTimeUpdate(): void {
    const el = this.audioEl;
    if (!el) return;
    const duration = el.duration || 0;
    const currentTime = el.currentTime;
    this.opts.onProgress?.({
      currentTime,
      duration,
      ratio: duration ? currentTime / duration : 0,
    });

    const boundaries = this.loaded?.boundaries;
    if (!boundaries || !boundaries.length) return;
    const ms = currentTime * 1000;
    let idx = this.wordIndex;
    // advance forward while the next word has already started
    while (idx + 1 < boundaries.length && boundaries[idx + 1].offset <= ms) idx++;
    // handle backward seeks
    while (idx >= 0 && boundaries[idx] && boundaries[idx].offset > ms) idx--;
    if (idx !== this.wordIndex && idx >= 0) {
      this.wordIndex = idx;
      this.highlighter?.highlight(idx);
      this.opts.onWord?.(idx, boundaries[idx]);
    }
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Convenience factory. `const reader = createReadAloud({ source: "#article" })`. */
export function createReadAloud(opts?: ReadAloudOptions): ReadAloud {
  return new ReadAloud(opts);
}
