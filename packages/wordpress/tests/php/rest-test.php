<?php
/**
 * REST endpoints used by the block editor.
 *
 * @package ChronicleTimeline
 */

function rest_get( string $route, array $params = array() ): WP_REST_Response {
	$request = new WP_REST_Request( 'GET', $route );
	foreach ( $params as $k => $v ) {
		$request->set_param( $k, $v );
	}
	return rest_do_request( $request );
}

function projects_response(): array {
	$base = array(
		'role'           => 'owner',
		'draftVersion'   => 3,
		'eventCount'     => 4,
		'updatedAt'      => '2026-11-01T00:00:00.000Z',
		'createdAt'      => '2026-10-01T00:00:00.000Z',
	);
	return array(
		'projects' => array(
			array_merge( $base, array( 'id' => 'p1', 'title' => 'Public', 'slug' => 'public-1', 'isPublic' => true, 'publishedVersion' => 2 ) ),
			array_merge( $base, array( 'id' => 'p2', 'title' => 'Private', 'slug' => 'private-2', 'isPublic' => false, 'publishedVersion' => 1 ) ),
			array_merge( $base, array( 'id' => 'p3', 'title' => 'Draft <b>only</b>', 'slug' => 'draft-3', 'isPublic' => true, 'publishedVersion' => null ) ),
			array_merge( $base, array( 'id' => 'p4', 'title' => 'Bad slug', 'slug' => '../x', 'isPublic' => true, 'publishedVersion' => 1 ) ),
		),
	);
}

test(
	'only people who can edit posts may list timelines or preview them',
	function () {
		connect();
		http_routes( array( 'GET /api/v1/projects' => array( 200, projects_response() ) ) );
		assert_same( 401, rest_get( '/chronicle/v1/timelines' )->get_status() );
		assert_same( 401, rest_get( '/chronicle/v1/preview', array( 'slug' => 'x' ) )->get_status() );
		wp_set_current_user( make_user( 'subscriber' ) );
		assert_same( 403, rest_get( '/chronicle/v1/timelines' )->get_status() );
		assert_same( 0, count( http_requests() ), 'no request to Chronicle for unauthorised users' );
	}
);

test(
	'lists the account timelines, marking which can be embedded, without exposing the key',
	function () {
		connect();
		http_routes( array( 'GET /api/v1/projects' => array( 200, projects_response() ) ) );
		wp_set_current_user( make_user( 'author' ) );
		$res = rest_get( '/chronicle/v1/timelines' );
		assert_same( 200, $res->get_status() );
		$data = $res->get_data();
		assert_same( 'https://chronicle.test', $data['server'] );
		assert_same( array( 'public-1', 'private-2', 'draft-3' ), wp_list_pluck( $data['timelines'], 'slug' ) );
		assert_same( array( true, false, false ), wp_list_pluck( $data['timelines'], 'embeddable' ) );
		assert_same( 'Draft only', $data['timelines'][2]['title'] );
		assert_not_contains( TEST_KEY, wp_json_encode( $data ) );
		assert_not_contains( substr( TEST_KEY, 18 ), wp_json_encode( $data ) );
	}
);

test(
	'explains when no account is connected, and when the key is rejected',
	function () {
		wp_set_current_user( make_user( 'editor' ) );
		$res = rest_get( '/chronicle/v1/timelines' );
		assert_same( 400, $res->get_status() );
		assert_same( 'chronicle_not_configured', $res->get_data()['code'] );

		connect();
		http_routes(
			array(
				'GET /api/v1/projects' => array(
					401,
					array(
						'error' => array(
							'code'    => 'unauthorized',
							'message' => 'Invalid or expired API key',
						),
					),
				),
			)
		);
		$res = rest_get( '/chronicle/v1/timelines' );
		assert_same( 502, $res->get_status(), 'the upstream 401 must not look like a WordPress auth failure' );
		assert_same( 'Invalid or expired API key', $res->get_data()['message'] );
	}
);

test(
	'preview returns the published timeline, from the configured or another server',
	function () {
		connect();
		wp_set_current_user( make_user( 'author' ) );
		http_routes(
			array(
				'GET /api/v1/embed/space-race/v/1' => array( 200, embed_body() ),
				'GET https://other.example/api/v1/embed/theirs' => array( 200, embed_body( sample_timeline( array( 'title' => 'Theirs' ) ) ) ),
			)
		);
		$res = rest_get(
			'/chronicle/v1/preview',
			array(
				'slug'    => 'space-race',
				'version' => 1,
			)
		);
		assert_same( 200, $res->get_status() );
		assert_same( 'Space Race', $res->get_data()['timeline']['title'] );
		assert_same( 1, $res->get_data()['version'] );
		assert_same( 'https://chronicle.test/timeline/space-race', $res->get_data()['pageUrl'] );

		$other = rest_get(
			'/chronicle/v1/preview',
			array(
				'slug'   => 'theirs',
				'server' => 'https://other.example',
			)
		);
		assert_same( 'Theirs', $other->get_data()['timeline']['title'] );
	}
);

test(
	'preview validates its input',
	function () {
		connect();
		wp_set_current_user( make_user( 'author' ) );
		http_routes( array() );
		assert_same( 400, rest_get( '/chronicle/v1/preview', array( 'slug' => '../../x' ) )->get_status() );
		assert_same( 400, rest_get( '/chronicle/v1/preview' )->get_status() );
		assert_same(
			400,
			rest_get(
				'/chronicle/v1/preview',
				array(
					'slug'   => 'x',
					'server' => 'file:///etc/passwd',
				)
			)->get_status()
		);
		assert_same(
			400,
			rest_get(
				'/chronicle/v1/preview',
				array(
					'slug'   => 'x',
					'server' => 'http://169.254.169.254',
				)
			)->get_status(),
			'plain http to another server'
		);
		assert_same( 404, rest_get( '/chronicle/v1/preview', array( 'slug' => 'missing' ) )->get_status() );
		assert_same( 1, count( http_requests() ) );
	}
);
