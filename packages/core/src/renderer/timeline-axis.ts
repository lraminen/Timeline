import type { TimelineEvent, TimelineEra } from "@chronicle/schema";
import type { LayoutResult, I18nContext } from "../types.js";
import { getDatePosition, getDateRange } from "../date-engine.js";
import { h } from "./dom.js";

export function renderAxis(
  layoutResult: LayoutResult,
  events: TimelineEvent[],
  eras: TimelineEra[],
  _i18n: I18nContext
): HTMLElement {
  const axisContainer = h("div", { class: "chronicle-axis-container" });

  if (layoutResult.direction === "vertical" && layoutResult.axisStart.x > 0) {
    // Vertical axis line
    const axisLine = h("div", {
      class: "chronicle-axis chronicle-axis--vertical",
      style: `left: ${layoutResult.axisStart.x}px; top: ${layoutResult.axisStart.y}px; height: ${
        layoutResult.axisEnd.y - layoutResult.axisStart.y
      }px;`,
    });
    axisContainer.appendChild(axisLine);
  } else if (layoutResult.direction === "horizontal") {
    // Horizontal axis line
    const axisLine = h("div", {
      class: "chronicle-axis chronicle-axis--horizontal",
      style: `top: ${layoutResult.axisStart.y}px; left: ${layoutResult.axisStart.x}px; width: ${
        layoutResult.axisEnd.x - layoutResult.axisStart.x
      }px;`,
    });
    axisContainer.appendChild(axisLine);
  }

  // Era bands (if any and horizontal)
  if (layoutResult.direction === "horizontal" && eras.length > 0) {
    const range = getDateRange(events);
    if (range) {
      for (const era of eras) {
        const startPos = getDatePosition(era.start, range.earliest, range.latest);
        const endPos = getDatePosition(era.end, range.earliest, range.latest);

        const trackWidth = layoutResult.totalWidth - 128;
        const left = 64 + Math.round(startPos * trackWidth);
        const width = Math.max(40, Math.round((endPos - startPos) * trackWidth));

        const band = h(
          "div",
          {
            class: "chronicle-era-band",
            style: `left: ${left}px; width: ${width}px; top: 16px; bottom: 16px; ${
              era.color ? `background-color: ${era.color};` : ""
            }`,
          },
          h("span", { class: "chronicle-era-band__label" }, era.title)
        );

        axisContainer.appendChild(band);
      }
    }
  }

  // Markers
  for (const pos of layoutResult.positions) {
    if (pos.side === "center") continue; // No separate markers for centered stacked cards

    const marker = h("div", {
      class: "chronicle-marker",
      "data-event-id": pos.eventId,
      style: `left: ${pos.markerX}px; top: ${pos.markerY}px;`,
    });
    axisContainer.appendChild(marker);
  }

  return axisContainer;
}
