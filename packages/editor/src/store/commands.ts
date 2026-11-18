import type { Timeline, TimelineEra, TimelineEvent, TimelineSettings } from '@chronicle/schema';
import { sortEvents } from '@chronicle/core';

/**
 * A reversible edit (Command pattern). Commands are pure: `apply`/`revert`
 * return new documents and never mutate their input, so history entries can
 * share structure safely.
 *
 * Factories capture whatever "before" state `revert` needs at creation time,
 * from the document the command is created against.
 */
export interface Command {
  readonly label: string;
  apply: (doc: Timeline) => Timeline;
  revert: (doc: Timeline) => Timeline;
  /**
   * Commands with the same key executed in quick succession are merged into
   * one undo step (e.g. typing in a title field).
   */
  readonly mergeKey?: string;
  /** Selection to set after apply / after revert (`undefined` = leave as is). */
  readonly selectAfterApply?: string | null;
  readonly selectAfterRevert?: string | null;
}

type Patch<T> = { [K in keyof T]?: T[K] | undefined };

/** Applies a patch; keys whose value is `undefined` are removed (clearing optional fields). */
export function patchObject<T extends object>(obj: T, patch: Patch<T>): T {
  const cleared = new Set(
    Object.entries(patch)
      .filter(([, v]) => v === undefined)
      .map(([k]) => k),
  );
  return Object.fromEntries(
    Object.entries({ ...obj, ...patch }).filter(([k]) => !cleared.has(k)),
  ) as T;
}

/** Captures the current values of the keys a patch will change. */
function snapshot<T extends object>(obj: T, patch: Patch<T>): Patch<T> {
  const before: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    before[k] = (obj as Record<string, unknown>)[k];
  }
  return before as Patch<T>;
}

function findEvent(doc: Timeline, id: string): { event: TimelineEvent; index: number } {
  const index = doc.events.findIndex((e) => e.id === id);
  if (index === -1) throw new Error(`Event ${id} not found`);
  return { event: doc.events[index], index };
}

function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  const next = [...list];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
  return next;
}

function keyOf(patch: object): string {
  return Object.keys(patch).sort().join(',');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function addEvent(event: TimelineEvent, index?: number): Command {
  return {
    label: 'Add event',
    apply: (doc) => ({ ...doc, events: insertAt(doc.events, index ?? doc.events.length, event) }),
    revert: (doc) => ({ ...doc, events: doc.events.filter((e) => e.id !== event.id) }),
    selectAfterApply: event.id,
    selectAfterRevert: null,
  };
}

export function deleteEvent(doc: Timeline, id: string): Command {
  const { event, index } = findEvent(doc, id);
  return {
    label: `Delete “${event.title}”`,
    apply: (d) => ({ ...d, events: d.events.filter((e) => e.id !== id) }),
    revert: (d) => ({ ...d, events: insertAt(d.events, index, event) }),
    selectAfterApply: null,
    selectAfterRevert: id,
  };
}

export function duplicateEvent(doc: Timeline, id: string, newId: string): Command {
  const { event, index } = findEvent(doc, id);
  const copy: TimelineEvent = structuredClone({
    ...event,
    id: newId,
    title: `${event.title} (copy)`,
  });
  return { ...addEvent(copy, index + 1), label: `Duplicate “${event.title}”` };
}

export function updateEvent(doc: Timeline, id: string, patch: Patch<TimelineEvent>): Command {
  const { event } = findEvent(doc, id);
  const before = snapshot(event, patch);
  const update = (p: Patch<TimelineEvent>) => (d: Timeline) => ({
    ...d,
    events: d.events.map((e) => (e.id === id ? patchObject(e, p) : e)),
  });
  return {
    label: `Edit ${Object.keys(patch).join(', ')}`,
    apply: update(patch),
    revert: update(before),
    mergeKey: `event:${id}:${keyOf(patch)}`,
  };
}

export function moveEvent(from: number, to: number): Command {
  const move = (a: number, b: number) => (d: Timeline) => {
    const events = [...d.events];
    const [item] = events.splice(a, 1);
    events.splice(b, 0, item);
    return { ...d, events };
  };
  return { label: 'Reorder events', apply: move(from, to), revert: move(to, from) };
}

export function sortEventsByDate(doc: Timeline): Command {
  const originalOrder = doc.events.map((e) => e.id);
  return {
    label: 'Sort events by date',
    apply: (d) => ({ ...d, events: sortEvents(d.events) }),
    revert: (d) => {
      const byId = new Map(d.events.map((e) => [e.id, e]));
      const restored = originalOrder.flatMap((id) => byId.get(id) ?? []);
      // Keep anything added since (defensive; history is linear).
      const rest = d.events.filter((e) => !originalOrder.includes(e.id));
      return { ...d, events: [...restored, ...rest] };
    },
  };
}

export function appendEvents(events: TimelineEvent[], eras: TimelineEra[] = []): Command {
  const eventIds = new Set(events.map((e) => e.id));
  const eraIds = new Set(eras.map((e) => e.id));
  return {
    label: `Import ${String(events.length)} event${events.length === 1 ? '' : 's'}`,
    apply: (d) => ({ ...d, events: [...d.events, ...events], eras: [...d.eras, ...eras] }),
    revert: (d) => ({
      ...d,
      events: d.events.filter((e) => !eventIds.has(e.id)),
      eras: d.eras.filter((e) => !eraIds.has(e.id)),
    }),
    selectAfterApply: events[0]?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Timeline & settings
// ---------------------------------------------------------------------------

type TimelineMeta = Pick<Timeline, 'title' | 'description'>;

export function updateTimeline(doc: Timeline, patch: Patch<TimelineMeta>): Command {
  const before = snapshot(doc as TimelineMeta, patch);
  return {
    label: `Edit timeline ${Object.keys(patch).join(', ')}`,
    apply: (d) => patchObject<Timeline>(d, patch),
    revert: (d) => patchObject<Timeline>(d, before),
    mergeKey: `timeline:${keyOf(patch)}`,
  };
}

export function updateSettings(doc: Timeline, patch: Patch<TimelineSettings>): Command {
  const before = snapshot(doc.settings, patch);
  return {
    label: `Change ${Object.keys(patch).join(', ')}`,
    apply: (d) => ({ ...d, settings: patchObject(d.settings, patch) }),
    revert: (d) => ({ ...d, settings: patchObject(d.settings, before) }),
    mergeKey: `settings:${keyOf(patch)}`,
  };
}

export function replaceDocument(
  doc: Timeline,
  next: Timeline,
  label = 'Replace timeline',
): Command {
  return {
    label,
    apply: () => next,
    revert: () => doc,
    selectAfterApply: next.events[0]?.id ?? null,
    selectAfterRevert: null,
  };
}

// ---------------------------------------------------------------------------
// Eras
// ---------------------------------------------------------------------------

export function addEra(era: TimelineEra): Command {
  return {
    label: 'Add era',
    apply: (d) => ({ ...d, eras: [...d.eras, era] }),
    revert: (d) => ({ ...d, eras: d.eras.filter((e) => e.id !== era.id) }),
  };
}

export function updateEra(doc: Timeline, id: string, patch: Patch<TimelineEra>): Command {
  const era = doc.eras.find((e) => e.id === id);
  if (!era) throw new Error(`Era ${id} not found`);
  const before = snapshot(era, patch);
  const update = (p: Patch<TimelineEra>) => (d: Timeline) => ({
    ...d,
    eras: d.eras.map((e) => (e.id === id ? patchObject(e, p) : e)),
  });
  return {
    label: `Edit era ${Object.keys(patch).join(', ')}`,
    apply: update(patch),
    revert: update(before),
    mergeKey: `era:${id}:${keyOf(patch)}`,
  };
}

/** Deletes an era and clears it from any events that referenced it. */
export function deleteEra(doc: Timeline, id: string): Command {
  const index = doc.eras.findIndex((e) => e.id === id);
  if (index === -1) throw new Error(`Era ${id} not found`);
  const era = doc.eras[index];
  const referencing = new Set(doc.events.filter((e) => e.era === id).map((e) => e.id));
  return {
    label: `Delete era “${era.title}”`,
    apply: (d) => ({
      ...d,
      eras: d.eras.filter((e) => e.id !== id),
      events: d.events.map((e) => (referencing.has(e.id) ? patchObject(e, { era: undefined }) : e)),
    }),
    revert: (d) => ({
      ...d,
      eras: insertAt(d.eras, index, era),
      events: d.events.map((e) => (referencing.has(e.id) ? { ...e, era: id } : e)),
    }),
  };
}
