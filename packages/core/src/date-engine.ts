import type { TimelineEvent, TimelineEra } from "@chronicle/schema";
import { compareDates, parseTimelineDate } from "@chronicle/schema";

/**
 * Sorts an array of timeline events chronologically by start date.
 */
export function sortEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => compareDates(a.date, b.date));
}

/**
 * Groups events by their era field. If an event has no era, it's grouped under "" (empty string).
 */
export function groupEventsByEra(
  events: TimelineEvent[],
  eras: TimelineEra[]
): Map<string, TimelineEvent[]> {
  const map = new Map<string, TimelineEvent[]>();
  for (const era of eras) {
    map.set(era.id, []);
  }
  map.set("", []);

  for (const event of events) {
    const eraId = event.era && map.has(event.era) ? event.era : "";
    const list = map.get(eraId) ?? [];
    list.push(event);
    map.set(eraId, list);
  }

  return map;
}

/**
 * Formats a raw timeline date string into a localized human-readable string.
 */
export function formatDate(
  dateStr: string,
  locale: string = "en",
  options?: { partial?: boolean; uncertain?: boolean; approximate?: boolean }
): string {
  const trimmed = dateStr.trim();
  const isBCE = trimmed.startsWith("-");
  const cleanStr = isBCE ? trimmed.slice(1) : trimmed;

  const parts = cleanStr.split("-");
  let formatted = "";

  const bceSuffix = locale === "es" ? " a.C." : locale === "ar" ? " ق.م" : " BCE";

  if (parts.length === 1) {
    // Year only
    const yearNum = parseInt(parts[0], 10);
    formatted = `${yearNum}${isBCE ? bceSuffix : ""}`;
  } else if (parts.length === 2) {
    // Year and Month
    const yearNum = parseInt(parts[0], 10);
    const monthNum = parseInt(parts[1], 10);
    const d = new Date(Date.UTC(2000, monthNum - 1, 1));
    const monthFormatter = new Intl.DateTimeFormat(locale, { month: "long" });
    const monthName = monthFormatter.format(d);
    formatted = `${monthName} ${yearNum}${isBCE ? bceSuffix : ""}`;
  } else {
    // Year, Month, Day or ISO
    const yearNum = parseInt(parts[0], 10);
    const monthNum = parseInt(parts[1], 10);
    const dayNum = parseInt(parts[2].slice(0, 2), 10);

    const d = new Date(Date.UTC(2000, monthNum - 1, dayNum));
    const monthFormatter = new Intl.DateTimeFormat(locale, { month: "short" });
    const monthName = monthFormatter.format(d);

    formatted = `${monthName} ${dayNum}, ${yearNum}${isBCE ? bceSuffix : ""}`;
  }

  if (options?.approximate) {
    formatted = `~${formatted}`;
  }
  if (options?.uncertain) {
    formatted = `${formatted}?`;
  }

  return formatted;
}

/**
 * Finds the earliest and latest dates among a collection of timeline events.
 */
export function getDateRange(
  events: TimelineEvent[]
): { earliest: string; latest: string } | null {
  if (events.length === 0) return null;

  const sorted = sortEvents(events);
  const earliest = sorted[0].date.start;

  let latest = sorted[0].date.end || sorted[0].date.start;
  for (const evt of sorted) {
    const candidate = evt.date.end || evt.date.start;
    if (compareDates({ start: candidate }, { start: latest }) > 0) {
      latest = candidate;
    }
  }

  return { earliest, latest };
}

/**
 * Extracts a uniform numeric coordinate (in days/years) for ratio computation.
 */
function toNumericCoord(dateStr: string): number {
  const norm = parseTimelineDate(dateStr);
  const match = norm.match(/^(-?\d+)-(\d{2})-(\d{2})/);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    return year * 365.25 + (month - 1) * 30.4 + day;
  }
  return 0;
}

/**
 * Calculates the relative [0..1] position of a date between earliest and latest dates.
 */
export function getDatePosition(
  dateStr: string,
  earliest: string,
  latest: string
): number {
  const minCoord = toNumericCoord(earliest);
  const maxCoord = toNumericCoord(latest);

  if (maxCoord <= minCoord) {
    return 0.5;
  }

  const currentCoord = toNumericCoord(dateStr);
  const clamped = Math.max(minCoord, Math.min(maxCoord, currentCoord));
  return (clamped - minCoord) / (maxCoord - minCoord);
}

/**
 * Groups events by time granularity (year, decade, or century).
 */
export function groupEventsByDate(
  events: TimelineEvent[],
  granularity: "year" | "decade" | "century"
): Map<string, TimelineEvent[]> {
  const groups = new Map<string, TimelineEvent[]>();

  for (const evt of events) {
    const norm = parseTimelineDate(evt.date.start);
    const match = norm.match(/^(-?\d+)/);
    const year = match ? parseInt(match[1], 10) : 2000;

    let key = "";
    if (granularity === "year") {
      key = `${year}`;
    } else if (granularity === "decade") {
      const decadeStart = Math.floor(year / 10) * 10;
      key = `${decadeStart}s`;
    } else {
      const century = Math.floor(year / 100) * 100;
      key = `${century}s`;
    }

    const list = groups.get(key) ?? [];
    list.push(evt);
    groups.set(key, list);
  }

  return groups;
}
