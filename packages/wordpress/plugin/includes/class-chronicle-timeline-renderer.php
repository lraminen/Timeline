<?php
/**
 * Front-end rendering shared by the block and the shortcode.
 *
 * @package ChronicleTimeline
 */

defined( 'ABSPATH' ) || exit;

/**
 * Fetches published timelines (with caching) and renders them as a
 * `<chronicle-timeline>` element that carries its data in an inert JSON
 * script and a server-rendered event list for crawlers and readers without
 * JavaScript. Once the web component upgrades, its shadow root replaces the
 * list with the interactive timeline.
 */
final class Chronicle_Timeline_Renderer {

	const CACHE_PREFIX = 'chronicle_tl_';

	const STALE_PREFIX = 'chronicle_tls_';

	/**
	 * How long to keep the last good copy for use while the server is down.
	 */
	const STALE_TTL = WEEK_IN_SECONDS;

	/**
	 * How long to wait before retrying a server that just failed.
	 */
	const FAILURE_TTL = MINUTE_IN_SECONDS;

	/**
	 * Validates display arguments from a block or shortcode.
	 *
	 * @param array<string, mixed> $raw Raw arguments.
	 * @return array{slug: string, server: string, version: int, layout: string, theme: string, height: string, filter_tags: string}
	 */
	public static function normalize_args( array $raw ): array {
		$tags = array();
		if ( isset( $raw['filter_tags'] ) && is_string( $raw['filter_tags'] ) ) {
			foreach ( explode( ',', $raw['filter_tags'] ) as $tag ) {
				$tag = trim( sanitize_text_field( $tag ) );
				if ( '' !== $tag && strlen( $tag ) <= 60 ) {
					$tags[] = $tag;
				}
			}
		}
		$height = isset( $raw['height'] ) && is_string( $raw['height'] ) ? strtolower( trim( $raw['height'] ) ) : '';
		if ( 1 === preg_match( '/^\d{1,4}$/', $height ) ) {
			$height .= 'px';
		}
		return array(
			'slug'        => isset( $raw['slug'] ) && Chronicle_Timeline_Urls::is_valid_slug( $raw['slug'] ) ? $raw['slug'] : '',
			'server'      => isset( $raw['server'] ) ? Chronicle_Timeline_Urls::normalize_server_url( $raw['server'] ) : '',
			'version'     => isset( $raw['version'] ) ? max( 0, (int) $raw['version'] ) : 0,
			'layout'      => Chronicle_Timeline_Settings::enum( $raw['layout'] ?? '', Chronicle_Timeline_Settings::LAYOUTS ),
			'theme'       => Chronicle_Timeline_Settings::enum( $raw['theme'] ?? '', Chronicle_Timeline_Settings::THEMES ),
			'height'      => 1 === preg_match( '/^\d{2,4}(px|vh|svh|dvh|rem|em)$/', $height ) ? $height : '',
			'filter_tags' => implode( ',', array_slice( array_unique( $tags ), 0, 20 ) ),
		);
	}

	/**
	 * Loads a published timeline, using the cache when fresh. When the server
	 * fails, the last good copy (kept for a week) is served instead, and the
	 * failure is remembered briefly so a down server doesn't slow every page.
	 *
	 * @param string $server  Server URL ('' = configured server).
	 * @param string $slug    Timeline slug.
	 * @param int    $version Pinned version, or 0 for the latest.
	 * @return array<string, mixed>|WP_Error The embed response.
	 */
	public static function fetch( string $server, string $slug, int $version ) {
		$client = Chronicle_Timeline_Client::for_server( $server );
		if ( is_wp_error( $client ) ) {
			return $client;
		}
		$key    = md5( $client->server() . '|' . $slug . '|' . $version );
		$cached = get_transient( self::CACHE_PREFIX . $key );
		if ( is_array( $cached ) ) {
			return isset( $cached['error'] )
				? new WP_Error( 'chronicle_unavailable', (string) $cached['error'], array( 'status' => (int) ( $cached['status'] ?? 502 ) ) )
				: $cached;
		}

		$result = $client->embed( $slug, $version );
		if ( ! is_wp_error( $result ) ) {
			$settings = Chronicle_Timeline_Settings::get();
			$ttl      = $version > 0 ? DAY_IN_SECONDS : max( 1, (int) $settings['cache_minutes'] ) * MINUTE_IN_SECONDS;
			set_transient( self::CACHE_PREFIX . $key, $result, $ttl );
			set_transient( self::STALE_PREFIX . $key, $result, self::STALE_TTL );
			return $result;
		}

		$status = (int) ( $result->get_error_data()['status'] ?? 502 );
		$stale  = 404 === $status ? false : get_transient( self::STALE_PREFIX . $key );
		if ( is_array( $stale ) ) {
			set_transient( self::CACHE_PREFIX . $key, $stale, self::FAILURE_TTL );
			return $stale;
		}
		if ( 404 === $status ) {
			delete_transient( self::STALE_PREFIX . $key );
		}
		set_transient(
			self::CACHE_PREFIX . $key,
			array(
				'error'  => $result->get_error_message(),
				'status' => $status,
			),
			self::FAILURE_TTL
		);
		return $result;
	}

	/**
	 * Renders a timeline.
	 *
	 * @param array<string, mixed> $raw                Block attributes or shortcode arguments.
	 * @param string               $wrapper_attributes Attributes for the wrapping element (already escaped).
	 */
	public static function render( array $raw, string $wrapper_attributes ): string {
		$args = self::normalize_args( $raw );
		if ( '' === $args['slug'] ) {
			return self::problem( __( 'No timeline has been chosen.', 'chronicle-timeline' ), $wrapper_attributes );
		}

		$result = self::fetch( $args['server'], $args['slug'], $args['version'] );
		if ( is_wp_error( $result ) ) {
			return self::problem( $result->get_error_message(), $wrapper_attributes );
		}

		$timeline = $result['timeline'];
		$json     = wp_json_encode( $timeline, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( false === $json ) {
			return self::problem( __( 'The timeline data could not be encoded.', 'chronicle-timeline' ), $wrapper_attributes );
		}

		$settings = Chronicle_Timeline_Settings::get();
		$title    = isset( $timeline['title'] ) && is_string( $timeline['title'] ) ? $timeline['title'] : '';
		$element  = array(
			'aria-label'  => '' !== $title ? $title : __( 'Timeline', 'chronicle-timeline' ),
			'layout'      => '' !== $args['layout'] ? $args['layout'] : $settings['default_layout'],
			'theme'       => '' !== $args['theme'] ? $args['theme'] : $settings['default_theme'],
			'height'      => $args['height'],
			'filter-tags' => $args['filter_tags'],
		);
		$attrs    = '';
		foreach ( $element as $name => $value ) {
			if ( '' !== $value ) {
				$attrs .= ' ' . $name . '="' . esc_attr( $value ) . '"';
			}
		}

		$fallback = isset( $result['fallbackHtml'] ) && is_string( $result['fallbackHtml'] )
			? wp_kses( $result['fallbackHtml'], self::allowed_fallback_html() )
			: self::basic_fallback( $timeline );
		$page_url = isset( $result['pageUrl'] ) && is_string( $result['pageUrl'] ) ? esc_url( $result['pageUrl'], array( 'http', 'https' ) ) : '';
		$link     = '' !== $page_url
			? '<p class="chronicle-timeline__link"><a href="' . $page_url . '">' . esc_html__( 'View the full timeline', 'chronicle-timeline' ) . '</a></p>'
			: '';

		Chronicle_Timeline_Assets::enqueue_frontend();

		return '<div ' . $wrapper_attributes . '>'
			. '<chronicle-timeline' . $attrs . '>'
			. '<script type="application/json">' . $json . '</script>'
			. $fallback
			. $link
			. '</chronicle-timeline>'
			. '</div>';
	}

	/**
	 * Tags and attributes the server-rendered fallback may contain. Anything
	 * else (scripts, event handlers, styles, iframes…) is removed.
	 *
	 * @return array<string, array<string, bool>>
	 */
	public static function allowed_fallback_html(): array {
		$none = array();
		return array(
			'ol'         => array( 'class' => true ),
			'ul'         => $none,
			'li'         => array( 'class' => true ),
			'article'    => array( 'aria-labelledby' => true ),
			'h2'         => array( 'id' => true ),
			'p'          => array( 'class' => true ),
			'div'        => array( 'class' => true ),
			'span'       => $none,
			'time'       => array( 'datetime' => true ),
			'figure'     => $none,
			'figcaption' => $none,
			'img'        => array(
				'src'      => true,
				'alt'      => true,
				'loading'  => true,
				'decoding' => true,
			),
			'a'          => array(
				'href' => true,
				'rel'  => true,
			),
			'strong'     => $none,
			'em'         => $none,
			'code'       => $none,
			'blockquote' => $none,
			'br'         => $none,
		);
	}

	/**
	 * A plain list of events, used when the server sends no fallback HTML.
	 *
	 * @param array<string, mixed> $timeline Timeline document.
	 */
	public static function basic_fallback( array $timeline ): string {
		$items = '';
		foreach ( $timeline['events'] as $event ) {
			if ( ! is_array( $event ) || ! isset( $event['title'] ) || ! is_string( $event['title'] ) ) {
				continue;
			}
			$date = '';
			if ( isset( $event['date']['displayOverride'] ) && is_string( $event['date']['displayOverride'] ) ) {
				$date = $event['date']['displayOverride'];
			} elseif ( isset( $event['date']['start'] ) && is_string( $event['date']['start'] ) ) {
				$date = $event['date']['start'];
				if ( isset( $event['date']['end'] ) && is_string( $event['date']['end'] ) ) {
					$date .= ' – ' . $event['date']['end'];
				}
			}
			$body   = isset( $event['body'] ) && is_string( $event['body'] ) ? '<p>' . esc_html( $event['body'] ) . '</p>' : '';
			$items .= '<li class="ssr-event"><article><h2>' . esc_html( $event['title'] ) . '</h2>'
				. ( '' !== $date ? '<p class="ssr-date">' . esc_html( $date ) . '</p>' : '' )
				. $body . '</article></li>';
		}
		return '<ol class="ssr-events">' . $items . '</ol>';
	}

	/**
	 * Output when a timeline can't be shown: an explanation for people who
	 * can edit posts, and nothing (just an HTML comment) for visitors.
	 *
	 * @param string $message            Explanation.
	 * @param string $wrapper_attributes Wrapper attributes (already escaped).
	 */
	public static function problem( string $message, string $wrapper_attributes ): string {
		if ( ! current_user_can( 'edit_posts' ) ) {
			return '<!-- ' . esc_html__( 'Chronicle timeline unavailable', 'chronicle-timeline' ) . ' -->';
		}
		return '<div ' . $wrapper_attributes . '><p class="chronicle-timeline__problem" role="note">'
			. esc_html(
				/* translators: %s: reason the timeline could not be shown */
				sprintf( __( 'Chronicle timeline unavailable: %s', 'chronicle-timeline' ), $message )
			)
			. '</p></div>';
	}

	/**
	 * Deletes every cached timeline (fresh and stale copies).
	 *
	 * @return int Number of cache entries removed.
	 */
	public static function clear_cache(): int {
		global $wpdb;
		$like = array(
			$wpdb->esc_like( '_transient_' . self::CACHE_PREFIX ) . '%',
			$wpdb->esc_like( '_transient_' . self::STALE_PREFIX ) . '%',
		);
		// Transients have no "delete by prefix" API; this mirrors what core does on upgrade.
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$names = $wpdb->get_col( $wpdb->prepare( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s", $like[0], $like[1] ) );
		foreach ( $names as $name ) {
			delete_transient( substr( $name, strlen( '_transient_' ) ) );
		}
		return count( $names );
	}
}
