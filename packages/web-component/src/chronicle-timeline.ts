import type { Timeline } from "@chronicle/schema";
import { TimelineRenderer, BASE_STYLES, createStyleSheet } from "@chronicle/core";

let instanceCounter = 0;

export class ChronicleTimeline extends HTMLElement {
  public static get observedAttributes(): string[] {
    return [
      "src",
      "data",
      "layout",
      "theme",
      "locale",
      "start-date",
      "zoom",
      "filter-tags",
      "height",
      "width",
    ];
  }

  private _timelineData: Timeline | null = null;
  private renderer: TimelineRenderer | null = null;
  private shadow: ShadowRoot;
  private containerEl: HTMLElement;
  private instanceId: string;
  private abortController: AbortController | null = null;

  constructor() {
    super();
    this.instanceId = `chronicle-timeline-${++instanceCounter}`;
    this.shadow = this.attachShadow({ mode: "open" });

    // Adopt base stylesheet into Shadow DOM
    try {
      const sheet = createStyleSheet(BASE_STYLES);
      this.shadow.adoptedStyleSheets = [sheet];
    } catch {
      // Fallback for browsers without adoptedStyleSheets support
      const styleEl = document.createElement("style");
      styleEl.textContent = BASE_STYLES;
      this.shadow.appendChild(styleEl);
    }

    this.containerEl = document.createElement("div");
    this.containerEl.id = this.instanceId;
    this.containerEl.style.width = "100%";
    this.containerEl.style.height = "100%";
    this.shadow.appendChild(this.containerEl);
  }

  public get data(): Timeline | null {
    return this._timelineData;
  }

  public set data(value: Timeline | null) {
    this._timelineData = value;
    if (this.renderer && value) {
      this.renderer.render(value);
    }
  }

  public connectedCallback(): void {
    this.applyHostDimensions();

    const options = {
      layout: (this.getAttribute("layout") as any) || "vertical",
      theme: this.getAttribute("theme") || "light",
      locale: this.getAttribute("locale") || "en",
      zoomLevel: this.getAttribute("zoom") ? parseFloat(this.getAttribute("zoom")!) : 1,
      filterTags: this.getAttribute("filter-tags")
        ? this.getAttribute("filter-tags")!.split(",").map((s) => s.trim())
        : undefined,
    };

    this.renderer = new TimelineRenderer(this.containerEl, options);

    // Forward CustomEvents from container to host element
    this.containerEl.addEventListener("chronicle:ready", this.forwardEvent);
    this.containerEl.addEventListener("chronicle:event-select", this.forwardEvent);
    this.containerEl.addEventListener("chronicle:navigate", this.forwardEvent);
    this.containerEl.addEventListener("chronicle:error", this.forwardEvent);

    if (this._timelineData) {
      this.renderer.render(this._timelineData);
    } else if (this.getAttribute("src")) {
      this.fetchTimelineSrc(this.getAttribute("src")!);
    } else if (this.getAttribute("data")) {
      this.parseInlineData(this.getAttribute("data")!);
    }
  }

  public disconnectedCallback(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.containerEl.removeEventListener("chronicle:ready", this.forwardEvent);
    this.containerEl.removeEventListener("chronicle:event-select", this.forwardEvent);
    this.containerEl.removeEventListener("chronicle:navigate", this.forwardEvent);
    this.containerEl.removeEventListener("chronicle:error", this.forwardEvent);

    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
  }

  public attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null
  ): void {
    if (oldValue === newValue || !this.renderer) return;

    switch (name) {
      case "src":
        if (newValue) {
          this.fetchTimelineSrc(newValue);
        }
        break;
      case "data":
        if (newValue) {
          this.parseInlineData(newValue);
        }
        break;
      case "layout":
        this.renderer.update({ layout: (newValue as any) || "vertical" });
        break;
      case "theme":
        this.renderer.update({ theme: newValue || "light" });
        break;
      case "locale":
        this.renderer.update({ locale: newValue || "en" });
        break;
      case "zoom":
        this.renderer.update({ zoomLevel: newValue ? parseFloat(newValue) : 1 });
        break;
      case "filter-tags":
        this.renderer.update({
          filterTags: newValue ? newValue.split(",").map((s) => s.trim()) : undefined,
        });
        break;
      case "height":
      case "width":
        this.applyHostDimensions();
        break;
    }
  }

  private applyHostDimensions(): void {
    const height = this.getAttribute("height");
    const width = this.getAttribute("width");
    if (height) this.style.height = height;
    if (width) this.style.width = width;
  }

  private async fetchTimelineSrc(url: string): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    try {
      const res = await fetch(url, { signal: this.abortController.signal });
      if (!res.ok) {
        throw new Error(`Failed to load timeline from ${url}: HTTP ${res.status}`);
      }
      const json = await res.json();
      this.data = json;
    } catch (err: unknown) {
      if ((err as any)?.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      this.dispatchEvent(
        new CustomEvent("chronicle:error", {
          bubbles: true,
          composed: true,
          detail: { message: msg },
        })
      );
    }
  }

  private parseInlineData(dataStr: string): void {
    try {
      const parsed = JSON.parse(dataStr);
      this.data = parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Invalid JSON in data attribute";
      this.dispatchEvent(
        new CustomEvent("chronicle:error", {
          bubbles: true,
          composed: true,
          detail: { message: msg },
        })
      );
    }
  }

  private forwardEvent = (e: Event): void => {
    const custom = e as CustomEvent;
    this.dispatchEvent(
      new CustomEvent(custom.type, {
        bubbles: true,
        composed: true,
        detail: custom.detail,
      })
    );
  };
}
