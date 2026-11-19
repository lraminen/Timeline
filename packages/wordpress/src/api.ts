import apiFetch from '@wordpress/api-fetch';
import { addQueryArgs } from '@wordpress/url';
import type { TimelineRef } from './url.js';

/** Settings printed by PHP (Chronicle_Timeline_Assets::editor_data). Never the API key. */
export interface EditorConfig {
  serverUrl: string;
  hasAccount: boolean;
  settingsUrl: string;
  defaultLayout: string;
  defaultTheme: string;
}

declare global {
  interface Window {
    chronicleTimelineEditor?: Partial<EditorConfig>;
  }
}

export function editorConfig(): EditorConfig {
  const c = window.chronicleTimelineEditor ?? {};
  return {
    serverUrl: c.serverUrl ?? '',
    hasAccount: c.hasAccount ?? false,
    settingsUrl: c.settingsUrl ?? '',
    defaultLayout: c.defaultLayout ?? '',
    defaultTheme: c.defaultTheme ?? '',
  };
}

export interface TimelineSummary {
  id: string;
  title: string;
  slug: string;
  role: string;
  isPublic: boolean;
  publishedVersion: number | null;
  eventCount: number;
  updatedAt: string;
  embeddable: boolean;
}

export interface TimelinePreview {
  version: number;
  pageUrl: string;
  timeline: {
    title?: string;
    events?: { tags?: string[] }[];
  } & Record<string, unknown>;
}

export function listTimelines(): Promise<{ server: string; timelines: TimelineSummary[] }> {
  return apiFetch({ path: '/chronicle/v1/timelines' });
}

export function fetchPreview(ref: TimelineRef): Promise<TimelinePreview> {
  const args: Record<string, string | number> = { slug: ref.slug };
  if (ref.server) args.server = ref.server;
  if (ref.version > 0) args.version = ref.version;
  return apiFetch({ path: addQueryArgs('/chronicle/v1/preview', args) });
}

/** apiFetch rejects with the REST error body (`{ code, message }`). */
export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}
