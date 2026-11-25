import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import { extractText, getDocumentProxy } from 'unpdf';
import {
  collapseWhitespace,
  extractDocxTextFromXml,
  extractHtmlTitle,
  parseHtmlToText,
} from './text-cleanup.js';

export interface ExtractedDocument {
  text: string;
  format: 'txt' | 'md' | 'html' | 'docx' | 'pdf';
  title?: string;
}

export const MAX_DOC_BYTES = 10 * 1024 * 1024;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;
export const MAX_DOCX_COMPRESSION_RATIO = 100;

/**
 * Extracts `word/document.xml` from a `.docx` ZIP buffer via `fflate` streaming
 * decompression with strict entry filtering, uncompressed size cap, and ratio guard.
 */
export function extractTextFromDocxBuffer(buf: Buffer): string {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Invalid DOCX file: ZIP signature not found');
  }

  const state: { found: boolean; abortError: Error | null } = {
    found: false,
    abortError: null,
  };
  let inflatedBytes = 0;
  const chunks: Uint8Array[] = [];

  const unzipper = new Unzip((file) => {
    if (file.name !== 'word/document.xml') return;
    state.found = true;
    if (file.compression !== 0 && file.compression !== 8) {
      state.abortError = new Error(
        `Unsupported DOCX compression method: ${String(file.compression)}`,
      );
      return;
    }
    if (file.originalSize && file.originalSize > MAX_DOCX_UNCOMPRESSED_BYTES) {
      state.abortError = new Error('DOCX entry exceeds maximum uncompressed size limit');
      return;
    }
    const compressedBase = file.size && file.size > 0 ? file.size : buf.length;
    file.ondata = (err, data) => {
      if (state.abortError) return;
      if (err) {
        state.abortError = err;
        return;
      }
      inflatedBytes += data.byteLength;
      if (inflatedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
        state.abortError = new Error('DOCX entry exceeds maximum uncompressed size limit');
        return;
      }
      if (
        inflatedBytes > 128 * 1024 &&
        compressedBase > 0 &&
        inflatedBytes / compressedBase > MAX_DOCX_COMPRESSION_RATIO
      ) {
        state.abortError = new Error('DOCX compression ratio exceeds safe limit');
        return;
      }
      chunks.push(data);
    };
    file.start();
  });
  unzipper.register(UnzipInflate);
  unzipper.register(UnzipPassThrough);

  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const pushChunkSize = 16 * 1024;
  for (let offset = 0; offset < u8.length; offset += pushChunkSize) {
    const end = Math.min(u8.length, offset + pushChunkSize);
    unzipper.push(u8.subarray(offset, end), end === u8.length);
    if (state.abortError) throw state.abortError;
  }

  if (state.abortError) throw state.abortError;
  if (!state.found) {
    throw new Error('Invalid DOCX file: word/document.xml not found');
  }

  const xml = Buffer.concat(chunks).toString('utf8');
  return extractDocxTextFromXml(xml);
}

/**
 * Extracts text from PDF buffers using `unpdf` (serverless PDF.js build),
 * supporting compressed streams, hex strings, and CID/ToUnicode fonts.
 */
export async function extractTextFromPdfBuffer(buf: Buffer): Promise<string> {
  const header = buf.subarray(0, 8).toString('latin1');
  if (!header.startsWith('%PDF-')) {
    throw new Error('Invalid PDF file: missing %PDF- header');
  }

  const doc = await getDocumentProxy(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  try {
    const extracted = await extractText(doc, { mergePages: true });
    return collapseWhitespace(extracted.text, { collapseHorizontal: false });
  } finally {
    await (doc as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
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
  if (
    lowerName.endsWith('.html') ||
    lowerName.endsWith('.htm') ||
    lowerMime.includes('text/html')
  ) {
    return 'html';
  }
  if (
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.markdown') ||
    lowerMime.includes('markdown')
  ) {
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

/** Runs buffer extraction in the current thread (called inside the document worker). */
export async function parseDocumentBufferDirect(
  buffer: Buffer,
  options?: { filename?: string; mimeType?: string },
): Promise<ExtractedDocument> {
  if (buffer.length > MAX_DOC_BYTES) {
    throw new Error(`Document exceeds maximum size (${String(MAX_DOC_BYTES / (1024 * 1024))} MB)`);
  }
  const format = detectDocumentFormat(options?.filename, options?.mimeType, buffer);

  switch (format) {
    case 'docx':
      return { format, text: extractTextFromDocxBuffer(buffer) };
    case 'pdf': {
      const text = await extractTextFromPdfBuffer(buffer);
      if (!text) {
        throw new Error(
          'No extractable text was found in this PDF (scanned/image-only PDFs are not supported without OCR).',
        );
      }
      return { format, text };
    }
    case 'html': {
      const html = buffer.toString('utf8');
      return {
        format,
        title: extractHtmlTitle(html),
        text: parseHtmlToText(html),
      };
    }
    case 'md':
    case 'txt':
      return { format, text: collapseWhitespace(buffer.toString('utf8')) };
  }
}
