import * as Y from 'yjs';
import type { Timeline } from '@chronicle/schema';
import { diffText } from './text-diff.js';

/**
 * The Yjs representation of a Chronicle timeline.
 *
 * ```
 * meta        Y.Map    top-level fields (title and description are Y.Text)
 * settings    Y.Map    one entry per setting (values are plain JSON)
 * events      Y.Map    event id → Y.Map of fields (title and body are Y.Text)
 * eventOrder  Y.Array  event ids in list order
 * eras        Y.Map    era id → Y.Map of fields (title is Y.Text)
 * eraOrder    Y.Array  era ids in list order
 * ```
 *
 * Why this shape:
 * - Items are keyed by id, so two people editing different events (or
 *   different fields of one event) never conflict. Concurrent edits to the
 *   same non-text field resolve last-writer-wins, per field.
 * - Prose fields are Y.Text, so two people typing in the same title or body
 *   merge character by character instead of overwriting each other.
 * - Order lives in a separate list of ids. A concurrent move can leave an id
 *   in the list twice; readers keep the first occurrence, and items missing
 *   from the list are appended (sorted by id, so every replica agrees).
 *   Order only breaks ties anyway: timelines always display by date.
 *
 * `readTimeline` never trusts the document: a malicious or buggy peer can put
 * anything in a Yjs update. Results must be validated before they are stored.
 */

export const ROOTS = {
  meta: 'meta',
  settings: 'settings',
  events: 'events',
  eventOrder: 'eventOrder',
  eras: 'eras',
  eraOrder: 'eraOrder',
} as const;

const META_TEXT: ReadonlySet<string> = new Set(['title', 'description']);
const EVENT_TEXT: ReadonlySet<string> = new Set(['title', 'body']);
const ERA_TEXT: ReadonlySet<string> = new Set(['title']);
const NO_TEXT: ReadonlySet<string> = new Set();

type Obj = Record<string, unknown>;

const isRecord = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function plain(value: unknown): unknown {
  return value instanceof Y.AbstractType ? (value.toJSON() as unknown) : value;
}

function mapToObject(map: Y.Map<unknown>): Obj {
  const out: Obj = {};
  map.forEach((value, key) => {
    out[key] = plain(value);
  });
  return out;
}

function readCollection(map: Y.Map<unknown>, order: Y.Array<unknown>): Obj[] {
  const seen = new Set<string>();
  const out: Obj[] = [];
  const take = (id: string) => {
    seen.add(id);
    const item = map.get(id);
    if (item instanceof Y.Map) out.push({ ...mapToObject(item as Y.Map<unknown>), id });
  };
  for (const id of order.toArray()) {
    if (typeof id === 'string' && !seen.has(id) && map.has(id)) take(id);
  }
  // Items missing from the order list: append in a replica-independent order.
  for (const id of [...map.keys()].filter((k) => !seen.has(k)).sort()) take(id);
  return out;
}

/**
 * The timeline a Yjs document currently represents. The result is NOT
 * validated (see the module comment); event and era ids always equal their
 * keys, so ids are unique.
 */
export function readTimeline(doc: Y.Doc): Timeline {
  const meta = mapToObject(doc.getMap(ROOTS.meta));
  return {
    ...meta,
    settings: mapToObject(doc.getMap(ROOTS.settings)),
    events: readCollection(doc.getMap(ROOTS.events), doc.getArray(ROOTS.eventOrder)),
    eras: readCollection(doc.getMap(ROOTS.eras), doc.getArray(ROOTS.eraOrder)),
  } as unknown as Timeline;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Deep equality for JSON values; `undefined` object members count as absent. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** A detached JSON copy (drops `undefined` members, like the wire format would). */
const toJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

function writeFields(map: Y.Map<unknown>, obj: Obj, textFields: ReadonlySet<string>): void {
  for (const key of [...map.keys()]) {
    if (!Object.hasOwn(obj, key) || obj[key] === undefined) map.delete(key);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const current = map.get(key);
    if (textFields.has(key) && typeof value === 'string') {
      if (current instanceof Y.Text) {
        const splice = diffText(current.toJSON(), value);
        if (splice) {
          if (splice.remove > 0) current.delete(splice.index, splice.remove);
          if (splice.insert) current.insert(splice.index, splice.insert);
        }
      } else {
        map.set(key, new Y.Text(value));
      }
    } else if (current instanceof Y.AbstractType || !jsonEqual(current, value)) {
      map.set(key, toJson(value));
    }
  }
}

/** Indices (into `seq`) of one longest strictly increasing subsequence. */
function longestIncreasing(seq: readonly number[]): Set<number> {
  const tails: number[] = []; // index into seq of the smallest tail for each length
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i] ?? 0;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((seq[tails[mid] ?? 0] ?? 0) < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] ?? -1;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i !== -1; i = prev[i] ?? -1) keep.add(i);
  return keep;
}

/**
 * Edits `order` so that its first occurrences of known ids equal `target`,
 * moving as few ids as possible (ids on a longest increasing run stay put).
 */
function writeOrder(order: Y.Array<unknown>, target: readonly string[]): void {
  const raw = order.toArray();
  if (raw.length === target.length && raw.every((v, i) => v === target[i])) return;

  const position = new Map(target.map((id, i) => [id, i]));
  const seen = new Set<string>();
  const candidates: number[] = []; // indices into raw of first occurrences of target ids
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v === 'string' && position.has(v) && !seen.has(v)) {
      seen.add(v);
      candidates.push(i);
    }
  }
  const lis = longestIncreasing(candidates.map((i) => position.get(raw[i] as string) ?? 0));
  const keepRaw = new Set(candidates.filter((_, k) => lis.has(k)));

  // Delete everything else, from the end, in contiguous runs.
  let i = raw.length - 1;
  while (i >= 0) {
    if (keepRaw.has(i)) {
      i--;
      continue;
    }
    let start = i;
    while (start - 1 >= 0 && !keepRaw.has(start - 1)) start--;
    order.delete(start, i - start + 1);
    i = start - 1;
  }

  // Insert missing ids around the kept ones (which are already in target order).
  const kept = raw.filter((_, idx) => keepRaw.has(idx)) as string[];
  let j = 0;
  let at = 0;
  let run: string[] = [];
  const flush = () => {
    if (run.length === 0) return;
    order.insert(at, run);
    at += run.length;
    run = [];
  };
  for (const id of target) {
    if (j < kept.length && kept[j] === id) {
      flush();
      at++;
      j++;
    } else {
      run.push(id);
    }
  }
  flush();
}

function writeCollection(
  map: Y.Map<unknown>,
  order: Y.Array<unknown>,
  items: unknown,
  textFields: ReadonlySet<string>,
  prevItems: unknown,
): void {
  const byId = new Map<string, Obj>();
  for (const item of Array.isArray(items) ? (items as unknown[]) : []) {
    // Items without a string id, or repeating one, cannot be represented.
    if (isRecord(item) && typeof item.id === 'string' && !byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  const prevById = new Map<string, unknown>();
  if (Array.isArray(prevItems)) {
    for (const item of prevItems as unknown[]) {
      if (isRecord(item) && typeof item.id === 'string') prevById.set(item.id, item);
    }
  }

  for (const key of [...map.keys()]) if (!byId.has(key)) map.delete(key);
  for (const [id, item] of byId) {
    const current = map.get(id);
    if (current instanceof Y.Map) {
      // Unchanged object (structural sharing from immutable updates): skip.
      if (prevById.get(id) === item) continue;
      writeFields(current as Y.Map<unknown>, item, textFields);
    } else {
      const created = map.set(id, new Y.Map<unknown>());
      writeFields(created, item, textFields);
    }
  }
  writeOrder(order, [...byId.keys()]);
}

export interface WriteOptions {
  /** Transaction origin, so observers can tell local edits from remote ones. */
  origin?: unknown;
  /**
   * The timeline the document held before this change (e.g. the last value
   * read from it). Events and eras that are the identical object in `prev`
   * and `next` are skipped, which keeps keystrokes cheap on big timelines.
   * Only pass it when it really matches the document.
   */
  prev?: Timeline;
}

/**
 * Makes `doc` represent `next` with the fewest operations: unchanged fields
 * are not touched, text fields are spliced, and moved items keep their maps.
 * Afterwards `readTimeline(doc)` equals `next` (with `undefined` members
 * dropped and items without a usable id omitted).
 */
export function writeTimeline(doc: Y.Doc, next: Timeline, options: WriteOptions = {}): void {
  const { events, eras, settings, ...meta } = next as unknown as Obj;
  const prev = options.prev as unknown as Obj | undefined;
  doc.transact(() => {
    writeFields(doc.getMap(ROOTS.meta), meta, META_TEXT);
    if (!prev || prev.settings !== settings) {
      writeFields(doc.getMap(ROOTS.settings), isRecord(settings) ? settings : {}, NO_TEXT);
    }
    if (!prev || prev.events !== events) {
      writeCollection(
        doc.getMap(ROOTS.events),
        doc.getArray(ROOTS.eventOrder),
        events,
        EVENT_TEXT,
        prev?.events,
      );
    }
    if (!prev || prev.eras !== eras) {
      writeCollection(
        doc.getMap(ROOTS.eras),
        doc.getArray(ROOTS.eraOrder),
        eras,
        ERA_TEXT,
        prev?.eras,
      );
    }
  }, options.origin ?? null);
}

/** A complete Yjs update that creates `timeline` from nothing. */
export function encodeTimeline(timeline: Timeline): Uint8Array {
  const doc = new Y.Doc();
  writeTimeline(doc, timeline);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** True when a Yjs update contains no insertions and no deletions. */
export function isEmptyUpdate(update: Uint8Array): boolean {
  const { structs, ds } = Y.decodeUpdate(update);
  return structs.length === 0 && ds.clients.size === 0;
}
