import { ReadAloud, type ReadAloudOptions } from "./read-aloud.js";
import type { ReadAloudState } from "./types.js";

export interface ButtonOptions extends ReadAloudOptions {
  /** Accessible label / default text. Default "Listen". */
  label?: string;
  /** Per-state text. Falls back to `label`. */
  labels?: Partial<Record<"idle" | "loading" | "playing" | "paused" | "error", string>>;
  /** Show the text label next to the icon. Default true. */
  showText?: boolean;
  /** Extra class on the button. */
  className?: string;
  /** Inject the default button stylesheet. Default true. */
  injectStyle?: boolean;
}

export interface MountedButton {
  controller: ReadAloud;
  button: HTMLButtonElement;
  destroy(): void;
}

const BTN_STYLE_ID = "read-aloud-btn-style";

const ICONS: Record<string, string> = {
  play: `<svg viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`,
  loading: `<svg viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" class="read-aloud-spin"><path stroke-linecap="round" d="M12 3a9 9 0 1 0 9 9"/></svg>`,
  error: `<svg viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="currentColor" aria-hidden="true"><path d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v4h2v-4z"/></svg>`,
};

function resolveTarget(target: string | HTMLElement): HTMLElement {
  const el = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!el) throw new Error(`read-aloud: button target not found (${String(target)})`);
  return el;
}

/**
 * Renders a ready-made play/pause button wired to a {@link ReadAloud} controller. The button is a
 * thin layer over the headless API — reach into `.controller` for anything the button doesn't do.
 */
export function mountButton(
  target: string | HTMLElement,
  options: ButtonOptions = {},
): MountedButton {
  const host = resolveTarget(target);
  if (options.injectStyle ?? true) injectButtonStyle();

  const showText = options.showText ?? true;
  const baseLabel = options.label ?? "Listen";

  const button = document.createElement("button");
  button.type = "button";
  button.className = ["read-aloud-btn", options.className].filter(Boolean).join(" ");
  button.setAttribute("aria-live", "polite");

  const icon = document.createElement("span");
  icon.className = "read-aloud-btn__icon";
  icon.innerHTML = ICONS.play;

  const text = document.createElement("span");
  text.className = "read-aloud-btn__text";
  text.textContent = baseLabel;

  button.appendChild(icon);
  if (showText) button.appendChild(text);

  const label = (state: ReadAloudState) => {
    const l = options.labels ?? {};
    if (state === "loading") return l.loading ?? "Loading…";
    if (state === "playing") return l.playing ?? "Pause";
    if (state === "paused") return l.paused ?? "Resume";
    if (state === "error") return l.error ?? "Try again";
    return l.idle ?? baseLabel;
  };

  const render = (state: ReadAloudState) => {
    button.dataset.state = state;
    const iconName =
      state === "loading" ? "loading" : state === "playing" ? "pause" : state === "error" ? "error" : "play";
    icon.innerHTML = ICONS[iconName];
    const l = label(state);
    text.textContent = l;
    button.setAttribute("aria-label", l);
    button.disabled = state === "loading";
  };

  const controller = new ReadAloud({
    ...options,
    onState: (state, prev) => {
      render(state);
      options.onState?.(state, prev);
    },
  });

  render("idle");
  button.addEventListener("click", () => void controller.toggle());
  host.appendChild(button);

  return {
    controller,
    button,
    destroy() {
      controller.destroy();
      button.remove();
    },
  };
}

function injectButtonStyle(): void {
  if (typeof document === "undefined" || document.getElementById(BTN_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = BTN_STYLE_ID;
  style.textContent = `
.read-aloud-btn{display:inline-flex;align-items:center;gap:.5em;padding:.5em .9em;font:inherit;
  font-weight:600;line-height:1;color:#fff;background:#2563eb;border:none;border-radius:999px;
  cursor:pointer;transition:background .15s ease,opacity .15s ease}
.read-aloud-btn:hover{background:#1d4ed8}
.read-aloud-btn:disabled{opacity:.7;cursor:default}
.read-aloud-btn[data-state="playing"]{background:#dc2626}
.read-aloud-btn[data-state="playing"]:hover{background:#b91c1c}
.read-aloud-btn[data-state="error"]{background:#b45309}
.read-aloud-btn__icon{display:inline-flex}
.read-aloud-spin{animation:read-aloud-spin .8s linear infinite;transform-origin:center}
@keyframes read-aloud-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.read-aloud-spin{animation:none}}`;
  document.head.appendChild(style);
}

/**
 * Registers a `<read-aloud>` custom element. Call once at startup.
 *
 *   defineReadAloudElement();
 *   // <read-aloud for="#article" voice="en-GB-RyanNeural" highlight></read-aloud>
 */
export function defineReadAloudElement(tagName = "read-aloud"): void {
  if (typeof customElements === "undefined" || customElements.get(tagName)) return;

  class ReadAloudElement extends HTMLElement {
    private mounted: MountedButton | null = null;

    connectedCallback() {
      const attr = (name: string) => this.getAttribute(name) ?? undefined;
      const has = (name: string) => this.hasAttribute(name);
      const rate = attr("playback-rate");
      this.mounted = mountButton(this, {
        endpoint: attr("endpoint"),
        source: attr("for") ?? attr("source"),
        voice: attr("voice"),
        rate: attr("rate"),
        pitch: attr("pitch"),
        volume: attr("volume"),
        label: attr("label"),
        showText: !has("icon-only"),
        highlight: has("highlight"),
        playbackRate: rate ? Number(rate) : undefined,
      });
    }

    disconnectedCallback() {
      this.mounted?.destroy();
      this.mounted = null;
    }

    /** The underlying controller, for scripting. */
    get controller(): ReadAloud | null {
      return this.mounted?.controller ?? null;
    }
  }

  customElements.define(tagName, ReadAloudElement);
}
