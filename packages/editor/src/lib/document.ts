import type { Timeline, TimelineEvent } from '@chronicle/schema';
import { newId } from './ids.js';
import { today } from './dates.js';

export function createBlankTimeline(title = 'Untitled timeline'): Timeline {
  return {
    schemaVersion: '1.0.0',
    id: newId(),
    title,
    events: [],
    eras: [],
    settings: { layout: 'vertical', theme: 'light', locale: 'en' },
  };
}

export function createEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: newId(),
    date: { start: today() },
    title: 'New event',
    media: [],
    tags: [],
    ...overrides,
  };
}

/** A small starter document so a first-time user sees something meaningful. */
export function createSampleTimeline(): Timeline {
  const doc = createBlankTimeline('My first timeline');
  doc.description = 'Edit these events, or import your own data from JSON or CSV.';
  doc.events = [
    createEvent({
      date: { start: '1969-07-20' },
      title: 'Apollo 11 lands on the Moon',
      body: 'Neil Armstrong and Buzz Aldrin become the **first humans** to walk on the Moon.',
      tags: ['space'],
    }),
    createEvent({
      date: { start: '1989-11-09' },
      title: 'Fall of the Berlin Wall',
      body: 'Crowds cross the border as East Germany opens its checkpoints.',
      tags: ['history'],
    }),
    createEvent({
      date: { start: '1991-08-06' },
      title: 'The first website goes live',
      body: 'Tim Berners-Lee publishes the first web page at CERN.',
      tags: ['technology'],
    }),
  ];
  return doc;
}

/** Collects every tag used in the document, sorted case-insensitively. */
export function allTags(doc: Timeline): string[] {
  return [...new Set(doc.events.flatMap((e) => e.tags))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
}
