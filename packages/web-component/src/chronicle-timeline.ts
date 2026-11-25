import { repairTimelineDates, validateTimeline, type Timeline } from '@chronicle/schema';
import {
  TimelineRenderer,
  BASE_STYLES,
  createStyleSheet,
  type RenderOptions,
} from '@chronicle/core';

type Layout = RenderOptions['layout'];
const LAYOUTS: readonly Layout[] = ['horizontal', 'vertical', 'card'];

const FORWARDED_EVENTS = [
  'chronicle:ready',
  'chronicle:event-select',
  'chronicle:navigate',
  'chronicle:error',
] as const;

let instanceCounter = 0;

function parseLayout(value: string | null): Layout | undefined {
  return LAYOUTS.find((l) => l === value);
}

function parseZoom(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseTags(value: string | null): string[] | undefined {
  if (!value) return undefined;
  const tags = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

/** Formats Zod issues into a short, human-readable message. */
function describeValidationErrors(
  issues: readonly { path: (string | number)[]; message: string }[],
): string {
  const lines = issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
  return `Invalid timeline data — ${lines.join('; ')}${more}`;
}

export class ChronicleTimeline extends HTMLElement {
  public static get observedAttributes(): string[] {
    return [
      'src',
      'data',
      'layout',
      'theme',
      'locale',
      'start-date',
      'zoom',
      'filter-tags',
      'height',
      'width',
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
    this.instanceId = `chronicle-timeline-${String(++instanceCounter)}`;
    this.shadow = this.attachShadow({ mode: 'open' });

    // Adopt base stylesheet into Shadow DOM
    try {
      const sheet = createStyleSheet(BASE_STYLES);
      this.shadow.adoptedStyleSheets = [sheet];
    } catch {
      // Fallback for browsers without constructable stylesheet support
      const styleEl = document.createElement('style');
      styleEl.textContent = BASE_STYLES;
      this.shadow.appendChild(styleEl);
    }

    this.containerEl = document.createElement('div');
    this.containerEl.id = this.instanceId;
    this.containerEl.style.width = '100%';
    this.containerEl.style.height = '100%';
    this.shadow.appendChild(this.containerEl);
  }

  /**
   * Marks an event as active (or clears it with `null`), optionally scrolling
   * it into view inside the timeline. Never moves keyboard focus.
   */
  public highlightEvent(eventId: string | null, options: { scroll?: boolean } = {}): void {
    this.renderer?.highlight(eventId, options);
  }

  /** Scrolls to an event and moves keyboard focus to it. */
  public scrollToEvent(eventId: string): void {
    this.renderer?.scrollToEvent(eventId);
  }

  public get data(): Timeline | null {
    return this._timelineData;
  }

  /**
   * Accepts any value; it is validated against the Chronicle schema before
   * rendering. Invalid data emits `chronicle:error` and is not rendered.
   * Date forms written by older releases (e.g. `1969-7-20`) are migrated
   * first, so timelines published before calendar validation still render.
   */
  public set data(value: unknown) {
    if (value === null || value === undefined) {
      this._timelineData = null;
      return;
    }
    const result = validateTimeline(repairTimelineDates(value).timeline);
    if (!result.success) {
      this.emitError(describeValidationErrors(result.errors.issues));
      return;
    }
    this._timelineData = result.data;
    this.renderer?.render(result.data);
  }

  public connectedCallback(): void {
    this.applyHostDimensions();

    this.renderer = new TimelineRenderer(this.containerEl, this.readOptionsFromAttributes());

    for (const name of FORWARDED_EVENTS) {
      this.containerEl.addEventListener(name, this.forwardEvent);
    }

    const src = this.getAttribute('src');
    const inline = this.getAttribute('data');
    // CSP-friendly data source: <script type="application/json"> child
    // (never executed by the browser, so no 'unsafe-inline' is needed).
    const jsonChild = this.querySelector(':scope > script[type="application/json"]');
    if (this._timelineData) {
      this.renderer.render(this._timelineData);
    } else if (src) {
      void this.fetchTimelineSrc(src);
    } else if (inline) {
      this.parseInlineData(inline);
    } else if (jsonChild?.textContent) {
      this.parseInlineData(jsonChild.textContent);
    }
  }

  public disconnectedCallback(): void {
    this.abortController?.abort();
    this.abortController = null;

    for (const name of FORWARDED_EVENTS) {
      this.containerEl.removeEventListener(name, this.forwardEvent);
    }

    this.renderer?.destroy();
    this.renderer = null;
  }

  public attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null,
  ): void {
    if (oldValue === newValue || !this.renderer) return;

    switch (name) {
      case 'src':
        if (newValue) void this.fetchTimelineSrc(newValue);
        break;
      case 'data':
        if (newValue) this.parseInlineData(newValue);
        break;
      case 'layout':
        this.renderer.update({ layout: parseLayout(newValue) });
        break;
      case 'theme':
        this.renderer.update({ theme: newValue ?? undefined });
        break;
      case 'locale':
        this.renderer.update({ locale: newValue ?? undefined });
        break;
      case 'start-date':
        this.renderer.update({ startDate: newValue ?? undefined });
        break;
      case 'zoom':
        this.renderer.update({ zoomLevel: parseZoom(newValue) });
        break;
      case 'filter-tags':
        this.renderer.update({ filterTags: parseTags(newValue) ?? [] });
        break;
      case 'height':
      case 'width':
        this.applyHostDimensions();
        break;
    }
  }

  /**
   * Only attributes that are actually present are returned, so that the
   * timeline's own `settings` apply when the host does not override them.
   */
  private readOptionsFromAttributes(): Partial<RenderOptions> {
    const options: Partial<RenderOptions> = {};
    const layout = parseLayout(this.getAttribute('layout'));
    const theme = this.getAttribute('theme');
    const locale = this.getAttribute('locale');
    const startDate = this.getAttribute('start-date');
    const zoom = parseZoom(this.getAttribute('zoom'));
    const tags = parseTags(this.getAttribute('filter-tags'));

    if (layout) options.layout = layout;
    if (theme) options.theme = theme;
    if (locale) options.locale = locale;
    if (startDate) options.startDate = startDate;
    if (zoom !== undefined) options.zoomLevel = zoom;
    if (tags) options.filterTags = tags;
    return options;
  }

  private applyHostDimensions(): void {
    const height = this.getAttribute('height');
    const width = this.getAttribute('width');
    if (height) this.style.height = height;
    if (width) this.style.width = width;
  }

  private async fetchTimelineSrc(url: string): Promise<void> {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Failed to load timeline from ${url}: HTTP ${String(res.status)}`);
      }
      const json: unknown = await res.json();
      this.data = json;
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.emitError(err instanceof Error ? err.message : String(err));
    }
  }

  private parseInlineData(dataStr: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataStr);
    } catch (err: unknown) {
      this.emitError(err instanceof Error ? err.message : 'Invalid JSON in data attribute');
      return;
    }
    this.data = parsed;
  }

  private emitError(message: string): void {
    this.dispatchEvent(
      new CustomEvent('chronicle:error', {
        bubbles: true,
        composed: true,
        detail: { message },
      }),
    );
  }

  private forwardEvent = (e: Event): void => {
    // Events from the renderer are already `composed`, so they cross the
    // shadow boundary on their own; re-dispatching from the host retargets
    // them so listeners see the <chronicle-timeline> as `event.target`.
    e.stopPropagation();
    const custom = e as CustomEvent<unknown>;
    this.dispatchEvent(
      new CustomEvent(custom.type, {
        bubbles: true,
        composed: true,
        detail: custom.detail,
      }),
    );
  };
}
