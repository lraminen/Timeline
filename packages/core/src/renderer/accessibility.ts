import type { Timeline } from "@chronicle/schema";
import { h } from "./dom.js";

/**
 * Attaches keyboard navigation (Arrow keys, Home, End, Enter) across event cards.
 */
export function setupKeyboardNavigation(
  container: HTMLElement,
  getCards: () => HTMLElement[],
  onSelect: (card: HTMLElement) => void
): () => void {
  function handleKeyDown(e: KeyboardEvent) {
    const cards = getCards();
    if (cards.length === 0) return;

    const activeEl = container.querySelector(".chronicle-event:focus") as HTMLElement | null;
    let currentIndex = activeEl ? cards.indexOf(activeEl) : -1;

    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight": {
        e.preventDefault();
        const nextIndex = currentIndex < cards.length - 1 ? currentIndex + 1 : 0;
        cards[nextIndex].focus();
        onSelect(cards[nextIndex]);
        break;
      }
      case "ArrowUp":
      case "ArrowLeft": {
        e.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : cards.length - 1;
        cards[prevIndex].focus();
        onSelect(cards[prevIndex]);
        break;
      }
      case "Home": {
        e.preventDefault();
        cards[0].focus();
        onSelect(cards[0]);
        break;
      }
      case "End": {
        e.preventDefault();
        cards[cards.length - 1].focus();
        onSelect(cards[cards.length - 1]);
        break;
      }
      case "Enter":
      case " ": {
        if (activeEl) {
          e.preventDefault();
          onSelect(activeEl);
        }
        break;
      }
    }
  }

  container.addEventListener("keydown", handleKeyDown);
  return () => container.removeEventListener("keydown", handleKeyDown);
}

/**
 * Creates an aria-live region to announce state changes to screen reader users.
 */
export function createLiveRegion(): HTMLElement {
  return h("div", {
    class: "chronicle-sr-only",
    "aria-live": "polite",
    "aria-atomic": "true",
  });
}

/**
 * Announces a message to screen readers via a live region.
 */
export function announceToScreenReader(liveRegion: HTMLElement, message: string): void {
  liveRegion.textContent = "";
  setTimeout(() => {
    liveRegion.textContent = message;
  }, 50);
}

/**
 * Creates an accessible skip link for keyboard/screen reader users.
 */
export function createSkipLink(targetId: string, label: string): HTMLElement {
  return h(
    "a",
    {
      href: `#${targetId}`,
      class: "chronicle-skip-link",
    },
    label
  );
}

/**
 * Sets comprehensive ARIA landmarks and metadata on the timeline container.
 */
export function setAriaAttributes(container: HTMLElement, timeline: Timeline): void {
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", timeline.title || "Timeline");
}
