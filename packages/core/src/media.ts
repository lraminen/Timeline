import type { TimelineMedia } from "@chronicle/schema";

export type MediaDisplayType = "image" | "video" | "audio" | "iframe" | "map";

/**
 * Resolves the presentation display type for a given TimelineMedia asset.
 */
export function resolveMediaType(media: TimelineMedia): MediaDisplayType {
  if (media.type === "oembed") {
    return "iframe";
  }
  return media.type;
}

/**
 * Checks if a given media URL is external (HTTP/HTTPS) or local/relative.
 */
export function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Converts known media platform URLs (YouTube, Vimeo, SoundCloud) into embeddable iframe URLs.
 */
export function getOEmbedUrl(url: string): string | null {
  const trimmed = url.trim();

  // YouTube
  const ytMatch = trimmed.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i
  );
  if (ytMatch) {
    return `https://www.youtube-nocookie.com/embed/${ytMatch[1]}`;
  }

  // Vimeo
  const vimeoMatch = trimmed.match(
    /(?:vimeo\.com\/(?:channels\/(?:\w+\/)?|groups\/([^\/]*)\/videos\/|album\/(\d+)\/video\/|video\/|)(\d+))/i
  );
  if (vimeoMatch) {
    const id = vimeoMatch[3] || vimeoMatch[2];
    return `https://player.vimeo.com/video/${id}`;
  }

  // Google Maps
  if (/google\.com\/maps\/embed/i.test(trimmed)) {
    return trimmed;
  }

  return null;
}

/**
 * Default CSS aspect ratio per media display type.
 */
export function getMediaAspectRatio(type: MediaDisplayType): string {
  switch (type) {
    case "video":
    case "iframe":
      return "16 / 9";
    case "map":
      return "4 / 3";
    case "audio":
      return "auto";
    case "image":
    default:
      return "16 / 9";
  }
}
