import type { Timeline, TimelineEra, TimelineEvent } from '@chronicle/schema';
import { newId } from './ids.js';

/**
 * Prepares imported events/eras for appending to `doc`: any id that already
 * exists is replaced with a fresh one, and era references are remapped so
 * imported events keep pointing at their imported eras.
 */
export function prepareAppend(
  doc: Timeline,
  events: TimelineEvent[],
  eras: TimelineEra[],
): { events: TimelineEvent[]; eras: TimelineEra[] } {
  const eventIds = new Set(doc.events.map((e) => e.id));
  const eraIds = new Set(doc.eras.map((e) => e.id));
  const eraRemap = new Map<string, string>();

  const nextEras = eras.map((era) => {
    if (!eraIds.has(era.id)) {
      eraIds.add(era.id);
      return era;
    }
    const id = newId();
    eraRemap.set(era.id, id);
    eraIds.add(id);
    return { ...era, id };
  });

  const nextEvents = events.map((evt) => {
    let next = evt;
    if (eventIds.has(evt.id)) next = { ...next, id: newId() };
    eventIds.add(next.id);
    if (evt.era && eraRemap.has(evt.era)) next = { ...next, era: eraRemap.get(evt.era) };
    return next;
  });

  return { events: nextEvents, eras: nextEras };
}
