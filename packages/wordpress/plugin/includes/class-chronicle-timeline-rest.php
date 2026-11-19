<?php
/**
 * REST endpoints used by the block editor.
 *
 * @package ChronicleTimeline
 */

defined( 'ABSPATH' ) || exit;

/**
 * `chronicle/v1/timelines` lists the connected account's timelines and
 * `chronicle/v1/preview` returns a published timeline for the editor
 * preview. Both proxy through WordPress so the API key never reaches the
 * browser, and both require the `edit_posts` capability.
 */
final class Chronicle_Timeline_Rest {

	const ROUTE_NAMESPACE = 'chronicle/v1';

	/**
	 * Hooks.
	 */
	public static function init(): void {
		add_action( 'rest_api_init', array( __CLASS__, 'register' ) );
	}

	/**
	 * Registers the routes.
	 */
	public static function register(): void {
		register_rest_route(
			self::ROUTE_NAMESPACE,
			'/timelines',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'timelines' ),
				'permission_callback' => array( __CLASS__, 'can_edit' ),
			)
		);
		register_rest_route(
			self::ROUTE_NAMESPACE,
			'/preview',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'preview' ),
				'permission_callback' => array( __CLASS__, 'can_edit' ),
				'args'                => array(
					'slug'    => array(
						'type'              => 'string',
						'required'          => true,
						'validate_callback' => static function ( $value ) {
							return Chronicle_Timeline_Urls::is_valid_slug( $value );
						},
					),
					'server'  => array(
						'type'    => 'string',
						'default' => '',
					),
					'version' => array(
						'type'    => 'integer',
						'minimum' => 0,
						'default' => 0,
					),
				),
			)
		);
	}

	/**
	 * Only people who can write posts may browse timelines.
	 */
	public static function can_edit(): bool {
		return current_user_can( 'edit_posts' );
	}

	/**
	 * The connected account's timelines, most recently updated first.
	 *
	 * @return WP_REST_Response|WP_Error
	 */
	public static function timelines() {
		$client = Chronicle_Timeline_Settings::account_client();
		if ( is_wp_error( $client ) ) {
			return $client;
		}
		$res = $client->request( 'GET', '/api/v1/projects' );
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		$projects = is_array( $res['body'] ) && isset( $res['body']['projects'] ) && is_array( $res['body']['projects'] ) ? $res['body']['projects'] : array();

		$out = array();
		foreach ( $projects as $p ) {
			if ( ! is_array( $p ) || ! isset( $p['slug'] ) || ! Chronicle_Timeline_Urls::is_valid_slug( $p['slug'] ) ) {
				continue;
			}
			$published = isset( $p['publishedVersion'] ) && is_int( $p['publishedVersion'] ) ? $p['publishedVersion'] : null;
			$public    = ! empty( $p['isPublic'] );
			$out[]     = array(
				'id'               => isset( $p['id'] ) ? sanitize_text_field( (string) $p['id'] ) : '',
				'title'            => isset( $p['title'] ) ? sanitize_text_field( (string) $p['title'] ) : '',
				'slug'             => $p['slug'],
				'role'             => isset( $p['role'] ) ? sanitize_key( (string) $p['role'] ) : '',
				'isPublic'         => $public,
				'publishedVersion' => $published,
				'eventCount'       => isset( $p['eventCount'] ) ? (int) $p['eventCount'] : 0,
				'updatedAt'        => isset( $p['updatedAt'] ) ? sanitize_text_field( (string) $p['updatedAt'] ) : '',
				'embeddable'       => $public && null !== $published,
			);
		}
		return rest_ensure_response(
			array(
				'server'    => $client->server(),
				'timelines' => $out,
			)
		);
	}

	/**
	 * A published timeline for the editor preview.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function preview( WP_REST_Request $request ) {
		$server = (string) $request->get_param( 'server' );
		if ( '' !== $server && '' === Chronicle_Timeline_Urls::normalize_server_url( $server ) ) {
			return new WP_Error( 'rest_invalid_param', __( 'Invalid server URL.', 'chronicle-timeline' ), array( 'status' => 400 ) );
		}
		$result = Chronicle_Timeline_Renderer::fetch( $server, (string) $request->get_param( 'slug' ), (int) $request->get_param( 'version' ) );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		return rest_ensure_response(
			array(
				'version'  => isset( $result['version'] ) ? (int) $result['version'] : 0,
				'pageUrl'  => isset( $result['pageUrl'] ) && is_string( $result['pageUrl'] ) ? esc_url_raw( $result['pageUrl'], array( 'http', 'https' ) ) : '',
				'timeline' => $result['timeline'],
			)
		);
	}
}
