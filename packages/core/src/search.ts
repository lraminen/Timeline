import type { TimelineEvent } from "@chronicle/schema";
import { compareDates } from "@chronicle/schema";

export interface FilterOptions {
  tags?: string[];
  era?: string;
  dateRange?: { start: string; end: string };
  searchQuery?: string;
}

/**
 * Searches events for a query string across title, body, and tags.
 */
export function searchEvents(
  events: TimelineEvent[],
  query: string
): TimelineEvent[] {
  const clean = query.trim().toLowerCase();
  if (!clean) return events;

  return events.filter((evt) => {
    const titleMatch = evt.title.toLowerCase().includes(clean);
    const bodyMatch = evt.body ? evt.body.toLowerCase().includes(clean) : false;
    const tagMatch = evt.tags.some((t) => t.toLowerCase().includes(clean));
    return titleMatch || bodyMatch || tagMatch;
  });
}

/**
 * Applies multi-criteria filters to timeline events (AND logic).
 */
export function filterEvents(
  events: TimelineEvent[],
  filters: FilterOptions
): TimelineEvent[] {
  let result = events;

  // Search query filter
  if (filters.searchQuery) {
    result = searchEvents(result, filters.searchQuery);
  }

  // Tag filter (event must contain at least one of the selected tags)
  if (filters.tags && filters.tags.length > 0) {
    const tagSet = new Set(filters.tags.map((t) => t.toLowerCase()));
    result = result.filter((evt) =>
      evt.tags.some((t) => tagSet.has(t.toLowerCase()))
    );
  }

  // Era filter
  if (filters.era) {
    result = result.filter((evt) => evt.era === filters.era);
  }

  // Date range filter
  if (filters.dateRange) {
    const { start, end } = filters.dateRange;
    result = result.filter((evt) => {
      const evtStart = evt.date.start;
      const evtEnd = evt.date.end || evt.date.start;

      // Event must overlap with or fall within [start, end]
      const afterStart = compareDates({ start: evtEnd }, { start }) >= 0;
      const beforeEnd = compareDates({ start: evtStart }, { start: end }) <= 0;
      return afterStart && beforeEnd;
    });
  }

  return result;
}

/**
 * Collects all unique, sorted tags from a set of timeline events.
 */
export function getUniqueTags(events: TimelineEvent[]): string[] {
  const set = new Set<string>();
  for (const evt of events) {
    for (const tag of evt.tags) {
      if (tag.trim()) {
        set.add(tag.trim());
      }
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Collects all unique era IDs referenced by events.
 */
export function getUniqueEras(events: TimelineEvent[]): string[] {
  const set = new Set<string>();
  for (const evt of events) {
    if (evt.era && evt.era.trim()) {
      set.add(evt.era.trim());
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
