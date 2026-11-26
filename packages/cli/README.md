# @chronicle/cli

The `chronicle` command: check timelines, convert TimelineJS files, and export timelines as self-contained static sites.

```sh
pnpm --filter @chronicle/cli build
node packages/cli/dist/cli.js --help
```

## Commands

```sh
chronicle validate timeline.json
chronicle migrate timelinejs.json -o timeline.json
chronicle export timeline.json                    # → ./<timeline-title>/
chronicle export timeline.json -o archive.zip
chronicle export https://chronicle.example/timeline/space-race/v/3
chronicle export --server https://chronicle.example --project <id> [--version 3] --api-key chr_…
```

Exit codes: `0` success, `1` the timeline is invalid or the export failed, `2` usage error.

## What an export contains

| File                           | Purpose                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `index.html`                   | The timeline. Events are plain HTML (readable without JavaScript), with a strict CSP         |
| `timeline.json`                | The data in the open Chronicle format; re-importable                                         |
| `assets/chronicle-timeline.js` | The interactive `<chronicle-timeline>` viewer (a classic script, so it works from `file://`) |
| `media/`                       | Copies of images, video and audio (JPEG, PNG, WebP, AVIF, GIF, MP4, WebM, MP3…)              |
| `manifest.json`                | Every file with its SHA-256 checksum, plus a report of media that could not be copied        |
| `README.txt`                   | How to open and check the archive                                                            |

The site needs no server or network: open `index.html` from the folder, or upload the folder to any static host.

Media handling:

- Media next to a local JSON file is copied, but never from outside that file's folder.
- Remote media is downloaded.
- SVG and HTML are never copied, because they can carry scripts. Neither are video or map embeds.
- Anything that is not copied keeps its original URL and is listed in the manifest.

Use `--no-media` to keep all media at its original URLs.

The builder is `@chronicle/static`; the editor (Export → Static site) and the server (`GET /api/v1/projects/:id/export.zip`) produce the same archive.
