=== Chronicle Timeline ===
Contributors: chronicle
Tags: timeline, history, chronology, embed, block
Requires at least: 6.6
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Embed interactive, accessible Chronicle timelines with a block or a shortcode, and optionally publish your posts as timeline events.

== Description ==

Chronicle turns events into interactive, accessible timelines. This plugin brings published Chronicle timelines into WordPress:

* **Chronicle Timeline block.** Pick a timeline from your Chronicle account, or paste a timeline link. The editor shows a live preview. Choose the layout (vertical, horizontal or cards), theme, height and which tags to show, and use wide or full-width alignment.
* **Works without JavaScript.** Every timeline is also rendered on the server as a plain list of events, so search engines, feed readers and visitors without JavaScript see the content.
* **Fast and resilient.** Timelines are cached on your site. If the Chronicle server is unavailable, the last good copy keeps showing.
* **Shortcode** for the classic editor and widgets: `[chronicle id="my-timeline" layout="horizontal" theme="dark" height="600" tags="space,moon"]`.
* **Post sync (optional).** Keep a Chronicle timeline in step with your posts: each published post becomes an event with its title, date, excerpt, featured image and tags.

= Shortcode attributes =

* `id` — the timeline's slug on your configured server, or a full timeline link (`url` also works).
* `version` — show a specific published version instead of the latest.
* `layout` — `vertical`, `horizontal` or `card`.
* `theme` — `light`, `dark`, `editorial` or `minimal`.
* `height` — for example `600`, `600px` or `80vh`.
* `tags` — comma-separated tags; only events with these tags are shown.
* `align` — `wide` or `full`.
* `class` — extra CSS classes.

== External services ==

This plugin connects to a Chronicle server: the one you enter under Settings → Chronicle, or the server named in a timeline link you paste into a block or shortcode.

* **Showing a timeline.** Your site requests the published timeline (`/api/v1/embed/…`) when a page with a timeline is first viewed and again when the cache expires (every 5 minutes by default). No visitor information is sent with these requests. Visitors' browsers load the timeline's images and other media from the Chronicle server, which can see their IP addresses.
* **In the block editor.** Listing your timelines and previewing one sends requests from your site to your configured server, authenticated with your API key.
* **Post sync** (off by default) sends each published post's title, date, excerpt, link, featured-image URL and tags to your configured server.

Chronicle can be self-hosted; the operator of the server you connect to determines its terms of use and privacy policy.

== Installation ==

1. Install and activate the plugin.
2. Go to **Settings → Chronicle**, enter your Chronicle server's address and, to browse your timelines from the editor, an API key (create one in Chronicle under Account → API keys).
3. Add the **Chronicle Timeline** block to a post or page and choose a timeline.

Timelines must be published and public in Chronicle to be embedded.

To keep the API key out of the database, add this to `wp-config.php` instead:

`define( 'CHRONICLE_TIMELINE_API_KEY', 'chr_…' );`

== Frequently Asked Questions ==

= Can I embed a private timeline? =

No. A timeline shown on a public website is public, so the plugin only embeds timelines that are public in Chronicle. Private share links are refused because they expire.

= When do changes in Chronicle appear on my site? =

After you publish them in Chronicle, within the refresh interval set under Settings → Chronicle (5 minutes by default). A block or shortcode pinned to a specific version never changes. **Clear cached timelines** on the settings page refreshes everything immediately.

= Does it load scripts from other sites? =

No, by default the timeline component is bundled with the plugin and served by your site. You can choose a version-pinned CDN copy instead (with an optional integrity hash); the bundled copy is used if the CDN copy fails.

= Which data does post sync send? =

Only for the post types you choose: the post title, publish date, excerpt, permalink, featured image URL with its alt text and caption, and tag names. Password-protected posts are never sent.

== Changelog ==

= 0.1.0 =
* First release: Chronicle Timeline block with account picker and live preview, shortcode, server-rendered fallback, caching with stale fallback, post sync.
