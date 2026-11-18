import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createServer, type Server } from 'node:net';
import sharp from 'sharp';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  createProject,
  createTestServer,
  signUp,
  type TestContext,
  type TestUser,
} from '../test/harness.js';
import { ClamdScanner, type Scanner } from '../media/scanner.js';
import { FsStorage, S3Storage } from '../media/storage.js';

let t: TestContext;
let owner: TestUser;
let stranger: TestUser;
let projectId: string;

beforeAll(async () => {
  t = await createTestServer();
  owner = await signUp(t.app);
  stranger = await signUp(t.app);
  projectId = (await createProject(t.app, owner)).id;
});
afterAll(async () => {
  await t.close();
});

function multipart(filename: string, data: Buffer, contentType = 'application/octet-stream') {
  const boundary = '----chronicletest';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, data, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const upload = (
  ctx: TestContext,
  user: TestUser,
  project: string,
  filename: string,
  data: Buffer,
  type?: string,
) => {
  const body = multipart(filename, data, type);
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/media`,
    headers: { ...user.auth, ...body.headers },
    payload: body.payload,
  });
};

/** A JPEG carrying EXIF including GPS coordinates. */
async function jpegWithGps(width = 3000, height = 2000): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#3366cc' } })
    .jpeg()
    .withExif({
      IFD0: { Copyright: 'Secret Photographer', Make: 'CameraCo' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '51/1 30/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 7/1 0/1',
      },
    })
    .toBuffer();
}

interface MediaResponse {
  id: string;
  url: string;
  kind: string;
  width: number;
  height: number;
  variants: Record<string, { url: string; mimeType: string; width?: number }>;
}

describe('uploads', () => {
  it('re-encodes images to WebP/AVIF renditions and strips EXIF/GPS metadata', async () => {
    const original = await jpegWithGps();
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const res = await upload(t, owner, projectId, 'holiday.jpg', original, 'image/jpeg');
    expect(res.statusCode).toBe(201);
    const body = res.json<MediaResponse>();
    expect(body.kind).toBe('image');
    expect(Object.keys(body.variants).sort()).toEqual(['display', 'display_avif', 'thumb']);
    expect(body.width).toBe(2400); // capped
    expect(body.variants.thumb?.width).toBe(480);
    expect(body.url).toMatch(
      new RegExp(
        `^http://chronicle\\.test/media/projects/${projectId}/media/[0-9a-f-]+/display\\.webp$`,
      ),
    );

    for (const variant of Object.values(body.variants)) {
      const served = await t.app.inject({ method: 'GET', url: new URL(variant.url).pathname });
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-type']).toBe(variant.mimeType);
      expect(served.headers['cache-control']).toContain('immutable');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
      const meta = await sharp(served.rawPayload).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
    }
    // The original (with GPS) is never stored.
    const stored = path.join(t.storageDir, 'projects', projectId, 'media', body.id);
    expect(existsSync(path.join(stored, 'original.jpg'))).toBe(false);
  });

  it('decides the type from the bytes, not the name or declared type', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect((await upload(t, owner, projectId, 'logo.svg', svg, 'image/svg+xml')).statusCode).toBe(
      415,
    );

    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    const disguised = await upload(t, owner, projectId, 'photo.png', html, 'image/png');
    expect(disguised.statusCode).toBe(415);

    // A real PNG named .txt is accepted as an image.
    const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#fff' } })
      .png()
      .toBuffer();
    expect(
      (await upload(t, owner, projectId, 'notes.txt', png, 'text/plain')).json<MediaResponse>()
        .kind,
    ).toBe('image');
  });

  it('rejects truncated images that only pretend to be valid', async () => {
    const jpeg = await jpegWithGps(200, 200);
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length / 3));
    expect((await upload(t, owner, projectId, 'broken.jpg', truncated)).statusCode).toBe(422);
  });

  it('stores audio/video as uploaded (after sniffing)', async () => {
    // Minimal valid WAV header + 1 sample.
    const wav = Buffer.alloc(46);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(38, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(2, 40);
    const res = await upload(t, owner, projectId, 'clip.wav', wav);
    expect(res.statusCode).toBe(201);
    expect(res.json<MediaResponse>()).toMatchObject({ kind: 'audio' });
  });

  it('enforces the size limit with 413', async () => {
    const small = await createTestServer({ MAX_UPLOAD_MB: '0.01' });
    try {
      const user = await signUp(small.app);
      const p = await createProject(small.app, user);
      // 50 KB of random bytes (incompressible) against a ~10 KB limit. The
      // limit applies while streaming, before any type detection.
      const res = await upload(small, user, p.id, 'big.jpg', randomBytes(50_000));
      expect(res.statusCode).toBe(413);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('payload_too_large');
    } finally {
      await small.close();
    }
  });

  it('requires editor access', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    expect((await upload(t, stranger, projectId, 'x.png', png)).statusCode).toBe(404);
  });

  it('lists and deletes media, removing stored files', async () => {
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#0f0' } })
      .png()
      .toBuffer();
    const created = (await upload(t, owner, projectId, 'del.png', png)).json<MediaResponse>();
    const list = await t.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/media`,
      headers: owner.auth,
    });
    expect(list.json<{ media: { id: string }[] }>().media.some((m) => m.id === created.id)).toBe(
      true,
    );

    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/media/${created.id}`,
      headers: owner.auth,
    });
    expect(del.statusCode).toBe(204);
    expect(
      (await t.app.inject({ method: 'GET', url: new URL(created.url).pathname })).statusCode,
    ).toBe(404);
  });

  it('refuses path traversal in media URLs', async () => {
    for (const url of [
      '/media/../../etc/passwd',
      '/media/projects/%2e%2e/%2e%2e/secret',
      '/media/C:/windows/win.ini',
    ]) {
      expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
  });
});

describe('malware scanning', () => {
  const png = () =>
    sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } })
      .png()
      .toBuffer();

  it('rejects infected files and audits them', async () => {
    const infected: Scanner = {
      scan: () => Promise.resolve({ clean: false, signature: 'Eicar-Test-Signature' }),
    };
    const ctx = await createTestServer({}, { scanner: infected });
    try {
      const user = await signUp(ctx.app);
      const p = await createProject(ctx.app, user);
      const res = await upload(ctx, user, p.id, 'x.png', await png());
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('malware_detected');
    } finally {
      await ctx.close();
    }
  });

  it('fails closed when the scanner is unavailable', async () => {
    const broken: Scanner = { scan: () => Promise.reject(new Error('connection refused')) };
    const ctx = await createTestServer({}, { scanner: broken });
    try {
      const user = await signUp(ctx.app);
      const p = await createProject(ctx.app, user);
      expect((await upload(ctx, user, p.id, 'x.png', await png())).statusCode).toBe(503);
    } finally {
      await ctx.close();
    }
  });

  it('speaks the clamd INSTREAM protocol', async () => {
    const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const received: Buffer[] = [];
    const server: Server = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (c: Buffer) => chunks.push(c));
      socket.on('end', () => {
        const all = Buffer.concat(chunks);
        expect(all.subarray(0, 10).toString()).toBe('zINSTREAM\0');
        // Re-assemble length-prefixed chunks.
        let off = 10;
        const parts: Buffer[] = [];
        for (;;) {
          const len = all.readUInt32BE(off);
          off += 4;
          if (len === 0) break;
          parts.push(all.subarray(off, off + len));
          off += len;
        }
        const payload = Buffer.concat(parts);
        received.push(payload);
        socket.end(
          payload.toString().includes('EICAR') ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0',
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const scanner = ClamdScanner.fromAddress(`127.0.0.1:${String(port)}`);
      expect(await scanner.scan(Buffer.from('hello world'))).toEqual({ clean: true });
      expect(await scanner.scan(Buffer.from(EICAR))).toEqual({
        clean: false,
        signature: 'Eicar-Signature',
      });
      // Large payloads are chunked correctly.
      const big = Buffer.alloc(200_000, 7);
      await scanner.scan(big);
      expect(received.at(-1)?.equals(big)).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('media proxy', () => {
  const pngBytes = () =>
    sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } })
      .png()
      .toBuffer();

  async function withFetch(fake: typeof fetch, run: (ctx: TestContext) => Promise<void>) {
    const ctx = await createTestServer({ MEDIA_PROXY_HOSTS: 'images.example' }, { fetch: fake });
    try {
      await run(ctx);
    } finally {
      await ctx.close();
    }
  }
  const proxy = (ctx: TestContext, url: string) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1/media-proxy?url=${encodeURIComponent(url)}` });

  it('proxies allowlisted https images with safe headers', async () => {
    const body = await pngBytes();
    let requested = '';
    const fake = ((input: URL) => {
      requested = input.href;
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    }) as unknown as typeof fetch;
    await withFetch(fake, async (ctx) => {
      const res = await proxy(ctx, 'https://images.example/a.png');
      expect(res.statusCode).toBe(200);
      expect(requested).toBe('https://images.example/a.png');
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-security-policy']).toContain('sandbox');
      expect(res.rawPayload.equals(body)).toBe(true);
    });
  });

  it('refuses other hosts, http, look-alikes, redirects and non-images', async () => {
    const fake = ((input: URL) =>
      Promise.resolve(
        input.pathname === '/redirect'
          ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
          : new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }),
      )) as unknown as typeof fetch;
    await withFetch(fake, async (ctx) => {
      expect((await proxy(ctx, 'https://evil.example/a.png')).statusCode).toBe(403);
      expect((await proxy(ctx, 'http://images.example/a.png')).statusCode).toBe(403);
      expect((await proxy(ctx, 'https://images.example.evil.com/a.png')).statusCode).toBe(403);
      expect((await proxy(ctx, 'https://images.example/redirect')).statusCode).toBe(502);
      expect((await proxy(ctx, 'https://images.example/a.svg')).statusCode).toBe(400);
    });
  });
});

describe('storage drivers', () => {
  it('FsStorage refuses keys that could escape its directory', async () => {
    const fs = new FsStorage(t.storageDir);
    for (const key of ['../x', '/etc/passwd', 'a/../../b', 'C:/x', 'a\\b', 'UPPER/x', '']) {
      await expect(fs.put(key, Buffer.from('x'), 'text/plain')).rejects.toThrow(
        /Unsafe storage key/,
      );
    }
  });

  it('S3Storage sends the right commands', async () => {
    const s3 = mockClient(S3Client);
    s3.on(PutObjectCommand).resolves({});
    s3.on(DeleteObjectsCommand).resolves({});
    s3.on(GetObjectCommand).resolves({
      ContentType: 'image/webp',
      ContentLength: 3,
      Body: undefined,
    });
    const storage = new S3Storage(new S3Client({ region: 'auto' }), 'bucket');

    await storage.put('projects/a/media/b/display.webp', Buffer.from('abc'), 'image/webp');
    const put = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(put).toMatchObject({
      Bucket: 'bucket',
      Key: 'projects/a/media/b/display.webp',
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    });

    await storage.delete(['projects/a/media/b/display.webp', 'projects/a/media/b/thumb.webp']);
    expect(s3.commandCalls(DeleteObjectsCommand)[0]?.args[0].input.Delete?.Objects).toHaveLength(2);
    await expect(storage.put('../escape', Buffer.from('x'), 'x')).rejects.toThrow();
    s3.restore();
  });
});
