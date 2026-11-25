import { describe, expect, it } from 'vitest';
import { repairLegacyDateString, repairTimelineDates } from '../repair.js';
import { validateTimeline } from '../validate.js';

const value = (raw: string) => repairLegacyDateString(raw)?.value ?? null;

describe('repairLegacyDateString', () => {
  it('leaves valid dates untouched', () => {
    for (const ok of ['1969', '1969-07', '1969-07-20', '-0044-03-15', '2024-07-04T12:00:00Z']) {
      expect(repairLegacyDateString(ok)).toEqual({
        value: ok,
        reducedPrecision: false,
        changes: [],
      });
    }
  });

  it('canonicalises formats older releases accepted', () => {
    expect(value(' 1969-07-20 ')).toBe('1969-07-20');
    expect(value('1969-7-20')).toBe('1969-07-20');
    expect(value('1969/07/20')).toBe('1969-07-20');
    expect(value('+2024')).toBe('2024');
    expect(value('476')).toBe('476'); // already valid: short years are allowed
    expect(value('2024-07-04 12:00')).toBe('2024-07-04T12:00');
    expect(value('2024-07-04 9:05:07.250z')).toBe('2024-07-04T09:05:07.250Z');
  });

  it('reads year 0 as 1 BCE', () => {
    expect(value('0000')).toBe('-0001');
    expect(value('-0000-05')).toBe('-0001-05');
  });

  it('drops impossible parts and reports the lost precision', () => {
    expect(repairLegacyDateString('1969-02-31')).toMatchObject({
      value: '1969-02',
      reducedPrecision: true,
    });
    expect(value('1969-13-45')).toBe('1969');
    expect(value('2023-02-29')).toBe('2023-02');
    expect(value('2024-07-04T24:00:00Z')).toBe('2024-07-04');
  });

  it('returns null for text it cannot recognise', () => {
    for (const bad of ['Summer 1969', 'July 20, 1969', '', 'abc', '07/20/1969']) {
      expect(repairLegacyDateString(bad)).toBeNull();
    }
  });
});

describe('repairTimelineDates', () => {
  const legacy = {
    schemaVersion: '1.0.0',
    id: 'legacy',
    title: 'Legacy',
    events: [
      { id: 'a', title: 'Fine', date: { start: '1969-07-20' }, media: [], tags: [] },
      {
        id: 'b',
        title: 'Padded',
        date: { start: '1969-7-20', end: '1969-8-1' },
        media: [],
        tags: [],
      },
      { id: 'c', title: 'Impossible', date: { start: '1969-02-31' }, media: [], tags: [] },
      {
        id: 'd',
        title: 'Labelled',
        date: { start: '1969-02-31', displayOverride: 'Late Feb' },
        media: [],
        tags: [],
      },
    ],
    eras: [{ id: 'e', title: 'Era', start: '0000', end: '1969-7' }],
    settings: { layout: 'vertical', theme: 'light', locale: 'en' },
  };

  it('migrates a legacy timeline so it validates, without mutating the input', () => {
    const before = JSON.stringify(legacy);
    expect(validateTimeline(legacy).success).toBe(false);

    const report = repairTimelineDates(legacy);
    expect(JSON.stringify(legacy)).toBe(before);
    expect(report.changed).toBe(true);
    expect(validateTimeline(report.timeline).success).toBe(true);

    const events = report.timeline.events;
    expect(events[0]).toBe(legacy.events[0]); // untouched events keep their identity
    expect(events[1]?.date).toEqual({ start: '1969-07-20', end: '1969-08-01' });
    expect(events[2]?.date).toEqual({
      start: '1969-02',
      uncertain: true,
      displayOverride: '1969-02-31',
    });
    expect(events[3]?.date).toEqual({
      start: '1969-02',
      uncertain: true,
      displayOverride: 'Late Feb',
    });
    expect(report.timeline.eras[0]).toMatchObject({ start: '-0001', end: '1969-07' });

    const paths = report.warnings.map((w) => w.path);
    expect(paths).toContain('events[1].date.start');
    expect(paths).toContain('eras[0].start');
    expect(report.warnings.find((w) => w.path === 'events[2].date.start')?.severity).toBe(
      'warning',
    );
  });

  it('is idempotent and returns the same object when nothing needs migrating', () => {
    const once = repairTimelineDates(legacy).timeline;
    const twice = repairTimelineDates(once);
    expect(twice.changed).toBe(false);
    expect(twice.timeline).toBe(once);
  });

  it('leaves unrecognisable dates for validation to report', () => {
    const doc = {
      ...legacy,
      eras: [],
      events: [{ ...legacy.events[0], date: { start: 'Summer 1969' } }],
    };
    const report = repairTimelineDates(doc);
    expect(report.changed).toBe(false);
    expect(report.unrecognised).toBe(1);
    expect(report.warnings[0]).toMatchObject({ path: 'events[0].date.start', severity: 'warning' });
    expect(validateTimeline(report.timeline).success).toBe(false);
  });

  it('ignores input that is not a timeline object', () => {
    expect(repairTimelineDates(null).timeline).toBeNull();
    expect(repairTimelineDates('x').changed).toBe(false);
  });
});
