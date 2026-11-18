import type { I18nContext } from '../types.js';
import type { FilterOptions } from '../search.js';
import { h } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SEARCH_DEBOUNCE_MS = 120;

export interface ControlsHandle {
  element: HTMLElement;
  /** Reflects the active tag filter on the buttons without rebuilding them. */
  syncFilters(filters: FilterOptions): void;
  destroy(): void;
}

/**
 * Builds the search / tag filter / zoom toolbar. The returned element is
 * meant to persist across result updates so focus (e.g. in the search box)
 * is never lost while the user interacts with it.
 */
export function renderControls(options: {
  tags: string[];
  currentFilters: FilterOptions;
  i18n: I18nContext;
  showZoom?: boolean;
  onSearch: (query: string) => void;
  onFilterTag: (tag: string | null) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}): ControlsHandle {
  const { tags, currentFilters, i18n, showZoom, onSearch, onFilterTag, onZoomIn, onZoomOut } =
    options;

  const bar = h('div', {
    class: 'chronicle-controls',
    role: 'search',
    'aria-label': i18n.strings.aria.navigation,
  });

  // Search
  const searchWrapper = h('div', { class: 'chronicle-search' });
  const searchInput = h('input', {
    type: 'search',
    class: 'chronicle-search__input',
    placeholder: i18n.strings.search.placeholder,
    'aria-label': i18n.strings.search.placeholder,
  }) as HTMLInputElement;
  searchInput.value = currentFilters.searchQuery ?? '';

  let debounce: ReturnType<typeof setTimeout> | undefined;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      onSearch(searchInput.value);
    }, SEARCH_DEBOUNCE_MS);
  });

  searchWrapper.appendChild(searchIcon());
  searchWrapper.appendChild(searchInput);
  bar.appendChild(searchWrapper);

  // Tag filters
  const filterButtons: HTMLButtonElement[] = [];
  if (tags.length > 0) {
    const group = h('div', {
      class: 'chronicle-filters',
      role: 'group',
      'aria-label': i18n.strings.controls.filterByTag,
    });

    const addButton = (label: string, tag: string | null): void => {
      const btn = h(
        'button',
        { type: 'button', class: 'chronicle-filter-btn', 'data-tag': tag ?? '' },
        label,
      ) as HTMLButtonElement;
      btn.addEventListener('click', () => {
        onFilterTag(tag);
      });
      filterButtons.push(btn);
      group.appendChild(btn);
    };

    addButton(i18n.strings.controls.allTags, null);
    for (const tag of tags) addButton(`#${tag}`, tag);
    bar.appendChild(group);
  }

  // Zoom (horizontal layout)
  if (showZoom) {
    const zoom = h('div', { class: 'chronicle-zoom' });
    const zoomBtn = (label: string, text: string, handler: () => void): HTMLElement => {
      const btn = h(
        'button',
        { type: 'button', class: 'chronicle-zoom-btn', title: label, 'aria-label': label },
        text,
      );
      btn.addEventListener('click', handler);
      return btn;
    };
    zoom.appendChild(zoomBtn(i18n.strings.controls.zoomIn, '+', onZoomIn));
    zoom.appendChild(zoomBtn(i18n.strings.controls.zoomOut, '−', onZoomOut));
    bar.appendChild(zoom);
  }

  const syncFilters = (filters: FilterOptions): void => {
    const active = new Set(filters.tags ?? []);
    for (const btn of filterButtons) {
      const tag = btn.dataset.tag ?? '';
      const pressed = tag === '' ? active.size === 0 : active.has(tag);
      btn.classList.toggle('chronicle-filter-btn--active', pressed);
      btn.setAttribute('aria-pressed', String(pressed));
    }
  };
  syncFilters(currentFilters);

  return {
    element: bar,
    syncFilters,
    destroy: () => {
      clearTimeout(debounce);
    },
  };
}

function searchIcon(): Element {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'chronicle-search__icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    'M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z',
  );
  svg.appendChild(path);
  return svg;
}
