<?php
/**
 * HTTP client for the Chronicle API.
 *
 * @package ChronicleTimeline
 */

defined( 'ABSPATH' ) || exit;

/**
 * Talks to one Chronicle server.
 *
 * A "trusted" client targets the server configured by an administrator: it
 * may be on a private network and it receives the API key. Any other server
 * (from a link pasted into a block) is untrusted: requests go through
 * wp_safe_remote_request(), which refuses private and reserved addresses,
 * must use https, and never carry the API key.
 */
final class Chronicle_Timeline_Client {

	const TIMEOUT = 8;

	const MAX_BYTES = 5242880;

	/**
	 * Server base URL.
	 *
	 * @var string
	 */
	private $server;

	/**
	 * API key (trusted clients only).
	 *
	 * @var string
	 */
	private $api_key;

	/**
	 * Whether this is the administrator-configured server.
	 *
	 * @var bool
	 */
	private $trusted;

	/**
	 * Constructor.
	 *
	 * @param string $server  Normalised server base URL.
	 * @param string $api_key API key; ignored for untrusted servers.
	 * @param bool   $trusted Whether this is the configured server.
	 */
	public function __construct( string $server, string $api_key = '', bool $trusted = false ) {
		$this->server  = $server;
		$this->trusted = $trusted;
		$this->api_key = $trusted ? $api_key : '';
	}

	/**
	 * A client for `$server`: trusted when it is the configured server.
	 *
	 * @param string $server Server base URL ('' = the configured server).
	 * @return Chronicle_Timeline_Client|WP_Error
	 */
	public static function for_server( string $server ) {
		$configured = Chronicle_Timeline_Settings::server_url();
		if ( '' === $server || Chronicle_Timeline_Urls::same_server( $server, $configured ) ) {
			if ( '' === $configured ) {
				return new WP_Error( 'chronicle_not_configured', __( 'No Chronicle server is configured. Paste a full timeline link, or set the server under Settings → Chronicle.', 'chronicle-timeline' ), array( 'status' => 400 ) );
			}
			return new self( $configured, (string) Chronicle_Timeline_Settings::get()['api_key'], true );
		}
		$server = Chronicle_Timeline_Urls::normalize_server_url( $server );
		if ( '' === $server || 0 !== strpos( $server, 'https://' ) ) {
			return new WP_Error( 'chronicle_insecure_server', __( 'Timelines from other Chronicle servers must use https.', 'chronicle-timeline' ), array( 'status' => 400 ) );
		}
		return new self( $server );
	}

	/**
	 * The server base URL.
	 */
	public function server(): string {
		return $this->server;
	}

	/**
	 * Whether this client targets the configured server.
	 */
	public function is_trusted(): bool {
		return $this->trusted;
	}

	/**
	 * Fetches the published timeline (`GET /api/v1/embed/{slug}[/v/{n}]`),
	 * including the server-rendered no-JS fallback.
	 *
	 * @param string $slug    Timeline slug.
	 * @param int    $version Pinned version, or 0 for the latest.
	 * @return array<string, mixed>|WP_Error
	 */
	public function embed( string $slug, int $version = 0 ) {
		if ( ! Chronicle_Timeline_Urls::is_valid_slug( $slug ) ) {
			return new WP_Error( 'chronicle_invalid_slug', __( 'Invalid timeline identifier.', 'chronicle-timeline' ), array( 'status' => 400 ) );
		}
		$path = '/api/v1/embed/' . rawurlencode( $slug ) . ( $version > 0 ? '/v/' . $version : '' ) . '?include=fallback';
		// Public endpoint: never send the key, so a private timeline can't leak onto a site.
		$res = $this->request( 'GET', $path, null, false );
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		$body = $res['body'];
		if ( ! is_array( $body ) || ! isset( $body['timeline'] ) || ! is_array( $body['timeline'] ) || ! isset( $body['timeline']['events'] ) || ! is_array( $body['timeline']['events'] ) ) {
			return new WP_Error( 'chronicle_bad_response', __( 'The Chronicle server returned something that is not a timeline.', 'chronicle-timeline' ), array( 'status' => 502 ) );
		}
		return $body;
	}

	/**
	 * Performs a request and decodes the JSON response.
	 *
	 * @param string     $method HTTP method.
	 * @param string     $path   Path below the server URL, starting with `/api/v1/`.
	 * @param mixed|null $body   JSON body.
	 * @param bool       $auth   Whether to send the API key (trusted clients only).
	 * @return array{status: int, body: mixed}|WP_Error Errors carry the HTTP status in their data.
	 */
	public function request( string $method, string $path, $body = null, bool $auth = true ) {
		$headers = array(
			'Accept'     => 'application/json',
			'User-Agent' => 'Chronicle-WordPress/' . CHRONICLE_TIMELINE_VERSION,
		);
		if ( $auth && $this->trusted && '' !== $this->api_key ) {
			$headers['X-API-Key'] = $this->api_key;
		}
		$args = array(
			'method'              => $method,
			'timeout'             => self::TIMEOUT,
			'redirection'         => 0,
			'headers'             => $headers,
			'limit_response_size' => self::MAX_BYTES,
		);
		if ( null !== $body ) {
			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = wp_json_encode( $body );
		}

		$url      = $this->server . $path;
		$response = $this->trusted ? wp_remote_request( $url, $args ) : wp_safe_remote_request( $url, $args );
		if ( is_wp_error( $response ) ) {
			return new WP_Error(
				'chronicle_unreachable',
				/* translators: %s: error message from the HTTP library */
				sprintf( __( 'Could not reach the Chronicle server: %s', 'chronicle-timeline' ), $response->get_error_message() ),
				array( 'status' => 502 )
			);
		}

		$status  = (int) wp_remote_retrieve_response_code( $response );
		$raw     = (string) wp_remote_retrieve_body( $response );
		$decoded = '' === $raw ? null : json_decode( $raw, true );

		if ( $status >= 200 && $status < 300 ) {
			if ( '' !== $raw && null === $decoded ) {
				return new WP_Error( 'chronicle_bad_response', __( 'The Chronicle server returned invalid JSON.', 'chronicle-timeline' ), array( 'status' => 502 ) );
			}
			return array(
				'status' => $status,
				'body'   => $decoded,
			);
		}

		$message = is_array( $decoded ) && isset( $decoded['error']['message'] ) && is_string( $decoded['error']['message'] )
			? $decoded['error']['message']
			/* translators: %d: HTTP status code */
			: sprintf( __( 'The Chronicle server responded with HTTP %d.', 'chronicle-timeline' ), $status );
		$code    = is_array( $decoded ) && isset( $decoded['error']['code'] ) && is_string( $decoded['error']['code'] )
			? $decoded['error']['code']
			: 'http_' . $status;
		// Keep the upstream status for callers, but don't let e.g. the server's
		// 401 (bad API key) become this site's own REST response status.
		return new WP_Error(
			'chronicle_' . sanitize_key( $code ),
			sanitize_text_field( $message ),
			array(
				'status'          => 404 === $status ? 404 : 502,
				'upstream_status' => $status,
			)
		);
	}
}
