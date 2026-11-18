import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import type { MediaMetadata, MediaVariant } from '../db/schema.js';
import { ApiError } from '../http.js';

/**
 * Allowed upload types, decided from the file's bytes — never from its name
 * or the client-declared Content-Type. SVG is deliberately excluded (it can
 * carry script), as are HTML, PDF and anything else.
 */
const ALLOWED: Record<string, { kind: MediaMetadata['kind']; ext: string }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'image/gif': { kind: 'image', ext: 'gif' },
  'image/avif': { kind: 'image', ext: 'avif' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/webm': { kind: 'video', ext: 'webm' },
  'audio/mpeg': { kind: 'audio', ext: 'mp3' },
  'audio/ogg': { kind: 'audio', ext: 'ogg' },
  'audio/wav': { kind: 'audio', ext: 'wav' },
  'audio/x-wav': { kind: 'audio', ext: 'wav' },
  'audio/mp4': { kind: 'audio', ext: 'm4a' },
  'audio/x-m4a': { kind: 'audio', ext: 'm4a' },
};

/** Refuse decompression bombs: ~50 megapixels. */
const MAX_PIXELS = 50_000_000;
const DISPLAY_MAX = 2400;
const THUMB_MAX = 480;

export interface ProcessedFile {
  name: string;
  data: Buffer;
  variant: MediaVariant;
}

export interface ProcessedMedia {
  mimeType: string;
  metadata: Omit<MediaMetadata, 'variants'>;
  /** Files to store; keys are relative to the media item's folder. */
  files: ProcessedFile[];
  /** Name (within `files`) of the primary rendition to serve. */
  primary: string;
}

export async function detectType(
  data: Buffer,
): Promise<{ mime: string; kind: MediaMetadata['kind']; ext: string }> {
  const detected = await fileTypeFromBuffer(data);
  const allowed = detected ? ALLOWED[detected.mime] : undefined;
  if (!detected || !allowed) {
    throw new ApiError(
      415,
      'unsupported_media_type',
      'Unsupported file type. Upload JPEG, PNG, WebP, GIF, AVIF images, MP4/WebM video, or MP3/OGG/WAV/M4A audio.',
    );
  }
  return { mime: detected.mime, ...allowed };
}

/**
 * Validates and prepares an upload.
 *
 * Images are decoded and re-encoded, which (a) proves they are real images,
 * (b) strips all metadata — EXIF, GPS location, camera serials — because
 * sharp drops metadata unless asked to keep it, and (c) produces web-sized
 * renditions: `display.webp` (≤ 2400 px), `display.avif`, `thumb.webp`.
 * Originals are not kept. Video and audio are stored as uploaded.
 */
export async function processUpload(data: Buffer): Promise<ProcessedMedia> {
  const type = await detectType(data);

  if (type.kind !== 'image') {
    const name = `original.${type.ext}`;
    return {
      mimeType: type.mime,
      metadata: { kind: type.kind },
      files: [{ name, data, variant: { key: name, mimeType: type.mime, sizeBytes: data.length } }],
      primary: name,
    };
  }

  const animated = type.mime === 'image/gif' || type.mime === 'image/webp';
  let base: sharp.Sharp;
  let info: sharp.Metadata;
  try {
    base = sharp(data, { animated, limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate();
    info = await sharp(data, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new ApiError(422, 'invalid_image', 'The image could not be decoded');
  }
  const isAnimated = (info.pages ?? 1) > 1;

  const render = async (
    name: string,
    max: number,
    format: 'webp' | 'avif',
  ): Promise<ProcessedFile> => {
    const pipeline = base
      .clone()
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true });
    const out =
      format === 'webp'
        ? await pipeline.webp({ quality: 82 }).toBuffer({ resolveWithObject: true })
        : await pipeline.avif({ quality: 55, effort: 4 }).toBuffer({ resolveWithObject: true });
    const file = `${name}.${format}`;
    return {
      name: file,
      data: out.data,
      variant: {
        key: file,
        mimeType: `image/${format}`,
        width: out.info.width,
        // Animated output stacks frames vertically; report a single frame.
        height: isAnimated
          ? Math.round(
              (out.info.width * (info.pageHeight ?? info.height ?? out.info.height)) /
                (info.width ?? out.info.width),
            )
          : out.info.height,
        sizeBytes: out.data.length,
      },
    };
  };

  let files: ProcessedFile[];
  try {
    files = [
      await render('display', DISPLAY_MAX, 'webp'),
      await render('thumb', THUMB_MAX, 'webp'),
    ];
    // AVIF has no animation support in sharp; skip it for animated images.
    if (!isAnimated) files.push(await render('display', DISPLAY_MAX, 'avif'));
  } catch {
    throw new ApiError(422, 'invalid_image', 'The image could not be processed');
  }

  const display = files[0];
  if (!display) throw new ApiError(422, 'invalid_image', 'The image could not be processed');
  return {
    mimeType: 'image/webp',
    metadata: { kind: 'image', width: display.variant.width, height: display.variant.height },
    files,
    primary: display.name,
  };
}
