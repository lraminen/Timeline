<?php
/**
 * Settings → Chronicle.
 *
 * @package ChronicleTimeline
 */

defined( 'ABSPATH' ) || exit;

/**
 * The settings page: connection, display defaults, script loading, post
 * sync and cache tools.
 */
final class Chronicle_Timeline_Admin {

	const PAGE = 'chronicle-timeline';

	const GROUP = 'chronicle_timeline';

	/**
	 * Hooks.
	 */
	public static function init(): void {
		add_action( 'admin_init', array( __CLASS__, 'register_setting' ) );
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_post_chronicle_timeline_clear_cache', array( __CLASS__, 'clear_cache' ) );
		add_action( 'admin_init', array( __CLASS__, 'privacy_policy' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( CHRONICLE_TIMELINE_FILE ), array( __CLASS__, 'action_links' ) );
	}

	/**
	 * Registers the option with its sanitiser.
	 */
	public static function register_setting(): void {
		register_setting(
			self::GROUP,
			Chronicle_Timeline_Settings::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( 'Chronicle_Timeline_Settings', 'sanitize' ),
				'default'           => Chronicle_Timeline_Settings::defaults(),
				'show_in_rest'      => false,
			)
		);
	}

	/**
	 * Adds the page under Settings.
	 */
	public static function menu(): void {
		add_options_page(
			__( 'Chronicle Timeline', 'chronicle-timeline' ),
			__( 'Chronicle', 'chronicle-timeline' ),
			'manage_options',
			self::PAGE,
			array( __CLASS__, 'render' )
		);
	}

	/**
	 * "Settings" link on the Plugins screen.
	 *
	 * @param string[] $links Links.
	 * @return string[]
	 */
	public static function action_links( array $links ): array {
		array_unshift(
			$links,
			'<a href="' . esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ) . '">' . esc_html__( 'Settings', 'chronicle-timeline' ) . '</a>'
		);
		return $links;
	}

	/**
	 * Suggested privacy-policy text.
	 */
	public static function privacy_policy(): void {
		if ( ! function_exists( 'wp_add_privacy_policy_content' ) ) {
			return;
		}
		wp_add_privacy_policy_content(
			__( 'Chronicle Timeline', 'chronicle-timeline' ),
			'<p>' . esc_html__( 'Pages with an embedded timeline load the timeline\'s images and other media from the Chronicle server that hosts it, which can see your visitors\' IP addresses. Timeline text is fetched by this site, not by visitors\' browsers.', 'chronicle-timeline' ) . '</p>'
		);
	}

	/**
	 * Handles "Clear cached timelines".
	 */
	public static function clear_cache(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Sorry, you are not allowed to do that.', 'chronicle-timeline' ), 403 );
		}
		check_admin_referer( 'chronicle_timeline_clear_cache' );
		$count = Chronicle_Timeline_Renderer::clear_cache();
		wp_safe_redirect( add_query_arg( array( 'page' => self::PAGE, 'cleared' => $count ), admin_url( 'options-general.php' ) ) );
		exit;
	}

	/**
	 * The connection status line.
	 *
	 * @return array{ok: bool, message: string}
	 */
	private static function connection_status(): array {
		$client = Chronicle_Timeline_Settings::account_client();
		if ( is_wp_error( $client ) ) {
			return array(
				'ok'      => false,
				'message' => __( 'Not connected. Add the server URL and an API key (create one in Chronicle under Account → API keys).', 'chronicle-timeline' ),
			);
		}
		$me = $client->request( 'GET', '/api/v1/me' );
		if ( is_wp_error( $me ) ) {
			return array(
				'ok'      => false,
				/* translators: %s: error message */
				'message' => sprintf( __( 'Could not connect: %s', 'chronicle-timeline' ), $me->get_error_message() ),
			);
		}
		$name  = is_array( $me['body'] ) && isset( $me['body']['name'] ) ? (string) $me['body']['name'] : '';
		$email = is_array( $me['body'] ) && isset( $me['body']['email'] ) ? (string) $me['body']['email'] : '';
		return array(
			'ok'      => true,
			/* translators: 1: account name, 2: account email */
			'message' => sprintf( __( 'Connected as %1$s (%2$s).', 'chronicle-timeline' ), $name, $email ),
		);
	}

	/**
	 * Timelines the account can edit (for the sync target).
	 *
	 * @return array<int, array{id: string, title: string}>
	 */
	private static function editable_timelines(): array {
		$client = Chronicle_Timeline_Settings::account_client();
		if ( is_wp_error( $client ) ) {
			return array();
		}
		$res = $client->request( 'GET', '/api/v1/projects' );
		if ( is_wp_error( $res ) || ! is_array( $res['body'] ) || ! isset( $res['body']['projects'] ) || ! is_array( $res['body']['projects'] ) ) {
			return array();
		}
		$out = array();
		foreach ( $res['body']['projects'] as $p ) {
			if ( is_array( $p ) && isset( $p['id'], $p['title'], $p['role'] ) && in_array( $p['role'], array( 'owner', 'editor' ), true ) ) {
				$out[] = array(
					'id'    => (string) $p['id'],
					'title' => (string) $p['title'],
				);
			}
		}
		return $out;
	}

	/**
	 * Renders the page.
	 */
	public static function render(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$settings  = Chronicle_Timeline_Settings::get();
		$name      = Chronicle_Timeline_Settings::OPTION;
		$status    = self::connection_status();
		$timelines = $status['ok'] ? self::editable_timelines() : array();
		$last_sync = get_option( Chronicle_Timeline_Sync::LAST_RESULT_OPTION );
		$types     = get_post_types( array( 'public' => true ), 'objects' );
		unset( $types['attachment'] );
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Chronicle Timeline', 'chronicle-timeline' ); ?></h1>
			<?php
			// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display only.
			if ( isset( $_GET['cleared'] ) ) {
				// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display only.
				$cleared = absint( $_GET['cleared'] );
				echo '<div class="notice notice-success is-dismissible"><p>' . esc_html(
					/* translators: %d: number of cache entries */
					sprintf( _n( 'Cleared %d cached timeline entry.', 'Cleared %d cached timeline entries.', $cleared, 'chronicle-timeline' ), $cleared )
				) . '</p></div>';
			}
			?>
			<form method="post" action="options.php">
				<?php settings_fields( self::GROUP ); ?>

				<h2><?php esc_html_e( 'Connection', 'chronicle-timeline' ); ?></h2>
				<p id="chronicle-status" class="<?php echo $status['ok'] ? 'chronicle-ok' : 'chronicle-error'; ?>">
					<strong><?php echo esc_html( $status['message'] ); ?></strong>
				</p>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="chronicle-server-url"><?php esc_html_e( 'Chronicle server', 'chronicle-timeline' ); ?></label></th>
						<td>
							<input type="url" class="regular-text code" id="chronicle-server-url" name="<?php echo esc_attr( $name ); ?>[server_url]" value="<?php echo esc_attr( $settings['server_url'] ); ?>" placeholder="https://timelines.example.org">
							<p class="description"><?php esc_html_e( 'The address of your Chronicle server. Timeline links from this server can be embedded by slug.', 'chronicle-timeline' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="chronicle-api-key"><?php esc_html_e( 'API key', 'chronicle-timeline' ); ?></label></th>
						<td>
							<?php if ( Chronicle_Timeline_Settings::key_from_constant() ) : ?>
								<p><?php esc_html_e( 'Set by CHRONICLE_TIMELINE_API_KEY in wp-config.php.', 'chronicle-timeline' ); ?></p>
							<?php else : ?>
								<input type="password" class="regular-text code" id="chronicle-api-key" name="<?php echo esc_attr( $name ); ?>[api_key]" value="" autocomplete="new-password" spellcheck="false" aria-describedby="chronicle-api-key-help">
								<p class="description" id="chronicle-api-key-help">
									<?php
									if ( '' !== $settings['api_key'] ) {
										/* translators: %s: masked API key */
										echo esc_html( sprintf( __( 'Saved: %s. Leave empty to keep it.', 'chronicle-timeline' ), Chronicle_Timeline_Settings::mask_key( (string) $settings['api_key'] ) ) );
									} else {
										esc_html_e( 'Lets editors pick timelines from your account, and is needed for post sync. Stored in the database; define CHRONICLE_TIMELINE_API_KEY in wp-config.php to keep it out.', 'chronicle-timeline' );
									}
									?>
								</p>
								<?php if ( '' !== $settings['api_key'] ) : ?>
									<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[api_key_clear]" value="1"> <?php esc_html_e( 'Remove the saved key', 'chronicle-timeline' ); ?></label>
								<?php endif; ?>
							<?php endif; ?>
						</td>
					</tr>
				</table>

				<h2><?php esc_html_e( 'Display', 'chronicle-timeline' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="chronicle-default-layout"><?php esc_html_e( 'Default layout', 'chronicle-timeline' ); ?></label></th>
						<td>
							<select id="chronicle-default-layout" name="<?php echo esc_attr( $name ); ?>[default_layout]">
								<option value=""><?php esc_html_e( 'As set in the timeline', 'chronicle-timeline' ); ?></option>
								<?php foreach ( self::layout_labels() as $value => $label ) : ?>
									<option value="<?php echo esc_attr( $value ); ?>" <?php selected( $settings['default_layout'], $value ); ?>><?php echo esc_html( $label ); ?></option>
								<?php endforeach; ?>
							</select>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="chronicle-default-theme"><?php esc_html_e( 'Default theme', 'chronicle-timeline' ); ?></label></th>
						<td>
							<select id="chronicle-default-theme" name="<?php echo esc_attr( $name ); ?>[default_theme]">
								<option value=""><?php esc_html_e( 'As set in the timeline', 'chronicle-timeline' ); ?></option>
								<?php foreach ( self::theme_labels() as $value => $label ) : ?>
									<option value="<?php echo esc_attr( $value ); ?>" <?php selected( $settings['default_theme'], $value ); ?>><?php echo esc_html( $label ); ?></option>
								<?php endforeach; ?>
							</select>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="chronicle-cache-minutes"><?php esc_html_e( 'Refresh timelines every', 'chronicle-timeline' ); ?></label></th>
						<td>
							<input type="number" min="1" max="1440" class="small-text" id="chronicle-cache-minutes" name="<?php echo esc_attr( $name ); ?>[cache_minutes]" value="<?php echo esc_attr( (string) $settings['cache_minutes'] ); ?>"> <?php esc_html_e( 'minutes', 'chronicle-timeline' ); ?>
							<p class="description"><?php esc_html_e( 'Newly published versions appear after at most this long. Pinned versions never change and are cached for a day.', 'chronicle-timeline' ); ?></p>
						</td>
					</tr>
				</table>

				<h2><?php esc_html_e( 'Timeline script', 'chronicle-timeline' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'Load the timeline component from', 'chronicle-timeline' ); ?></th>
						<td>
							<fieldset>
								<label><input type="radio" name="<?php echo esc_attr( $name ); ?>[script_source]" value="bundled" <?php checked( $settings['script_source'], 'bundled' ); ?>> <?php esc_html_e( 'This site (bundled with the plugin)', 'chronicle-timeline' ); ?></label><br>
								<label><input type="radio" name="<?php echo esc_attr( $name ); ?>[script_source]" value="cdn" <?php checked( $settings['script_source'], 'cdn' ); ?>> <?php esc_html_e( 'A CDN, falling back to the bundled copy', 'chronicle-timeline' ); ?></label>
							</fieldset>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="chronicle-cdn-url"><?php esc_html_e( 'CDN URL', 'chronicle-timeline' ); ?></label></th>
						<td>
							<input type="url" class="large-text code" id="chronicle-cdn-url" name="<?php echo esc_attr( $name ); ?>[cdn_url]" value="<?php echo esc_attr( $settings['cdn_url'] ); ?>" placeholder="https://cdn.jsdelivr.net/npm/@chronicle/web-component@0.1.0/dist/cdn/chronicle-timeline.iife.js">
							<p class="description"><?php esc_html_e( 'Must name an exact version, so the script cannot change underneath you.', 'chronicle-timeline' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="chronicle-cdn-integrity"><?php esc_html_e( 'Integrity hash (optional)', 'chronicle-timeline' ); ?></label></th>
						<td>
							<input type="text" class="large-text code" id="chronicle-cdn-integrity" name="<?php echo esc_attr( $name ); ?>[cdn_integrity]" value="<?php echo esc_attr( $settings['cdn_integrity'] ); ?>" placeholder="sha384-…" spellcheck="false">
							<p class="description"><?php esc_html_e( 'If set, browsers refuse a CDN file that does not match, and the bundled copy is used instead.', 'chronicle-timeline' ); ?></p>
						</td>
					</tr>
				</table>

				<h2><?php esc_html_e( 'Post sync', 'chronicle-timeline' ); ?></h2>
				<input type="hidden" name="<?php echo esc_attr( $name ); ?>[sync_section]" value="1">
				<p><?php esc_html_e( 'Publish posts as events on a Chronicle timeline: title, publish date, excerpt with a link back, featured image and tags. Unpublished, private, password-protected and deleted posts are removed from the timeline.', 'chronicle-timeline' ); ?></p>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'Sync posts', 'chronicle-timeline' ); ?></th>
						<td><label><input type="checkbox" id="chronicle-sync-enabled" name="<?php echo esc_attr( $name ); ?>[sync_enabled]" value="1" <?php checked( ! empty( $settings['sync_enabled'] ) ); ?>> <?php esc_html_e( 'Keep a timeline in sync with published posts', 'chronicle-timeline' ); ?></label></td>
					</tr>
					<tr>
						<th scope="row"><label for="chronicle-sync-project"><?php esc_html_e( 'Timeline', 'chronicle-timeline' ); ?></label></th>
						<td>
							<select id="chronicle-sync-project" name="<?php echo esc_attr( $name ); ?>[sync_project]" <?php disabled( ! $status['ok'] ); ?>>
								<option value=""><?php esc_html_e( '— Choose —', 'chronicle-timeline' ); ?></option>
								<?php foreach ( $timelines as $t ) : ?>
									<option value="<?php echo esc_attr( $t['id'] ); ?>" <?php selected( $settings['sync_project'], $t['id'] ); ?>><?php echo esc_html( $t['title'] ); ?></option>
								<?php endforeach; ?>
							</select>
							<?php if ( ! $status['ok'] ) : ?>
								<input type="hidden" name="<?php echo esc_attr( $name ); ?>[sync_project]" value="<?php echo esc_attr( $settings['sync_project'] ); ?>">
								<p class="description"><?php esc_html_e( 'Connect an account to choose a timeline.', 'chronicle-timeline' ); ?></p>
							<?php endif; ?>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Post types', 'chronicle-timeline' ); ?></th>
						<td>
							<fieldset>
								<?php foreach ( $types as $type ) : ?>
									<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[sync_post_types][]" value="<?php echo esc_attr( $type->name ); ?>" <?php checked( in_array( $type->name, (array) $settings['sync_post_types'], true ) ); ?>> <?php echo esc_html( $type->labels->name ); ?></label><br>
								<?php endforeach; ?>
							</fieldset>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Publishing', 'chronicle-timeline' ); ?></th>
						<td><label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[sync_publish]" value="1" <?php checked( ! empty( $settings['sync_publish'] ) ); ?>> <?php esc_html_e( 'Publish a new timeline version after each change (otherwise changes wait in the timeline\'s draft)', 'chronicle-timeline' ); ?></label></td>
					</tr>
					<?php if ( is_array( $last_sync ) && isset( $last_sync['at'] ) ) : ?>
						<tr>
							<th scope="row"><?php esc_html_e( 'Last sync', 'chronicle-timeline' ); ?></th>
							<td id="chronicle-last-sync">
								<?php
								echo esc_html(
									sprintf(
										/* translators: 1: date and time, 2: result message */
										__( '%1$s — %2$s', 'chronicle-timeline' ),
										wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), (int) $last_sync['at'] ),
										(string) $last_sync['message']
									)
								);
								?>
							</td>
						</tr>
					<?php endif; ?>
				</table>

				<?php submit_button(); ?>
			</form>

			<h2><?php esc_html_e( 'Cache', 'chronicle-timeline' ); ?></h2>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="chronicle_timeline_clear_cache">
				<?php wp_nonce_field( 'chronicle_timeline_clear_cache' ); ?>
				<p><?php esc_html_e( 'Timelines are cached so pages stay fast and keep working if the Chronicle server is briefly unavailable.', 'chronicle-timeline' ); ?></p>
				<?php submit_button( __( 'Clear cached timelines', 'chronicle-timeline' ), 'secondary', 'submit', false ); ?>
			</form>
		</div>
		<?php
	}

	/**
	 * Layout names.
	 *
	 * @return array<string, string>
	 */
	public static function layout_labels(): array {
		return array(
			'vertical'   => __( 'Vertical', 'chronicle-timeline' ),
			'horizontal' => __( 'Horizontal', 'chronicle-timeline' ),
			'card'       => __( 'Cards', 'chronicle-timeline' ),
		);
	}

	/**
	 * Theme names.
	 *
	 * @return array<string, string>
	 */
	public static function theme_labels(): array {
		return array(
			'light'     => __( 'Light', 'chronicle-timeline' ),
			'dark'      => __( 'Dark', 'chronicle-timeline' ),
			'editorial' => __( 'Editorial', 'chronicle-timeline' ),
			'minimal'   => __( 'Minimal', 'chronicle-timeline' ),
		);
	}
}
