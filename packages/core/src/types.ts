import type { Timeline, TimelineEvent, TimelineEra } from "@chronicle/schema";

/** Position data for a single event as computed by a layout engine. */
export interface LayoutPosition {
  eventId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  markerX: number;
  markerY: number;
  side: "left" | "right" | "center";
}

/** Full result from a layout computation. */
export interface LayoutResult {
  positions: LayoutPosition[];
  axisStart: { x: number; y: number };
  axisEnd: { x: number; y: number };
  totalWidth: number;
  totalHeight: number;
  direction: "vertical" | "horizontal";
}

/** Options controlling how the timeline renders. */
export interface RenderOptions {
  layout: "horizontal" | "vertical" | "card";
  theme: string;
  locale: string;
  startDate?: string;
  zoomLevel?: number;
  filterTags?: string[];
  searchQuery?: string;
  height?: string;
  width?: string;
  reducedMotion?: boolean;
}

/** A layout engine takes sorted/filtered events and computes positions. */
export interface LayoutEngine {
  readonly name: string;
  compute(
    events: TimelineEvent[],
    eras: TimelineEra[],
    containerWidth: number,
    containerHeight: number,
    options: RenderOptions
  ): LayoutResult;
}

/** Design tokens for a Chronicle theme. */
export interface ThemeTokens {
  name: string;
  colors: {
    primary: string;
    primaryLight: string;
    secondary: string;
    background: string;
    surface: string;
    surfaceAlt: string;
    text: string;
    textSecondary: string;
    textInverse: string;
    border: string;
    accent: string;
    error: string;
    axisLine: string;
    marker: string;
    markerActive: string;
    eraBackground: string;
  };
  typography: {
    fontFamily: string;
    fontFamilyMono: string;
    fontSizeBase: string;
    fontSizeSm: string;
    fontSizeLg: string;
    fontSizeXl: string;
    fontSizeTitle: string;
    lineHeight: string;
    fontWeightNormal: string;
    fontWeightMedium: string;
    fontWeightBold: string;
  };
  spacing: {
    xs: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
    xxl: string;
  };
  borderRadius: {
    sm: string;
    md: string;
    lg: string;
    full: string;
  };
  shadows: {
    sm: string;
    md: string;
    lg: string;
  };
  transitions: {
    fast: string;
    normal: string;
    slow: string;
  };
  media: {
    maxMediaHeight: string;
    thumbnailSize: string;
  };
}

/** Locale strings and config for i18n. */
export interface I18nStrings {
  locale: string;
  dir: "ltr" | "rtl";
  search: { placeholder: string; noResults: string; resultsCount: string };
  controls: { zoomIn: string; zoomOut: string; filterByTag: string; clearFilters: string; allTags: string };
  event: { readMore: string; collapse: string; media: string; location: string };
  timeline: { loading: string; empty: string; error: string };
  aria: {
    timelineLabel: string;
    eventList: string;
    eventItem: string;
    navigation: string;
    skipToContent: string;
    expandEvent: string;
    collapseEvent: string;
  };
  dates: {
    bce: string;
    ce: string;
    circa: string;
    uncertain: string;
    present: string;
    to: string;
  };
}

/** Active i18n context with formatting helpers. */
export interface I18nContext {
  strings: I18nStrings;
  formatDate(
    dateStr: string,
    options?: { partial?: boolean; uncertain?: boolean; approximate?: boolean }
  ): string;
  formatDateRange(
    start: string,
    end?: string,
    options?: { uncertain?: boolean; approximate?: boolean }
  ): string;
  isRTL(): boolean;
}
