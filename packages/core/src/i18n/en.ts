import type { I18nStrings } from '../types.js';

export const en: I18nStrings = {
  locale: 'en',
  dir: 'ltr',
  search: {
    placeholder: 'Search events, tags, and descriptions...',
    noResults: 'No events match your criteria',
    resultsCount: '{count} events found',
  },
  controls: {
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    filterByTag: 'Filter by tag',
    clearFilters: 'Clear filters',
    allTags: 'All tags',
  },
  event: {
    readMore: 'Read more',
    collapse: 'Collapse',
    media: 'Attached media',
    location: 'Location',
  },
  timeline: {
    loading: 'Loading timeline...',
    empty: 'No events to display in this timeline',
    error: 'Failed to load timeline data',
  },
  aria: {
    timelineLabel: 'Interactive timeline',
    eventList: 'Timeline events sequence',
    eventItem: 'Timeline event: {title}',
    navigation: 'Timeline navigation controls',
    skipToContent: 'Skip to timeline events',
    expandEvent: 'Expand event details for {title}',
    collapseEvent: 'Collapse event details for {title}',
  },
  dates: {
    bce: 'BCE',
    ce: 'CE',
    circa: 'c.',
    uncertain: '?',
    present: 'Present',
    to: 'to',
  },
};
