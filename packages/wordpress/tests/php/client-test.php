<?php
/**
 * HTTP client: trust boundaries and error mapping.
 *
 * @package ChronicleTimeline
 */

test(
	'the configured server gets the API key; the public embed endpoint never does',
	function () {
		connect();
		http_routes(
			array(
				'GET /api/v1/projects'     => array( 200, array( 'projects' => array() ) ),
				'GET /api/v1/embed/x'      => array( 200, embed_body() ),
				'GET /api/v1/embed/x/v/2'  => array( 200, embed_body() ),
			)
		);
		$client = Chronicle_Timeline_Client::for_server( '' );
		assert_true( $client->is_trusted() );
		$client->request( 'GET', '/api/v1/projects' );
		$client->embed( 'x' );
		$client->embed( 'x', 2 );

		list( $list, $embed, $pinned ) = http_requests();
		assert_same( TEST_KEY, $list['args']['headers']['X-API-Key'] ?? null );
		assert_same( 'https://chronicle.test/api/v1/embed/x?include=fallback', $embed['url'] );
		assert_same( 'https://chronicle.test/api/v1/embed/x/v/2?include=fallback', $pinned['url'] );
		assert_false( isset( $embed['args']['headers']['X-API-Key'] ), 'embed sent the key' );
		assert_same( 0, $embed['args']['redirection'] );
		assert_false( (bool) ( $list['args']['reject_unsafe_urls'] ?? false ), 'configured server may be internal' );
	}
);

test(
	'other servers are untrusted: https only, safe requests, never the key',
	function () {
		connect();
		http_routes( array( 'GET /api/v1/embed/x' => array( 200, embed_body() ) ), 'https://other.example' );
		$client = Chronicle_Timeline_Client::for_server( 'https://other.example' );
		assert_false( $client->is_trusted() );
		$client->request( 'GET', '/api/v1/projects' );
		$client->embed( 'x' );
		foreach ( http_requests() as $request ) {
			assert_false( isset( $request['args']['headers']['X-API-Key'] ), 'key sent to ' . $request['url'] );
			assert_true( $request['args']['reject_unsafe_urls'] );
		}

		assert_wp_error( Chronicle_Timeline_Client::for_server( 'http://other.example' ), 'chronicle_insecure_server' );
		// Same host as configured but different scheme/path is a different server.
		assert_false( Chronicle_Timeline_Client::for_server( 'https://chronicle.test/other' )->is_trusted() );
		// The configured server matches regardless of case and trailing slash.
		assert_true( Chronicle_Timeline_Client::for_server( 'https://CHRONICLE.test/' )->is_trusted() );
	}
);

test(
	'without a configured server, only full links to https servers work',
	function () {
		assert_wp_error( Chronicle_Timeline_Client::for_server( '' ), 'chronicle_not_configured' );
		assert_wp_error( Chronicle_Timeline_Settings::account_client(), 'chronicle_not_configured' );
		assert_false( Chronicle_Timeline_Client::for_server( 'https://other.example' )->is_trusted() );
	}
);

test(
	'server errors keep their message and upstream status; only 404 passes through',
	function () {
		connect();
		http_routes(
			array(
				'GET /api/v1/me'       => array(
					401,
					array(
						'error' => array(
							'code'    => 'unauthorized',
							'message' => 'Invalid API key <b>x</b>',
						),
					),
				),
				'GET /api/v1/embed/gone' => array(
					404,
					array(
						'error' => array(
							'code'    => 'not_found',
							'message' => 'Timeline not found',
						),
					),
				),
				'GET /api/v1/embed/html' => array( 200, '<html>oops</html>' ),
				'GET /api/v1/embed/odd'  => array( 200, array( 'timeline' => 'nope' ) ),
				'GET /api/v1/embed/down' => new WP_Error( 'http_request_failed', 'Connection refused' ),
			)
		);
		$client = Chronicle_Timeline_Settings::account_client();

		$e = assert_wp_error( $client->request( 'GET', '/api/v1/me' ), 'chronicle_unauthorized' );
		assert_same( 'Invalid API key x', $e->get_error_message() );
		assert_same(
			array(
				'status'          => 502,
				'upstream_status' => 401,
			),
			$e->get_error_data()
		);

		$e = assert_wp_error( $client->embed( 'gone' ), 'chronicle_not_found' );
		assert_same( 404, $e->get_error_data()['status'] );

		assert_wp_error( $client->embed( 'html' ), 'chronicle_bad_response' );
		assert_wp_error( $client->embed( 'odd' ), 'chronicle_bad_response' );
		$e = assert_wp_error( $client->embed( 'down' ), 'chronicle_unreachable' );
		assert_contains( 'Connection refused', $e->get_error_message() );
		assert_wp_error( $client->embed( '../etc/passwd' ), 'chronicle_invalid_slug' );
	}
);
