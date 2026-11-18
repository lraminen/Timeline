import { describe, it, expect } from 'vitest';
import type { TimelineEvent, TimelineEra } from '@chronicle/schema';
import {
  sortEvents,
  groupEventsByEra,
  formatDate,
  getDateRange,
  getDatePosition,
  groupEventsByDate,
} from '../date-engine.js';

const sampleEvents: TimelineEvent[] = [
  {
    id: 'moon-landing',
    date: { start: '1969-07-20' },
    title: 'Apollo 11 lands on the Moon',
    media: [],
    tags: ['space', 'usa'],
    era: 'space-race',
  },
  {
    id: 'sputnik',
    date: { start: '1957-10-04' },
    title: 'Sputnik 1 Launch',
    media: [],
    tags: ['space', 'ussr'],
    era: 'space-race',
  },
  {
    id: 'caesar-death',
    date: { start: '-0044-03-15' },
    title: 'Assassination of Julius Caesar',
    media: [],
    tags: ['rome', 'ancient'],
  },
  {
    id: 'iss',
    date: { start: '1998-11-20' },
    title: 'ISS First Module',
    media: [],
    tags: ['space', 'international'],
    era: 'modern',
  },
];

const sampleEras: TimelineEra[] = [
  { id: 'space-race', title: 'Space Race', start: '1957', end: '1975' },
  { id: 'modern', title: 'Modern Era', start: '1990', end: '2024' },
];

describe('date-engine', () => {
  it('sortEvents sorts events chronologically including BCE', () => {
    const sorted = sortEvents(sampleEvents);
    expect(sorted[0].id).toBe('caesar-death');
    expect(sorted[1].id).toBe('sputnik');
    expect(sorted[2].id).toBe('moon-landing');
    expect(sorted[3].id).toBe('iss');
  });

  it('groupEventsByEra groups events correctly by their era ID', () => {
    const grouped = groupEventsByEra(sampleEvents, sampleEras);
    expect(grouped.get('space-race')?.length).toBe(2);
    expect(grouped.get('modern')?.length).toBe(1);
    expect(grouped.get('')?.length).toBe(1); // Caesar has no era
  });

  it('formatDate handles full dates, partial dates, BCE, approximate, uncertain', () => {
    const d1 = formatDate('2024-07-20', 'en');
    expect(d1).toContain('2024');
    expect(d1).toContain('20');

    const dYear = formatDate('1969', 'en');
    expect(dYear).toBe('1969');

    const dBCE = formatDate('-0044', 'en');
    expect(dBCE).toBe('44 BCE');

    const dApprox = formatDate('1500', 'en', { approximate: true });
    expect(dApprox).toBe('~1500');

    const dUncertain = formatDate('1500', 'en', { uncertain: true });
    expect(dUncertain).toBe('1500?');
  });

  it('getDateRange returns correct earliest and latest dates', () => {
    const range = getDateRange(sampleEvents);
    expect(range).not.toBeNull();
    expect(range?.earliest).toBe('-0044-03-15');
    expect(range?.latest).toBe('1998-11-20');
  });

  it('getDatePosition computes normalized coordinates [0..1]', () => {
    const p1 = getDatePosition('1957-10-04', '1957-10-04', '1998-11-20');
    expect(p1).toBe(0);

    const p2 = getDatePosition('1998-11-20', '1957-10-04', '1998-11-20');
    expect(p2).toBe(1);

    const pMid = getDatePosition('1978-01-01', '1957-01-01', '1999-01-01');
    expect(pMid).toBeGreaterThan(0.4);
    expect(pMid).toBeLessThan(0.6);
  });

  it('groupEventsByDate groups by year, decade, century', () => {
    const byDecade = groupEventsByDate(sampleEvents, 'decade');
    expect(byDecade.get('1950s')?.length).toBe(1);
    expect(byDecade.get('1960s')?.length).toBe(1);
    expect(byDecade.get('1990s')?.length).toBe(1);
  });
});
