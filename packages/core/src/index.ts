// Types
export type {
  LayoutPosition,
  LayoutResult,
  RenderOptions,
  LayoutEngine,
  ThemeTokens,
  I18nStrings,
  I18nContext,
} from './types.js';

// Date engine
export {
  sortEvents,
  groupEventsByEra,
  formatDate,
  getDateRange,
  getDatePosition,
  groupEventsByDate,
} from './date-engine.js';

// Search & filter
export {
  searchEvents,
  filterEvents,
  getUniqueTags,
  getUniqueEras,
  type FilterOptions,
} from './search.js';

// Media
export {
  resolveMediaType,
  getOEmbedUrl,
  isExternalUrl,
  getMediaAspectRatio,
  isSafeMediaUrl,
  EMBED_SANDBOX,
  type MediaDisplayType,
} from './media.js';

// Theme
export {
  getTheme,
  getAllThemes,
  registerTheme,
  applyTheme,
  removeTheme,
  themeToCSSProperties,
  lightTheme,
  darkTheme,
  minimalTheme,
  editorialTheme,
} from './theme/index.js';

// i18n
export { createI18n, registerLocale, getAvailableLocales, en, es, ar } from './i18n/index.js';

// Layout
export {
  getLayout,
  registerLayout,
  VerticalLayout,
  HorizontalLayout,
  CardLayout,
} from './layout/index.js';

// Renderer
export { TimelineRenderer } from './renderer/index.js';
export { BASE_STYLES } from './renderer/styles.js';
export { h, setAttributes, clearChildren, createStyleSheet } from './renderer/dom.js';
