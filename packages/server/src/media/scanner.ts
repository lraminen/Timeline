import { Socket } from 'node:net';

export type ScanResult = { clean: true } | { clean: false; signature: string };

/** Malware scanning hook for uploads. */
export interface Scanner {
  scan(data: Buffer): Promise<ScanResult>;
}

/** Used when no scanner is configured. */
export const noopScanner: Scanner = { scan: () => Promise.resolve({ clean: true }) };

/**
 * ClamAV daemon (clamd) scanner using the INSTREAM protocol over TCP:
 * `zINSTREAM\0`, then chunks prefixed by a 4-byte big-endian length, then a
 * zero-length chunk; clamd replies `stream: OK` or `stream: <name> FOUND`.
 *
 * Fails closed: if clamd is unreachable or replies unexpectedly, the scan
 * throws and the upload is rejected rather than stored unscanned.
 */
export class ClamdScanner implements Scanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 15_000,
  ) {}

  static fromAddress(address: string): ClamdScanner {
    const i = address.lastIndexOf(':');
    const port = Number(address.slice(i + 1));
    if (i <= 0 || !Number.isInteger(port)) throw new Error(`Invalid CLAMAV_ADDRESS: ${address}`);
    return new ClamdScanner(address.slice(0, i), port);
  }

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      const fail = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.setTimeout(this.timeoutMs, () => {
        fail(new Error('clamd scan timed out'));
      });
      socket.on('error', fail);
      socket.on('data', (c: Buffer) => chunks.push(c));
      socket.on('end', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        if (reply.endsWith('OK')) resolve({ clean: true });
        else {
          const found = /^stream: (.+) FOUND$/.exec(reply);
          if (found?.[1]) resolve({ clean: false, signature: found[1] });
          else fail(new Error(`Unexpected clamd reply: ${reply.slice(0, 200)}`));
        }
      });

      socket.connect(this.port, this.host, () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let off = 0; off < data.length; off += CHUNK) {
          const part = data.subarray(off, off + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.end(Buffer.alloc(4)); // zero-length terminator
      });
    });
  }
}
