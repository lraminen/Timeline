# Chronicle

Chronicle is a modern, embeddable timeline platform that turns structured events into accessible, media-rich stories.

## Overview

Chronicle lets people create timelines with a visual editor or by importing CSV and JSON data, Google Sheets, Airtable, REST and GraphQL APIs, WordPress posts, or custom content. Timelines can be published as responsive embeds, standalone pages, WordPress blocks, downloadable static sites, or mobile-friendly stories.

## Features

- Horizontal, vertical, and card layouts
- Image, video, audio, oEmbed, map, and geographic route support
- Date ranges and uncertain or approximate events
- Search, filtering, tags, eras, and zoom controls
- Drag-and-drop editing, revisions, publishing, and rollback
- Theme builder, localization, and right-to-left support
- Keyboard navigation, screen-reader support, and reduced-motion mode
- Dark mode and privacy-respecting analytics
- Stable embed URLs with version pinning
- JSON and CSV import/export
- AI-assisted extraction, summaries, alt text, and date normalization with human approval
- Offline editing, collaboration, webhooks, and static export

## Architecture

- TypeScript monorepo
- Shared and versioned timeline schema
- React or Svelte visual editor
- Framework-agnostic `<chronicle-timeline>` Web Component
- Server-rendered public pages
- PostgreSQL for projects and revisions
- Object storage for uploaded media
- CDN-delivered assets
- REST and GraphQL APIs
- WordPress block integration

The content model, rendering engine, and CMS integrations are kept separate so timelines remain portable across platforms and preserve their data for the long term.

## Example event

```json
{
  "id": "moon-landing",
  "date": {
    "start": "1969-07-20",
    "end": null
  },
  "title": "Apollo 11 lands on the Moon",
  "body": "Apollo 11 became the first crewed mission to land on the Moon.",
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

## MVP

The recommended initial implementation is:

1. Timeline schema and validation
2. Visual editor
3. JSON and CSV import
4. Responsive embeddable Web Component
5. Image, video, audio, and map support
6. Themes and localization
7. WordPress block
8. Static export
9. Accessibility and automated testing
