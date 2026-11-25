import { deflateSync, deflateRawSync } from 'node:zlib';
import type { LookupAddress } from 'node:dns';
import { describe, it, expect } from 'vitest';
import { suggestEventSummary, suggestImageAltText } from '../content.js';
import {
  createSsrfSafeLookup,
  DocumentParserBusyError,
  extractTextFromBuffer,
  MAX_PARALLEL_PARSES,
  MAX_QUEUED_PARSES,
  extractTextFromDocxBuffer,
  extractTextFromPdfBuffer,
  fetchDocumentFromUrl,
  isPrivateIp,
} from '../documents.js';
import { chunkDocument, extractEventsFromDocument, parseHtmlToText } from '../extract.js';
import { MockAiProvider } from '../providers.js';

/** Builds a minimal valid single-entry ZIP/DOCX buffer with `word/document.xml`. */
function makeMinimalDocx(xmlContent: string | Buffer): Buffer {
  const filename = Buffer.from('word/document.xml', 'utf8');
  const uncompressed = Buffer.isBuffer(xmlContent) ? xmlContent : Buffer.from(xmlContent, 'utf8');
  const compressed = deflateRawSync(uncompressed);

  const localHeader = Buffer.alloc(30 + filename.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(uncompressed.length, 22);
  localHeader.writeUInt16LE(filename.length, 26);
  filename.copy(localHeader, 30);

  const cdHeader = Buffer.alloc(46 + filename.length);
  cdHeader.writeUInt32LE(0x02014b50, 0);
  cdHeader.writeUInt16LE(8, 10); // deflate
  cdHeader.writeUInt32LE(compressed.length, 20);
  cdHeader.writeUInt32LE(uncompressed.length, 24);
  cdHeader.writeUInt16LE(filename.length, 28);
  cdHeader.writeUInt32LE(0, 42); // local header offset
  filename.copy(cdHeader, 46);

  const cdOffset = localHeader.length + compressed.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdHeader.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([localHeader, compressed, cdHeader, eocd]);
}

/** Builds a structurally valid PDF document with exact xref offsets. */
function makeMinimalPdf(streamBody: string, compressed = false): Buffer {
  const payload = compressed
    ? deflateSync(Buffer.from(streamBody, 'latin1'))
    : Buffer.from(streamBody, 'latin1');
  const streamDict = compressed
    ? `<< /Length ${String(payload.length)} /Filter /FlateDecode >>`
    : `<< /Length ${String(payload.length)} >>`;

  const header = Buffer.from('%PDF-1.4\n', 'latin1');
  const obj1 = Buffer.from('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n', 'latin1');
  const obj2 = Buffer.from('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n', 'latin1');
  const obj3 = Buffer.from(
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n',
    'latin1',
  );
  const obj4 = Buffer.concat([
    Buffer.from(`4 0 obj ${streamDict} stream\n`, 'latin1'),
    payload,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
  const obj5 = Buffer.from(
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n',
    'latin1',
  );

  const objs = [obj1, obj2, obj3, obj4, obj5];
  const offsets: number[] = [];
  let cursor = header.length;
  for (const o of objs) {
    offsets.push(cursor);
    cursor += o.length;
  }

  const xrefOffset = cursor;
  const xrefLines = [
    'xref',
    `0 ${String(objs.length + 1)}`,
    '0000000000 65535 f ',
    ...offsets.map((off) => `${String(off).padStart(10, '0')} 00000 n `),
    `trailer << /Size ${String(objs.length + 1)} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
  ].join('\n');

  return Buffer.concat([header, ...objs, Buffer.from(xrefLines, 'latin1')]);
}

describe('document parsing, extraction, summaries & alt text', () => {
  it('chunks large documents cleanly and extracts deduplicated events with citations', async () => {
    const p1 =
      'On October 4, 1957, the Soviet Union launched Sputnik 1 into orbit. ' + 'x '.repeat(300);
    const p2 = 'On July 20, 1969, Apollo 11 landed humans on the Moon. ' + 'y '.repeat(300);
    const doc = `${p1}\n\n${p2}`;

    const chunks = chunkDocument(doc, 700, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const provider = new MockAiProvider((req) => {
      if (req.prompt.includes('Sputnik 1')) {
        return {
          documentTitle: 'Space History',
          events: [
            {
              title: 'Sputnik 1 Launch',
              date: { start: '1957-10-04' },
              body: 'First artificial satellite.',
              tags: ['space'],
              citation: { quote: 'the Soviet Union launched Sputnik 1 into orbit.' },
              confidence: 0.95,
            },
          ],
        };
      }
      return {
        events: [
          {
            title: 'Apollo 11 Landing',
            date: { start: '1969-07-20' },
            body: 'First crewed lunar landing.',
            tags: ['moon'],
            citation: { quote: 'Apollo 11 landed humans on the Moon.' },
            confidence: 0.98,
          },
        ],
      };
    });

    const result = await extractEventsFromDocument(doc, provider, {
      chunkSize: 700,
      chunkOverlap: 100,
    });
    expect(result.aiGenerated).toBe(true);
    expect(result.documentTitle).toBe('Space History');
    expect(result.sourceText).toBe(doc.trim());
    expect(result.droppedEvents).toBe(0);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.citation.startOffset).toBeTypeOf('number');
    expect(result.events[1]?.citation.quote).toBe('Apollo 11 landed humans on the Moon.');
  });

  it('drops individual malformed events without failing valid events in the same chunk', async () => {
    const seenChunkTokens: number[] = [];
    let callCount = 0;
    const provider = new MockAiProvider((req) => {
      callCount += 1;
      if (callCount === 2 && req.prompt.includes('Chunk 2')) {
        throw new Error('Chunk 2 failed');
      }
      return {
        events: [
          {
            title: 'Valid Landing',
            date: { start: '1969-07-20' },
            citation: { quote: 'Apollo 11 landed' },
            confidence: 85, // normalized from percentage
          },
          {
            title: 'Malformed Calendar Date',
            date: { start: '1969-13-45' },
            citation: { quote: 'bad date' },
            confidence: 0.9,
          },
        ],
      };
    });

    const result = await extractEventsFromDocument('Apollo 11 landed in 1969.', provider);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.confidence).toBe(0.85);
    expect(result.droppedEvents).toBe(1);

    // Mid-extraction failure still reports earlier chunk usage via onChunkUsage
    callCount = 0;
    const largeDoc = 'Apollo 11 landed in 1969. ' + 'a '.repeat(400) + '\n\n' + 'Chunk 2 text.';
    await expect(
      extractEventsFromDocument(largeDoc, provider, {
        chunkSize: 600,
        chunkOverlap: 50,
        onChunkUsage: (u) => {
          seenChunkTokens.push(u.totalTokens);
        },
      }),
    ).rejects.toThrow('Chunk 2 failed');
    expect(seenChunkTokens.length).toBe(1);
    expect(seenChunkTokens[0]).toBeGreaterThan(0);
  });

  it('strips HTML scripts/styles while preserving readable text in linear time', async () => {
    const html = `<html><head><title>History</title><style>body{color:red}</style></head>
      <body><script>alert(1)</script><h1>Launch</h1><p>In 1969 &amp; beyond.</p></body></html>`;
    const parsed = await extractTextFromBuffer(Buffer.from(html), { filename: 'page.html' });
    expect(parsed.format).toBe('html');
    expect(parsed.title).toBe('History');
    expect(parsed.text).toContain('Launch');
    expect(parsed.text).toContain('In 1969 & beyond.');
    expect(parsed.text).not.toContain('alert(1)');
    expect(parseHtmlToText('<p>Hello<br>World</p>')).toBe('Hello\nWorld');

    // Hostile 1 MB whitespace run completes in milliseconds (not quadratic minutes)
    const hostileHtml = `<p>${' '.repeat(1_000_000)}Done</p>`;
    const start = performance.now();
    expect(parseHtmlToText(hostileHtml)).toBe('Done');
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('extracts text from DOCX and FlateDecode + hex-encoded PDF buffers without ReDoS', async () => {
    const docx = makeMinimalDocx(
      '<w:document><w:body><w:p><w:r><w:t>Apollo 11</w:t></w:r></w:p><w:p><w:r><w:t>July 20, 1969</w:t></w:r></w:p></w:body></w:document>',
    );
    expect(extractTextFromDocxBuffer(docx)).toBe('Apollo 11\n\nJuly 20, 1969');

    const pdf = makeMinimalPdf('BT /F1 12 Tf (Moon Landing) Tj [(19) -10 (69)] TJ ET', true);
    expect(await extractTextFromPdfBuffer(pdf)).toBe('Moon Landing1969');

    // Hex-encoded PDF text (<41706f6c6c6f> = "Apollo")
    const hexPdf = makeMinimalPdf('BT /F1 12 Tf <41706f6c6c6f> Tj ET', false);
    expect(await extractTextFromPdfBuffer(hexPdf)).toBe('Apollo');

    // Adversarial TJ array with 60 "(a)" tokens finishes rapidly without event-loop freeze
    const hostileTj = `BT /F1 12 Tf [${'(a) '.repeat(60)}] TJ ET`;
    const hostilePdf = makeMinimalPdf(hostileTj, false);
    const t0 = performance.now();
    const out = await extractTextFromPdfBuffer(hostilePdf);
    expect(out).toContain('a');
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('rejects DOCX zip bombs quickly before inflating megabytes', () => {
    // 1 MB of zeros compresses to ~1 KB (ratio ~1000:1, well above 100:1 cap)
    const zeros = Buffer.alloc(1024 * 1024, 0x20);
    const bomb = makeMinimalDocx(zeros);
    expect(bomb.length).toBeLessThan(10_000);
    expect(() => extractTextFromDocxBuffer(bomb)).toThrow(/uncompressed size|ratio/i);
  });

  it('terminates runaway document parser workers on timeout', async () => {
    const spinWorker = new URL(
      'data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.on("message", () => { for (;;) {} });',
    );
    await expect(
      extractTextFromBuffer(Buffer.from('<p>hi</p>'), {
        filename: 'test.html',
        timeoutMs: 100,
        workerUrl: spinWorker,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it('caps parallel parser workers and refuses work once the wait queue is full', async () => {
    const slowWorker = new URL(
      'data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.on("message", () => { setTimeout(() => parentPort.postMessage({ ok: true, result: { format: "html", text: "ok" } }), 80); });',
    );
    const parse = () =>
      extractTextFromBuffer(Buffer.from('<p>hi</p>'), {
        filename: 'test.html',
        timeoutMs: 10_000,
        workerUrl: slowWorker,
      });

    // Fill every worker slot and every queue place.
    const accepted = Array.from({ length: MAX_PARALLEL_PARSES + MAX_QUEUED_PARSES }, parse);

    // One more is refused straight away rather than queued.
    await expect(parse()).rejects.toBeInstanceOf(DocumentParserBusyError);

    // Everything that was queued still completes, and the parser accepts work again afterwards.
    expect((await Promise.all(accepted)).every((r) => r.text === 'ok')).toBe(true);
    await expect(parse()).resolves.toMatchObject({ text: 'ok' });
  });

  it('hardens SSRF checks against IPv4-mapped IPv6, NAT64, DNS rebinding, and oversized streams', async () => {
    for (const badIp of [
      '127.0.0.1',
      '10.0.0.5',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      '[::ffff:169.254.169.254]',
      '::ffff:172.16.0.1',
      '64:ff9b::169.254.169.254',
      '64:ff9b:1::10.0.0.1',
      'fe80::1',
    ]) {
      expect(isPrivateIp(badIp)).toBe(true);
    }
    expect(isPrivateIp('93.184.216.34')).toBe(false);

    await expect(fetchDocumentFromUrl('http://127.0.0.1/secret')).rejects.toThrow(
      /Localhost|Private/i,
    );
    await expect(fetchDocumentFromUrl('http://[::ffff:169.254.169.254]/latest')).rejects.toThrow(
      /Private/i,
    );
    await expect(fetchDocumentFromUrl('http://[64:ff9b::169.254.169.254]/latest')).rejects.toThrow(
      /Private/i,
    );

    // DNS rebinding simulation via custom undici lookup hook
    const rebindLookup = (
      _hostname: string,
      _opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
    ) => {
      cb(null, [{ address: '169.254.169.254', family: 4 }]);
    };
    const safeLookup = createSsrfSafeLookup(rebindLookup);
    await new Promise<void>((resolve) => {
      safeLookup('evil.example', { all: true }, (err) => {
        expect(err?.message).toMatch(/disallowed/i);
        resolve();
      });
    });

    // Streaming body cutoff aborts mid-stream when exceeding maxBytes without Content-Length
    let canceled = false;
    const hugeStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024).fill(65));
      },
      cancel() {
        canceled = true;
      },
    });
    const streamFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(hugeStream, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      );
    await expect(
      fetchDocumentFromUrl('https://example.com/huge.txt', {
        fetch: streamFetch,
        skipDnsCheck: true,
        maxBytes: 2500,
      }),
    ).rejects.toThrow(/exceeds maximum size/i);
    expect(canceled).toBe(true);

    const mockFetch: typeof fetch = () =>
      Promise.resolve(
        new Response('<html><title>Test</title><body><p>Event text</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );
    const doc = await fetchDocumentFromUrl('https://example.com/article', {
      fetch: mockFetch,
      skipDnsCheck: true,
    });
    expect(doc.text).toBe('Event text');
  });

  it('generates summary and alt-text suggestions marked as aiGenerated', async () => {
    const provider = new MockAiProvider(() => ({
      summary: 'Concise summary of the historic mission.',
    }));
    const sum = await suggestEventSummary(
      { eventId: 'e1', title: 'Apollo 11', body: 'A very long description '.repeat(15) },
      provider,
    );
    expect(sum.aiGenerated).toBe(true);
    expect(sum.summary).toBe('Concise summary of the historic mission.');

    const alt = await suggestImageAltText(
      { imageBase64: 'AAAA', mimeType: 'image/jpeg', eventTitle: 'Apollo 11' },
      provider,
    );
    expect(alt.aiGenerated).toBe(true);
    expect(alt.altText.length).toBeGreaterThan(0);
  });
});
