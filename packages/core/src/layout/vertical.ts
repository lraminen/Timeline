import type { TimelineEvent, TimelineEra } from "@chronicle/schema";
import type { LayoutEngine, LayoutPosition, LayoutResult, RenderOptions } from "../types.js";

export class VerticalLayout implements LayoutEngine {
  readonly name = "vertical";

  compute(
    events: TimelineEvent[],
    _eras: TimelineEra[],
    containerWidth: number,
    _containerHeight: number,
    _options: RenderOptions
  ): LayoutResult {
    const isMobile = containerWidth < 640;
    const paddingY = 48;
    const cardGap = 32;
    const estimatedCardHeight = 180;

    const axisX = isMobile ? 32 : Math.round(containerWidth / 2);
    const cardWidth = isMobile
      ? Math.max(220, containerWidth - axisX - 32)
      : Math.min(460, Math.round(containerWidth * 0.42));

    const positions: LayoutPosition[] = [];
    let currentY = paddingY;

    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      let side: "left" | "right" | "center" = "right";
      let x = 0;

      if (isMobile) {
        side = "right";
        x = axisX + 24;
      } else {
        side = i % 2 === 0 ? "left" : "right";
        x = side === "left" ? axisX - cardWidth - 24 : axisX + 24;
      }

      positions.push({
        eventId: evt.id,
        x,
        y: currentY,
        width: cardWidth,
        height: estimatedCardHeight,
        markerX: axisX,
        markerY: currentY + 24, // Vertically align marker with card header
        side,
      });

      currentY += estimatedCardHeight + cardGap;
    }

    const totalHeight = Math.max(300, currentY + paddingY);

    return {
      positions,
      axisStart: { x: axisX, y: paddingY },
      axisEnd: { x: axisX, y: totalHeight - paddingY },
      totalWidth: containerWidth,
      totalHeight,
      direction: "vertical",
    };
  }
}
