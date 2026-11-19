<?php
/**
 * The `[chronicle]` shortcode, for the classic editor and widgets.
 *
 * @package ChronicleTimeline
 */

defined( 'ABSPATH' ) || exit;

/**
 * `[chronicle id="my-timeline" layout="horizontal" theme="dark" height="600" tags="space,moon" version="3" align="wide"]`
 *
 * `id` is a timeline slug on the configured server, or a full timeline link
 * (also accepted as `url`).
 */
final class Chronicle_Timeline_Shortcode {

	const TAG = 'chronicle';

	/**
	 * Hooks.
	 */
	public static function init(): void {
		add_action( 'init', array( __CLASS__, 'register' ) );
	}

	/**
	 * Registers the shortcode.
	 */
	public static function register(): void {
		add_shortcode( self::TAG, array( __CLASS__, 'render' ) );
	}

	/**
	 * Shortcode handler.
	 *
	 * @param array<string, string>|string $atts Shortcode attributes ('' when none).
	 */
	public static function render( $atts ): string {
		$atts = shortcode_atts(
			array(
				'id'      => '',
				'url'     => '',
				'version' => '',
				'layout'  => '',
				'theme'   => '',
				'height'  => '',
				'tags'    => '',
				'align'   => '',
				'class'   => '',
			),
			is_array( $atts ) ? $atts : array(),
			self::TAG
		);

		$classes = array( 'wp-block-chronicle-timeline', 'chronicle-timeline-shortcode' );
		if ( in_array( $atts['align'], array( 'wide', 'full' ), true ) ) {
			$classes[] = 'align' . $atts['align'];
		}
		foreach ( preg_split( '/\s+/', (string) $atts['class'], -1, PREG_SPLIT_NO_EMPTY ) as $class ) {
			$class = sanitize_html_class( $class );
			if ( '' !== $class ) {
				$classes[] = $class;
			}
		}
		$wrapper = 'class="' . esc_attr( implode( ' ', $classes ) ) . '"';

		$target = '' !== $atts['url'] ? $atts['url'] : $atts['id'];
		$server = '';
		$slug   = $target;
		$pinned = (int) $atts['version'];
		if ( false !== strpos( $target, '://' ) ) {
			$parsed = Chronicle_Timeline_Urls::parse_timeline_url( $target );
			if ( is_wp_error( $parsed ) ) {
				return Chronicle_Timeline_Renderer::problem( $parsed->get_error_message(), $wrapper );
			}
			$server = $parsed['server'];
			$slug   = $parsed['slug'];
			$pinned = $pinned > 0 ? $pinned : $parsed['version'];
		}

		return Chronicle_Timeline_Renderer::render(
			array(
				'slug'        => $slug,
				'server'      => $server,
				'version'     => $pinned,
				'layout'      => $atts['layout'],
				'theme'       => $atts['theme'],
				'height'      => $atts['height'],
				'filter_tags' => $atts['tags'],
			),
			$wrapper
		);
	}
}
