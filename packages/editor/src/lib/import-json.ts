import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import {
  migrateFromTimelineJSWithReport,
  repairTimelineDates,
  validateTimeline,
  type MigrationWarning,
  type Timeline,
} from '@chronicle/schema';

export interface ImportIssue {
  message: string;
  /** 1-based line/column in the source text, when known. */
  line?: number;
  column?: number;
  path?: string;
}

export type JsonImportResult =
  | {
      ok: true;
      kind: 'chronicle' | 'timelinejs';
      timeline: Timeline;
      /** Migration notes (TimelineJS only). */
      warnings: MigrationWarning[];
    }
  | { ok: false; issues: ImportIssue[] };

/** Converts a character offset into a 1-based line/column. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** Finds the closest node for a path, walking up when the leaf does not exist. */
function nodeForPath(root: Node, path: (string | number)[]): Node {
  for (let len = path.length; len >= 0; len--) {
    const node = findNodeAtLocation(root, path.slice(0, len));
    if (node) {
      // Point at the property key rather than the value when possible.
      return node.parent?.type === 'property' ? node.parent : node;
    }
  }
  return root;
}

function isTimelineJS(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const events = (value as { events?: unknown }).events;
  return (
    Array.isArray(events) &&
    events.some((e) => typeof e === 'object' && e !== null && 'start_date' in e)
  );
}

/**
 * Parses and validates a JSON document. Accepts Chronicle documents and
 * TimelineJS v3 payloads (auto-detected and migrated). All problems are
 * reported with line/column positions in the original text.
 */
export function importJson(text: string): JsonImportResult {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });

  if (errors.length > 0 || !root) {
    const issues = errors.length
      ? errors.map((e) => ({
          message: `JSON syntax error: ${printParseErrorCode(e.error)}`,
          ...lineColumn(text, e.offset),
        }))
      : [{ message: 'The file is empty' }];
    return { ok: false, issues };
  }

  const value: unknown = getNodeValue(root);

  if (isTimelineJS(value)) {
    const { timeline, warnings } = migrateFromTimelineJSWithReport(value);
    const result = validateTimeline(timeline);
    if (!result.success) {
      return {
        ok: false,
        issues: result.errors.issues.map((i) => ({
          message: `After TimelineJS conversion: ${i.message}`,
          path: i.path.join('.'),
        })),
      };
    }
    return { ok: true, kind: 'timelinejs', timeline: result.data, warnings };
  }

  // Files exported by older releases can hold date forms the schema now rejects.
  // Paths are unchanged by the migration, so issues still point into the source text.
  const migrated = repairTimelineDates(value);
  const result = validateTimeline(migrated.timeline);
  if (!result.success) {
    return {
      ok: false,
      issues: result.errors.issues.map((issue) => {
        const node = nodeForPath(root, issue.path);
        const where = lineColumn(text, node.offset);
        const missing = !findNodeAtLocation(root, issue.path);
        return {
          message:
            missing && issue.code === 'invalid_type' && issue.received === 'undefined'
              ? `Missing required field “${String(issue.path.at(-1))}”`
              : issue.message,
          path: issue.path.join('.') || '(root)',
          ...where,
        };
      }),
    };
  }
  return { ok: true, kind: 'chronicle', timeline: result.data, warnings: migrated.warnings };
}
