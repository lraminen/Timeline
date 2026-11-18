import type { Timeline, TimelineEvent } from "@chronicle/schema";
import type { RenderOptions, LayoutResult } from "../types.js";
import { sortEvents } from "../date-engine.js";
import { filterEvents, getUniqueTags, type FilterOptions } from "../search.js";
import { getTheme, applyTheme } from "../theme/index.js";
import { createI18n } from "../i18n/index.js";
import { getLayout } from "../layout/index.js";
import { h, clearChildren } from "./dom.js";
import { renderEventCard } from "./event-card.js";
import { renderAxis } from "./timeline-axis.js";
import { renderControls } from "./controls.js";
import {
  setupKeyboardNavigation,
  createLiveRegion,
  announceToScreenReader,
  createSkipLink,
  setAriaAttributes,
} from "./accessibility.js";

export class TimelineRenderer {
  private container: HTMLElement;
  private timeline: Timeline | null = null;
  private options: RenderOptions;
  private activeEventId: string | null = null;
  private filterState: FilterOptions = {};
  private cleanupFns: (() => void)[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private liveRegion: HTMLElement | null = null;

  constructor(container: HTMLElement, options?: Partial<RenderOptions>) {
    this.container = container;
    this.options = {
      layout: options?.layout || "vertical",
      theme: options?.theme || "light",
      locale: options?.locale || "en",
      zoomLevel: options?.zoomLevel || 1,
      reducedMotion: options?.reducedMotion || false,
      filterTags: options?.filterTags,
      searchQuery: options?.searchQuery,
      height: options?.height,
      width: options?.width,
    };

    if (this.options.filterTags) {
      this.filterState.tags = this.options.filterTags;
    }
    if (this.options.searchQuery) {
      this.filterState.searchQuery = this.options.searchQuery;
    }

    // Set up resize observer to recompute layout smoothly
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.timeline) {
          this.draw();
        }
      });
      this.resizeObserver.observe(this.container);
    }
  }

  /**
   * Sets the timeline data and renders the view.
   */
  public render(timeline: Timeline): void {
    try {
      this.timeline = timeline;

      // Merge timeline's built-in settings with options if not overridden
      if (timeline.settings) {
        if (!this.options.layout && timeline.settings.layout) {
          this.options.layout = timeline.settings.layout;
        }
        if (!this.options.theme && timeline.settings.theme) {
          this.options.theme = timeline.settings.theme;
        }
        if (!this.options.locale && timeline.settings.locale) {
          this.options.locale = timeline.settings.locale;
        }
      }

      this.draw();

      this.dispatchCustomEvent("chronicle:ready", {
        timelineId: timeline.id,
        eventCount: timeline.events.length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.dispatchCustomEvent("chronicle:error", { message: msg });
    }
  }

  /**
   * Updates rendering options and redraws.
   */
  public update(options: Partial<RenderOptions>): void {
    this.options = { ...this.options, ...options };
    if (options.filterTags !== undefined) {
      this.filterState.tags = options.filterTags;
    }
    if (options.searchQuery !== undefined) {
      this.filterState.searchQuery = options.searchQuery;
    }
    if (this.timeline) {
      this.draw();
    }
  }

  /**
   * Replaces timeline data.
   */
  public setData(timeline: Timeline): void {
    this.render(timeline);
  }

  /**
   * Retrieves the currently focused/active event ID.
   */
  public getActiveEvent(): string | null {
    return this.activeEventId;
  }

  /**
   * Scrolls to and highlights an event card.
   */
  public scrollToEvent(eventId: string): void {
    this.activeEventId = eventId;
    const card = this.container.querySelector(
      `[data-event-id="${eventId}"]`
    ) as HTMLElement | null;

    if (card) {
      card.scrollIntoView({
        behavior: this.options.reducedMotion ? "auto" : "smooth",
        block: "center",
        inline: "center",
      });
      card.focus();
      this.highlightEvent(eventId);
    }
  }

  /**
   * Cleans up all DOM listeners and observers.
   */
  public destroy(): void {
    for (const cleanup of this.cleanupFns) {
      cleanup();
    }
    this.cleanupFns = [];
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    clearChildren(this.container);
  }

  // ---------------------------------------------------------------------------
  // Internal rendering logic
  // ---------------------------------------------------------------------------

  private draw(): void {
    if (!this.timeline) return;

    // Run cleanups from previous draw
    for (const cleanup of this.cleanupFns) {
      cleanup();
    }
    this.cleanupFns = [];
    clearChildren(this.container);

    const i18n = createI18n(this.options.locale);
    const theme = getTheme(this.options.theme);

    // Apply theme custom properties
    applyTheme(this.container, theme);

    // Set container direction & attributes
    this.container.dir = i18n.isRTL() ? "rtl" : "ltr";
    this.container.className = `chronicle-container chronicle-container--${this.options.layout}`;
    setAriaAttributes(this.container, this.timeline);

    // Live region for screen readers
    this.liveRegion = createLiveRegion();
    this.container.appendChild(this.liveRegion);

    // Skip link
    const skipLink = createSkipLink("chronicle-viewport", i18n.strings.aria.skipToContent);
    this.container.appendChild(skipLink);

    // Sort and filter events
    const sorted = sortEvents(this.timeline.events);
    const filtered = filterEvents(sorted, this.filterState);
    const allTags = getUniqueTags(this.timeline.events);

    // Controls header
    const controls = renderControls({
      tags: allTags,
      currentFilters: this.filterState,
      i18n,
      showZoom: this.options.layout === "horizontal",
      onSearch: (query) => {
        this.filterState.searchQuery = query;
        this.draw();
        if (this.liveRegion) {
          const count = filtered.length;
          announceToScreenReader(
            this.liveRegion,
            i18n.strings.search.resultsCount.replace("{count}", String(count))
          );
        }
      },
      onFilterTag: (tag) => {
        if (!tag) {
          delete this.filterState.tags;
        } else {
          this.filterState.tags = [tag];
        }
        this.draw();
      },
      onZoomIn: () => {
        this.options.zoomLevel = Math.min(3, (this.options.zoomLevel || 1) + 0.25);
        this.draw();
      },
      onZoomOut: () => {
        this.options.zoomLevel = Math.max(0.5, (this.options.zoomLevel || 1) - 0.25);
        this.draw();
      },
    });
    this.container.appendChild(controls);

    // Viewport
    const viewport = h("div", {
      id: "chronicle-viewport",
      class: "chronicle-viewport",
      role: "list",
      "aria-label": i18n.strings.aria.eventList,
    });

    if (filtered.length === 0) {
      const emptyEl = h(
        "div",
        { class: "chronicle-empty", role: "status" },
        i18n.strings.search.noResults
      );
      viewport.appendChild(emptyEl);
      this.container.appendChild(viewport);
      return;
    }

    // Compute layout
    const containerRect = this.container.getBoundingClientRect();
    const width = Math.max(320, containerRect.width || 800);
    const height = Math.max(400, containerRect.height || 600);

    const layoutEngine = getLayout(this.options.layout);
    const layoutResult: LayoutResult = layoutEngine.compute(
      filtered,
      this.timeline.eras,
      width,
      height,
      this.options
    );

    // Set viewport dimensions
    if (this.options.layout === "horizontal") {
      viewport.style.width = `${layoutResult.totalWidth}px`;
      viewport.style.height = `${layoutResult.totalHeight}px`;
    } else {
      viewport.style.height = `${layoutResult.totalHeight}px`;
    }

    // Render axis & era bands
    const axisEl = renderAxis(layoutResult, filtered, this.timeline.eras, i18n);
    viewport.appendChild(axisEl);

    // Render event cards
    const cardElements: HTMLElement[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const evt = filtered[i];
      const pos = layoutResult.positions[i];
      const isActive = evt.id === this.activeEventId;

      const card = renderEventCard(evt, pos, i18n, {
        isActive,
        reducedMotion: this.options.reducedMotion || false,
      });

      card.addEventListener("click", () => {
        this.highlightEvent(evt.id);
        this.dispatchCustomEvent("chronicle:event-select", { eventId: evt.id });
      });

      cardElements.push(card);
      viewport.appendChild(card);
    }

    this.container.appendChild(viewport);

    // Set up accessible keyboard navigation
    const cleanupKeyboard = setupKeyboardNavigation(
      this.container,
      () => cardElements,
      (card) => {
        const id = card.getAttribute("data-event-id");
        if (id) {
          this.highlightEvent(id);
          this.dispatchCustomEvent("chronicle:event-select", { eventId: id });
        }
      }
    );
    this.cleanupFns.push(cleanupKeyboard);
  }

  private highlightEvent(eventId: string): void {
    this.activeEventId = eventId;
    const cards = this.container.querySelectorAll(".chronicle-event");
    for (let i = 0; i < cards.length; i++) {
      const el = cards[i] as HTMLElement;
      if (el.getAttribute("data-event-id") === eventId) {
        el.classList.add("chronicle-event--active");
      } else {
        el.classList.remove("chronicle-event--active");
      }
    }

    const markers = this.container.querySelectorAll(".chronicle-marker");
    for (let i = 0; i < markers.length; i++) {
      const el = markers[i] as HTMLElement;
      if (el.getAttribute("data-event-id") === eventId) {
        el.classList.add("chronicle-marker--active");
      } else {
        el.classList.remove("chronicle-marker--active");
      }
    }
  }

  private dispatchCustomEvent(name: string, detail: unknown): void {
    const event = new CustomEvent(name, {
      bubbles: true,
      composed: true,
      detail,
    });
    this.container.dispatchEvent(event);
  }
}
