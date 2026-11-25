import { parentPort } from 'node:worker_threads';
import { parseDocumentBufferDirect } from './document-parse.js';

interface WorkerRequest {
  buffer: Uint8Array;
  filename?: string;
  mimeType?: string;
}

parentPort?.on('message', (msg: WorkerRequest) => {
  const buf = Buffer.from(msg.buffer.buffer, msg.buffer.byteOffset, msg.buffer.byteLength);
  void parseDocumentBufferDirect(buf, { filename: msg.filename, mimeType: msg.mimeType })
    .then((result) => {
      parentPort?.postMessage({ ok: true, result });
    })
    .catch((err: unknown) => {
      parentPort?.postMessage({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
});
