import type { TimelineEra } from '@chronicle/schema';
import type { LayoutResult } from '../types.js';
import { h } from './dom.js';

/**
 * Renders the decorative axis line, era bands and event markers.
 *
 * All geometry is applied through the CSSOM (`el.style.x = …`), never through
 * `style="…"` attribute strings, so it works under a strict CSP without
 * `'unsafe-inline'`. It also means an invalid era colour is simply rejected by
 * the browser instead of being able to inject extra declarations.
 *
 * The whole layer is `aria-hidden`: dates and order are conveyed by the cards.
 */
export function renderAxis(layout: LayoutResult, eras: TimelineEra[]): HTMLElement {
  const layer = h('div', { class: 'chronicle-axis-container', 'aria-hidden': 'true' });

  if (layout.flow) return layer;

  const { axisStart, axisEnd } = layout;
  const line = h('div', { class: `chronicle-axis chronicle-axis--${layout.direction}` });
  line.style.left = px(axisStart.x);
  line.style.top = px(axisStart.y);
  if (layout.direction === 'vertical') {
    line.style.height = px(axisEnd.y - axisStart.y);
  } else {
    line.style.width = px(axisEnd.x - axisStart.x);
  }
  layer.appendChild(line);

  const erasById = new Map(eras.map((e) => [e.id, e]));
  for (const band of layout.eraBands ?? []) {
    const era = erasById.get(band.eraId);
    if (!era) continue;
    const el = h(
      'div',
      { class: 'chronicle-era-band' },
      h('span', { class: 'chronicle-era-band__label' }, era.title),
    );
    el.style.left = px(band.x);
    el.style.width = px(band.width);
    if (era.color) el.style.backgroundColor = era.color;
    layer.appendChild(el);
  }

  for (const pos of layout.positions) {
    const marker = h('div', { class: 'chronicle-marker', 'data-event-id': pos.eventId });
    marker.style.left = px(pos.markerX);
    marker.style.top = px(pos.markerY);
    layer.appendChild(marker);
  }

  return layer;
}

function px(n: number): string {
  return `${Math.round(n)}px`;
}
