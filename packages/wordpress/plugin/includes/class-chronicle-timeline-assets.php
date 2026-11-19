<?php
/**
 * Script and style registration.
 *
 * @package ChronicleTimeline
 */

defined( 'ABSPATH' ) || exit;

/**
 * Registers the `<chronicle-timeline>` web component and the block editor
 * script. The component is bundled with the plugin; a version-pinned CDN
 * copy can be used instead, in which case the bundled copy is loaded if the
 * CDN copy fails (network error or a failed integrity check).
 */
final class Chronicle_Timeline_Assets {

	const COMPONENT = 'chronicle-timeline';

	const EDITOR = 'chronicle-timeline-editor';

	const STYLE = 'chronicle-timeline';

	/**
	 * Hooks.
	 */
	public static function init(): void {
		add_action( 'init', array( __CLASS__, 'register' ), 5 );
		add_filter( 'script_loader_tag', array( __CLASS__, 'script_tag' ), 10, 2 );
		add_action( 'enqueue_block_assets', array( __CLASS__, 'enqueue_in_editor_canvas' ) );
		add_action( 'enqueue_block_editor_assets', array( __CLASS__, 'editor_data' ) );
	}

	/**
	 * URL of the bundled web component.
	 */
	public static function bundled_component_url(): string {
		return CHRONICLE_TIMELINE_URL . 'build/chronicle-timeline.js';
	}

	/**
	 * Registers scripts and styles.
	 */
	public static function register(): void {
		$settings = Chronicle_Timeline_Settings::get();
		$use_cdn  = 'cdn' === $settings['script_source'] && Chronicle_Timeline_Settings::is_pinned_cdn_url( (string) $settings['cdn_url'] );

		wp_register_script(
			self::COMPONENT,
			$use_cdn ? $settings['cdn_url'] : self::bundled_component_url(),
			array(),
			$use_cdn ? null : CHRONICLE_TIMELINE_VERSION,
			array( 'in_footer' => true )
		);
		if ( $use_cdn ) {
			// Runs right after the CDN script, whether it loaded or not.
			wp_add_inline_script(
				self::COMPONENT,
				sprintf(
					'(function(){if(window.customElements&&!customElements.get("chronicle-timeline")){var s=document.createElement("script");s.src=%s;document.body.appendChild(s);}})();',
					wp_json_encode( add_query_arg( 'ver', CHRONICLE_TIMELINE_VERSION, self::bundled_component_url() ) )
				)
			);
		}

		wp_register_style(
			self::STYLE,
			CHRONICLE_TIMELINE_URL . 'assets/timeline.css',
			array(),
			CHRONICLE_TIMELINE_VERSION
		);

		$deps = array( 'react', 'react-jsx-runtime', 'wp-api-fetch', 'wp-block-editor', 'wp-blocks', 'wp-components', 'wp-element', 'wp-i18n', 'wp-url' );
		wp_register_script(
			self::EDITOR,
			CHRONICLE_TIMELINE_URL . 'build/editor.js',
			$deps,
			CHRONICLE_TIMELINE_VERSION,
			array( 'in_footer' => false )
		);
		wp_set_script_translations( self::EDITOR, 'chronicle-timeline' );
		wp_register_style(
			self::EDITOR,
			CHRONICLE_TIMELINE_URL . 'assets/editor.css',
			array(),
			CHRONICLE_TIMELINE_VERSION
		);
	}

	/**
	 * Adds Subresource Integrity to the CDN script.
	 *
	 * @param string $tag    Script tag.
	 * @param string $handle Script handle.
	 */
	public static function script_tag( string $tag, string $handle ): string {
		if ( self::COMPONENT !== $handle ) {
			return $tag;
		}
		$settings = Chronicle_Timeline_Settings::get();
		if ( 'cdn' !== $settings['script_source'] || '' === $settings['cdn_integrity'] ) {
			return $tag;
		}
		$src = (string) $settings['cdn_url'];
		return preg_replace(
			'#<script(?=[^>]*\ssrc=["\']' . preg_quote( esc_url( $src ), '#' ) . '["\'])#',
			'<script integrity="' . esc_attr( $settings['cdn_integrity'] ) . '" crossorigin="anonymous"',
			$tag,
			1
		) ?? $tag;
	}

	/**
	 * Loads the component on the front end (called when a timeline renders).
	 */
	public static function enqueue_frontend(): void {
		wp_enqueue_script( self::COMPONENT );
		wp_enqueue_style( self::STYLE );
	}

	/**
	 * The block editor renders blocks inside an iframe with its own custom
	 * element registry, so the component must be loaded there too. Assets
	 * enqueued on `enqueue_block_assets` are added to that iframe.
	 */
	public static function enqueue_in_editor_canvas(): void {
		if ( is_admin() ) {
			wp_enqueue_script( self::COMPONENT );
			wp_enqueue_style( self::STYLE );
			wp_enqueue_style( self::EDITOR );
		}
	}

	/**
	 * Settings the block editor needs (never the API key).
	 */
	public static function editor_data(): void {
		$settings = Chronicle_Timeline_Settings::get();
		$data     = array(
			'serverUrl'     => Chronicle_Timeline_Settings::server_url(),
			'hasAccount'    => Chronicle_Timeline_Settings::has_account(),
			'settingsUrl'   => current_user_can( 'manage_options' ) ? admin_url( 'options-general.php?page=chronicle-timeline' ) : '',
			'defaultLayout' => $settings['default_layout'],
			'defaultTheme'  => $settings['default_theme'],
		);
		wp_add_inline_script( self::EDITOR, 'window.chronicleTimelineEditor = ' . wp_json_encode( $data, JSON_HEX_TAG | JSON_HEX_AMP ) . ';', 'before' );
	}
}
