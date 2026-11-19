<?php
/**
 * Plugin settings: storage, defaults and validation.
 *
 * @package ChronicleTimeline
 */

defined( 'ABSPATH' ) || exit;

/**
 * Reads and validates the `chronicle_timeline_settings` option.
 */
final class Chronicle_Timeline_Settings {

	const OPTION = 'chronicle_timeline_settings';

	const LAYOUTS = array( 'horizontal', 'vertical', 'card' );

	const THEMES = array( 'light', 'dark', 'editorial', 'minimal' );

	/**
	 * API keys look like `chr_<12 letters/digits>_<43 base64url characters>`.
	 */
	const API_KEY_PATTERN = '/^chr_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/';

	/**
	 * Default values for every setting.
	 *
	 * @return array<string, mixed>
	 */
	public static function defaults(): array {
		return array(
			'server_url'      => '',
			'api_key'         => '',
			'default_layout'  => '',
			'default_theme'   => '',
			'script_source'   => 'bundled',
			'cdn_url'         => '',
			'cdn_integrity'   => '',
			'cache_minutes'   => 5,
			'sync_enabled'    => false,
			'sync_project'    => '',
			'sync_post_types' => array( 'post' ),
			'sync_publish'    => false,
		);
	}

	/**
	 * The current settings, merged with defaults. A `CHRONICLE_TIMELINE_API_KEY`
	 * constant (in wp-config.php) overrides the stored key, so the secret
	 * need not live in the database.
	 *
	 * @return array<string, mixed>
	 */
	public static function get(): array {
		$stored   = get_option( self::OPTION, array() );
		$settings = array_merge( self::defaults(), is_array( $stored ) ? $stored : array() );
		if ( self::key_from_constant() ) {
			$settings['api_key'] = (string) constant( 'CHRONICLE_TIMELINE_API_KEY' );
		}
		return $settings;
	}

	/**
	 * Whether the API key is defined in wp-config.php.
	 */
	public static function key_from_constant(): bool {
		return defined( 'CHRONICLE_TIMELINE_API_KEY' ) && is_string( constant( 'CHRONICLE_TIMELINE_API_KEY' ) ) && '' !== constant( 'CHRONICLE_TIMELINE_API_KEY' );
	}

	/**
	 * The configured Chronicle server, or '' when none.
	 */
	public static function server_url(): string {
		return Chronicle_Timeline_Urls::normalize_server_url( self::get()['server_url'] );
	}

	/**
	 * Whether the plugin can call the configured server on the account's behalf.
	 */
	public static function has_account(): bool {
		$settings = self::get();
		return '' !== self::server_url() && '' !== $settings['api_key'];
	}

	/**
	 * A client for the configured server, authenticated with the API key.
	 *
	 * @return Chronicle_Timeline_Client|WP_Error
	 */
	public static function account_client() {
		if ( ! self::has_account() ) {
			return new WP_Error( 'chronicle_not_configured', __( 'Connect a Chronicle account under Settings → Chronicle first.', 'chronicle-timeline' ), array( 'status' => 400 ) );
		}
		return new Chronicle_Timeline_Client( self::server_url(), (string) self::get()['api_key'], true );
	}

	/**
	 * What the settings page shows for a saved key: only the public prefix,
	 * never any of the secret.
	 *
	 * @param string $key An API key.
	 */
	public static function mask_key( string $key ): string {
		if ( 1 !== preg_match( '/^(chr_[A-Za-z0-9]{12})_/', $key, $m ) ) {
			return '';
		}
		return $m[1] . '_••••••••';
	}

	/**
	 * Sanitises the settings form. Invalid values keep the previous value and
	 * report an error on the settings page.
	 *
	 * @param mixed $input Submitted values.
	 * @return array<string, mixed>
	 */
	public static function sanitize( $input ): array {
		$previous = get_option( self::OPTION, array() );
		$previous = array_merge( self::defaults(), is_array( $previous ) ? $previous : array() );
		$input    = is_array( $input ) ? wp_unslash( $input ) : array();
		$out      = $previous;

		// Connection.
		if ( isset( $input['server_url'] ) ) {
			$raw    = trim( (string) $input['server_url'] );
			$server = Chronicle_Timeline_Urls::normalize_server_url( $raw );
			if ( '' === $raw || '' !== $server ) {
				$out['server_url'] = $server;
			} else {
				self::error( 'server_url', __( 'The Chronicle server URL must be an http(s) address without a query string.', 'chronicle-timeline' ) );
			}
		}
		if ( ! empty( $input['api_key_clear'] ) ) {
			$out['api_key'] = '';
		} elseif ( isset( $input['api_key'] ) && '' !== trim( (string) $input['api_key'] ) ) {
			// An empty field means "keep the saved key": it is never echoed back.
			$key = trim( (string) $input['api_key'] );
			if ( 1 === preg_match( self::API_KEY_PATTERN, $key ) ) {
				$out['api_key'] = $key;
			} else {
				self::error( 'api_key', __( 'That does not look like a Chronicle API key (it starts with chr_).', 'chronicle-timeline' ) );
			}
		}

		// Display defaults.
		if ( isset( $input['default_layout'] ) ) {
			$out['default_layout'] = self::enum( $input['default_layout'], self::LAYOUTS );
		}
		if ( isset( $input['default_theme'] ) ) {
			$out['default_theme'] = self::enum( $input['default_theme'], self::THEMES );
		}
		if ( isset( $input['cache_minutes'] ) ) {
			$out['cache_minutes'] = max( 1, min( 1440, absint( $input['cache_minutes'] ) ) );
		}

		// Script loading.
		if ( isset( $input['script_source'] ) ) {
			$source = 'cdn' === $input['script_source'] ? 'cdn' : 'bundled';
			$cdn    = isset( $input['cdn_url'] ) ? trim( (string) $input['cdn_url'] ) : '';
			$sri    = isset( $input['cdn_integrity'] ) ? trim( (string) $input['cdn_integrity'] ) : '';
			if ( '' !== $cdn && ! self::is_pinned_cdn_url( $cdn ) ) {
				self::error( 'cdn_url', __( 'The CDN URL must be an https URL to a .js file that names an exact version (for example …@0.1.0/…).', 'chronicle-timeline' ) );
				$cdn    = $previous['cdn_url'];
				$source = $previous['script_source'];
			}
			if ( '' !== $sri && 1 !== preg_match( '#^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$#', $sri ) ) {
				self::error( 'cdn_integrity', __( 'The integrity hash must look like sha384-….', 'chronicle-timeline' ) );
				$sri = $previous['cdn_integrity'];
			}
			if ( 'cdn' === $source && '' === $cdn ) {
				$source = 'bundled';
			}
			$out['script_source'] = $source;
			$out['cdn_url']       = $cdn;
			$out['cdn_integrity'] = $sri;
		}

		// Post sync.
		if ( isset( $input['sync_section'] ) ) {
			$out['sync_enabled'] = ! empty( $input['sync_enabled'] );
			$out['sync_publish'] = ! empty( $input['sync_publish'] );
			$project             = isset( $input['sync_project'] ) ? trim( (string) $input['sync_project'] ) : '';
			if ( '' === $project || 1 === preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $project ) ) {
				$out['sync_project'] = strtolower( $project );
			} else {
				self::error( 'sync_project', __( 'Choose a timeline to sync posts into.', 'chronicle-timeline' ) );
			}
			$types = isset( $input['sync_post_types'] ) && is_array( $input['sync_post_types'] ) ? $input['sync_post_types'] : array();
			$out['sync_post_types'] = array_values( array_filter( array_map( 'sanitize_key', $types ), 'post_type_exists' ) );
			if ( $out['sync_enabled'] && ( '' === $out['sync_project'] || array() === $out['sync_post_types'] ) ) {
				self::error( 'sync_enabled', __( 'Post sync needs a timeline and at least one post type; it has been turned off.', 'chronicle-timeline' ) );
				$out['sync_enabled'] = false;
			}
		}

		return $out;
	}

	/**
	 * Whether a URL is an https link to a version-pinned script.
	 *
	 * @param string $url Candidate URL.
	 */
	public static function is_pinned_cdn_url( string $url ): bool {
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || 'https' !== ( $parts['scheme'] ?? '' ) || empty( $parts['host'] ) || empty( $parts['path'] ) ) {
			return false;
		}
		if ( isset( $parts['user'] ) || isset( $parts['pass'] ) || isset( $parts['fragment'] ) ) {
			return false;
		}
		return 1 === preg_match( '#\.js$#', $parts['path'] ) && 1 === preg_match( '#[@/]v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/#', $parts['path'] );
	}

	/**
	 * Returns $value when it is one of $allowed, else ''.
	 *
	 * @param mixed    $value   Candidate.
	 * @param string[] $allowed Allowed values.
	 */
	public static function enum( $value, array $allowed ): string {
		return is_string( $value ) && in_array( $value, $allowed, true ) ? $value : '';
	}

	/**
	 * Records a settings error.
	 *
	 * @param string $field   Field name.
	 * @param string $message Message.
	 */
	private static function error( string $field, string $message ): void {
		if ( function_exists( 'add_settings_error' ) ) {
			add_settings_error( self::OPTION, 'chronicle_' . $field, $message );
		}
	}
}
