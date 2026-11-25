import { inflateRawSync, inflateSync } from 'node:zlib';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { parseHtmlToText } from './extract.js';

export interface ExtractedDocument {
  text: string;
  format: 'txt' | 'md' | 'html' | 'docx' | 'pdf';
  title?: string;
}

const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB safety cap

function decodeXmlEntities(xml: string): string {
  return xml
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Extracts `word/document.xml` from a `.docx` ZIP buffer using Node's built-in
 * `zlib.inflateRawSync` without requiring external ZIP packages.
 */
export function extractTextFromDocxBuffer(buf: Buffer): string {
  // Locate End of Central Directory (PK\x05\x06)
  let eocdOffset = -1;
  for (let i = Math.max(0, buf.length - 65557); i <= buf.length - 22; i++) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid DOCX file: ZIP end-of-central-directory not found');
  }

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdEntries = buf.readUInt16LE(eocdOffset + 10);

  let pos = cdOffset;
  for (let entryIdx = 0; entryIdx < cdEntries && pos + 46 <= buf.length; entryIdx++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');

    if (name === 'word/document.xml') {
      if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error('Invalid DOCX file: malformed local file header');
      }
      const lhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
      const compressed = buf.subarray(dataStart, dataStart + compressedSize);

      let xmlBuf: Buffer;
      if (compressionMethod === 0) {
        xmlBuf = compressed;
      } else if (compressionMethod === 8) {
        xmlBuf = inflateRawSync(compressed);
      } else {
        throw new Error(`Unsupported DOCX compression method: ${String(compressionMethod)}`);
      }

      const xml = xmlBuf.toString('utf8');
      const text = xml
        .replace(/<\/w:p>/g, '\n\n')
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:br\s*\/?>/g, '\n')
        .replace(/<[^>]+>/g, '');
      return decodeXmlEntities(text)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error('Invalid DOCX file: word/document.xml not found');
}

function unescapePdfLiteral(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\([0-7]{1,3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

function extractTextFromPdfStreamText(streamText: string): string {
  const pieces: string[] = [];
  const btRegex = /\bBT\b([\s\S]*?)\bET\b/g;
  let btMatch: RegExpExecArray | null;

  while ((btMatch = btRegex.exec(streamText)) !== null) {
    const block = btMatch[1] ?? '';
    const blockParts: string[] = [];

    // Handle TJ arrays and simple Tj / ' / " operators in order via token scan
    const tokenRegex = /\[((?:[^[\]]|\([^)]*\))*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")/g;
    let tok: RegExpExecArray | null;
    while ((tok = tokenRegex.exec(block)) !== null) {
      if (tok[1] !== undefined) {
        const inner = tok[1];
        const strRegex = /\(((?:\\.|[^\\)])*)\)/g;
        let s: RegExpExecArray | null;
        const arrText: string[] = [];
        while ((s = strRegex.exec(inner)) !== null) {
          if (s[1] !== undefined) arrText.push(unescapePdfLiteral(s[1]));
        }
        if (arrText.length) blockParts.push(arrText.join(''));
      } else if (tok[2] !== undefined) {
        blockParts.push(unescapePdfLiteral(tok[2]));
      }
    }

    if (blockParts.length > 0) {
      pieces.push(blockParts.join(''));
    }
  }

  return pieces.join('\n');
}

/**
 * Pure-TypeScript PDF text extractor supporting uncompressed and `FlateDecode`
 * content streams. Designed for text-based PDFs without native/canvas dependencies.
 */
export function extractTextFromPdfBuffer(buf: Buffer): string {
  const header = buf.subarray(0, 8).toString('latin1');
  if (!header.startsWith('%PDF-')) {
    throw new Error('Invalid PDF file: missing %PDF- header');
  }

  const rawLatin = buf.toString('latin1');
  const extractedChunks: string[] = [];
  const streamRegex = /<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\n?endstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(rawLatin)) !== null) {
    const dict = match[1] ?? '';
    const streamBody = match[2] ?? '';
    const isFlate = /\/Filter\s*(?:\[[^\]]*\/FlateDecode|\/FlateDecode)\b/.test(dict);

    let decoded: string;
    if (isFlate) {
      try {
        const rawBytes = Buffer.from(streamBody, 'latin1');
        decoded = inflateSync(rawBytes).toString('latin1');
      } catch {
        continue;
      }
    } else {
      decoded = streamBody;
    }

    if (decoded.includes('BT') && decoded.includes('ET')) {
      const text = extractTextFromPdfStreamText(decoded);
      if (text.trim()) extractedChunks.push(text);
    }
  }

  // Fallback: check uncompressed top-level BT..ET blocks if no streams matched
  if (extractedChunks.length === 0 && rawLatin.includes('BT')) {
    const fallback = extractTextFromPdfStreamText(rawLatin);
    if (fallback.trim()) extractedChunks.push(fallback);
  }

  return extractedChunks
    .join('\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function detectDocumentFormat(
  filename = '',
  mimeType = '',
  buffer?: Buffer,
): ExtractedDocument['format'] {
  const lowerName = filename.toLowerCase();
  const lowerMime = mimeType.toLowerCase();

  if (lowerName.endsWith('.pdf') || lowerMime === 'application/pdf') return 'pdf';
  if (
    lowerName.endsWith('.docx') ||
    lowerMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  if (lowerName.endsWith('.html') || lowerName.endsWith('.htm') || lowerMime.includes('text/html')) {
    return 'html';
  }
  if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown') || lowerMime.includes('markdown')) {
    return 'md';
  }

  if (buffer) {
    if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) return 'docx';
    const head = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  }

  return 'txt';
}

/**
 * Extracts normalized plain text from an uploaded document buffer (PDF, DOCX, HTML, MD, TXT).
 */
export function extractTextFromBuffer(
  buffer: Buffer,
  options?: { filename?: string; mimeType?: string },
): ExtractedDocument {
  if (buffer.length > MAX_DOC_BYTES) {
    throw new Error(`Document exceeds maximum size (${String(MAX_DOC_BYTES / (1024 * 1024))} MB)`);
  }
  const format = detectDocumentFormat(options?.filename, options?.mimeType, buffer);

  switch (format) {
    case 'docx':
      return { format, text: extractTextFromDocxBuffer(buffer) };
    case 'pdf': {
      const text = extractTextFromPdfBuffer(buffer);
      if (!text) {
        throw new Error(
          'No extractable text was found in this PDF (scanned/image-only PDFs are not supported without OCR).',
        );
      }
      return { format, text };
    }
    case 'html': {
      const html = buffer.toString('utf8');
      const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      return {
        format,
        title: titleMatch?.[1]?.replace(/\s+/g, ' ').trim() || undefined,
        text: parseHtmlToText(html),
      };
    }
    case 'md':
    case 'txt':
      return { format, text: buffer.toString('utf8').replace(/\r\n/g, '\n').trim() };
  }
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80:') ||
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:192.168.')
    );
  }
  return true;
}

/**
 * Fetches an external HTTP(S) document with SSRF protection (blocks loopback,
 * link-local, and RFC1918 private addresses; disables redirects).
 */
export async function fetchDocumentFromUrl(
  rawUrl: string,
  options?: { fetch?: typeof fetch; maxBytes?: number; timeoutMs?: number; skipDnsCheck?: boolean },
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

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Localhost and internal URLs are not allowed');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Private network IP addresses are not allowed');
  } else if (!options?.skipDnsCheck) {
    const resolved = await lookup(hostname, { all: true }).catch(() => []);
    if (resolved.length === 0 || resolved.some((r) => isPrivateIp(r.address))) {
      throw new Error('URL resolves to a disallowed or unresolvable address');
    }
  }

  const fetchFn = options?.fetch ?? fetch;
  const maxBytes = options?.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = options?.timeoutMs ?? 15_000;

  const res = await fetchFn(parsed.toString(), {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'text/html,text/plain,text/markdown,application/pdf,*/*;q=0.5' },
  });

  if (res.status >= 300 && res.status < 400) {
    throw new Error('Redirects are not followed when fetching remote documents');
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch URL: HTTP ${String(res.status)}`);
  }

  const arrBuf = await res.arrayBuffer();
  if (arrBuf.byteLength > maxBytes) {
    throw new Error(`Remote document exceeds maximum size (${String(maxBytes)} bytes)`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  return extractTextFromBuffer(Buffer.from(arrBuf), {
    filename: parsed.pathname,
    mimeType: contentType.split(';')[0]?.trim(),
  });
}
