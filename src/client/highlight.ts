export interface HighlightOptions {
  /** Class added to the currently spoken word. Default "read-aloud-word--active". */
  activeClass?: string;
  /** Class added to every wrapped word. Default "read-aloud-word". */
  wordClass?: string;
  /** Scroll the active word into view. Default true. */
  scroll?: boolean;
  /** Where to scroll the active word. Default "center". */
  scrollBlock?: ScrollLogicalPosition;
  /** Don't wrap text inside these selectors. Default code/pre/script/style. */
  skipSelectors?: string[];
  /** Inject a default highlight style so it looks good with no CSS. Default true. */
  injectStyle?: boolean;
}

const DEFAULT_SKIP = ["code", "pre", "script", "style", "[data-read-aloud-skip]"];
const STYLE_ID = "read-aloud-highlight-style";

/**
 * Wraps the words of an element in spans (in place, keeping bold/links/etc.) and highlights
 * one at a time. Word index maps to the engine's per-word boundaries. Best-effort: punctuation
 * and markup can cause small drift on long text.
 */
export class Highlighter {
  private spans: HTMLElement[] = [];
  private active = -1;
  private prepared = false;
  private readonly opts: Required<Omit<HighlightOptions, "skipSelectors">> & {
    skipSelectors: string[];
  };

  constructor(
    private root: HTMLElement,
    opts: HighlightOptions = {},
  ) {
    this.opts = {
      activeClass: opts.activeClass ?? "read-aloud-word--active",
      wordClass: opts.wordClass ?? "read-aloud-word",
      scroll: opts.scroll ?? true,
      scrollBlock: opts.scrollBlock ?? "center",
      skipSelectors: opts.skipSelectors ?? DEFAULT_SKIP,
      injectStyle: opts.injectStyle ?? true,
    };
  }

  get wordCount(): number {
    return this.spans.length;
  }

  /** Wrap the element's words. Idempotent. */
  prepare(): void {
    if (this.prepared || typeof document === "undefined") return;
    if (this.opts.injectStyle) this.injectDefaultStyle();

    const skip = this.opts.skipSelectors.join(",");
    const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        let el = node.parentElement;
        while (el && el !== this.root.parentElement) {
          if (skip && el.matches(skip)) return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

    for (const node of textNodes) {
      const parts = (node.nodeValue ?? "").split(/(\s+)/);
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          frag.appendChild(document.createTextNode(part));
        } else {
          const span = document.createElement("span");
          span.className = this.opts.wordClass;
          span.textContent = part;
          frag.appendChild(span);
          this.spans.push(span);
        }
      }
      node.parentNode?.replaceChild(frag, node);
    }
    this.prepared = true;
  }

  highlight(index: number): void {
    if (!this.prepared) this.prepare();
    if (index === this.active) return;
    this.spans[this.active]?.classList.remove(this.opts.activeClass);
    this.active = index;
    const span = this.spans[index];
    if (!span) return;
    span.classList.add(this.opts.activeClass);
    if (this.opts.scroll) {
      const reduce =
        typeof matchMedia !== "undefined" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches;
      span.scrollIntoView({
        block: this.opts.scrollBlock,
        inline: "nearest",
        behavior: reduce ? "auto" : "smooth",
      });
    }
  }

  clear(): void {
    this.spans[this.active]?.classList.remove(this.opts.activeClass);
    this.active = -1;
  }

  /** Unwrap the spans and restore the original markup. */
  destroy(): void {
    this.clear();
    for (const span of this.spans) {
      const text = document.createTextNode(span.textContent ?? "");
      span.parentNode?.replaceChild(text, span);
    }
    this.spans = [];
    this.prepared = false;
    this.root.normalize();
  }

  private injectDefaultStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      `.${this.opts.activeClass}{background:rgba(250,204,21,.45);border-radius:.15em;` +
      `box-shadow:0 0 0 .1em rgba(250,204,21,.45);transition:background .1s ease}`;
    document.head.appendChild(style);
  }
}
