import type { LayoutEngine } from "../types.js";
import { VerticalLayout } from "./vertical.js";
import { HorizontalLayout } from "./horizontal.js";
import { CardLayout } from "./card.js";

const layouts = new Map<string, LayoutEngine>();

const defaultVertical = new VerticalLayout();
const defaultHorizontal = new HorizontalLayout();
const defaultCard = new CardLayout();

layouts.set("vertical", defaultVertical);
layouts.set("horizontal", defaultHorizontal);
layouts.set("card", defaultCard);

/**
 * Retrieves a layout engine by name, defaulting to VerticalLayout.
 */
export function getLayout(name: string): LayoutEngine {
  return layouts.get(name.toLowerCase()) || defaultVertical;
}

/**
 * Registers a custom layout engine.
 */
export function registerLayout(layout: LayoutEngine): void {
  layouts.set(layout.name.toLowerCase(), layout);
}

export { VerticalLayout, HorizontalLayout, CardLayout };
