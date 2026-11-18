import { compareDates } from '@chronicle/schema';
import { useEditor } from './store/editor-store.js';
import { addEvent, deleteEvent, duplicateEvent } from './store/commands.js';
import { createEvent } from './lib/document.js';
import { newId } from './lib/ids.js';
import { collectIssues, hasErrors } from './lib/validation.js';
import { downloadFile, exportCsv, exportJson, slugify } from './lib/export.js';

/**
 * Adds an event after the selected one (or at the end), dated like its
 * neighbour so it lands near the user's focus in chronological views.
 */
export function addNewEvent(): void {
  const { doc, selectedId, execute } = useEditor.getState();
  const index = selectedId ? doc.events.findIndex((e) => e.id === selectedId) : -1;
  const anchor = index >= 0 ? doc.events[index] : doc.events.at(-1);
  const event = createEvent(anchor ? { date: { start: anchor.date.start } } : {});
  execute(addEvent(event, index >= 0 ? index + 1 : undefined));
}

export function duplicateSelected(): void {
  const { doc, selectedId, execute } = useEditor.getState();
  if (selectedId) execute(duplicateEvent(doc, selectedId, newId()));
}

export function deleteSelected(): void {
  const { doc, selectedId, execute } = useEditor.getState();
  if (!selectedId) return;
  // Select the next event (or previous) so keyboard users keep their place.
  const index = doc.events.findIndex((e) => e.id === selectedId);
  const neighbour = doc.events.at(index + 1) ?? (index > 0 ? doc.events.at(index - 1) : undefined);
  execute(deleteEvent(doc, selectedId));
  if (neighbour) useEditor.getState().select(neighbour.id);
}

/**
 * Exports the document. Returns the blocking issues instead of exporting
 * when the document would not validate — an export must always be loadable.
 */
export function exportDocument(format: 'json' | 'csv'): string[] {
  const { doc } = useEditor.getState();
  const issues = collectIssues(doc);
  if (hasErrors(issues)) {
    return issues.filter((i) => i.severity === 'error').map((i) => i.message);
  }
  const name = slugify(doc.title);
  if (format === 'json') downloadFile(`${name}.json`, exportJson(doc), 'application/json');
  else downloadFile(`${name}.csv`, exportCsv(doc), 'text/csv');
  return [];
}

/** Events in chronological order (stable for equal dates). */
export function chronological<T extends { date: { start: string } }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => compareDates(a.date, b.date));
}
