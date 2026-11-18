import type { TimelineEvent, TimelineEra } from "@chronicle/schema";
import type { LayoutEngine, LayoutPosition, LayoutResult, RenderOptions } from "../types.js";

export class CardLayout implements LayoutEngine {
  readonly name = "card";

  compute(
    events: TimelineEvent[],
    _eras: TimelineEra[],
    containerWidth: number,
    _containerHeight: number,
    _options: RenderOptions
  ): LayoutResult {
    const cardMaxWidth = 680;
    const cardWidth = Math.min(containerWidth - 32, cardMaxWidth);
    const cardX = Math.max(16, Math.round((containerWidth - cardWidth) / 2));
    const paddingY = 24;
    const cardGap = 24;
    const estimatedCardHeight = 200;

    const positions: LayoutPosition[] = [];
    let currentY = paddingY;

    for (let i = 0; i < events.length; i++) {
      const evt = events[i];

      positions.push({
        eventId: evt.id,
        x: cardX,
        y: currentY,
        width: cardWidth,
        height: estimatedCardHeight,
        markerX: cardX,
        markerY: currentY,
        side: "center",
      });

      currentY += estimatedCardHeight + cardGap;
    }

    const totalHeight = Math.max(200, currentY + paddingY);

    return {
      positions,
      axisStart: { x: 0, y: 0 },
      axisEnd: { x: 0, y: 0 },
      totalWidth: containerWidth,
      totalHeight,
      direction: "vertical",
    };
  }
}
