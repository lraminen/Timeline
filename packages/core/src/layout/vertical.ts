import type { TimelineEvent, TimelineEra } from '@chronicle/schema';
import type {
  CardMeasurer,
  LayoutEngine,
  LayoutPosition,
  LayoutResult,
  RenderOptions,
} from '../types.js';

const MOBILE_BREAKPOINT = 640;
const PADDING_Y = 48;
const CARD_GAP = 24;
/** Minimum vertical offset between consecutive cards on opposite sides. */
const STAGGER = 56;
const AXIS_GAP = 24;
const MARKER_OFFSET = 24;
const ESTIMATED_CARD_HEIGHT = 180;

/**
 * Centre-axis timeline with cards alternating left/right. Each side is
 * stacked independently (no overlap); consecutive cards are staggered so
 * reading order stays chronological. Collapses to one column on narrow widths.
 */
export class VerticalLayout implements LayoutEngine {
  readonly name = 'vertical';

  compute(
    events: TimelineEvent[],
    _eras: TimelineEra[],
    containerWidth: number,
    _containerHeight: number,
    _options: RenderOptions,
    measure?: CardMeasurer,
  ): LayoutResult {
    const isMobile = containerWidth < MOBILE_BREAKPOINT;
    const axisX = isMobile ? 32 : Math.round(containerWidth / 2);
    const cardWidth = isMobile
      ? Math.max(220, containerWidth - axisX - AXIS_GAP - 16)
      : Math.min(460, Math.round(containerWidth / 2 - AXIS_GAP - 24));

    const positions: LayoutPosition[] = [];
    const bottom = { left: PADDING_Y - CARD_GAP, right: PADDING_Y - CARD_GAP };
    let prevY = -Infinity;

    events.forEach((evt, i) => {
      const side: 'left' | 'right' = isMobile || i % 2 === 1 ? 'right' : 'left';
      const height = measure?.(evt.id, cardWidth) ?? ESTIMATED_CARD_HEIGHT;
      const y = Math.max(bottom[side] + CARD_GAP, prevY + STAGGER);
      const x = side === 'left' ? axisX - AXIS_GAP - cardWidth : axisX + AXIS_GAP;

      positions.push({
        eventId: evt.id,
        x,
        y,
        width: cardWidth,
        height,
        markerX: axisX,
        markerY: y + MARKER_OFFSET,
        side,
      });

      bottom[side] = y + height;
      prevY = y;
    });

    const contentBottom = positions.length > 0 ? Math.max(bottom.left, bottom.right) : 0;
    const totalHeight = Math.max(300, contentBottom + PADDING_Y);

    return {
      positions,
      axisStart: { x: axisX, y: PADDING_Y },
      axisEnd: { x: axisX, y: totalHeight - PADDING_Y },
      totalWidth: containerWidth,
      totalHeight,
      direction: 'vertical',
    };
  }
}
