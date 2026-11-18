import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Config } from '../config.js';

export interface StoredObject {
  body: Readable;
  contentType: string;
  size?: number;
}

/** Object storage for uploaded media. Keys are server-generated. */
export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(keys: string[]): Promise<void>;
}

/** Keys look like `projects/<uuid>/media/<uuid>/display.webp`. */
const KEY = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_.-]*)*$/;

export function assertSafeKey(key: string): void {
  if (!KEY.test(key) || key.includes('..') || key.length > 300) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

export function contentTypeForKey(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? 'application/octet-stream';
}

/** Local filesystem storage (default; suits single-server and self-hosted installs). */
export class FsStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    // Defence in depth on top of the key pattern.
    if (!full.startsWith(this.root + path.sep)) throw new Error(`Unsafe storage key: ${key}`);
    return full;
  }

  async put(key: string, data: Buffer, _contentType?: string): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async get(key: string): Promise<StoredObject | null> {
    const file = this.resolve(key);
    try {
      const info = await stat(file);
      if (!info.isFile()) return null;
      return { body: createReadStream(file), contentType: contentTypeForKey(key), size: info.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => rm(this.resolve(k), { force: true })));
  }
}

/** S3-compatible storage (AWS S3, Cloudflare R2, MinIO). */
export class S3Storage implements Storage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  static fromConfig(config: Config): S3Storage {
    if (!config.S3_BUCKET) throw new Error('S3_BUCKET is required');
    const client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials:
        config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
    return new S3Storage(client, config.S3_BUCKET);
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      return {
        body: res.Body as Readable,
        contentType: res.ContentType ?? contentTypeForKey(key),
        size: res.ContentLength,
      };
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    keys.forEach(assertSafeKey);
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}

export function createStorage(config: Config): Storage {
  return config.STORAGE_DRIVER === 's3'
    ? S3Storage.fromConfig(config)
    : new FsStorage(config.STORAGE_DIR);
}

/**
 * Called after media is deleted/replaced so CDNs drop cached copies.
 * The default does nothing (keys are immutable UUID paths, so stale copies
 * are unreachable rather than wrong); plug in CloudFront/Cloudflare here.
 */
export interface CdnInvalidator {
  invalidate(keys: string[]): Promise<void>;
}

export const noopInvalidator: CdnInvalidator = { invalidate: () => Promise.resolve() };
