import Papa from 'papaparse';
import type { Timeline } from '@chronicle/schema';

/** Pretty-printed, schema-shaped JSON. */
export function exportJson(doc: Timeline): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Column headers chosen so that `guessMapping` maps them back on re-import. */
export const CSV_EXPORT_HEADERS = [
  'id',
  'title',
  'start_date',
  'end_date',
  'display_date',
  'approximate',
  'uncertain',
  'description',
  'tags',
  'era',
  'media_type',
  'media_url',
  'media_alt',
  'media_caption',
  'media_credit',
  'latitude',
  'longitude',
  'location',
] as const;

/**
 * Flattens events to CSV, one row per event. Only the first media item is
 * included (CSV has no natural way to express lists of objects); eras are
 * written by title so the file is readable and re-importable.
 */
export function exportCsv(doc: Timeline): string {
  const eraTitle = new Map(doc.eras.map((e) => [e.id, e.title]));
  const rows = doc.events.map((e) => {
    const media = e.media.at(0);
    return [
      e.id,
      e.title,
      e.date.start,
      e.date.end ?? '',
      e.date.displayOverride ?? '',
      e.date.approximate ? 'yes' : '',
      e.date.uncertain ? 'yes' : '',
      e.body ?? '',
      e.tags.join('; '),
      e.era ? (eraTitle.get(e.era) ?? '') : '',
      media?.type ?? '',
      media?.url ?? '',
      media?.alt ?? '',
      media?.caption ?? '',
      media?.credit ?? '',
      e.location?.lat ?? '',
      e.location?.lng ?? '',
      e.location?.label ?? '',
    ];
  });
  // Prefix formula-like cells so spreadsheet apps don't execute them.
  const safe = rows.map((r) =>
    r.map((cell) => {
      const s = String(cell);
      return /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    }),
  );
  return Papa.unparse({ fields: [...CSV_EXPORT_HEADERS], data: safe }, { newline: '\n' });
}

export function slugify(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'timeline'
  );
}

/** Triggers a browser download of `content`. */
export function downloadFile(filename: string, content: string | Uint8Array, mime: string): void {
  const blob =
    typeof content === 'string'
      ? new Blob([content], { type: `${mime};charset=utf-8` })
      : new Blob([new Uint8Array(content)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
