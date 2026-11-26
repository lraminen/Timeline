import type { Timeline } from '@chronicle/schema';
import {
  buildStaticSite,
  siteFolderName,
  zipStaticSite,
  type MediaFetcher,
} from '@chronicle/static';
// The same <chronicle-timeline> bundle the CDN and the server ship.
import bundle from '@chronicle/web-component/cdn/iife?raw';
import { downloadFile } from './export.js';

/** Loaded on demand (it carries the viewer bundle). */

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/**
 * Downloads media for the export. Works for this editor's own uploads,
 * inline images, and any host that allows cross-origin reads; anything else
 * keeps its URL (and is listed in the archive's manifest).
 */
const fetchMedia: MediaFetcher = async (url) => {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  const blob = await res.blob();
  if (blob.size > MAX_MEDIA_BYTES) throw new Error('File too large');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type };
};

export interface StaticExportResult {
  filename: string;
  included: number;
  /** Media still linked to the internet (download refused or not allowed). */
  notCopied: number;
}

/** Builds the static site for `doc` and downloads it as a zip. */
export async function exportStaticSite(doc: Timeline): Promise<StaticExportResult> {
  const site = await buildStaticSite(doc, {
    script: bundle,
    fetchMedia,
    generator: 'Chronicle editor',
  });
  const folder = siteFolderName(doc.title);
  downloadFile(`${folder}.zip`, zipStaticSite(site, folder), 'application/zip');
  return {
    filename: `${folder}.zip`,
    included: site.media.filter((m) => m.status === 'included').length,
    notCopied: site.media.filter((m) => m.status !== 'included').length,
  };
}
