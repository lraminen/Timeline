import type { Timeline } from '@chronicle/schema';
import { h } from './dom.js';

/**
 * Roving keyboard navigation across event cards (Arrow keys, Home, End,
 * Enter/Space). The listener is attached to the card list, and only reacts
 * when a card itself has focus — so typing in the search box or operating
 * toolbar buttons is never intercepted.
 */
export function setupKeyboardNavigation(
  list: HTMLElement,
  getCards: () => HTMLElement[],
  onSelect: (card: HTMLElement) => void,
): () => void {
  function handleKeyDown(e: KeyboardEvent): void {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (!target?.classList.contains('chronicle-event')) return;

    const cards = getCards();
    if (cards.length === 0) return;
    const current = cards.indexOf(target);

    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = current < cards.length - 1 ? current + 1 : 0;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = current > 0 ? current - 1 : cards.length - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = cards.length - 1;
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onSelect(target);
        return;
      default:
        return;
    }

    e.preventDefault();
    cards[next].focus();
    onSelect(cards[next]);
  }

  list.addEventListener('keydown', handleKeyDown);
  return () => {
    list.removeEventListener('keydown', handleKeyDown);
  };
}

/**
 * Creates an aria-live region to announce state changes to screen reader users.
 */
export function createLiveRegion(): HTMLElement {
  return h('div', {
    class: 'chronicle-sr-only',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });
}

/**
 * Announces a message to screen readers via a live region.
 */
export function announceToScreenReader(liveRegion: HTMLElement, message: string): void {
  liveRegion.textContent = '';
  setTimeout(() => {
    liveRegion.textContent = message;
  }, 50);
}

/**
 * Creates a skip control that moves focus to the timeline content.
 *
 * Fragment links (`href="#id"`) cannot target elements inside a shadow root,
 * so this is a button that moves focus programmatically.
 */
export function createSkipLink(label: string, focusTarget: () => HTMLElement | null): HTMLElement {
  const btn = h('button', { type: 'button', class: 'chronicle-skip-link' }, label);
  btn.addEventListener('click', () => {
    focusTarget()?.focus();
  });
  return btn;
}

/**
 * Sets ARIA landmark metadata on the timeline container.
 */
export function setAriaAttributes(container: HTMLElement, timeline: Timeline): void {
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', timeline.title || 'Timeline');
}
