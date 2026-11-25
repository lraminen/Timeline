import { deflateSync, deflateRawSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { suggestEventSummary, suggestImageAltText } from '../content.js';
import {
  extractTextFromBuffer,
  extractTextFromDocxBuffer,
  extractTextFromPdfBuffer,
  fetchDocumentFromUrl,
} from '../documents.js';
import { chunkDocument, extractEventsFromDocument, parseHtmlToText } from '../extract.js';
import { MockAiProvider } from '../providers.js';

/** Builds a minimal valid single-entry ZIP/DOCX buffer with `word/document.xml`. */
function makeMinimalDocx(xmlContent: string): Buffer {
  const filename = Buffer.from('word/document.xml', 'utf8');
  const uncompressed = Buffer.from(xmlContent, 'utf8');
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

function makeMinimalPdf(streamBody: string, compressed = false): Buffer {
  const payload = compressed ? deflateSync(Buffer.from(streamBody, 'latin1')) : Buffer.from(streamBody, 'latin1');
  const dict = compressed
    ? `<< /Length ${String(payload.length)} /Filter /FlateDecode >>`
    : `<< /Length ${String(payload.length)} >>`;
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n${dict}\nstream\n`, 'latin1'),
    payload,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);
}

describe('document parsing, extraction, summaries & alt text', () => {
  it('chunks large documents cleanly and extracts deduplicated events with citations', async () => {
    const p1 = 'On October 4, 1957, the Soviet Union launched Sputnik 1 into orbit. ' + 'x '.repeat(300);
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
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.citation.startOffset).toBeTypeOf('number');
    expect(result.events[1]?.citation.quote).toBe('Apollo 11 landed humans on the Moon.');
  });

  it('strips HTML scripts/styles while preserving readable text', () => {
    const html = `<html><head><title>History</title><style>body{color:red}</style></head>
      <body><script>alert(1)</script><h1>Launch</h1><p>In 1969 &amp; beyond.</p></body></html>`;
    const parsed = extractTextFromBuffer(Buffer.from(html), { filename: 'page.html' });
    expect(parsed.format).toBe('html');
    expect(parsed.title).toBe('History');
    expect(parsed.text).toContain('Launch');
    expect(parsed.text).toContain('In 1969 & beyond.');
    expect(parsed.text).not.toContain('alert(1)');
    expect(parseHtmlToText('<p>Hello<br>World</p>')).toBe('Hello\nWorld');
  });

  it('extracts text from DOCX and FlateDecode PDF buffers', () => {
    const docx = makeMinimalDocx(
      '<w:document><w:body><w:p><w:r><w:t>Apollo 11</w:t></w:r></w:p><w:p><w:r><w:t>July 20, 1969</w:t></w:r></w:p></w:body></w:document>',
    );
    expect(extractTextFromDocxBuffer(docx)).toBe('Apollo 11\n\nJuly 20, 1969');

    const pdf = makeMinimalPdf('BT /F1 12 Tf (Moon Landing) Tj [(19) -10 (69)] TJ ET', true);
    expect(extractTextFromPdfBuffer(pdf)).toBe('Moon Landing1969');
  });

  it('blocks private/loopback URLs for SSRF protection and fetches valid public HTML', async () => {
    await expect(fetchDocumentFromUrl('http://127.0.0.1/secret')).rejects.toThrow(/Localhost|Private/i);
    await expect(fetchDocumentFromUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /Private/i,
    );

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
