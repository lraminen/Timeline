import { describe, it, expect } from 'vitest';
import type { TimelineEra, TimelineEvent } from '@chronicle/schema';
import type { LayoutPosition, RenderOptions } from '../types.js';
import { VerticalLayout } from '../layout/vertical.js';
import { HorizontalLayout } from '../layout/horizontal.js';
import { CardLayout } from '../layout/card.js';
import { mirrorLayout } from '../renderer/index.js';

const OPTIONS: RenderOptions = { layout: 'vertical', theme: 'light', locale: 'en' };

function events(dates: string[]): TimelineEvent[] {
  return dates.map((start, i) => ({
    id: `e${String(i)}`,
    date: { start },
    title: `Event ${String(i)}`,
    media: [],
    tags: [],
  }));
}

/** Deterministic, deliberately uneven card heights. */
const HEIGHTS = [420, 140, 310, 520, 180, 260, 600, 150];
const measure = (id: string): number => HEIGHTS[Number(id.slice(1)) % HEIGHTS.length] ?? 200;

function overlaps(a: LayoutPosition, b: LayoutPosition): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function expectNoOverlap(positions: LayoutPosition[]): void {
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      expect(
        overlaps(positions[i], positions[j]),
        `${positions[i].eventId} overlaps ${positions[j].eventId}`,
      ).toBe(false);
    }
  }
}

const DATES = [
  '1957-10-04',
  '1961-04-12',
  '1969-07-20',
  '1973-05-14',
  '1977-09-05',
  '1990-04-24',
  '1998-11-20',
  '2012-08-06',
];

describe('VerticalLayout', () => {
  const layout = new VerticalLayout();

  it('never overlaps cards when heights vary (desktop)', () => {
    const r = layout.compute(events(DATES), [], 1100, 600, OPTIONS, measure);
    expectNoOverlap(r.positions);
    expect(r.positions.map((p) => p.side)).toEqual([
      'left',
      'right',
      'left',
      'right',
      'left',
      'right',
      'left',
      'right',
    ]);
  });

  it('never overlaps cards in the single-column mobile layout', () => {
    const r = layout.compute(events(DATES), [], 400, 600, OPTIONS, measure);
    expectNoOverlap(r.positions);
    expect(new Set(r.positions.map((p) => p.side))).toEqual(new Set(['right']));
  });

  it('keeps chronological reading order (y never decreases)', () => {
    const r = layout.compute(events(DATES), [], 1100, 600, OPTIONS, measure);
    const ys = r.positions.map((p) => p.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it('contains every card within totalHeight and uses measured heights', () => {
    const r = layout.compute(events(DATES), [], 1100, 600, OPTIONS, measure);
    for (const p of r.positions) {
      expect(p.height).toBe(measure(p.eventId));
      expect(p.y + p.height).toBeLessThanOrEqual(r.totalHeight);
    }
  });

  it('falls back to estimates without a measurer', () => {
    const r = layout.compute(events(DATES), [], 1100, 600, OPTIONS);
    expect(r.positions.every((p) => p.height > 0)).toBe(true);
    expectNoOverlap(r.positions);
  });
});

describe('HorizontalLayout', () => {
  const layout = new HorizontalLayout();
  const opts: RenderOptions = { ...OPTIONS, layout: 'horizontal' };

  it('never overlaps cards, even for clustered dates', () => {
    const clustered = events([
      '1969-07-16',
      '1969-07-18',
      '1969-07-20',
      '1969-07-21',
      '1969-07-24',
      '2012-08-06',
    ]);
    const r = layout.compute(clustered, [], 900, 520, opts, measure);
    expectNoOverlap(r.positions);
  });

  it('keeps cards off the axis and on their side', () => {
    const r = layout.compute(events(DATES), [], 1200, 520, opts, measure);
    const axisY = r.axisStart.y;
    for (const p of r.positions) {
      if (p.side === 'left') expect(p.y + p.height).toBeLessThan(axisY);
      else expect(p.y).toBeGreaterThan(axisY);
      expect(p.markerY).toBe(axisY);
    }
    expectNoOverlap(r.positions);
  });

  it('fits all content within totalWidth/totalHeight', () => {
    const r = layout.compute(events(DATES), [], 1200, 520, opts, measure);
    for (const p of r.positions) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + p.width).toBeLessThanOrEqual(r.totalWidth);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y + p.height).toBeLessThanOrEqual(r.totalHeight);
    }
  });

  it('places markers in date order and widens with zoom', () => {
    const r1 = layout.compute(events(DATES), [], 1200, 520, opts, measure);
    const xs = r1.positions.map((p) => p.markerX);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    const r2 = layout.compute(events(DATES), [], 1200, 520, { ...opts, zoomLevel: 2 }, measure);
    expect(r2.totalWidth).toBe(r1.totalWidth * 2);
  });

  it('computes era bands within the track', () => {
    const eras: TimelineEra[] = [
      { id: 'race', title: 'Space Race', start: '1957', end: '1975' },
      { id: 'out', title: 'Out of range', start: '1800', end: '1801' },
    ];
    const r = layout.compute(events(DATES), eras, 1200, 520, opts, measure);
    expect(r.eraBands?.map((b) => b.eraId)).toEqual(['race']);
    const band = r.eraBands?.[0];
    expect(band && band.x + band.width).toBeLessThanOrEqual(r.totalWidth);
  });
});

describe('CardLayout', () => {
  it('marks itself as normal-flow', () => {
    const r = new CardLayout().compute(events(DATES), [], 800, 600, OPTIONS);
    expect(r.flow).toBe(true);
  });
});

describe('mirrorLayout', () => {
  it('mirrors x coordinates and swaps sides for RTL', () => {
    const r = new HorizontalLayout().compute(events(DATES), [], 1200, 520, OPTIONS, measure);
    const m = mirrorLayout(r);
    r.positions.forEach((p, i) => {
      const q = m.positions[i];
      expect(q.x).toBe(r.totalWidth - p.x - p.width);
      expect(q.markerX).toBe(r.totalWidth - p.markerX);
      expect(q.y).toBe(p.y);
    });
    // Earliest event is now right-most.
    expect(m.positions[0].markerX).toBeGreaterThan(m.positions.at(-1)?.markerX ?? Infinity);
    expectNoOverlap(m.positions);
  });
});
