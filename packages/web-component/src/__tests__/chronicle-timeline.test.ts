import { describe, it, expect, afterEach } from 'vitest';
import '../index.js';
import { ChronicleTimeline } from '../chronicle-timeline.js';

const VALID = {
  id: 'tl',
  title: 'Space',
  settings: { layout: 'card' },
  events: [
    { id: 'a', date: { start: '1957' }, title: 'Sputnik' },
    { id: 'b', date: { start: '1969' }, title: 'Apollo' },
  ],
};

function create(attrs: Record<string, string> = {}): {
  el: ChronicleTimeline;
  events: { type: string; detail: unknown }[];
} {
  const el = document.createElement('chronicle-timeline');
  if (!(el instanceof ChronicleTimeline)) throw new Error('element not registered');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  const events: { type: string; detail: unknown }[] = [];
  for (const type of ['chronicle:ready', 'chronicle:error', 'chronicle:event-select']) {
    // Listen on document to catch both the original and any re-dispatch.
    document.addEventListener(type, (e) => {
      events.push({ type, detail: (e as CustomEvent).detail });
    });
  }
  return { el, events };
}

const inner = (el: ChronicleTimeline): HTMLElement => {
  const div = el.shadowRoot?.querySelector<HTMLElement>('.chronicle-container');
  if (!div) throw new Error('not rendered');
  return div;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('<chronicle-timeline>', () => {
  it('renders valid data and emits chronicle:ready exactly once', () => {
    const { el, events } = create();
    el.data = VALID;
    document.body.appendChild(el);

    expect(events.filter((e) => e.type === 'chronicle:ready')).toHaveLength(1);
    expect(el.shadowRoot?.querySelectorAll('.chronicle-event')).toHaveLength(2);
  });

  it('emits chronicle:event-select exactly once per click, targeted at the host', () => {
    const { el, events } = create();
    el.data = VALID;
    document.body.appendChild(el);
    let target: EventTarget | null = null;
    el.addEventListener('chronicle:event-select', (e) => (target = e.target));

    el.shadowRoot?.querySelector<HTMLElement>('.chronicle-event')?.click();

    expect(events.filter((e) => e.type === 'chronicle:event-select')).toHaveLength(1);
    expect(target).toBe(el);
  });

  it('applies timeline.settings when no attribute overrides them', () => {
    const { el } = create();
    el.data = VALID;
    document.body.appendChild(el);
    expect(inner(el).classList.contains('chronicle-container--card')).toBe(true);
  });

  it('lets attributes override timeline.settings', () => {
    const { el } = create({ layout: 'horizontal' });
    el.data = VALID;
    document.body.appendChild(el);
    expect(inner(el).classList.contains('chronicle-container--horizontal')).toBe(true);
  });

  it('rejects schema-invalid data with a readable chronicle:error and renders nothing', () => {
    const { el, events } = create();
    document.body.appendChild(el);
    el.data = { id: 'tl', events: [{ id: 'a', title: 'No date' }] };

    const errors = events.filter((e) => e.type === 'chronicle:error');
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0].detail)).toMatch(/title|date/);
    expect(el.data).toBeNull();
    expect(el.shadowRoot?.querySelector('.chronicle-event')).toBeNull();
  });

  it('rejects javascript: media URLs via schema validation', () => {
    const { el, events } = create();
    document.body.appendChild(el);
    el.data = {
      ...VALID,
      events: [
        {
          id: 'x',
          date: { start: '2000' },
          title: 'X',
          media: [{ type: 'oembed', url: 'javascript:alert(1)' }],
        },
      ],
    };
    expect(events.some((e) => e.type === 'chronicle:error')).toBe(true);
    expect(el.shadowRoot?.querySelector('iframe')).toBeNull();
  });

  it('reports invalid JSON in the data attribute', () => {
    const { el, events } = create({ data: '{not json' });
    document.body.appendChild(el);
    expect(events.filter((e) => e.type === 'chronicle:error')).toHaveLength(1);
  });

  it('parses valid JSON in the data attribute', () => {
    const { el } = create({ data: JSON.stringify(VALID) });
    document.body.appendChild(el);
    expect(el.data?.title).toBe('Space');
  });
});
