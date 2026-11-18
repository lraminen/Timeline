// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateTimeline, type Timeline } from '@chronicle/schema';
import { TimelineRenderer } from '../renderer/index.js';

function timeline(overrides: Record<string, unknown> = {}): Timeline {
  const result = validateTimeline({
    id: 'tl',
    title: 'Space',
    events: [
      { id: 'sputnik', date: { start: '1957-10-04' }, title: 'Sputnik', tags: ['ussr'] },
      { id: 'apollo', date: { start: '1969-07-20' }, title: 'Apollo 11', tags: ['usa', 'moon'] },
      { id: 'iss', date: { start: '1998-11-20', end: '2030' }, title: 'ISS', tags: ['intl'] },
    ],
    eras: [{ id: 'race', title: 'Space Race', start: '1957', end: '1975' }],
    ...overrides,
  });
  if (!result.success) throw result.errors;
  return result.data;
}

let container: HTMLElement;
let renderer: TimelineRenderer;

function $as<T extends Element>(sel: string, ctor: abstract new () => T): T {
  const el = container.querySelector(sel);
  if (!(el instanceof ctor)) throw new Error(`missing ${sel}`);
  return el;
}
const $ = (sel: string): HTMLElement => $as(sel, HTMLElement);
const active = (): HTMLElement => {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) throw new Error('no focused element');
  return el;
};
const $$ = (sel: string): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(sel));
const cardIds = (): string[] => $$('.chronicle-event').map((c) => c.dataset.eventId ?? '');

function key(target: Element, k: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  renderer.destroy();
  container.remove();
  vi.useRealTimers();
});

describe('TimelineRenderer — focus & updates', () => {
  it('keeps the same, focused search input while typing', () => {
    renderer = new TimelineRenderer(container);
    renderer.render(timeline());
    const input = $as('.chronicle-search__input', HTMLInputElement);
    input.focus();

    for (const text of ['a', 'ap', 'apo']) {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(200);
    }

    expect(input.isConnected).toBe(true);
    expect($('.chronicle-search__input')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(cardIds()).toEqual(['apollo']);
  });

  it('announces the correct (current) result count', () => {
    renderer = new TimelineRenderer(container);
    renderer.render(timeline());
    const input = $as('.chronicle-search__input', HTMLInputElement);
    input.value = 'apollo';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(500);
    expect($('[aria-live]').textContent).toContain('1');
  });

  it('filters by tag without rebuilding the toolbar, and reflects aria-pressed', () => {
    renderer = new TimelineRenderer(container);
    renderer.render(timeline());
    const usa = $$('.chronicle-filter-btn').find((b) => b.dataset.tag === 'usa');
    if (!usa) throw new Error('no usa button');
    usa.focus();
    usa.click();

    expect(usa.isConnected).toBe(true);
    expect(document.activeElement).toBe(usa);
    expect(usa.getAttribute('aria-pressed')).toBe('true');
    expect(cardIds()).toEqual(['apollo']);
  });

  it('zooms without rebuilding the toolbar', () => {
    renderer = new TimelineRenderer(container, { layout: 'horizontal' });
    renderer.render(timeline());
    const zoomIn = $('.chronicle-zoom-btn');
    const before = $('.chronicle-viewport').style.width;
    zoomIn.focus();
    zoomIn.click();
    expect(zoomIn.isConnected).toBe(true);
    expect(document.activeElement).toBe(zoomIn);
    expect($('.chronicle-viewport').style.width).not.toBe(before);
  });
});

describe('TimelineRenderer — keyboard', () => {
  it('does not intercept arrow/Home/End keys in the search box', () => {
    renderer = new TimelineRenderer(container);
    renderer.render(timeline());
    const input = $('.chronicle-search__input');
    input.focus();
    for (const k of ['ArrowLeft', 'ArrowRight', 'Home', 'End', ' ']) {
      expect(key(input, k).defaultPrevented).toBe(false);
    }
    expect(document.activeElement).toBe(input);
  });

  it('moves between cards with arrows, Home and End, and emits event-select', () => {
    renderer = new TimelineRenderer(container);
    renderer.render(timeline());
    const selected: string[] = [];
    container.addEventListener('chronicle:event-select', (e) => {
      selected.push((e as CustomEvent<{ eventId: string }>).detail.eventId);
    });
    const [first] = $$('.chronicle-event');
    first.focus();

    key(first, 'ArrowDown');
    expect(active().dataset.eventId).toBe('apollo');
    key(active(), 'End');
    expect(active().dataset.eventId).toBe('iss');
    key(active(), 'Home');
    expect(active().dataset.eventId).toBe('sputnik');
    expect(selected).toEqual(['apollo', 'iss', 'sputnik']);
  });

  it('skip control moves focus to the first event', () => {
    renderer = new TimelineRenderer(container);
    renderer.render(timeline());
    $('.chronicle-skip-link').click();
    expect(active().dataset.eventId).toBe('sputnik');
  });
});

describe('TimelineRenderer — structure & a11y', () => {
  it('list contains only listitems; decorative layer is aria-hidden', () => {
    renderer = new TimelineRenderer(container);
    renderer.render(timeline());
    const list = $('[role="list"]');
    expect(Array.from(list.children).every((c) => c.getAttribute('role') === 'listitem')).toBe(
      true,
    );
    expect($('.chronicle-axis-container').getAttribute('aria-hidden')).toBe('true');
  });

  it('shows date ranges and displayOverride', () => {
    renderer = new TimelineRenderer(container);
    renderer.render(
      timeline({
        events: [
          { id: 'a', date: { start: '1500', displayOverride: 'The Renaissance' }, title: 'A' },
          { id: 'b', date: { start: '1998', end: '2030' }, title: 'B' },
        ],
      }),
    );
    const dates = $$('.chronicle-event__date').map((d) => d.textContent);
    expect(dates[0]).toBe('The Renaissance');
    expect(dates[1]).toContain('2030');
  });

  it('reports render errors as chronicle:error instead of throwing', () => {
    renderer = new TimelineRenderer(container);
    const errors: unknown[] = [];
    container.addEventListener('chronicle:error', (e) => errors.push((e as CustomEvent).detail));
    renderer.render({ id: 'x', title: 'x' } as unknown as Timeline);
    expect(errors).toHaveLength(1);
  });
});

describe('TimelineRenderer — settings precedence', () => {
  it('applies timeline.settings when the host sets nothing', () => {
    renderer = new TimelineRenderer(container);
    renderer.render(timeline({ settings: { layout: 'card', locale: 'ar' } }));
    expect(container.classList.contains('chronicle-container--card')).toBe(true);
    expect(container.dir).toBe('rtl');
  });

  it('lets explicit host options override timeline.settings', () => {
    renderer = new TimelineRenderer(container, { layout: 'horizontal' });
    renderer.render(timeline({ settings: { layout: 'card' } }));
    expect(container.classList.contains('chronicle-container--horizontal')).toBe(true);
  });

  it('falls back to settings when an explicit option is cleared', () => {
    renderer = new TimelineRenderer(container, { layout: 'horizontal' });
    renderer.render(timeline({ settings: { layout: 'card' } }));
    renderer.update({ layout: undefined });
    expect(container.classList.contains('chronicle-container--card')).toBe(true);
  });
});

describe('TimelineRenderer — untrusted media (no schema validation)', () => {
  // The renderer is public API; it must be safe even if handed raw data.
  function rawTimeline(media: unknown[]): Timeline {
    const t = timeline();
    return {
      ...t,
      events: media.map((m, i) => ({
        id: `m${String(i)}`,
        date: { start: '2000' },
        title: `M${String(i)}`,
        media: [m],
        tags: [],
      })),
    } as Timeline;
  }

  it('never puts javascript: URLs in iframe/img/video src', () => {
    renderer = new TimelineRenderer(container);
    renderer.render(
      rawTimeline([
        { type: 'oembed', url: 'javascript:alert(1)' },
        { type: 'oembed', url: 'javascript:alert(1)//google.com/maps/embed' },
        { type: 'map', url: 'java\tscript:alert(1)' },
        { type: 'image', url: 'javascript:alert(1)' },
        { type: 'video', url: 'data:text/html,<script>alert(1)</script>' },
      ]),
    );
    expect($$('iframe')).toHaveLength(0);
    for (const el of $$('[src], [href]')) {
      const url = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
      expect(url).not.toMatch(/script|data:text/i);
    }
  });

  it('sandboxes allowlisted embeds and links unknown providers', () => {
    renderer = new TimelineRenderer(container);
    renderer.render(
      rawTimeline([
        { type: 'oembed', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        { type: 'oembed', url: 'https://example.com/some-player' },
      ]),
    );
    const [iframe] = $$('iframe');
    expect(iframe.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(iframe.getAttribute('sandbox')).toContain('allow-scripts');
    const link = $as('.chronicle-event__media-link', HTMLAnchorElement);
    expect(link.getAttribute('href')).toBe('https://example.com/some-player');
    expect(link.rel).toContain('noopener');
  });

  it('cannot inject CSS through an era colour', () => {
    renderer = new TimelineRenderer(container, { layout: 'horizontal' });
    const t = timeline();
    renderer.render({
      ...t,
      eras: [{ ...t.eras[0], color: 'red; background-image: url(https://evil.example/x)' }],
    });
    const band = $('.chronicle-era-band');
    expect(band.getAttribute('style') ?? '').not.toContain('evil.example');
  });
});
