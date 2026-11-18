import type { I18nContext } from "../types.js";
import type { FilterOptions } from "../search.js";
import { h } from "./dom.js";

export function renderControls(options: {
  tags: string[];
  currentFilters: FilterOptions;
  i18n: I18nContext;
  showZoom?: boolean;
  onSearch: (query: string) => void;
  onFilterTag: (tag: string | null) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}): HTMLElement {
  const { tags, currentFilters, i18n, showZoom, onSearch, onFilterTag, onZoomIn, onZoomOut } =
    options;

  const bar = h("header", {
    class: "chronicle-controls",
    role: "toolbar",
    "aria-label": i18n.strings.aria.navigation,
  });

  // Search input
  const searchWrapper = h("div", { class: "chronicle-search" });
  const searchInput = h("input", {
    type: "search",
    class: "chronicle-search__input",
    placeholder: i18n.strings.search.placeholder,
    value: currentFilters.searchQuery || "",
    "aria-label": i18n.strings.search.placeholder,
  }) as HTMLInputElement;

  searchInput.addEventListener("input", (e) => {
    const val = (e.target as HTMLInputElement).value;
    onSearch(val);
  });

  // Search SVG icon
  const icon = h("span", { class: "chronicle-search__icon" }, "🔍");
  searchWrapper.appendChild(icon);
  searchWrapper.appendChild(searchInput);
  bar.appendChild(searchWrapper);

  // Filter tags
  if (tags.length > 0) {
    const filterContainer = h("div", { class: "chronicle-filters" });

    // "All" button
    const allBtn = h(
      "button",
      {
        type: "button",
        class: `chronicle-filter-btn${
          !currentFilters.tags || currentFilters.tags.length === 0
            ? " chronicle-filter-btn--active"
            : ""
        }`,
      },
      i18n.strings.controls.allTags
    );
    allBtn.addEventListener("click", () => onFilterTag(null));
    filterContainer.appendChild(allBtn);

    // Individual tag buttons
    for (const tag of tags) {
      const isSelected = currentFilters.tags?.includes(tag);
      const tagBtn = h(
        "button",
        {
          type: "button",
          class: `chronicle-filter-btn${isSelected ? " chronicle-filter-btn--active" : ""}`,
        },
        `#${tag}`
      );
      tagBtn.addEventListener("click", () => onFilterTag(tag));
      filterContainer.appendChild(tagBtn);
    }

    bar.appendChild(filterContainer);
  }

  // Zoom buttons (for horizontal layout)
  if (showZoom) {
    const zoomContainer = h("div", { class: "chronicle-zoom" });

    const zoomInBtn = h(
      "button",
      {
        type: "button",
        class: "chronicle-zoom-btn",
        title: i18n.strings.controls.zoomIn,
        "aria-label": i18n.strings.controls.zoomIn,
      },
      "+"
    );
    zoomInBtn.addEventListener("click", onZoomIn);

    const zoomOutBtn = h(
      "button",
      {
        type: "button",
        class: "chronicle-zoom-btn",
        title: i18n.strings.controls.zoomOut,
        "aria-label": i18n.strings.controls.zoomOut,
      },
      "-"
    );
    zoomOutBtn.addEventListener("click", onZoomOut);

    zoomContainer.appendChild(zoomInBtn);
    zoomContainer.appendChild(zoomOutBtn);
    bar.appendChild(zoomContainer);
  }

  return bar;
}
