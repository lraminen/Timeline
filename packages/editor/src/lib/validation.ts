import { compareDates, validateTimeline, type Timeline } from '@chronicle/schema';
import { dateProblem } from './dates.js';

export interface Issue {
  severity: 'error' | 'warning';
  message: string;
  /** Event the issue belongs to, so the UI can jump to it. */
  eventId?: string;
  /** Field within the event, for inline display. */
  field?: 'title' | 'date.start' | 'date.end' | 'media' | 'era' | 'location';
}

/**
 * Validates a document for the editor: schema validation plus checks the
 * schema cannot express (well-formed partial dates, ranges, alt text).
 *
 * Errors block export/preview updates; warnings are advisory.
 */
export function collectIssues(doc: Timeline): Issue[] {
  const issues: Issue[] = [];
  const eraIds = new Set(doc.eras.map((e) => e.id));

  if (!doc.title.trim()) issues.push({ severity: 'warning', message: 'Timeline has no title' });

  for (const evt of doc.events) {
    const name = evt.title.trim() || 'Untitled event';
    if (!evt.title.trim()) {
      issues.push({
        severity: 'error',
        message: 'Event title is required',
        eventId: evt.id,
        field: 'title',
      });
    }
    const startProblem = dateProblem(evt.date.start);
    if (startProblem) {
      issues.push({
        severity: 'error',
        message: `${name}: start date — ${startProblem}`,
        eventId: evt.id,
        field: 'date.start',
      });
    }
    if (evt.date.end !== undefined) {
      const endProblem = dateProblem(evt.date.end);
      if (endProblem) {
        issues.push({
          severity: 'error',
          message: `${name}: end date — ${endProblem}`,
          eventId: evt.id,
          field: 'date.end',
        });
      } else if (!startProblem && compareDates({ start: evt.date.end }, evt.date) < 0) {
        issues.push({
          severity: 'error',
          message: `${name}: end date is before the start date`,
          eventId: evt.id,
          field: 'date.end',
        });
      }
    }
    evt.media.forEach((m, i) => {
      if (m.type === 'image' && !m.alt?.trim()) {
        issues.push({
          severity: 'warning',
          message: `${name}: image ${String(i + 1)} has no alt text`,
          eventId: evt.id,
          field: 'media',
        });
      }
    });
    if (evt.era && !eraIds.has(evt.era)) {
      issues.push({
        severity: 'warning',
        message: `${name}: refers to a deleted era`,
        eventId: evt.id,
        field: 'era',
      });
    }
  }

  for (const era of doc.eras) {
    for (const [label, value] of [
      ['start', era.start],
      ['end', era.end],
    ] as const) {
      const problem = dateProblem(value);
      if (problem)
        issues.push({
          severity: 'error',
          message: `Era “${era.title}”: ${label} date — ${problem}`,
        });
    }
  }

  // Anything else the schema rejects (unsafe URLs, bad colours, …).
  const result = validateTimeline(doc);
  if (!result.success) {
    for (const issue of result.errors.issues) {
      const [root, index, field] = issue.path;
      // Empty titles are already reported above with a friendlier message.
      if (root === 'events' && field === 'title') continue;
      const eventId =
        root === 'events' && typeof index === 'number' ? doc.events[index]?.id : undefined;
      issues.push({
        severity: 'error',
        message: `${issue.path.join('.')}: ${issue.message}`,
        eventId,
      });
    }
  }

  return issues;
}

export const hasErrors = (issues: Issue[]): boolean => issues.some((i) => i.severity === 'error');
