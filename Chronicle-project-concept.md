# Chronicle

## Project concept

Chronicle is a modern, embeddable timeline platform that turns structured events into accessible, media-rich stories.

## Core product

Users create timelines from:

- A visual editor
- CSV and JSON imports
- Google Sheets or Airtable
- REST and GraphQL APIs
- WordPress posts or custom content

They publish timelines as:

- Responsive web embeds
- Standalone shareable pages
- WordPress blocks
- Downloadable static sites
- Mobile-friendly stories

## Ideal architecture

- TypeScript monorepo
- Shared, versioned timeline schema
- React or Svelte editor
- Framework-agnostic `<chronicle-timeline>` Web Component
- Server-rendered public pages for SEO
- PostgreSQL for projects and revisions
- Object storage for uploaded media
- CDN-delivered assets
- REST and GraphQL APIs
- WordPress integration using a block rather than shortcode-only integration

## Timeline schema

```json
{
  "id": "moon-landing",
  "date": {
    "start": "1969-07-20",
    "end": null
  },
  "title": "Apollo 11 lands on the Moon",
  "body": "…",
  "media": [
    {
      "type": "image",
      "url": "https://example.com/image.jpg",
      "alt": "Apollo 11 astronauts"
    }
  ],
  "location": {
    "lat": 0,
    "lng": 0,
    "label": "Moon"
  },
  "tags": ["space", "science"]
}
```

## Features

- Multiple timelines per page
- Responsive horizontal, vertical, and card layouts
- Zooming, filtering, search, tags, and eras
- Rich media through oEmbed
- Maps and geographic routes
- Uncertain, approximate, and date-range events
- Drag-and-drop editing
- Drafts, revisions, publishing, and rollback
- Theme builder with design tokens
- Localization and right-to-left support
- Keyboard navigation and screen-reader support
- Reduced-motion mode
- Dark mode
- Stable embed URLs with version pinning
- Privacy-respecting analytics
- Import/export without vendor lock-in

## 2026-specific improvements

- AI-assisted event extraction from documents, with citations and human approval
- Automatic date normalization and conflict detection
- AI-generated summaries and alt text, never silently published
- Collaborative editing and comments
- Webhooks for automatically updating timelines
- Offline-capable editor
- Static export for long-term preservation
- Migration tools for legacy TimelineJS data

## Security and reliability

The modern version should:

- Validate timeline data against a schema
- Sanitize rich text and embedded HTML
- Avoid inserting user data into raw JavaScript
- Use CSP-compatible embeds
- Proxy or allowlist external media providers
- Avoid third-party tracking by default
- Support signed and private timelines
- Give each embed a unique instance ID
- Pin asset versions and provide fallbacks

## Recommended MVP

1. Timeline schema and validation
2. Visual editor
3. JSON and CSV import
4. Responsive embeddable Web Component
5. Image, video, audio, and map support
6. Themes and localization
7. WordPress block
8. Static export
9. Accessibility and automated testing

## Positioning

> Chronicle is the open, accessible, and developer-friendly way to publish interactive timelines that remain portable for decades.

## Key design lesson

Separate the content model, rendering engine, and CMS integrations. This makes the project useful beyond WordPress and avoids tightly coupling embed code to one platform.
