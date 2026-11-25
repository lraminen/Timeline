import dns from 'node:dns';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import { lookup as lookupPromises } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  extractTextFromDocxBuffer,
  extractTextFromPdfBuffer,
  detectDocumentFormat,
  parseDocumentBufferDirect,
  MAX_DOC_BYTES,
  MAX_DOCX_UNCOMPRESSED_BYTES,
  MAX_DOCX_COMPRESSION_RATIO,
  type ExtractedDocument,
} from './document-parse.js';

export {
  extractTextFromDocxBuffer,
  extractTextFromPdfBuffer,
  detectDocumentFormat,
  MAX_DOC_BYTES,
  MAX_DOCX_UNCOMPRESSED_BYTES,
  MAX_DOCX_COMPRESSION_RATIO,
  type ExtractedDocument,
};

export const PARSE_TIMEOUT_MS = 10_000;

const BLOCKED_NAT64_LOCAL = ipaddr.parseCIDR('64:ff9b:1::/48');
const BLOCKED_IPV4_COMPAT = ipaddr.parseCIDR('::/96');

/**
 * Returns `true` if `rawIp` is invalid (fail-closed) or belongs to any
 * non-public IPv4/IPv6 range, including IPv4-mapped IPv6 (`::ffff:169.254.169.254`),
 * NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), link-local, loopback, ULA, or CGNAT.
 */
export function isPrivateIp(rawIp: string): boolean {
  const unbracketed = rawIp.startsWith('[') && rawIp.endsWith(']') ? rawIp.slice(1, -1) : rawIp;
  const clean = unbracketed.split('%')[0] ?? unbracketed;
  if (!ipaddr.isValid(clean)) return true;

  try {
    const addr = ipaddr.parse(clean);
    if (addr instanceof ipaddr.IPv4) {
      return addr.range() !== 'unicast';
    }
    if (addr.isIPv4MappedAddress()) {
      return addr.toIPv4Address().range() !== 'unicast';
    }
    if (addr.range() !== 'unicast') {
      return true;
    }
    if (addr.match(BLOCKED_NAT64_LOCAL) || addr.match(BLOCKED_IPV4_COMPAT)) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

export type DnsLookupFn = (
  hostname: string,
  options: LookupOneOptions | LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

/**
 * Wraps DNS resolution so `undici`'s connector validates EVERY resolved IP
 * before connecting and binds directly to that resolved IP (preventing DNS rebinding).
 */
export function createSsrfSafeLookup(baseLookup: DnsLookupFn = dns.lookup) {
  return (
    hostname: string,
    options: LookupOneOptions | LookupAllOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    baseLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, options.all ? [] : '');
        return;
      }
      const list: LookupAddress[] = Array.isArray(addresses)
        ? addresses
        : [{ address: addresses, family: net.isIPv6(addresses) ? 6 : 4 }];
      if (list.length === 0 || list.some((entry) => isPrivateIp(entry.address))) {
        const blocked: NodeJS.ErrnoException = Object.assign(
          new Error('URL resolves to a disallowed or unresolvable address'),
          { code: 'ESSRFBLOCKED' },
        );
        callback(blocked, options.all ? [] : '');
        return;
      }
      if (options.all) {
        callback(null, list);
        return;
      }
      const first = list[0];
      if (!first) {
        const blocked: NodeJS.ErrnoException = Object.assign(
          new Error('URL resolves to a disallowed or unresolvable address'),
          { code: 'ESSRFBLOCKED' },
        );
        callback(blocked, '');
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

/**
 * Reads an HTTP response body stream up to `maxBytes`, aborting immediately on
 * overflow rather than buffering the entire payload in memory first.
 */
export async function readResponseBytesWithLimit(
  res: Pick<Response, 'headers' | 'body'>,
  maxBytes: number,
): Promise<Buffer> {
  const lenHeader = res.headers.get('content-length');
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Remote document exceeds maximum size (${String(maxBytes)} bytes)`);
    }
  }
  if (!res.body) {
    return Buffer.alloc(0);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Remote document exceeds maximum size (${String(maxBytes)} bytes)`);
      }
      chunks.push(step.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function resolveWorkerUrl(): URL | null {
  if (import.meta.url.endsWith('.js') || import.meta.url.endsWith('.mjs')) {
    const sibling = new URL('./document-worker.js', import.meta.url);
    return existsSync(sibling) ? sibling : null;
  }
  const built = new URL('../dist/document-worker.js', import.meta.url);
  return existsSync(built) ? built : null;
}

interface WorkerResponse {
  ok: boolean;
  result?: ExtractedDocument;
  error?: string;
}

/** Most parser workers allowed to run at once, process-wide. */
export const MAX_PARALLEL_PARSES = Math.max(1, Math.min(4, availableParallelism() - 1));
/** Most parse requests allowed to wait for a free worker before new ones are refused. */
export const MAX_QUEUED_PARSES = 16;
/** Heap limits for each parser worker, so one hostile document cannot exhaust process memory. */
export const PARSE_WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
} as const;

/** Thrown when every parser worker is busy and the wait queue is full. */
export class DocumentParserBusyError extends Error {
  constructor() {
    super('The document parser is busy; please retry shortly');
    this.name = 'DocumentParserBusyError';
  }
}

let activeParses = 0;
const parseQueue: (() => void)[] = [];

function acquireParseSlot(): Promise<() => void> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const next = parseQueue.shift();
    if (next) {
      next(); // hand the slot straight to the next waiter
    } else {
      activeParses -= 1;
    }
  };
  if (activeParses < MAX_PARALLEL_PARSES) {
    activeParses += 1;
    return Promise.resolve(release);
  }
  if (parseQueue.length >= MAX_QUEUED_PARSES) {
    return Promise.reject(new DocumentParserBusyError());
  }
  return new Promise((resolve) => {
    parseQueue.push(() => {
      resolve(release);
    });
  });
}

export async function parseDocumentInWorker(
  workerUrl: URL,
  buffer: Buffer,
  options?: { filename?: string; mimeType?: string; timeoutMs?: number },
): Promise<ExtractedDocument> {
  const release = await acquireParseSlot();
  try {
    return await runParserWorker(workerUrl, buffer, options);
  } finally {
    release();
  }
}

function runParserWorker(
  workerUrl: URL,
  buffer: Buffer,
  options?: { filename?: string; mimeType?: string; timeoutMs?: number },
): Promise<ExtractedDocument> {
  const timeoutMs = options?.timeoutMs ?? PARSE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { resourceLimits: PARSE_WORKER_RESOURCE_LIMITS });
    let settled = false;

    // Settle only once the worker has fully stopped, so the slot is not
    // handed on while the old worker still holds its memory.
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker
        .terminate()
        .catch(() => undefined)
        .finally(outcome);
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error(`Document parsing timed out after ${String(timeoutMs)}ms`));
      });
    }, timeoutMs);

    worker.once('message', (msg: WorkerResponse) => {
      finish(() => {
        if (msg.ok && msg.result) {
          resolve(msg.result);
        } else {
          reject(new Error(msg.error ?? 'Document parsing failed in worker'));
        }
      });
    });

    worker.once('error', (err) => {
      const outOfMemory = (err as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY';
      finish(() => {
        reject(outOfMemory ? new Error('Document is too complex to parse') : err);
      });
    });

    worker.once('exit', (code) => {
      finish(() => {
        reject(new Error(`Document parser worker exited unexpectedly (${String(code)})`));
      });
    });

    // Pass a copy so transferring won't detach caller's Buffer.
    const copy = new Uint8Array(buffer.length);
    copy.set(buffer);
    worker.postMessage({ buffer: copy, filename: options?.filename, mimeType: options?.mimeType }, [
      copy.buffer,
    ]);
  });
}

/**
 * Extracts normalized plain text from an uploaded document buffer (PDF, DOCX, HTML, MD, TXT).
 * PDF, DOCX, and HTML buffers execute inside an isolated worker thread with a timeout.
 */
export async function extractTextFromBuffer(
  buffer: Buffer,
  options?: {
    filename?: string;
    mimeType?: string;
    timeoutMs?: number;
    useWorker?: boolean;
    workerUrl?: URL;
  },
): Promise<ExtractedDocument> {
  if (buffer.length > MAX_DOC_BYTES) {
    throw new Error(`Document exceeds maximum size (${String(MAX_DOC_BYTES / (1024 * 1024))} MB)`);
  }
  const format = detectDocumentFormat(options?.filename, options?.mimeType, buffer);

  if (
    (format === 'pdf' || format === 'docx' || format === 'html') &&
    options?.useWorker !== false
  ) {
    const workerUrl = options?.workerUrl ?? resolveWorkerUrl();
    if (workerUrl) {
      return parseDocumentInWorker(workerUrl, buffer, options);
    }
  }

  return parseDocumentBufferDirect(buffer, options);
}

/**
 * Fetches an external HTTP(S) document with SSRF protection:
 * - Blocks localhost, `.local`/`.internal` hostnames, and all non-unicast IPs (incl. IPv4-mapped IPv6 & NAT64)
 * - Uses an `undici` dispatcher with custom DNS-pinning `connect.lookup` to prevent DNS rebinding
 * - Disables redirects and streams response bodies with a strict byte cap
 */
export async function fetchDocumentFromUrl(
  rawUrl: string,
  options?: {
    fetch?: typeof fetch;
    lookup?: DnsLookupFn;
    maxBytes?: number;
    timeoutMs?: number;
    skipDnsCheck?: boolean;
  },
): Promise<ExtractedDocument> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid document URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http:// and https:// document URLs are supported');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Credentials in URLs are not allowed');
  }

  const rawHost = parsed.hostname.toLowerCase();
  const hostNoBrackets =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  if (
    hostNoBrackets === 'localhost' ||
    hostNoBrackets.endsWith('.local') ||
    hostNoBrackets.endsWith('.internal')
  ) {
    throw new Error('Localhost and internal URLs are not allowed');
  }

  if (net.isIP(hostNoBrackets) || ipaddr.isValid(hostNoBrackets)) {
    if (isPrivateIp(hostNoBrackets)) {
      throw new Error('Private network IP addresses are not allowed');
    }
  } else if (options?.fetch && !options.skipDnsCheck) {
    const resolved = await lookupPromises(hostNoBrackets, { all: true }).catch(() => []);
    if (resolved.length === 0 || resolved.some((r) => isPrivateIp(r.address))) {
      throw new Error('URL resolves to a disallowed or unresolvable address');
    }
  }

  const maxBytes = options?.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const requestHeaders = {
    accept: 'text/html,text/plain,text/markdown,application/pdf,*/*;q=0.5',
  };

  let res: Response;
  let agent: Agent | null = null;
  try {
    if (options?.fetch) {
      res = await options.fetch(parsed.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: requestHeaders,
      });
    } else {
      const safeLookup = createSsrfSafeLookup(options?.lookup);
      agent = new Agent({
        connect: { lookup: options?.skipDnsCheck ? undefined : safeLookup },
        maxResponseSize: maxBytes,
      });
      const undiciRes = await undiciFetch(parsed.toString(), {
        dispatcher: agent,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: requestHeaders,
      });
      res = undiciRes as unknown as Response;
    }

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error('Redirects are not followed when fetching remote documents');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Failed to fetch URL: HTTP ${String(res.status)}`);
    }

    const buf = await readResponseBytesWithLimit(res, maxBytes);
    const contentType = res.headers.get('content-type') ?? '';
    return await extractTextFromBuffer(buf, {
      filename: parsed.pathname,
      mimeType: contentType.split(';')[0]?.trim(),
    });
  } finally {
    if (agent) {
      await agent.close().catch(() => undefined);
    }
  }
}
