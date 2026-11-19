<?php
/**
 * A tiny test harness. WordPress's own PHPUnit suite needs MySQL and a
 * wordpress-develop checkout, which Playground doesn't provide; this runs
 * against the real WordPress that Playground boots.
 *
 * @package ChronicleTimeline
 */

/**
 * Assertion failure.
 */
final class Chronicle_Test_Failure extends Exception {}

$GLOBALS['chronicle_tests'] = array();

function test( string $name, callable $fn ): void {
	$GLOBALS['chronicle_tests'][] = array( $name, $fn );
}

function fail( string $message ): void {
	throw new Chronicle_Test_Failure( $message );
}

function export( $value ): string {
	$s = var_export( $value, true );
	return strlen( $s ) > 700 ? substr( $s, 0, 700 ) . '…' : $s;
}

function assert_same( $expected, $actual, string $message = '' ): void {
	if ( $expected !== $actual ) {
		fail( ( $message ? $message . ': ' : '' ) . 'expected ' . export( $expected ) . ', got ' . export( $actual ) );
	}
}

function assert_true( $value, string $message = 'expected true' ): void {
	if ( true !== $value ) {
		fail( $message . ' (got ' . export( $value ) . ')' );
	}
}

function assert_false( $value, string $message = 'expected false' ): void {
	if ( false !== $value ) {
		fail( $message . ' (got ' . export( $value ) . ')' );
	}
}

function assert_contains( string $needle, string $haystack, string $message = '' ): void {
	if ( false === strpos( $haystack, $needle ) ) {
		fail( ( $message ? $message . ': ' : '' ) . 'expected to find ' . export( $needle ) . ' in ' . export( $haystack ) );
	}
}

function assert_not_contains( string $needle, string $haystack, string $message = '' ): void {
	if ( false !== stripos( $haystack, $needle ) ) {
		fail( ( $message ? $message . ': ' : '' ) . 'did not expect ' . export( $needle ) . ' in ' . export( $haystack ) );
	}
}

function assert_matches( string $pattern, string $subject, string $message = '' ): void {
	if ( 1 !== preg_match( $pattern, $subject ) ) {
		fail( ( $message ? $message . ': ' : '' ) . export( $subject ) . ' does not match ' . $pattern );
	}
}

function assert_wp_error( $value, string $code = '' ): WP_Error {
	if ( ! is_wp_error( $value ) ) {
		fail( 'expected WP_Error, got ' . export( $value ) );
	}
	if ( '' !== $code && $value->get_error_code() !== $code ) {
		fail( 'expected error ' . $code . ', got ' . $value->get_error_code() . ': ' . $value->get_error_message() );
	}
	return $value;
}

/*
 * HTTP mocking: every outgoing request is recorded and answered by the
 * current handler; nothing reaches the network.
 */
$GLOBALS['chronicle_requests'] = array();
$GLOBALS['chronicle_http']     = null;

add_filter(
	'pre_http_request',
	static function ( $pre, $args, $url ) {
		$GLOBALS['chronicle_requests'][] = array(
			'url'  => $url,
			'args' => $args,
		);
		$handler = $GLOBALS['chronicle_http'];
		if ( ! $handler ) {
			return new WP_Error( 'http_request_failed', 'No HTTP handler in this test' );
		}
		return $handler( $url, $args );
	},
	10,
	3
);

/**
 * Sets the HTTP handler. Routes map "METHOD /path?query" (or without the
 * query) to [status, body], a WP_Error, or a callable returning either.
 *
 * @param array<string, mixed> $routes Routes.
 * @param string               $server Server prefix to strip from URLs.
 */
function http_routes( array $routes, string $server = 'https://chronicle.test' ): void {
	$GLOBALS['chronicle_requests'] = array();
	$GLOBALS['chronicle_http']     = static function ( $url, $args ) use ( $routes, $server ) {
		$path  = 0 === strpos( $url, $server ) ? substr( $url, strlen( $server ) ) : $url;
		$key   = ( $args['method'] ?? 'GET' ) . ' ' . $path;
		$route = $routes[ $key ] ?? $routes[ (string) preg_replace( '/\?.*$/', '', $key ) ] ?? null;
		if ( null === $route ) {
			return http_response(
				404,
				array(
					'error' => array(
						'code'    => 'not_found',
						'message' => 'No route ' . $key,
					),
				)
			);
		}
		if ( is_callable( $route ) ) {
			$route = $route( $url, $args );
		}
		if ( is_wp_error( $route ) ) {
			return $route;
		}
		return http_response( $route[0], $route[1] );
	};
}

function http_response( int $status, $body ): array {
	return array(
		'headers'  => array(),
		'body'     => is_string( $body ) ? $body : wp_json_encode( $body ),
		'response' => array(
			'code'    => $status,
			'message' => get_status_header_desc( $status ),
		),
		'cookies'  => array(),
		'filename' => null,
	);
}

/**
 * Requests made since the routes were set.
 *
 * @return array<int, array{url: string, args: array}>
 */
function http_requests(): array {
	return $GLOBALS['chronicle_requests'];
}

/** The decoded JSON body of a recorded request. */
function request_json( array $request ) {
	return json_decode( (string) ( $request['args']['body'] ?? '' ), true );
}

function configure( array $settings ): void {
	update_option( Chronicle_Timeline_Settings::OPTION, array_merge( Chronicle_Timeline_Settings::defaults(), $settings ) );
}

const TEST_KEY = 'chr_abcdefABCDEF_0123456789abcdefghijABCDEFGHIJklmnopqrst-_x';

function connect( array $more = array() ): void {
	configure(
		array_merge(
			array(
				'server_url' => 'https://chronicle.test',
				'api_key'    => TEST_KEY,
			),
			$more
		)
	);
}

function sample_timeline( array $overrides = array() ): array {
	return array_merge(
		array(
			'schemaVersion' => '1.0.0',
			'id'            => 't1',
			'title'         => 'Space Race',
			'events'        => array(
				array(
					'id'    => 'e1',
					'title' => 'Sputnik',
					'date'  => array( 'start' => '1957-10-04' ),
					'media' => array(),
					'tags'  => array( 'space' ),
				),
			),
			'eras'          => array(),
			'settings'      => array(
				'layout' => 'vertical',
				'theme'  => 'light',
				'locale' => 'en',
			),
		),
		$overrides
	);
}

function embed_body( array $timeline = array(), array $extra = array() ): array {
	return array_merge(
		array(
			'version'      => 1,
			'publishedAt'  => '2026-01-01T00:00:00.000Z',
			'pageUrl'      => 'https://chronicle.test/timeline/space-race',
			'timeline'     => $timeline ? $timeline : sample_timeline(),
			'fallbackHtml' => '<ol class="ssr-events"><li class="ssr-event"><article aria-labelledby="ev-e1"><h2 id="ev-e1">Sputnik</h2></article></li></ol>',
		),
		$extra
	);
}

function make_user( string $role ): int {
	$id = wp_insert_user(
		array(
			'user_login' => $role . '_' . wp_generate_password( 8, false ),
			'user_pass'  => wp_generate_password(),
			'user_email' => wp_generate_password( 8, false ) . '@example.org',
			'role'       => $role,
		)
	);
	if ( is_wp_error( $id ) ) {
		fail( $id->get_error_message() );
	}
	return $id;
}

/** Resets state shared between tests. */
function reset_state(): void {
	global $wp_settings_errors;
	delete_option( Chronicle_Timeline_Settings::OPTION );
	delete_option( Chronicle_Timeline_Sync::LAST_RESULT_OPTION );
	Chronicle_Timeline_Renderer::clear_cache();
	wp_set_current_user( 0 );
	$GLOBALS['chronicle_http']     = null;
	$GLOBALS['chronicle_requests'] = array();
	wp_dequeue_script( Chronicle_Timeline_Assets::COMPONENT );
	_set_cron_array( array() );
	$wp_settings_errors = array();
}

function run_tests(): void {
	$passed = 0;
	$failed = array();
	foreach ( $GLOBALS['chronicle_tests'] as list( $name, $fn ) ) {
		reset_state();
		try {
			$fn();
			++$passed;
			echo "  ok   {$name}\n";
		} catch ( Throwable $e ) {
			$failed[] = $name;
			$frame    = $e->getTrace()[1] ?? array();
			$where    = $e instanceof Chronicle_Test_Failure
				? basename( $frame['file'] ?? $e->getFile() ) . ':' . ( $frame['line'] ?? $e->getLine() )
				: get_class( $e ) . ' at ' . basename( $e->getFile() ) . ':' . $e->getLine();
			echo "  FAIL {$name}\n       {$e->getMessage()}\n       ({$where})\n";
		}
	}
	$total   = $passed + count( $failed );
	$runtime = 'PHP ' . PHP_VERSION . ', WordPress ' . get_bloginfo( 'version' );
	echo "\n";
	if ( $failed ) {
		echo "PHP TESTS FAILED: {$passed}/{$total} passed ({$runtime})\n";
		exit( 1 );
	}
	echo "PHP TESTS PASSED: {$total} tests ({$runtime})\n";
}
