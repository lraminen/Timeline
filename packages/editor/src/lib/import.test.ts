import { describe, it, expect } from 'vitest';
import { validateTimeline } from '@chronicle/schema';
import { importJson, lineColumn } from './import-json.js';
import {
  detectSlashOrder,
  guessMapping,
  parseCsv,
  parseDateValue,
  rowsToEvents,
  toCsvUrl,
} from './import-csv.js';
import { exportCsv, exportJson, slugify } from './export.js';
import { createBlankTimeline, createEvent } from './document.js';
import { dateProblem, parseDateParts, formatDateParts } from './dates.js';

describe('parseDateValue', () => {
  it.each([
    ['1969', '1969'],
    ['1969-07', '1969-07'],
    ['1969-7-20', '1969-07-20'],
    ['1969-07-20T20:17:00Z', '1969-07-20'],
    ['-44', '-0044'],
    ['44 BC', '-0044'],
    ['44 B.C.E.', '-0044'],
    ['1066 AD', '1066'],
    ['July 20, 1969', '1969-07-20'],
    ['Jul 1969', '1969-07'],
    ['20 July 1969', '1969-07-20'],
    ['20th Sept 1969', '1969-09-20'],
  ])('parses %j', (input, expected) => {
    expect(parseDateValue(input)?.value).toBe(expected);
  });

  it('applies slash order', () => {
    expect(parseDateValue('03/04/2020', 'mdy')?.value).toBe('2020-03-04');
    expect(parseDateValue('03/04/2020', 'dmy')?.value).toBe('2020-04-03');
    expect(parseDateValue('25.12.2020', 'dmy')?.value).toBe('2020-12-25');
  });

  it('marks circa dates as approximate', () => {
    expect(parseDateValue('c. 1500')).toEqual({ value: '1500', approximate: true });
    expect(parseDateValue('~ 300 BCE')).toEqual({ value: '-0300', approximate: true });
  });

  it.each(['', 'soon', '2020-13-01', '2021-02-29', '31/31/2020', '0'])('rejects %j', (input) => {
    expect(parseDateValue(input, 'dmy')).toBeNull();
  });

  it('knows leap years (including BCE)', () => {
    expect(parseDateValue('2020-02-29')?.value).toBe('2020-02-29');
    // 1 BCE is astronomical year 0, a leap year.
    expect(parseDateParts('-0001-02-29')).not.toBeNull();
    expect(parseDateParts('-0002-02-29')).toBeNull();
  });
});

describe('dates helpers', () => {
  it('round-trips parts', () => {
    expect(formatDateParts({ year: 44, bce: true, month: 3, day: 15 })).toBe('-0044-03-15');
    expect(parseDateParts('-0044-03-15')).toEqual({ year: 44, bce: true, month: 3, day: 15 });
  });
  it('explains problems', () => {
    expect(dateProblem('')).toMatch(/required/);
    expect(dateProblem('19x9')).toMatch(/YYYY/);
    expect(dateProblem('0000')).toMatch(/Year/);
    expect(dateProblem('1969-07-20')).toBeNull();
  });
});

describe('detectSlashOrder', () => {
  it('infers DMY / MDY from unambiguous values', () => {
    expect(detectSlashOrder(['01/02/2020', '25/12/2020'])).toMatchObject({
      order: 'dmy',
      ambiguous: false,
    });
    expect(detectSlashOrder(['12/25/2020'])).toMatchObject({ order: 'mdy', ambiguous: false });
  });
  it('flags ambiguity', () => {
    expect(detectSlashOrder(['01/02/2020', '03/04/2020'])).toMatchObject({
      present: true,
      ambiguous: true,
    });
    expect(detectSlashOrder(['1969-07-20'])).toMatchObject({ present: false, ambiguous: false });
  });
});

describe('CSV import', () => {
  const csv = [
    'Headline,Date,End,Description,Tags,Era,Image URL,Lat,Lon,Place',
    'Moon landing,1969-07-20,,First **steps**,"space; usa",Space Race,https://x.test/a.jpg,0.67,23.47,Tranquility',
    ',1970,,No title,,,,,,',
    'Bad date,someday,,,,,,,,',
    'Sputnik,04/10/1957,,,space,Space Race,javascript:alert(1),,,',
    'Range,1990,1980,,,,,,,',
  ].join('\n');

  it('guesses the column mapping from headers', () => {
    const table = parseCsv(csv);
    expect(guessMapping(table.headers)).toMatchObject({
      title: 0,
      start: 1,
      end: 2,
      body: 3,
      tags: 4,
      era: 5,
      mediaUrl: 6,
      lat: 7,
      lng: 8,
      locationLabel: 9,
    });
  });

  it('converts rows, reports problems by line, and creates missing eras', () => {
    const table = parseCsv(csv);
    const { events, newEras, errors } = rowsToEvents(table, guessMapping(table.headers), {
      slashOrder: 'dmy',
      existingEras: [],
    });

    expect(events.map((e) => e.title)).toEqual(['Moon landing', 'Sputnik', 'Range']);
    const [moon, sputnik, range] = events;
    expect(moon.tags).toEqual(['space', 'usa']);
    expect(moon.media[0]).toMatchObject({ type: 'image', url: 'https://x.test/a.jpg' });
    expect(moon.location).toEqual({ lat: 0.67, lng: 23.47, label: 'Tranquility' });
    expect(sputnik.date.start).toBe('1957-10-04');
    expect(sputnik.media).toEqual([]);
    expect(range.date.end).toBeUndefined();

    expect(newEras).toHaveLength(1);
    expect(newEras[0]).toMatchObject({
      title: 'Space Race',
      start: '1957-10-04',
      end: '1969-07-20',
    });
    expect(moon.era).toBe(newEras[0].id);

    expect(errors.map(({ line, skipped }) => ({ line, skipped }))).toEqual([
      { line: 3, skipped: true },
      { line: 4, skipped: true },
      { line: 5, skipped: false },
      { line: 6, skipped: false },
    ]);
    expect(errors[1].message).toContain('someday');
    expect(errors[2].message).toContain('Media');
    expect(errors[3].message).toContain('before');

    const doc = { ...createBlankTimeline(), events, eras: newEras };
    expect(validateTimeline(doc).success).toBe(true);
  });

  it('matches existing eras by id or title', () => {
    const table = parseCsv('title,date,era\nA,2000,modern\nB,2001,MODERN ERA');
    const { events, newEras } = rowsToEvents(table, guessMapping(table.headers), {
      slashOrder: 'mdy',
      existingEras: [{ id: 'modern', title: 'Modern Era', start: '1990', end: '2020' }],
    });
    expect(newEras).toEqual([]);
    expect(events.map((e) => e.era)).toEqual(['modern', 'modern']);
  });

  it('handles a BOM, quoted newlines and ragged rows', () => {
    const table = parseCsv('﻿title,date,description\n"A, B",2000,"line1\nline2"\nC,2001');
    expect(table.headers).toEqual(['title', 'date', 'description']);
    expect(table.rows).toEqual([
      ['A, B', '2000', 'line1\nline2'],
      ['C', '2001', ''],
    ]);
  });

  it('converts Google Sheets share links to CSV export links', () => {
    expect(toCsvUrl('https://docs.google.com/spreadsheets/d/abc_123/edit#gid=42')).toBe(
      'https://docs.google.com/spreadsheets/d/abc_123/export?format=csv&gid=42',
    );
    expect(toCsvUrl('https://example.com/data.csv')).toBe('https://example.com/data.csv');
  });
});

describe('JSON import', () => {
  it('reports syntax errors with line and column', () => {
    const result = importJson('{\n  "title": "x",\n  "events": [\n}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toMatchObject({ line: 4 });
  });

  it('reports schema errors at the offending line', () => {
    const text = JSON.stringify(
      { id: 't', title: 'T', events: [{ id: 'a', date: { start: '2000' }, title: '' }] },
      null,
      2,
    );
    const result = importJson(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues[0];
      expect(issue.path).toBe('events.0.title');
      expect(text.split('\n')[(issue.line ?? 0) - 1]).toContain('"title": ""');
    }
  });

  it('names missing required fields', () => {
    const result = importJson('{"id":"t","title":"T","events":[{"id":"a","title":"A"}]}');
    expect(!result.ok && result.issues[0].message).toMatch(/Missing required field “date”/);
  });

  it('detects and migrates TimelineJS with a report', () => {
    const result = importJson(
      JSON.stringify({
        events: [{ start_date: { year: 1969 }, text: { headline: 'Moon', text: '<b>Yes</b>' } }],
      }),
    );
    expect(result.ok && result.kind).toBe('timelinejs');
    if (result.ok) {
      expect(result.timeline.events[0].body).toBe('**Yes**');
      expect(result.warnings).toHaveLength(1);
    }
  });

  it('lineColumn counts from 1', () => {
    expect(lineColumn('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  });
});

describe('export', () => {
  const doc = createBlankTimeline('Round Trip');
  doc.eras = [{ id: 'e1', title: 'Era One', start: '1900', end: '2000' }];
  doc.events = [
    createEvent({
      id: 'a',
      title: '=SUM(A1) "quoted", title',
      date: { start: '-0044-03-15', end: '-0044-03-16', approximate: true },
      body: '- a list\n- **bold**',
      tags: ['x', 'y z'],
      era: 'e1',
      media: [{ type: 'image', url: 'https://x.test/a.png', alt: 'Alt', caption: 'Cap' }],
      location: { lat: 41.9, lng: 12.5, label: 'Rome' },
    }),
  ];

  it('JSON export re-imports to an identical document', () => {
    const result = importJson(exportJson(doc));
    expect(result.ok && result.timeline).toEqual(doc);
  });

  it('CSV export round-trips through CSV import', () => {
    const csv = exportCsv(doc);
    expect(csv.split('\n')[1]).toContain("'=SUM"); // formula guard
    const table = parseCsv(csv);
    const { events, errors } = rowsToEvents(table, guessMapping(table.headers), {
      slashOrder: 'mdy',
      existingEras: doc.eras,
    });
    expect(errors).toEqual([]);
    expect(events).toEqual(doc.events);
  });

  it('slugifies titles for filenames', () => {
    expect(slugify('Ère des Lumières: 1715–1789!')).toBe('ere-des-lumieres-1715-1789');
    expect(slugify('***')).toBe('timeline');
  });
});
