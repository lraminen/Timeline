import { describe, it, expect } from 'vitest';
import type { TimelineEvent } from '@chronicle/schema';
import { searchEvents, filterEvents, getUniqueTags, getUniqueEras } from '../search.js';

const sampleEvents: TimelineEvent[] = [
  {
    id: 'moon-landing',
    date: { start: '1969-07-20' },
    title: 'Apollo 11 lands on the Moon',
    body: 'First humans on lunar surface, Armstrong and Aldrin.',
    media: [],
    tags: ['space', 'apollo', 'usa'],
    era: 'space-race',
  },
  {
    id: 'sputnik',
    date: { start: '1957-10-04' },
    title: 'Sputnik 1 Launch',
    body: 'First artificial satellite orbited Earth.',
    media: [],
    tags: ['space', 'satellite', 'ussr'],
    era: 'space-race',
  },
  {
    id: 'webb',
    date: { start: '2021-12-25' },
    title: 'James Webb Space Telescope Launch',
    body: 'Next generation infrared space observatory.',
    media: [],
    tags: ['space', 'telescope', 'astronomy'],
    era: 'modern',
  },
];

describe('search & filter', () => {
  it('searchEvents finds by title', () => {
    const results = searchEvents(sampleEvents, 'apollo');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('moon-landing');
  });

  it('searchEvents finds by body content', () => {
    const results = searchEvents(sampleEvents, 'satellite');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('sputnik');
  });

  it('searchEvents is case-insensitive', () => {
    const results = searchEvents(sampleEvents, 'TELESCOPE');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('webb');
  });

  it('filterEvents filters by tag', () => {
    const results = filterEvents(sampleEvents, { tags: ['apollo'] });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('moon-landing');
  });

  it('filterEvents filters by era', () => {
    const results = filterEvents(sampleEvents, { era: 'space-race' });
    expect(results.length).toBe(2);
  });

  it('filterEvents applies combined criteria (AND logic)', () => {
    const results = filterEvents(sampleEvents, {
      era: 'space-race',
      tags: ['ussr'],
    });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('sputnik');
  });

  it('getUniqueTags extracts sorted unique tags', () => {
    const tags = getUniqueTags(sampleEvents);
    expect(tags).toContain('apollo');
    expect(tags).toContain('astronomy');
    expect(tags).toContain('satellite');
    expect(tags).toContain('space');
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('getUniqueEras extracts unique era IDs', () => {
    const eras = getUniqueEras(sampleEvents);
    expect(eras).toEqual(['modern', 'space-race']);
  });
});
