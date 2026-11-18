import type { TimelineEvent, TimelineEra } from "@chronicle/schema";
import type { LayoutEngine, LayoutPosition, LayoutResult, RenderOptions } from "../types.js";
import { getDatePosition, getDateRange } from "../date-engine.js";

export class HorizontalLayout implements LayoutEngine {
  readonly name = "horizontal";

  compute(
    events: TimelineEvent[],
    _eras: TimelineEra[],
    containerWidth: number,
    containerHeight: number,
    options: RenderOptions
  ): LayoutResult {
    const zoom = Math.max(0.5, Math.min(3, options.zoomLevel || 1));
    const cardWidth = 280;
    const estimatedCardHeight = 220;
    const paddingX = 64;
    const height = Math.max(containerHeight || 520, 520);
    const axisY = Math.round(height / 2);

    const range = getDateRange(events);
    const minSpacing = cardWidth + 40;
    const baseWidth = Math.max(containerWidth, events.length * minSpacing + paddingX * 2);
    const totalWidth = Math.round(baseWidth * zoom);

    const positions: LayoutPosition[] = [];

    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      let normPos = (i + 0.5) / events.length;

      if (range && range.earliest !== range.latest) {
        normPos = getDatePosition(evt.date.start, range.earliest, range.latest);
      }

      // Calculate X coordinate
      const availableWidth = totalWidth - paddingX * 2 - cardWidth;
      const x = paddingX + Math.round(normPos * availableWidth);

      // Alternate above and below horizontal axis
      const isAbove = i % 2 === 0;
      const side = isAbove ? "left" : "right"; // Above = left, Below = right
      const y = isAbove ? axisY - estimatedCardHeight - 32 : axisY + 32;

      positions.push({
        eventId: evt.id,
        x,
        y,
        width: cardWidth,
        height: estimatedCardHeight,
        markerX: x + Math.round(cardWidth / 2),
        markerY: axisY,
        side,
      });
    }

    return {
      positions,
      axisStart: { x: paddingX, y: axisY },
      axisEnd: { x: totalWidth - paddingX, y: axisY },
      totalWidth,
      totalHeight: height,
      direction: "horizontal",
    };
  }
}
