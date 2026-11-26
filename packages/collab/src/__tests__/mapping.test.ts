import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Timeline } from '@chronicle/schema';
import { diffText } from '../text-diff.js';
import { encodeTimeline, isEmptyUpdate, readTimeline, ROOTS, writeTimeline } from '../mapping.js';

const base = (): Timeline => ({
  schemaVersion: '1.0.0',
  id: 'tl',
  title: 'Space Race',
  description: 'From Sputnik to Apollo',
  settings: { layout: 'vertical', theme: 'light', locale: 'en' },
  eras: [{ id: 'cold-war', title: 'Cold War', start: '1947', end: '1991', color: '#334155' }],
  events: [
    {
      id: 'sputnik',
      date: { start: '1957-10-04' },
      title: 'Sputnik 1',
      body: 'First **satellite**.',
      media: [],
      tags: ['ussr'],
      era: 'cold-war',
    },
    {
      id: 'gagarin',
      date: { start: '1961-04-12' },
      title: 'Gagarin',
      media: [],
      tags: ['ussr'],
    },
    { id: 'apollo', date: { start: '1969-07-20' }, title: 'Apollo 11', media: [], tags: ['usa'] },
  ],
});

function docOf(t: Timeline): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeTimeline(t));
  return doc;
}

/** Two replicas starting from the same state, like two browser tabs. */
function replicas(t: Timeline): [Y.Doc, Y.Doc] {
  const update = encodeTimeline(t);
  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(a, update);
  Y.applyUpdate(b, update);
  return [a, b];
}

function exchange(a: Y.Doc, b: Y.Doc): void {
  const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, toB);
  Y.applyUpdate(a, toA);
}

const edit = (t: Timeline, f: (draft: Timeline) => void): Timeline => {
  const copy = structuredClone(t);
  f(copy);
  return copy;
};

describe('diffText', () => {
  it('finds the single splice between two strings', () => {
    expect(diffText('hello world', 'hello brave world')).toEqual({
      index: 6,
      remove: 0,
      insert: 'brave ',
    });
    expect(diffText('abc', 'abc')).toBeNull();
    expect(diffText('abcdef', 'abXYef')).toEqual({ index: 2, remove: 2, insert: 'XY' });
    expect(diffText('', 'x')).toEqual({ index: 0, remove: 0, insert: 'x' });
    expect(diffText('aaa', 'aa')).toEqual({ index: 2, remove: 1, insert: '' });
  });

  it('never splits a surrogate pair', () => {
    // 😀 and 😃 share their high surrogate.
    const s = diffText('a😀b', 'a😃b');
    expect(s).toEqual({ index: 1, remove: 2, insert: '😃' });
    const apply = (from: string, sp: { index: number; remove: number; insert: string }) =>
      from.slice(0, sp.index) + sp.insert + from.slice(sp.index + sp.remove);
    for (const [from, to] of [
      ['😀😀', '😀😃'],
      ['x😀', 'x'],
      ['😀', '😃😀'],
      ['a😀😀b', 'a😀b'],
    ] as const) {
      const sp = diffText(from, to);
      expect(sp).not.toBeNull();
      if (!sp) continue;
      expect(apply(from, sp)).toBe(to);
      expect(sp.insert).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
  });
});

describe('timeline ↔ Yjs mapping', () => {
  it('round-trips a timeline', () => {
    const t = base();
    expect(readTimeline(docOf(t))).toEqual(t);
  });

  it('stores prose fields as Y.Text and other fields as plain JSON', () => {
    const doc = docOf(base());
    const event = doc.getMap(ROOTS.events).get('sputnik') as Y.Map<unknown>;
    expect(event.get('title')).toBeInstanceOf(Y.Text);
    expect(event.get('body')).toBeInstanceOf(Y.Text);
    expect(event.get('date')).toEqual({ start: '1957-10-04' });
    expect(doc.getMap(ROOTS.meta).get('title')).toBeInstanceOf(Y.Text);
    expect(doc.getArray(ROOTS.eventOrder).toArray()).toEqual(['sputnik', 'gagarin', 'apollo']);
  });

  it('writes exactly the target for arbitrary edits', () => {
    const doc = docOf(base());
    const targets: Timeline[] = [
      edit(base(), (d) => {
        d.title = 'The Space Race';
        delete d.description;
      }),
      edit(base(), (d) => {
        d.events.reverse();
        d.eras = [];
        delete d.events[0]?.era;
      }),
      edit(base(), (d) => {
        d.events.splice(1, 1);
        d.events.push({
          id: 'new',
          title: 'New',
          date: { start: '1970' },
          media: [],
          tags: [],
        });
        d.settings = { layout: 'horizontal', theme: 'dark', locale: 'fr' };
      }),
      edit(base(), (d) => {
        const e = d.events[0];
        if (e) {
          e.body = undefined;
          e.date = { start: '1957-10', approximate: true };
          e.tags = [];
        }
      }),
      base(),
      edit(base(), (d) => {
        d.events = [];
      }),
    ];
    for (const target of targets) {
      writeTimeline(doc, target);
      expect(readTimeline(doc)).toEqual(JSON.parse(JSON.stringify(target)));
    }
  });

  it('makes no change at all when nothing changed', () => {
    const doc = docOf(base());
    const before = Y.encodeStateVector(doc);
    let updates = 0;
    doc.on('update', () => updates++);
    writeTimeline(doc, base());
    expect(updates).toBe(0);
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });

  it('splices text instead of replacing it', () => {
    const doc = docOf(base());
    const text = (doc.getMap(ROOTS.events).get('apollo') as Y.Map<unknown>).get('title');
    writeTimeline(
      doc,
      edit(base(), (d) => {
        const e = d.events[2];
        if (e) e.title = 'Apollo 11 lands';
      }),
    );
    // The same Y.Text instance was edited in place.
    expect((doc.getMap(ROOTS.events).get('apollo') as Y.Map<unknown>).get('title')).toBe(text);
    expect(String(text)).toBe('Apollo 11 lands');
  });

  it('moves few ids when reordering', () => {
    const doc = docOf(base());
    const order = doc.getArray(ROOTS.eventOrder);
    let deleted = 0;
    let inserted = 0;
    order.observe((e) => {
      for (const d of e.changes.delta) {
        if (d.delete) deleted += d.delete;
        if (d.insert) inserted += (d.insert as unknown[]).length;
      }
    });
    // Move apollo to the front: one delete + one insert, not a rewrite.
    writeTimeline(
      doc,
      edit(base(), (d) => {
        const apollo = d.events.pop();
        if (apollo) d.events.unshift(apollo);
      }),
    );
    expect(order.toArray()).toEqual(['apollo', 'sputnik', 'gagarin']);
    expect(deleted).toBe(1);
    expect(inserted).toBe(1);
  });

  it('skips unchanged events when given the previous value', () => {
    const doc = docOf(base());
    const prev = readTimeline(doc);
    // A different object for "sputnik" with a changed title, others identical.
    const next = {
      ...prev,
      events: prev.events.map((e) => (e.id === 'sputnik' ? { ...e, title: 'Sputnik' } : e)),
    };
    writeTimeline(doc, next, { prev });
    expect(readTimeline(doc)).toEqual(next);
  });

  it('tags transactions with the given origin', () => {
    const doc = docOf(base());
    const origins: unknown[] = [];
    doc.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin));
    writeTimeline(
      doc,
      edit(base(), (d) => (d.title = 'X')),
      { origin: 'local' },
    );
    expect(origins).toEqual(['local']);
  });

  it('detects empty updates', () => {
    const doc = docOf(base());
    expect(isEmptyUpdate(Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc)))).toBe(true);
    expect(isEmptyUpdate(Y.encodeStateAsUpdate(doc))).toBe(false);
  });
});

describe('concurrent editing', () => {
  it('merges edits to different events and fields', () => {
    const [a, b] = replicas(base());
    writeTimeline(
      a,
      edit(base(), (d) => {
        const e = d.events[0];
        if (e) e.tags = ['ussr', 'satellite'];
      }),
    );
    writeTimeline(
      b,
      edit(base(), (d) => {
        const e = d.events[2];
        if (e) e.date = { start: '1969-07-21' };
        d.settings = { ...d.settings, theme: 'dark' };
      }),
    );
    exchange(a, b);
    const merged = readTimeline(a);
    expect(readTimeline(b)).toEqual(merged);
    expect(merged.events[0]?.tags).toEqual(['ussr', 'satellite']);
    expect(merged.events[2]?.date).toEqual({ start: '1969-07-21' });
    expect(merged.settings.theme).toBe('dark');
  });

  it('merges typing in the same text field character by character', () => {
    const [a, b] = replicas(base());
    writeTimeline(
      a,
      edit(base(), (d) => {
        const e = d.events[0];
        if (e) e.body = 'The first **satellite**.';
      }),
    );
    writeTimeline(
      b,
      edit(base(), (d) => {
        const e = d.events[0];
        if (e) e.body = 'First **satellite**, launched by the USSR.';
      }),
    );
    exchange(a, b);
    expect(readTimeline(a).events[0]?.body).toBe('The first **satellite**, launched by the USSR.');
    expect(readTimeline(b)).toEqual(readTimeline(a));
  });

  it('keeps both events added concurrently', () => {
    const [a, b] = replicas(base());
    const add = (id: string) =>
      edit(base(), (d) => {
        d.events.splice(1, 0, {
          id,
          title: id,
          date: { start: '1960' },
          media: [],
          tags: [],
        } as Timeline['events'][number]);
      });
    writeTimeline(a, add('from-a'));
    writeTimeline(b, add('from-b'));
    exchange(a, b);
    const ids = readTimeline(a).events.map((e) => e.id);
    expect(ids).toHaveLength(5);
    expect(ids).toEqual(expect.arrayContaining(['from-a', 'from-b']));
    expect(readTimeline(b).events.map((e) => e.id)).toEqual(ids);
  });

  it('deleting an event wins over a concurrent edit to it', () => {
    const [a, b] = replicas(base());
    writeTimeline(
      a,
      edit(base(), (d) => {
        d.events = d.events.filter((e) => e.id !== 'gagarin');
      }),
    );
    writeTimeline(
      b,
      edit(base(), (d) => {
        const e = d.events[1];
        if (e) e.title = 'Yuri Gagarin';
      }),
    );
    exchange(a, b);
    expect(readTimeline(a).events.map((e) => e.id)).toEqual(['sputnik', 'apollo']);
    expect(readTimeline(b)).toEqual(readTimeline(a));
  });

  it('converges after concurrent reorders without losing or duplicating events', () => {
    const [a, b] = replicas(base());
    writeTimeline(
      a,
      edit(base(), (d) => {
        d.events.reverse();
      }),
    );
    writeTimeline(
      b,
      edit(base(), (d) => {
        const first = d.events.shift();
        if (first) d.events.push(first);
      }),
    );
    exchange(a, b);
    const ids = readTimeline(a).events.map((e) => e.id);
    expect([...ids].sort()).toEqual(['apollo', 'gagarin', 'sputnik']);
    expect(readTimeline(b).events.map((e) => e.id)).toEqual(ids);
    // Writing the merged result back is a no-op for the other replica's view.
    writeTimeline(a, readTimeline(a));
    expect(readTimeline(a).events.map((e) => e.id)).toEqual(ids);
  });
});

describe('reading untrusted documents', () => {
  it('ignores junk in the order list and keeps ids equal to keys', () => {
    const doc = docOf(base());
    doc.transact(() => {
      doc.getArray(ROOTS.eventOrder).push([42, 'missing', 'sputnik', null]);
      doc.getMap(ROOTS.events).set('not-a-map', 'junk');
      const e = doc.getMap(ROOTS.events).get('apollo') as Y.Map<unknown>;
      e.set('id', 'spoofed');
    });
    const t = readTimeline(doc);
    expect(t.events.map((e) => e.id)).toEqual(['sputnik', 'gagarin', 'apollo']);
  });

  it('appends events missing from the order list in id order', () => {
    const doc = docOf(base());
    doc.getArray(ROOTS.eventOrder).delete(0, 3);
    expect(readTimeline(doc).events.map((e) => e.id)).toEqual(['apollo', 'gagarin', 'sputnik']);
  });

  it('cannot be confused by top-level keys that shadow collections', () => {
    const doc = docOf(base());
    doc.getMap(ROOTS.meta).set('events', 'oops');
    expect(readTimeline(doc).events).toHaveLength(3);
  });
});
