<?php
/**
 * Parsing and validation of Chronicle URLs and identifiers.
 *
 * Mirrors src/url.ts in the block editor so that a link pasted into the
 * block, a shortcode and the server all agree on what a timeline link is.
 *
 * @package ChronicleTimeline
 */

defined( 'ABSPATH' ) || exit;

/**
 * Static helpers for Chronicle URLs.
 */
final class Chronicle_Timeline_Urls {

	/**
	 * Slugs the Chronicle server generates: letters, digits, `-` and `_`.
	 */
	const SLUG_PATTERN = '/^[A-Za-z0-9_-]{1,100}$/';

	/**
	 * Whether a string is a valid timeline slug.
	 *
	 * @param mixed $slug Candidate slug.
	 */
	public static function is_valid_slug( $slug ): bool {
		return is_string( $slug ) && 1 === preg_match( self::SLUG_PATTERN, $slug );
	}

	/**
	 * Normalises a Chronicle server base URL: http(s) only, no credentials,
	 * query or fragment, no trailing slash. Returns '' when invalid.
	 *
	 * @param mixed $url Candidate URL.
	 */
	public static function normalize_server_url( $url ): string {
		if ( ! is_string( $url ) ) {
			return '';
		}
		$url = trim( $url );
		if ( '' === $url ) {
			return '';
		}
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) || empty( $parts['scheme'] ) ) {
			return '';
		}
		$scheme = strtolower( $parts['scheme'] );
		if ( 'http' !== $scheme && 'https' !== $scheme ) {
			return '';
		}
		if ( isset( $parts['user'] ) || isset( $parts['pass'] ) || isset( $parts['query'] ) || isset( $parts['fragment'] ) ) {
			return '';
		}
		$host = strtolower( $parts['host'] );
		if ( 1 !== preg_match( '/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/', $host ) ) {
			return '';
		}
		$port = isset( $parts['port'] ) ? ':' . (int) $parts['port'] : '';
		$path = isset( $parts['path'] ) ? rtrim( $parts['path'], '/' ) : '';
		if ( '' !== $path && 1 !== preg_match( '#^(/[A-Za-z0-9._~-]+)+$#', $path ) ) {
			return '';
		}
		return $scheme . '://' . $host . $port . $path;
	}

	/**
	 * Parses a timeline link into its server, slug and pinned version.
	 *
	 * Accepted forms (optionally below a path prefix such as `/chronicle`):
	 * `/timeline/{slug}`, `/timeline/{slug}/v/{n}`, `/api/v1/embed/{slug}`
	 * and `/api/v1/embed/{slug}/v/{n}`. Share links (`?token=`) are refused:
	 * they expire, and a private timeline should not be published on a site.
	 *
	 * @param mixed $url The link.
	 * @return array{server: string, slug: string, version: int}|WP_Error
	 */
	public static function parse_timeline_url( $url ) {
		$invalid = new WP_Error( 'chronicle_invalid_url', __( 'That is not a Chronicle timeline link.', 'chronicle-timeline' ) );
		if ( ! is_string( $url ) || strlen( $url ) > 2048 ) {
			return $invalid;
		}
		$parts = wp_parse_url( trim( $url ) );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) || empty( $parts['path'] ) || empty( $parts['scheme'] ) ) {
			return $invalid;
		}
		if ( isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
			return $invalid;
		}
		if ( isset( $parts['query'] ) && 1 === preg_match( '/(^|&)token=/', $parts['query'] ) ) {
			return new WP_Error(
				'chronicle_share_link',
				__( 'This is a private share link, which expires. Make the timeline public in Chronicle and use its public link instead.', 'chronicle-timeline' )
			);
		}
		if ( 1 !== preg_match( '#^(.*?)/(?:timeline|api/v1/embed)/([^/]+)(?:/v/([0-9]{1,9}))?/?$#', $parts['path'], $m ) ) {
			return $invalid;
		}
		$slug = rawurldecode( $m[2] );
		if ( ! self::is_valid_slug( $slug ) ) {
			return $invalid;
		}
		$base = $parts['scheme'] . '://' . $parts['host'] . ( isset( $parts['port'] ) ? ':' . $parts['port'] : '' ) . $m[1];
		$server = self::normalize_server_url( $base );
		if ( '' === $server ) {
			return $invalid;
		}
		return array(
			'server'  => $server,
			'slug'    => $slug,
			'version' => isset( $m[3] ) ? (int) $m[3] : 0,
		);
	}

	/**
	 * Whether two server URLs are the same server.
	 *
	 * @param string $a First server URL.
	 * @param string $b Second server URL.
	 */
	public static function same_server( string $a, string $b ): bool {
		$a = self::normalize_server_url( $a );
		return '' !== $a && self::normalize_server_url( $b ) === $a;
	}
}
