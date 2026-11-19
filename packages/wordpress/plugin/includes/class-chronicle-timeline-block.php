<?php
/**
 * The `chronicle/timeline` block.
 *
 * @package ChronicleTimeline
 */

defined( 'ABSPATH' ) || exit;

/**
 * Registers the dynamic block; it is rendered on the server so published
 * changes to a timeline appear without re-saving the post.
 */
final class Chronicle_Timeline_Block {

	/**
	 * Hooks.
	 */
	public static function init(): void {
		add_action( 'init', array( __CLASS__, 'register' ) );
	}

	/**
	 * Registers the block from its block.json.
	 */
	public static function register(): void {
		register_block_type(
			CHRONICLE_TIMELINE_DIR . 'blocks/timeline',
			array( 'render_callback' => array( __CLASS__, 'render' ) )
		);
	}

	/**
	 * Server-side render callback.
	 *
	 * @param array<string, mixed> $attributes Block attributes.
	 */
	public static function render( array $attributes ): string {
		return Chronicle_Timeline_Renderer::render(
			array(
				'slug'        => $attributes['slug'] ?? '',
				'server'      => $attributes['server'] ?? '',
				'version'     => $attributes['version'] ?? 0,
				'layout'      => $attributes['layout'] ?? '',
				'theme'       => $attributes['theme'] ?? '',
				'height'      => $attributes['height'] ?? '',
				'filter_tags' => $attributes['filterTags'] ?? '',
			),
			get_block_wrapper_attributes()
		);
	}
}
