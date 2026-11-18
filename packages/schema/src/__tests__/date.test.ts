import { describe, it, expect } from 'vitest';
import { TimelineDateSchema, parseTimelineDate, compareDates, type TimelineDate } from '../date.js';

// ---------------------------------------------------------------------------
// parseTimelineDate
// ---------------------------------------------------------------------------
describe('parseTimelineDate', () => {
  it('normalises a year-only string', () => {
    expect(parseTimelineDate('2024')).toBe('2024-01-01');
  });

  it('normalises a year-month string', () => {
    expect(parseTimelineDate('2024-07')).toBe('2024-07-01');
  });

  it('passes through a full date string', () => {
    expect(parseTimelineDate('2024-07-04')).toBe('2024-07-04');
  });

  it('passes through a full ISO-8601 datetime', () => {
    const iso = '2024-07-04T12:00:00Z';
    expect(parseTimelineDate(iso)).toBe(iso);
  });

  it('handles BCE (negative) year-only strings', () => {
    expect(parseTimelineDate('-0044')).toBe('-0044-01-01');
  });

  it('handles BCE year-month strings', () => {
    expect(parseTimelineDate('-0044-03')).toBe('-0044-03-01');
  });

  it('handles BCE full date strings', () => {
    expect(parseTimelineDate('-0044-03-15')).toBe('-0044-03-15');
  });

  it('trims whitespace', () => {
    expect(parseTimelineDate('  2024  ')).toBe('2024-01-01');
  });
});

// ---------------------------------------------------------------------------
// compareDates
// ---------------------------------------------------------------------------
describe('compareDates', () => {
  it('sorts earlier dates before later dates', () => {
    const a: TimelineDate = { start: '2000' };
    const b: TimelineDate = { start: '2020' };
    expect(compareDates(a, b)).toBeLessThan(0);
  });

  it('returns 0 for identical dates', () => {
    const a: TimelineDate = { start: '2020-06-15' };
    const b: TimelineDate = { start: '2020-06-15' };
    expect(compareDates(a, b)).toBe(0);
  });

  it('sorts BCE dates before CE dates', () => {
    const bce: TimelineDate = { start: '-0044' };
    const ce: TimelineDate = { start: '2024' };
    expect(compareDates(bce, ce)).toBeLessThan(0);
  });

  it('sorts two BCE dates correctly (more negative = earlier)', () => {
    const earlier: TimelineDate = { start: '-0500' };
    const later: TimelineDate = { start: '-0044' };
    expect(compareDates(earlier, later)).toBeLessThan(0);
  });

  it('sorts BCE before early CE dates (1 CE)', () => {
    const bce: TimelineDate = { start: '-0044' };
    const ce: TimelineDate = { start: '0001' };
    expect(compareDates(bce, ce)).toBeLessThan(0);
  });

  it('sorts BCE before medieval CE dates (500 CE)', () => {
    const bce: TimelineDate = { start: '-0044' };
    const ce: TimelineDate = { start: '0500' };
    expect(compareDates(bce, ce)).toBeLessThan(0);
  });

  it('sorts BCE before pre-epoch CE dates (1000 CE)', () => {
    const bce: TimelineDate = { start: '-0044' };
    const ce: TimelineDate = { start: '1000' };
    expect(compareDates(bce, ce)).toBeLessThan(0);
  });

  it('sorts BCE before pre-1970 CE dates (1950 CE)', () => {
    const bce: TimelineDate = { start: '-0044' };
    const ce: TimelineDate = { start: '1950' };
    expect(compareDates(bce, ce)).toBeLessThan(0);
  });

  it('sorts partial dates by normalised form', () => {
    const yearOnly: TimelineDate = { start: '2020' };
    const monthDay: TimelineDate = { start: '2020-06-15' };
    // 2020-01-01 vs 2020-06-15
    expect(compareDates(yearOnly, monthDay)).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// TimelineDateSchema validation
// ---------------------------------------------------------------------------
describe('TimelineDateSchema', () => {
  it('accepts a minimal date with only start', () => {
    const result = TimelineDateSchema.safeParse({ start: '2024' });
    expect(result.success).toBe(true);
  });

  it('accepts a date range with start and end', () => {
    const result = TimelineDateSchema.safeParse({
      start: '2020-01',
      end: '2024-12',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional modifiers', () => {
    const result = TimelineDateSchema.safeParse({
      start: '1500',
      uncertain: true,
      approximate: true,
      displayOverride: 'circa 1500',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.uncertain).toBe(true);
      expect(result.data.approximate).toBe(true);
      expect(result.data.displayOverride).toBe('circa 1500');
    }
  });

  it('rejects when start is missing', () => {
    const result = TimelineDateSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects when start is not a string', () => {
    const result = TimelineDateSchema.safeParse({ start: 2024 });
    expect(result.success).toBe(false);
  });
});
