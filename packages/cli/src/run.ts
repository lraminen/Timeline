import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  migrateFromTimelineJSWithReport,
  repairTimelineDates,
  validateTimeline,
} from '@chronicle/schema';
import {
  buildStaticSite,
  siteFolderName,
  StaticExportError,
  zipStaticSite,
  type FetchedMedia,
  type MediaFetcher,
} from '@chronicle/static';

export const VERSION = '0.1.0';

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}

class UsageError extends Error {}
class CommandError extends Error {}

const HELP = `Chronicle CLI ${VERSION}

Usage:
  chronicle validate <timeline.json>
      Check a timeline against the Chronicle schema.

  chronicle export <source> [options]
      Make a self-contained static site (works offline, from any folder or host).
      <source> is a timeline JSON file, or the address of a published timeline
      (https://…/timeline/<slug>, …/timeline/<slug>/v/<n>, or an embed API URL).

      -o, --out <path>     Folder to write, or a path ending in .zip
                           (default: ./<timeline-title>)
          --zip            Write <out>.zip instead of a folder
          --no-media       Keep media at its original URLs instead of copying it
          --force          Write into a folder that is not empty
          --server <url>   Export a project from a Chronicle server instead of <source>
          --project <id>   …the project's draft (or, with --version, a published version)
          --version <n>    …published version n
          --api-key <key>  API key (default: $CHRONICLE_API_KEY)

  chronicle migrate <timelinejs.json> [-o <out.json>]
      Convert a TimelineJS file to Chronicle format (prints to stdout without -o).

  chronicle --help | --version
`;

// ---------------------------------------------------------------------------
// Loading timelines
// ---------------------------------------------------------------------------

interface Loaded {
  data: unknown;
  /** Base for resolving relative media URLs: a URL or a directory. */
  base: { kind: 'url'; url: string } | { kind: 'dir'; dir: string };
  source: string;
  version?: number;
}

const isTimelineJS = (data: unknown) =>
  typeof data === 'object' &&
  data !== null &&
  Array.isArray((data as { events?: unknown }).events) &&
  (data as { events: unknown[] }).events.some(
    (e) => typeof e === 'object' && e !== null && 'start_date' in e,
  );

function readJsonFile(io: Io, file: string): unknown {
  const full = path.resolve(io.cwd, file);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    throw new CommandError(`Can't read ${file}`);
  }
  try {
    // Skip a byte-order mark (some Windows editors add one).
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch (err) {
    throw new CommandError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

async function getJson(io: Io, url: string, headers: Record<string, string> = {}) {
  let res: Response;
  try {
    res = await io.fetch(url, { headers: { accept: 'application/json', ...headers } });
  } catch (err) {
    throw new CommandError(`Can't reach ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new CommandError(
      `${url} answered HTTP ${String(res.status)}${body.error?.message ? `: ${body.error.message}` : ''}`,
    );
  }
  return (await res.json()) as unknown;
}

/** Turns a public page address into the embed API address that returns JSON. */
export function embedUrlFor(address: string): string {
  const url = new URL(address);
  const page = /^\/timeline\/([^/]+)(?:\/v\/(\d+))?\/?$/.exec(url.pathname);
  if (page) {
    url.pathname = `/api/v1/embed/${page[1] ?? ''}${page[2] ? `/v/${page[2]}` : ''}`;
  }
  return url.toString();
}

async function load(
  io: Io,
  source: string | undefined,
  opts: { server?: string; project?: string; version?: string; apiKey?: string },
): Promise<Loaded> {
  if (opts.server || opts.project) {
    if (!opts.server || !opts.project) throw new UsageError('Use --server and --project together');
    const key = opts.apiKey ?? io.env.CHRONICLE_API_KEY;
    if (!key) throw new UsageError('Exporting a project needs --api-key or $CHRONICLE_API_KEY');
    const base = opts.server.replace(/\/+$/, '');
    const version = opts.version ? Number(opts.version) : undefined;
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
      throw new UsageError('--version must be a positive whole number');
    }
    const url = `${base}/api/v1/projects/${encodeURIComponent(opts.project)}/${
      version ? `revisions/${String(version)}` : 'draft'
    }`;
    const body = (await getJson(io, url, { 'x-api-key': key })) as { timeline?: unknown };
    return { data: body.timeline, base: { kind: 'url', url: `${base}/` }, source: url, version };
  }
  if (!source) throw new UsageError('Give a timeline file or address to export');
  if (/^https?:\/\//i.test(source)) {
    const url = embedUrlFor(source);
    const body = (await getJson(io, url)) as {
      timeline?: unknown;
      version?: number;
      pageUrl?: string;
    };
    const isEmbed = typeof body === 'object' && 'timeline' in body;
    return {
      data: isEmbed ? body.timeline : body,
      base: { kind: 'url', url },
      source: (isEmbed ? body.pageUrl : undefined) ?? source,
      version: isEmbed ? body.version : undefined,
    };
  }
  return {
    data: readJsonFile(io, source),
    base: { kind: 'dir', dir: path.dirname(path.resolve(io.cwd, source)) },
    source: path.basename(source),
  };
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function mediaFetcher(io: Io, base: Loaded['base']): MediaFetcher {
  return async (raw): Promise<FetchedMedia | null> => {
    const absolute = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(raw);
    if (!absolute && base.kind === 'dir') {
      // A relative path next to a local JSON file: never outside its folder.
      const file = path.resolve(base.dir, decodeURIComponent(raw.split(/[?#]/)[0] ?? ''));
      if (
        path.relative(base.dir, file).startsWith('..') ||
        path.isAbsolute(path.relative(base.dir, file))
      ) {
        throw new Error('Path is outside the timeline’s folder');
      }
      if (!existsSync(file)) throw new Error('File not found');
      if (statSync(file).size > MAX_MEDIA_BYTES) throw new Error('File too large');
      const mime = EXT_MIME[path.extname(file).toLowerCase()];
      if (!mime) throw new Error('Unknown file type');
      return { bytes: new Uint8Array(readFileSync(file)), mimeType: mime };
    }
    const url = new URL(raw, base.kind === 'url' ? base.url : undefined).toString();
    const res = await io.fetch(url, {
      signal: AbortSignal.timeout(30_000),
      // Some media hosts (e.g. Wikimedia) refuse requests without a descriptive agent.
      headers: { 'user-agent': `Chronicle-CLI/${VERSION} (static site export)` },
    });
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_MEDIA_BYTES) throw new Error('File too large');
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, mimeType: res.headers.get('content-type') ?? '' };
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function printIssues(io: Io, issues: { path: string; message: string }[]): void {
  for (const issue of issues.slice(0, 50)) {
    io.stderr(`  ${issue.path || '(document)'}: ${issue.message}\n`);
  }
  if (issues.length > 50) io.stderr(`  …and ${String(issues.length - 50)} more\n`);
}

function validate(io: Io, args: string[]): number {
  const file = args[0];
  if (!file) throw new UsageError('Give a timeline file to check');
  const data = readJsonFile(io, file);
  if (isTimelineJS(data)) {
    io.stderr(`${file} is a TimelineJS file. Convert it first: chronicle migrate ${file}\n`);
    return 1;
  }
  const result = validateTimeline(repairTimelineDates(data).timeline);
  if (!result.success) {
    io.stderr(`${file} is not a valid Chronicle timeline:\n`);
    printIssues(
      io,
      result.errors.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
    return 1;
  }
  io.stdout(
    `${file}: valid Chronicle timeline “${result.data.title}” with ${String(result.data.events.length)} events.\n`,
  );
  return 0;
}

function migrate(io: Io, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { out: { type: 'string', short: 'o' } },
  });
  const file = positionals[0];
  if (!file) throw new UsageError('Give a TimelineJS file to convert');
  let report: ReturnType<typeof migrateFromTimelineJSWithReport>;
  try {
    report = migrateFromTimelineJSWithReport(readJsonFile(io, file));
  } catch (err) {
    throw new CommandError((err as Error).message);
  }
  for (const w of report.warnings) io.stderr(`warning: ${JSON.stringify(w)}\n`);
  const json = `${JSON.stringify(report.timeline, null, 2)}\n`;
  if (values.out) {
    writeFileSync(path.resolve(io.cwd, values.out), json);
    io.stderr(
      `Wrote ${values.out}: ${String(report.timeline.events.length)} events, ${String(report.warnings.length)} warnings.\n`,
    );
  } else {
    io.stdout(json);
  }
  return 0;
}

/** The <chronicle-timeline> bundle shipped with @chronicle/web-component. */
function componentBundle(): string {
  const require = createRequire(import.meta.url);
  return readFileSync(require.resolve('@chronicle/web-component/cdn/iife'), 'utf8');
}

async function exportSite(io: Io, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      zip: { type: 'boolean', default: false },
      'no-media': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      server: { type: 'string' },
      project: { type: 'string' },
      version: { type: 'string' },
      'api-key': { type: 'string' },
    },
  });
  const loaded = await load(io, positionals[0], {
    server: values.server,
    project: values.project,
    version: values.version,
    apiKey: values['api-key'],
  });
  let data = loaded.data;
  if (isTimelineJS(data)) {
    io.stderr('Converting from TimelineJS format…\n');
    data = migrateFromTimelineJSWithReport(data).timeline;
  }

  let site: Awaited<ReturnType<typeof buildStaticSite>>;
  try {
    site = await buildStaticSite(data, {
      script: componentBundle(),
      fetchMedia: mediaFetcher(io, loaded.base),
      includeMedia: !values['no-media'],
      source: loaded.source,
      version: loaded.version,
      generator: `Chronicle CLI ${VERSION}`,
    });
  } catch (err) {
    if (err instanceof StaticExportError) {
      io.stderr(`${err.message}:\n`);
      printIssues(io, err.issues);
      return 1;
    }
    throw err;
  }

  const folder = siteFolderName(site.timeline.title);
  const wantZip = values.zip || values.out?.toLowerCase().endsWith('.zip') === true;
  let out = path.resolve(io.cwd, values.out ?? folder);
  if (wantZip) {
    if (!out.toLowerCase().endsWith('.zip')) out = `${out}.zip`;
    if (existsSync(out) && !values.force) {
      throw new CommandError(`${out} already exists (use --force to replace it)`);
    }
    writeFileSync(out, zipStaticSite(site, path.basename(out, '.zip')));
  } else {
    if (existsSync(out) && readdirSync(out).length > 0 && !values.force) {
      throw new CommandError(`${out} is not empty (use --force to write into it)`);
    }
    for (const [rel, bytes] of site.files) {
      const target = path.join(out, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
  }

  const included = site.media.filter((m) => m.status === 'included').length;
  const problems = site.media.filter((m) => m.status === 'failed');
  io.stdout(
    `Exported “${site.timeline.title}” (${String(site.timeline.events.length)} events, ${String(included)} media files) to ${out}\n`,
  );
  if (!wantZip) io.stdout(`Open ${path.join(out, 'index.html')} in a browser to view it.\n`);
  if (problems.length > 0) {
    io.stderr(
      `${String(problems.length)} media item(s) were not copied and still need the internet:\n`,
    );
    for (const m of problems) io.stderr(`  ${m.url.slice(0, 120)}: ${m.reason ?? 'failed'}\n`);
  }
  return 0;
}

/** Runs the CLI; returns the process exit code (0 ok, 1 failure, 2 usage). */
export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        io.stdout(HELP);
        return 0;
      case '-v':
      case '--version':
        io.stdout(`${VERSION}\n`);
        return 0;
      case 'validate':
        return validate(io, rest);
      case 'export':
        return await exportSite(io, rest);
      case 'migrate':
        return migrate(io, rest);
      default:
        throw new UsageError(`Unknown command “${command}”`);
    }
  } catch (err) {
    if (
      err instanceof UsageError ||
      (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    ) {
      io.stderr(`${(err as Error).message}\nRun “chronicle --help” for usage.\n`);
      return 2;
    }
    if (err instanceof CommandError) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
