import { compareDates, type Timeline, type TimelineEvent } from '@chronicle/schema';
import type { RenderOptions, LayoutResult, I18nContext, CardMeasurer } from '../types.js';
import { sortEvents } from '../date-engine.js';
import { filterEvents, getUniqueTags, type FilterOptions } from '../search.js';
import { getTheme, applyTheme, applyThemeOverrides } from '../theme/index.js';
import { createI18n } from '../i18n/index.js';
import { getLayout } from '../layout/index.js';
import { h, clearChildren } from './dom.js';
import { renderEventCard } from './event-card.js';
import { renderAxis } from './timeline-axis.js';
import { renderControls, type ControlsHandle } from './controls.js';
import {
  setupKeyboardNavigation,
  createLiveRegion,
  announceToScreenReader,
  createSkipLink,
  setAriaAttributes,
} from './accessibility.js';

/** Persistent DOM built once per data/option change, reused across filtering. */
interface Shell {
  i18n: I18nContext;
  controls: ControlsHandle;
  liveRegion: HTMLElement;
  /** Scrollable area below the toolbar; its width drives the layout. */
  scroller: HTMLElement;
  /** Sized to the layout's total extent; positioning context for cards. */
  viewport: HTMLElement;
  /** `role="list"` holding only the event cards. */
  list: HTMLElement;
}

const MIN_WIDTH = 320;

/**
 * Renders a timeline into a container element.
 *
 * Update strategy:
 * - `render()` / `update()` rebuild the shell (theme, locale, layout changed).
 * - Search, tag filters and zoom only re-render the cards (`renderEvents`),
 *   so the toolbar — and the user's focus within it — persist.
 * - Size changes only re-run measurement + positioning (`relayout`).
 */
export class TimelineRenderer {
  private container: HTMLElement;
  private timeline: Timeline | null = null;
  private options: RenderOptions;
  /** Options set explicitly by the host; these override `timeline.settings`. */
  private explicitOptions: Partial<RenderOptions>;
  private activeEventId: string | null = null;
  private filterState: FilterOptions = {};
  private shell: Shell | null = null;
  private cards: HTMLElement[] = [];
  private cleanupFns: (() => void)[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private pendingFrame: number | null = null;
  private renderedLayout: RenderOptions['layout'] | null = null;
  /** Measurements from the last layout pass, to ignore no-op resize callbacks. */
  private lastScrollerWidth = -1;
  private lastCardHeights = new WeakMap<Element, number>();

  constructor(container: HTMLElement, options: Partial<RenderOptions> = {}) {
    this.container = container;
    this.explicitOptions = { ...options };
    this.options = this.resolveOptions();

    if (this.options.filterTags) {
      this.filterState.tags = this.options.filterTags;
    }
    if (this.options.searchQuery) {
      this.filterState.searchQuery = this.options.searchQuery;
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        this.onResize(entries);
      });
    }
  }

  /**
   * Sets the timeline data and renders the view.
   */
  public render(timeline: Timeline): void {
    try {
      this.timeline = timeline;
      this.options = this.resolveOptions();
      this.rebuild();

      this.dispatchCustomEvent('chronicle:ready', {
        timelineId: timeline.id,
        eventCount: timeline.events.length,
      });
    } catch (err: unknown) {
      this.reportError(err);
    }
  }

  /**
   * Updates rendering options and redraws.
   */
  public update(options: Partial<RenderOptions>): void {
    this.explicitOptions = { ...this.explicitOptions, ...options };
    this.options = this.resolveOptions();
    if (options.filterTags !== undefined) {
      this.filterState.tags = options.filterTags;
    }
    if (options.searchQuery !== undefined) {
      this.filterState.searchQuery = options.searchQuery;
    }
    if (this.timeline) {
      this.safely(() => {
        this.rebuild();
      });
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
    const card = this.cardById(eventId);
    if (!card) return;

    card.scrollIntoView({
      behavior: this.prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center',
      inline: 'center',
    });
    card.focus({ preventScroll: true });
    this.highlightEvent(eventId);
    this.dispatchCustomEvent('chronicle:navigate', { eventId });
  }

  /**
   * Marks an event as active and (optionally) scrolls the timeline — not the
   * host page — so it is in view. Unlike `scrollToEvent`, this never moves
   * keyboard focus, so hosts such as an editor can sync selection safely.
   */
  public highlight(eventId: string | null, options: { scroll?: boolean } = {}): void {
    if (eventId === null) {
      this.activeEventId = null;
      for (const el of this.container.querySelectorAll('.chronicle-event--active')) {
        el.classList.remove('chronicle-event--active');
      }
      for (const el of this.container.querySelectorAll('.chronicle-marker--active')) {
        el.classList.remove('chronicle-marker--active');
      }
      return;
    }
    this.highlightEvent(eventId);
    const card = this.cardById(eventId);
    if (!options.scroll || !card || !this.shell) return;

    const { scroller } = this.shell;
    const behavior: ScrollBehavior = this.prefersReducedMotion() ? 'auto' : 'smooth';
    scroller.scrollTo({
      top: Math.max(0, card.offsetTop - (scroller.clientHeight - card.offsetHeight) / 2),
      left: Math.max(0, card.offsetLeft - (scroller.clientWidth - card.offsetWidth) / 2),
      behavior,
    });
  }

  /**
   * Cleans up all DOM listeners and observers.
   */
  public destroy(): void {
    this.teardown();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    clearChildren(this.container);
  }

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------

  private rebuild(): void {
    if (!this.timeline) return;

    // Preserve focus across a rebuild (e.g. theme or locale change).
    const focusedId = this.focusedCardId();
    // Keep the reader's place when re-rendering the same layout (e.g. live edits).
    const previousScroll =
      this.shell && this.renderedLayout === this.options.layout
        ? { top: this.shell.scroller.scrollTop, left: this.shell.scroller.scrollLeft }
        : null;

    this.teardown();
    clearChildren(this.container);

    const i18n = createI18n(this.options.locale);
    applyTheme(
      this.container,
      applyThemeOverrides(getTheme(this.options.theme), this.timeline.settings.themeOverrides),
    );
    this.container.dir = i18n.isRTL() ? 'rtl' : 'ltr';
    this.container.className = `chronicle-container chronicle-container--${this.options.layout}`;
    setAriaAttributes(this.container, this.timeline);

    const liveRegion = createLiveRegion();
    const list = h('div', {
      class: 'chronicle-list',
      role: 'list',
      'aria-label': i18n.strings.aria.eventList,
    });
    const viewport = h('div', { class: 'chronicle-viewport' }, list);
    const scroller = h('div', { class: 'chronicle-scroller' }, viewport);

    const skipLink = createSkipLink(i18n.strings.aria.skipToContent, () => this.cards[0] ?? null);

    const controls = renderControls({
      tags: getUniqueTags(this.timeline.events),
      currentFilters: this.filterState,
      i18n,
      showZoom: this.options.layout === 'horizontal',
      onSearch: (query) => {
        this.filterState.searchQuery = query;
        this.refreshResults();
      },
      onFilterTag: (tag) => {
        if (tag) {
          this.filterState.tags = [tag];
        } else {
          delete this.filterState.tags;
        }
        this.refreshResults();
      },
      onZoomIn: () => {
        this.setZoom((this.options.zoomLevel ?? 1) + 0.25);
      },
      onZoomOut: () => {
        this.setZoom((this.options.zoomLevel ?? 1) - 0.25);
      },
    });
    this.cleanupFns.push(() => {
      controls.destroy();
    });

    this.container.append(liveRegion, skipLink, controls.element, scroller);
    this.shell = { i18n, controls, liveRegion, scroller, viewport, list };

    this.cleanupFns.push(
      setupKeyboardNavigation(
        list,
        () => this.cards,
        (card) => {
          const id = card.getAttribute('data-event-id');
          if (id) this.selectEvent(id);
        },
      ),
    );
    this.resizeObserver?.observe(scroller);

    this.renderEvents();
    this.renderedLayout = this.options.layout;

    if (previousScroll) {
      scroller.scrollTop = previousScroll.top;
      scroller.scrollLeft = previousScroll.left;
    }
    if (focusedId) {
      this.cardById(focusedId)?.focus({ preventScroll: true });
    } else if (previousScroll) {
      // Position restored above.
    } else if (this.options.startDate) {
      this.scrollToDate(this.options.startDate);
    } else if (this.options.layout === 'horizontal') {
      this.centreAxisVertically();
    }
  }

  /** Horizontal layout may be taller than the frame; start with the axis in view. */
  private centreAxisVertically(): void {
    if (!this.shell) return;
    const { scroller, viewport } = this.shell;
    const axis = viewport.querySelector<HTMLElement>('.chronicle-axis--horizontal');
    if (!axis) return;
    scroller.scrollTop = Math.max(0, axis.offsetTop - scroller.clientHeight / 2);
  }

  /** Scrolls the timeline (not the host page) to the first event on/after `date`. */
  private scrollToDate(date: string): void {
    if (!this.shell) return;
    const { scroller } = this.shell;
    const target =
      this.cards.find((card) => {
        const evt = this.timeline?.events.find((e) => e.id === card.dataset.eventId);
        return evt !== undefined && compareDates(evt.date, { start: date }) >= 0;
      }) ?? this.cards.at(-1);
    if (!target) return;
    if (this.options.layout === 'horizontal') {
      scroller.scrollLeft = Math.max(0, target.offsetLeft - 32);
    } else {
      scroller.scrollTop = Math.max(0, target.offsetTop - 32);
    }
  }

  private teardown(): void {
    if (this.pendingFrame !== null) {
      cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = null;
    }
    this.resizeObserver?.disconnect();
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns = [];
    this.shell = null;
    this.cards = [];
  }

  // ---------------------------------------------------------------------------
  // Events + layout
  // ---------------------------------------------------------------------------

  /** Re-renders cards for the current filters and announces the result count. */
  private refreshResults(): void {
    if (!this.shell) return;
    const shell = this.shell;
    this.safely(() => {
      shell.controls.syncFilters(this.filterState);
      const count = this.renderEvents();
      const msg =
        count === 0
          ? shell.i18n.strings.search.noResults
          : shell.i18n.strings.search.resultsCount.replace('{count}', String(count));
      announceToScreenReader(shell.liveRegion, msg);
    });
  }

  private setZoom(level: number): void {
    this.explicitOptions.zoomLevel = Math.max(0.5, Math.min(3, level));
    this.options = this.resolveOptions();
    this.safely(() => {
      this.relayout();
    });
  }

  /** Creates cards for the visible events. Returns the number shown. */
  private renderEvents(): number {
    if (!this.timeline || !this.shell) return 0;
    const { list, viewport, i18n } = this.shell;

    for (const card of this.cards) this.resizeObserver?.unobserve(card);
    clearChildren(list);
    viewport.querySelector('.chronicle-empty')?.remove();

    const visible = filterEvents(sortEvents(this.timeline.events), this.filterState);

    this.cards = visible.map((evt: TimelineEvent) => {
      const card = renderEventCard(evt, i18n, { isActive: evt.id === this.activeEventId });
      card.addEventListener('click', () => {
        this.selectEvent(evt.id);
      });
      list.appendChild(card);
      return card;
    });

    if (visible.length === 0) {
      viewport.appendChild(h('div', { class: 'chronicle-empty' }, i18n.strings.search.noResults));
    }

    this.relayout(visible);
    return visible.length;
  }

  /**
   * Measures cards and applies the layout. Safe to call repeatedly: it only
   * writes positions, never creates or destroys focusable elements.
   */
  private relayout(visible?: TimelineEvent[]): void {
    if (!this.timeline || !this.shell) return;
    const { scroller, viewport } = this.shell;

    const events = visible ?? filterEvents(sortEvents(this.timeline.events), this.filterState);
    const width = Math.max(MIN_WIDTH, scroller.clientWidth || 800);
    const height = scroller.clientHeight || 600;
    this.lastScrollerWidth = scroller.clientWidth;

    viewport.querySelector('.chronicle-axis-container')?.remove();
    if (events.length === 0) {
      viewport.style.removeProperty('width');
      viewport.style.removeProperty('height');
      return;
    }

    const computed: LayoutResult = getLayout(this.options.layout).compute(
      events,
      this.timeline.eras,
      width,
      height,
      this.options,
      this.createMeasurer(),
    );
    // Layout engines work in LTR coordinates; flip them for RTL locales so
    // time flows right→left, matching where an RTL scroller starts.
    const layout = this.container.dir === 'rtl' ? mirrorLayout(computed) : computed;

    this.applyLayout(layout);
    viewport.prepend(renderAxis(layout, this.timeline.eras));
  }

  private applyLayout(layout: LayoutResult): void {
    if (!this.shell) return;
    const { viewport } = this.shell;

    if (layout.flow) {
      viewport.style.removeProperty('width');
      viewport.style.removeProperty('height');
      for (const card of this.cards) {
        for (const prop of ['left', 'top', 'width']) card.style.removeProperty(prop);
      }
      return;
    }

    viewport.style.height = `${String(layout.totalHeight)}px`;
    if (layout.direction === 'horizontal') {
      viewport.style.width = `${String(layout.totalWidth)}px`;
    } else {
      viewport.style.removeProperty('width');
    }

    const byId = new Map(layout.positions.map((p) => [p.eventId, p]));
    for (const card of this.cards) {
      const pos = byId.get(card.dataset.eventId ?? '');
      if (!pos) continue;
      card.style.left = `${String(pos.x)}px`;
      card.style.top = `${String(pos.y)}px`;
      card.style.width = `${String(pos.width)}px`;
      card.dataset.side = pos.side;
      this.lastCardHeights.set(card, card.offsetHeight);
      this.resizeObserver?.observe(card);
    }
  }

  /**
   * Returns a measurer that sizes every card to a given width in one batch,
   * then reads all heights (one forced reflow per distinct width).
   */
  private createMeasurer(): CardMeasurer {
    const cache = new Map<number, Map<string, number>>();
    return (eventId, width) => {
      let heights = cache.get(width);
      if (!heights) {
        heights = new Map();
        for (const card of this.cards) card.style.width = `${String(width)}px`;
        for (const card of this.cards) {
          heights.set(card.dataset.eventId ?? '', card.offsetHeight);
        }
        cache.set(width, heights);
      }
      return heights.get(eventId) ?? 0;
    };
  }

  /**
   * Re-lays out only when the scroller width or a card's height actually
   * changed (e.g. an image finished loading). Positioning cards does not
   * change their size, so this cannot feed back into itself.
   */
  private onResize(entries: ResizeObserverEntry[]): void {
    if (!this.shell) return;
    const { scroller } = this.shell;
    const changed = entries.some((entry) =>
      entry.target === scroller
        ? scroller.clientWidth !== this.lastScrollerWidth
        : (entry.target as HTMLElement).offsetHeight !== this.lastCardHeights.get(entry.target),
    );
    if (!changed || this.pendingFrame !== null) return;

    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = null;
      this.safely(() => {
        this.relayout();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private selectEvent(eventId: string): void {
    this.highlightEvent(eventId);
    this.dispatchCustomEvent('chronicle:event-select', { eventId });
  }

  private highlightEvent(eventId: string): void {
    this.activeEventId = eventId;
    for (const el of this.container.querySelectorAll('.chronicle-event')) {
      el.classList.toggle('chronicle-event--active', el.getAttribute('data-event-id') === eventId);
    }
    for (const el of this.container.querySelectorAll('.chronicle-marker')) {
      el.classList.toggle('chronicle-marker--active', el.getAttribute('data-event-id') === eventId);
    }
  }

  private cardById(eventId: string): HTMLElement | undefined {
    return this.cards.find((c) => c.dataset.eventId === eventId);
  }

  private focusedCardId(): string | null {
    const root = this.container.getRootNode() as Document | ShadowRoot;
    const active = root.activeElement;
    return active instanceof HTMLElement && this.container.contains(active)
      ? (active.dataset.eventId ?? null)
      : null;
  }

  private prefersReducedMotion(): boolean {
    if (this.options.reducedMotion) return true;
    return typeof matchMedia === 'function'
      ? matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
  }

  /** Effective options: explicit host options → timeline.settings → defaults. */
  private resolveOptions(): RenderOptions {
    const explicit = this.explicitOptions;
    const settings = this.timeline?.settings;
    return {
      ...explicit,
      layout: explicit.layout ?? settings?.layout ?? 'vertical',
      theme: explicit.theme ?? settings?.theme ?? 'light',
      locale: explicit.locale ?? settings?.locale ?? 'en',
      zoomLevel: explicit.zoomLevel ?? settings?.zoomLevel ?? 1,
      startDate: explicit.startDate ?? settings?.startDate,
      reducedMotion: explicit.reducedMotion ?? false,
    };
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err: unknown) {
      this.reportError(err);
    }
  }

  private reportError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.dispatchCustomEvent('chronicle:error', { message });
  }

  private dispatchCustomEvent(name: string, detail: unknown): void {
    this.container.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }
}

/** Mirrors a layout's x coordinates across its width (for RTL rendering). */
export function mirrorLayout(layout: LayoutResult): LayoutResult {
  if (layout.flow) return layout;
  const W = layout.totalWidth;
  return {
    ...layout,
    positions: layout.positions.map((p) => ({
      ...p,
      x: W - p.x - p.width,
      markerX: W - p.markerX,
      side: p.side === 'left' ? 'right' : p.side === 'right' ? 'left' : p.side,
    })),
    axisStart: { x: W - layout.axisEnd.x, y: layout.axisStart.y },
    axisEnd: { x: W - layout.axisStart.x, y: layout.axisEnd.y },
    eraBands: layout.eraBands?.map((b) => ({ ...b, x: W - b.x - b.width })),
  };
}
