import { describe, it, expect } from 'vitest';
import { migrateFromTimelineJS, migrateFromTimelineJSWithReport } from '../migrate.js';
import { validateTimeline } from '../validate.js';

// ---------------------------------------------------------------------------
// Sample TimelineJS v3 payloads
// ---------------------------------------------------------------------------
const sampleTimelineJS = {
  title: {
    text: {
      headline: 'World War II',
      text: 'A global conflict lasting from 1939 to 1945.',
    },
  },
  events: [
    {
      start_date: { year: 1939, month: 9, day: 1 },
      end_date: { year: 1945, month: 9, day: 2 },
      text: {
        headline: 'Invasion of Poland',
        text: 'Germany invades Poland, starting WWII in Europe.',
      },
      media: {
        url: 'https://example.com/poland.jpg',
        caption: 'German troops',
        credit: 'Archive',
      },
    },
    {
      start_date: { year: 1941, month: 12, day: 7 },
      text: {
        headline: 'Attack on Pearl Harbor',
        text: 'Japan attacks the US naval base at Pearl Harbor.',
      },
    },
    {
      start_date: { year: 1944, month: 6, day: 6 },
      text: { headline: 'D-Day' },
      group: 'Western Front',
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('migrateFromTimelineJS', () => {
  it('converts a full TimelineJS payload to Chronicle format', () => {
    const result = migrateFromTimelineJS(sampleTimelineJS);

    expect(result.schemaVersion).toBe('1.0.0');
    expect(result.id).toBe('imported-timelinejs');
    expect(result.title).toBe('World War II');
    expect(result.description).toBe('A global conflict lasting from 1939 to 1945.');
    expect(result.events).toHaveLength(3);
    expect(result.eras).toEqual([]);
    expect(result.settings.layout).toBe('vertical');
  });

  it('converts dates correctly', () => {
    const result = migrateFromTimelineJS(sampleTimelineJS);
    const first = result.events[0];

    expect(first.date.start).toBe('1939-09-01');
    expect(first.date.end).toBe('1945-09-02');
  });

  it('converts media when present', () => {
    const result = migrateFromTimelineJS(sampleTimelineJS);
    const first = result.events[0];

    expect(first.media).toHaveLength(1);
    expect(first.media[0].type).toBe('image');
    expect(first.media[0].url).toBe('https://example.com/poland.jpg');
    expect(first.media[0].caption).toBe('German troops');
    expect(first.media[0].credit).toBe('Archive');
  });

  it('produces empty media array when event has no media', () => {
    const result = migrateFromTimelineJS(sampleTimelineJS);
    const second = result.events[1];

    expect(second.media).toEqual([]);
  });

  it('preserves group information', () => {
    const result = migrateFromTimelineJS(sampleTimelineJS);
    const dday = result.events[2];

    expect(dday.group).toBe('Western Front');
  });

  it('generates unique UUIDs when unique_id is absent', () => {
    const result = migrateFromTimelineJS(sampleTimelineJS);
    const ids = result.events.map((e) => e.id);
    // All IDs should be non-empty strings
    ids.forEach((id) => {
      expect(id).toBeTruthy();
    });
    // All IDs should be unique
    expect(new Set(ids).size).toBe(ids.length);
    // IDs should be valid UUIDs (8-4-4-4-12 hex pattern)
    ids.forEach((id) => {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  it('uses unique_id when provided', () => {
    const data = {
      events: [
        {
          unique_id: 'custom-id',
          start_date: { year: 2020 },
          text: { headline: 'Custom' },
        },
      ],
    };
    const result = migrateFromTimelineJS(data);
    expect(result.events[0].id).toBe('custom-id');
  });

  it('pads negative years as BCE dates', () => {
    const data = {
      events: [
        {
          start_date: { year: -44, month: 3, day: 15 },
          text: { headline: 'Assassination of Caesar' },
        },
      ],
    };
    const result = migrateFromTimelineJS(data);
    expect(result.events[0]?.date.start).toBe('-0044-03-15');
  });

  it('pads a negative year-only date', () => {
    const data = {
      events: [
        {
          start_date: { year: -500 },
          text: { headline: 'Early BCE' },
        },
      ],
    };
    const result = migrateFromTimelineJS(data);
    expect(result.events[0]?.date.start).toBe('-0500');
  });

  it('handles events with year-only dates', () => {
    const data = {
      events: [
        {
          start_date: { year: 1066 },
          text: { headline: 'Battle of Hastings' },
        },
      ],
    };
    const result = migrateFromTimelineJS(data);
    expect(result.events[0].date.start).toBe('1066');
  });

  it('handles events with year-month dates', () => {
    const data = {
      events: [
        {
          start_date: { year: 1969, month: 7 },
          text: { headline: 'Moon Landing' },
        },
      ],
    };
    const result = migrateFromTimelineJS(data);
    expect(result.events[0].date.start).toBe('1969-07');
  });

  it('falls back to default title when title slide is absent', () => {
    const data = {
      events: [
        {
          start_date: { year: 2024 },
          text: { headline: 'Something' },
        },
      ],
    };
    const result = migrateFromTimelineJS(data);
    expect(result.title).toBe('Imported Timeline');
  });

  it('skips events that have no start_date', () => {
    const data = {
      events: [
        { text: { headline: 'No date' } },
        { start_date: { year: 2024 }, text: { headline: 'Has date' } },
      ],
    };
    const result = migrateFromTimelineJS(data);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('Has date');
  });

  it('throws for non-object input', () => {
    expect(() => migrateFromTimelineJS(null)).toThrow();
    expect(() => migrateFromTimelineJS('string')).toThrow();
    expect(() => migrateFromTimelineJS(42)).toThrow();
  });
});

describe('migrateFromTimelineJSWithReport', () => {
  it('reports skipped events, dropped media and unsupported fields', () => {
    const { timeline, warnings } = migrateFromTimelineJSWithReport({
      title: { text: { headline: '<b>Title</b>' }, media: { url: 'https://x.test/a.jpg' } },
      scale: 'cosmological',
      events: [
        { text: { headline: 'No date' } },
        {
          start_date: { year: 1990 },
          text: { headline: 'Bad media', text: '<p>Hello <strong>world</strong></p>' },
          media: { url: 'javascript:alert(1)' },
          background: { color: '#000' },
        },
      ],
    });

    expect(timeline.title).toBe('Title');
    expect(timeline.events).toHaveLength(1);
    expect(timeline.events[0].media).toEqual([]);
    expect(timeline.events[0].body).toBe('Hello **world**');

    const byPath = new Map(warnings.map((w) => [w.path, w]));
    expect(byPath.get('events[0].start_date')?.severity).toBe('warning');
    expect(byPath.get('events[1].media.url')?.severity).toBe('warning');
    expect(byPath.get('events[1].background')).toBeDefined();
    expect(byPath.get('events[1].text.text')?.severity).toBe('info');
    expect(byPath.get('scale')).toBeDefined();
    expect(byPath.get('title.media')).toBeDefined();
  });

  it('maps eras and display dates, and de-duplicates ids', () => {
    const { timeline, warnings } = migrateFromTimelineJSWithReport({
      eras: [
        { start_date: { year: 1939 }, end_date: { year: 1945 }, text: { headline: 'War' } },
        { start_date: { year: 1950 } },
      ],
      events: [
        { unique_id: 'a', start_date: { year: 1940 }, display_date: 'Spring 1940' },
        { unique_id: 'a', start_date: { year: 1941 } },
      ],
    });
    expect(timeline.eras).toEqual([
      expect.objectContaining({ title: 'War', start: '1939', end: '1945' }),
    ]);
    expect(timeline.events[0].date.displayOverride).toBe('Spring 1940');
    expect(timeline.events[0].id).toBe('a');
    expect(timeline.events[1].id).not.toBe('a');
    expect(warnings.map((w) => w.path)).toEqual(
      expect.arrayContaining(['eras[1]', 'events[1].unique_id']),
    );
  });

  it('produces documents that pass schema validation', () => {
    const { timeline } = migrateFromTimelineJSWithReport({
      events: [{ start_date: { year: -44, month: 3, day: 15 }, text: { headline: 'Ides' } }],
    });
    expect(validateTimeline(timeline).success).toBe(true);
  });
});
