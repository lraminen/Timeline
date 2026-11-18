import { describe, it, expect } from 'vitest';
import { validateTimeline, validateEvent, toJsonSchema } from '../validate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validTimelineData() {
  return {
    id: 'tl-1',
    title: 'Test Timeline',
    events: [
      {
        id: 'evt-1',
        date: { start: '2024-01-01' },
        title: 'First event',
      },
    ],
  };
}

function validEventData() {
  return {
    id: 'evt-1',
    date: { start: '2024-01-01' },
    title: 'An event',
  };
}

// ---------------------------------------------------------------------------
// validateTimeline
// ---------------------------------------------------------------------------
describe('validateTimeline', () => {
  it('returns success for a valid timeline', () => {
    const result = validateTimeline(validTimelineData());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('Test Timeline');
      // defaults should be populated
      expect(result.data.eras).toEqual([]);
      expect(result.data.settings.layout).toBe('vertical');
      expect(result.data.settings.theme).toBe('light');
    }
  });

  it('fails when title is missing', () => {
    const { title: _title, ...rest } = validTimelineData();
    const result = validateTimeline(rest);
    expect(result.success).toBe(false);
  });

  it('fails when events is not an array', () => {
    const result = validateTimeline({
      ...validTimelineData(),
      events: 'not-an-array',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty events array', () => {
    const result = validateTimeline({
      ...validTimelineData(),
      events: [],
    });
    expect(result.success).toBe(true);
  });

  it('fails when an event inside the timeline is invalid', () => {
    const result = validateTimeline({
      ...validTimelineData(),
      events: [{ id: 'bad' }], // missing date & title
    });
    expect(result.success).toBe(false);
  });

  it('accepts timeline with eras', () => {
    const result = validateTimeline({
      ...validTimelineData(),
      eras: [
        {
          id: 'era-1',
          title: 'Renaissance',
          start: '1400',
          end: '1600',
          color: '#6366f1',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('validates partial date strings in events', () => {
    const result = validateTimeline({
      ...validTimelineData(),
      events: [
        { id: 'e1', date: { start: '2024' }, title: 'Year only' },
        { id: 'e2', date: { start: '2024-06' }, title: 'Month only' },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateEvent
// ---------------------------------------------------------------------------
describe('validateEvent', () => {
  it('returns success for a valid event', () => {
    const result = validateEvent(validEventData());
    expect(result.success).toBe(true);
  });

  it('populates defaults for media and tags', () => {
    const result = validateEvent(validEventData());
    if (result.success) {
      expect(result.data.media).toEqual([]);
      expect(result.data.tags).toEqual([]);
    }
  });

  it('fails when title is empty', () => {
    const result = validateEvent({ ...validEventData(), title: '' });
    expect(result.success).toBe(false);
  });

  it('fails when date is missing', () => {
    const { date: _date, ...rest } = validEventData();
    const result = validateEvent(rest);
    expect(result.success).toBe(false);
  });

  it('fails for completely invalid input', () => {
    const result = validateEvent(null);
    expect(result.success).toBe(false);
  });

  it('accepts an event with full media', () => {
    const result = validateEvent({
      ...validEventData(),
      media: [
        {
          type: 'image',
          url: 'https://example.com/photo.jpg',
          alt: 'A photo',
          caption: 'Caption',
          credit: 'Photographer',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an event with location', () => {
    const result = validateEvent({
      ...validEventData(),
      location: { lat: 41.9028, lng: 12.4964, label: 'Rome' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects location with out-of-range lat', () => {
    const result = validateEvent({
      ...validEventData(),
      location: { lat: 100, lng: 0 },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toJsonSchema
// ---------------------------------------------------------------------------
describe('toJsonSchema', () => {
  it('returns a valid JSON Schema object', () => {
    const schema = toJsonSchema();
    expect(schema).toBeDefined();
    expect(typeof schema).toBe('object');
    // Should contain a definitions or $defs key, plus the root reference.
    expect(
      '$ref' in schema || 'definitions' in schema || '$defs' in schema || 'properties' in schema,
    ).toBe(true);
  });
});
