/** Stylesheet for public timeline pages (served as a static asset; no inline CSS). */
export const PAGE_CSS = `
:root { color-scheme: light; --text: #0f172a; --muted: #475569; --line: #e2e8f0; --bg: #f8fafc; --accent: #2563eb; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--text); background: var(--bg); line-height: 1.6;
  display: flex; flex-direction: column; min-height: 100vh;
}
.page-header { padding: 32px 16px 16px; max-width: 960px; margin: 0 auto; width: 100%; }
.page-header h1 { margin: 0 0 8px; font-size: clamp(1.6rem, 4vw, 2.4rem); line-height: 1.2; }
.page-description { color: var(--muted); }
.page-description p { margin: 0 0 8px; }
main { flex: 1; width: 100%; }
.page-timeline { display: block; height: min(80vh, 900px); min-height: 480px; }

/* Server-rendered fallback (visible before upgrade, to crawlers and without JS). */
chronicle-timeline:not(:defined) { height: auto; }
.ssr-events { list-style: none; margin: 0 auto; padding: 0 16px 32px; max-width: 760px; }
.ssr-event article { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 16px 20px; margin: 0 0 16px; }
.ssr-event h2 { font-size: 1.15rem; margin: 0 0 4px; line-height: 1.35; }
.ssr-date { margin: 0 0 8px; color: var(--accent); font-weight: 500; font-size: 0.9rem; }
.ssr-event figure { margin: 8px 0 12px; }
.ssr-event img { max-width: 100%; height: auto; border-radius: 8px; display: block; }
.ssr-event figcaption { font-size: 0.85rem; color: var(--muted); margin-top: 4px; }
.ssr-body { color: var(--muted); }
.ssr-body p, .ssr-body ul, .ssr-body ol { margin: 0 0 8px; }
.ssr-body a { color: var(--accent); }
.ssr-tags span { display: inline-block; font-size: 0.8rem; color: var(--muted); background: #f1f5f9; border-radius: 999px; padding: 1px 8px; }

.page-footer { padding: 16px; text-align: center; color: var(--muted); font-size: 0.85rem; }
.not-found { max-width: 560px; margin: 15vh auto; padding: 0 16px; text-align: center; }
`;
