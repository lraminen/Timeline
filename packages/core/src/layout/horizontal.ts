import type { TimelineEvent, TimelineEra } from '@chronicle/schema';
import type {
  CardMeasurer,
  LayoutEngine,
  LayoutPosition,
  LayoutResult,
  RenderOptions,
} from '../types.js';
import { getDatePosition, getDateRange } from '../date-engine.js';

const CARD_WIDTH = 280;
const PADDING_X = 64;
/** Space above the top lane, leaving room for era band labels. */
const PADDING_TOP = 44;
const PADDING_BOTTOM = 24;
const AXIS_GAP = 28;
const LANE_GAP = 16;
const MIN_H_GAP = 16;
const MIN_SPACING = CARD_WIDTH + 40;
const ESTIMATED_CARD_HEIGHT = 220;

interface Lane {
  rightEdge: number;
  height: number;
}

/**
 * Continuous left→right time axis. Cards are placed by date and alternate
 * above/below the axis; cards that would collide horizontally are pushed into
 * further lanes away from the axis, so nothing overlaps.
 */
export class HorizontalLayout implements LayoutEngine {
  readonly name = 'horizontal';

  compute(
    events: TimelineEvent[],
    eras: TimelineEra[],
    containerWidth: number,
    containerHeight: number,
    options: RenderOptions,
    measure?: CardMeasurer,
  ): LayoutResult {
    const zoom = Math.max(0.5, Math.min(3, options.zoomLevel ?? 1));
    const range = getDateRange(events);
    const baseWidth = Math.max(containerWidth, events.length * MIN_SPACING + PADDING_X * 2);
    const totalWidth = Math.round(baseWidth * zoom);
    const trackStart = PADDING_X;
    const available = totalWidth - PADDING_X * 2 - CARD_WIDTH;
    const hasSpan = range !== null && range.earliest !== range.latest;

    // Pass 1: x position, side, lane assignment.
    const lanes: Record<'above' | 'below', Lane[]> = { above: [], below: [] };
    const placed = events.map((evt, i) => {
      const norm = hasSpan
        ? getDatePosition(evt.date.start, range.earliest, range.latest)
        : (i + 0.5) / events.length;
      const x = trackStart + Math.round(norm * available);
      const height = measure?.(evt.id, CARD_WIDTH) ?? ESTIMATED_CARD_HEIGHT;
      const band: 'above' | 'below' = i % 2 === 0 ? 'above' : 'below';

      const sideLanes = lanes[band];
      let laneIndex = sideLanes.findIndex((l) => x >= l.rightEdge + MIN_H_GAP);
      if (laneIndex === -1) {
        laneIndex = sideLanes.length;
        sideLanes.push({ rightEdge: -Infinity, height: 0 });
      }
      const lane = sideLanes[laneIndex];
      lane.rightEdge = x + CARD_WIDTH;
      lane.height = Math.max(lane.height, height);

      return { evt, x, height, band, laneIndex };
    });

    // Pass 2: vertical extents.
    const stackHeight = (ls: Lane[]): number =>
      ls.reduce((sum, l) => sum + l.height, 0) + Math.max(0, ls.length - 1) * LANE_GAP;
    const aboveHeight = stackHeight(lanes.above);
    const belowHeight = stackHeight(lanes.below);
    const contentHeight = PADDING_TOP + aboveHeight + AXIS_GAP * 2 + belowHeight + PADDING_BOTTOM;
    const totalHeight = Math.max(containerHeight, contentHeight);
    const offsetY = Math.floor((totalHeight - contentHeight) / 2);
    const axisY = offsetY + PADDING_TOP + aboveHeight + AXIS_GAP;

    /** Distance from the axis gap edge to the near edge of lane `k`. */
    const laneOffset = (ls: Lane[], k: number): number =>
      ls.slice(0, k).reduce((sum, l) => sum + l.height + LANE_GAP, 0);

    const positions: LayoutPosition[] = placed.map(({ evt, x, height, band, laneIndex }) => {
      const y =
        band === 'above'
          ? axisY - AXIS_GAP - laneOffset(lanes.above, laneIndex) - height
          : axisY + AXIS_GAP + laneOffset(lanes.below, laneIndex);
      return {
        eventId: evt.id,
        x,
        y,
        width: CARD_WIDTH,
        height,
        markerX: x + Math.round(CARD_WIDTH / 2),
        markerY: axisY,
        side: band === 'above' ? 'left' : 'right',
      };
    });

    // Era bands share the marker coordinate space.
    const eraBands: LayoutResult['eraBands'] = [];
    if (hasSpan) {
      const toX = (date: string): number =>
        trackStart +
        CARD_WIDTH / 2 +
        getDatePosition(date, range.earliest, range.latest) * available;
      for (const era of eras) {
        const start = Math.round(toX(era.start));
        const end = Math.round(toX(era.end));
        if (end > start) {
          eraBands.push({ eraId: era.id, x: start, width: end - start });
        }
      }
    }

    return {
      positions,
      axisStart: { x: PADDING_X, y: axisY },
      axisEnd: { x: totalWidth - PADDING_X, y: axisY },
      totalWidth,
      totalHeight,
      direction: 'horizontal',
      eraBands,
    };
  }
}
