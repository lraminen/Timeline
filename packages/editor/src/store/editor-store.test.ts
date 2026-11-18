import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Timeline } from '@chronicle/schema';
import { useEditor, MERGE_WINDOW_MS, selectUndoLabel } from './editor-store.js';
import {
  addEvent,
  deleteEra,
  deleteEvent,
  duplicateEvent,
  moveEvent,
  replaceDocument,
  sortEventsByDate,
  updateEvent,
  updateSettings,
  addEra,
  type Command,
} from './commands.js';
import { createBlankTimeline, createEvent } from '../lib/document.js';

const store = () => useEditor.getState();
const doc = () => store().doc;
const run = (factory: (d: Timeline) => Command): void => {
  store().execute(factory(doc()));
};

function seed(): Timeline {
  const t = createBlankTimeline('Seed');
  t.events = [
    createEvent({ id: 'a', title: 'A', date: { start: '2000' } }),
    createEvent({ id: 'b', title: 'B', date: { start: '1990' } }),
  ];
  return t;
}

beforeEach(() => {
  vi.useFakeTimers();
  store().load(seed(), 'draft-1');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('editor store — undo/redo', () => {
  it('adds, undoes and redoes an event, tracking selection', () => {
    const evt = createEvent({ id: 'c', title: 'C' });
    store().execute(addEvent(evt));
    expect(doc().events.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(store().selectedId).toBe('c');

    store().undo();
    expect(doc().events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(store().selectedId).toBeNull();

    store().redo();
    expect(doc().events.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(store().selectedId).toBe('c');
  });

  it('restores a deleted event at its original index', () => {
    run((d) => deleteEvent(d, 'a'));
    expect(doc().events.map((e) => e.id)).toEqual(['b']);
    store().undo();
    expect(doc().events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(store().selectedId).toBe('a');
  });

  it('merges rapid edits to the same field into one undo step', () => {
    for (const title of ['A1', 'A12', 'A123']) {
      run((d) => updateEvent(d, 'a', { title }));
      vi.advanceTimersByTime(200);
    }
    expect(store().past).toHaveLength(1);
    store().undo();
    expect(doc().events[0].title).toBe('A');
  });

  it('does not merge edits separated by a pause, or to different fields', () => {
    run((d) => updateEvent(d, 'a', { title: 'X' }));
    vi.advanceTimersByTime(MERGE_WINDOW_MS + 1);
    run((d) => updateEvent(d, 'a', { title: 'XY' }));
    run((d) => updateEvent(d, 'a', { body: 'text' }));
    expect(store().past).toHaveLength(3);
  });

  it('never merges into a redone command', () => {
    run((d) => updateEvent(d, 'a', { title: 'X' }));
    store().undo();
    store().redo();
    run((d) => updateEvent(d, 'a', { title: 'XY' }));
    store().undo();
    expect(doc().events[0].title).toBe('X');
  });

  it('clears optional fields when a patch sets them to undefined, and restores them on undo', () => {
    run((d) => updateEvent(d, 'a', { body: 'hello' }));
    vi.advanceTimersByTime(MERGE_WINDOW_MS + 1);
    run((d) => updateEvent(d, 'a', { body: undefined }));
    expect('body' in doc().events[0]).toBe(false);
    store().undo();
    expect(doc().events[0].body).toBe('hello');
  });

  it('a new command clears the redo stack', () => {
    run((d) => updateEvent(d, 'a', { title: 'X' }));
    store().undo();
    expect(store().future).toHaveLength(1);
    run((d) => updateEvent(d, 'b', { title: 'Y' }));
    expect(store().future).toHaveLength(0);
  });

  it('exposes a human label for the next undo step', () => {
    run((d) => deleteEvent(d, 'b'));
    expect(selectUndoLabel(store())).toBe('Delete “B”');
  });

  it('never mutates previous documents', () => {
    const before = doc();
    const snapshot = structuredClone(before);
    run((d) => updateEvent(d, 'a', { title: 'changed', tags: ['x'] }));
    run(() => moveEvent(0, 1));
    run((d) => sortEventsByDate(d));
    expect(before).toEqual(snapshot);
  });
});

describe('commands', () => {
  it('duplicates an event right after the original with a new id', () => {
    run((d) => duplicateEvent(d, 'a', 'a2'));
    expect(doc().events.map((e) => e.id)).toEqual(['a', 'a2', 'b']);
    expect(doc().events[1].title).toBe('A (copy)');
    expect(store().selectedId).toBe('a2');
  });

  it('moves events and undoes the move', () => {
    run(() => moveEvent(0, 1));
    expect(doc().events.map((e) => e.id)).toEqual(['b', 'a']);
    store().undo();
    expect(doc().events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('sorts by date and restores the manual order on undo', () => {
    run((d) => sortEventsByDate(d));
    expect(doc().events.map((e) => e.id)).toEqual(['b', 'a']);
    store().undo();
    expect(doc().events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('deleting an era clears references, and undo restores them', () => {
    store().execute(addEra({ id: 'e1', title: 'Era', start: '1980', end: '2010' }));
    run((d) => updateEvent(d, 'a', { era: 'e1' }));
    run((d) => deleteEra(d, 'e1'));
    expect(doc().eras).toHaveLength(0);
    expect(doc().events[0].era).toBeUndefined();
    store().undo();
    expect(doc().eras).toHaveLength(1);
    expect(doc().events[0].era).toBe('e1');
  });

  it('updates settings and replaces documents undoably', () => {
    run((d) => updateSettings(d, { layout: 'horizontal' }));
    expect(doc().settings.layout).toBe('horizontal');
    const replacement = createBlankTimeline('Other');
    run((d) => replaceDocument(d, replacement));
    expect(doc().title).toBe('Other');
    store().undo();
    expect(doc().title).toBe('Seed');
    expect(doc().settings.layout).toBe('horizontal');
  });

  it('load() starts a fresh session', () => {
    run((d) => updateEvent(d, 'a', { title: 'X' }));
    store().load(createBlankTimeline('Fresh'), 'draft-2');
    expect(store().past).toHaveLength(0);
    expect(store().draftId).toBe('draft-2');
  });
});
