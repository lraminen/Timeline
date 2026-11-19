<?php
/**
 * Post → Chronicle event sync.
 *
 * @package ChronicleTimeline
 */

const SYNC_PROJECT = '11111111-2222-3333-4444-555555555555';

function enable_sync( array $more = array() ): void {
	connect(
		array_merge(
			array(
				'sync_enabled'    => true,
				'sync_project'    => SYNC_PROJECT,
				'sync_post_types' => array( 'post' ),
			),
			$more
		)
	);
}

/** A fake Chronicle events API that keeps events in memory. */
function fake_events_api( array &$events, array $overrides = array() ): void {
	$base = '/api/v1/projects/' . SYNC_PROJECT;
	http_routes(
		array_merge(
			array(
				"POST {$base}/events"     => static function ( $url, $args ) use ( &$events ) {
					$event                  = json_decode( $args['body'], true );
					$events[ $event['id'] ] = $event;
					return array( 201, $event );
				},
				"POST {$base}/revisions"  => array( 201, array( 'version' => 2 ) ),
				'*'                       => null,
			),
			$overrides
		)
	);
	// PATCH and DELETE address an event by id: wrap the handler to route them.
	$routes = $GLOBALS['chronicle_http'];
	$GLOBALS['chronicle_http'] = static function ( $url, $args ) use ( &$events, $routes, $base, $overrides ) {
		$path   = substr( $url, strlen( 'https://chronicle.test' ) );
		$method = $args['method'];
		if ( isset( $overrides[ "{$method} {$path}" ] ) || ! preg_match( '#^' . preg_quote( $base, '#' ) . '/events/([^/]+)$#', $path, $m ) ) {
			return $routes( $url, $args );
		}
		$id = rawurldecode( $m[1] );
		if ( ! isset( $events[ $id ] ) ) {
			return http_response( 404, array( 'error' => array( 'code' => 'not_found', 'message' => 'Event not found' ) ) );
		}
		if ( 'DELETE' === $method ) {
			unset( $events[ $id ] );
			return http_response( 204, '' );
		}
		$events[ $id ] = array_merge( $events[ $id ], json_decode( $args['body'], true ) );
		return http_response( 200, $events[ $id ] );
	};
}

function methods(): array {
	return array_map(
		static function ( $r ) {
			return $r['args']['method'] . ' ' . preg_replace( '#^https://chronicle\.test/api/v1/projects/[^/]+#', '', $r['url'] );
		},
		http_requests()
	);
}

function make_post( array $args = array() ): int {
	$id = wp_insert_post(
		array_merge(
			array(
				'post_title'   => 'Apollo 11 & the "Eagle"',
				'post_content' => '<!-- wp:paragraph --><p>The *first* crewed landing [on] the Moon.</p><!-- /wp:paragraph -->',
				'post_status'  => 'publish',
				'post_date'    => '1969-07-20 20:17:00',
				'tags_input'   => array( 'moon', 'apollo' ),
			),
			$args
		),
		true
	);
	if ( is_wp_error( $id ) ) {
		fail( $id->get_error_message() );
	}
	return $id;
}

test(
	'publishing a post creates its event with title, date, excerpt, link, image and tags',
	function () {
		enable_sync();
		$events = array();
		fake_events_api( $events );

		$attachment = wp_insert_attachment(
			array(
				'post_mime_type' => 'image/jpeg',
				'post_title'     => 'Eagle',
				'post_excerpt'   => 'The lunar module',
				'post_status'    => 'inherit',
			),
			'eagle.jpg'
		);
		update_post_meta( $attachment, '_wp_attachment_image_alt', 'Lunar module on the Moon' );
		$post = make_post();
		set_post_thumbnail( $post, $attachment );
		Chronicle_Timeline_Sync::flush();

		assert_same( array( 'PATCH /events/' . Chronicle_Timeline_Sync::event_id( $post ), 'POST /events' ), methods() );
		$event = $events[ Chronicle_Timeline_Sync::event_id( $post ) ] ?? fail( 'no event created' );
		assert_matches( '/^wp-[0-9a-f]{8}-' . $post . '$/', $event['id'] );
		assert_same( 'Apollo 11 & the “Eagle”', $event['title'], 'as the site displays it' );
		assert_same( array( 'start' => '1969-07-20' ), $event['date'] );
		assert_same( 'The \*first\* crewed landing \[on\] the Moon\.' . "\n\n[Read more](" . get_permalink( $post ) . ')', $event['body'] );
		$tags = $event['tags'];
		sort( $tags );
		assert_same( array( 'apollo', 'moon' ), $tags );
		assert_same( 'image', $event['media'][0]['type'] );
		assert_matches( '#^https?://.+/eagle\.jpg$#', $event['media'][0]['url'] );
		assert_same( 'Lunar module on the Moon', $event['media'][0]['alt'] );
		assert_same( 'The lunar module', $event['media'][0]['caption'] );
		assert_true( get_option( Chronicle_Timeline_Sync::LAST_RESULT_OPTION )['ok'] );
	}
);

test(
	'unchanged posts are not re-sent; changes are patched',
	function () {
		enable_sync();
		$events = array();
		fake_events_api( $events );
		$post = make_post();
		Chronicle_Timeline_Sync::flush();

		wp_update_post( array( 'ID' => $post ) );
		Chronicle_Timeline_Sync::flush();
		assert_same( 2, count( http_requests() ), 'an unchanged save sent requests' );

		wp_update_post(
			array(
				'ID'           => $post,
				'post_title'   => 'Apollo 11',
				'post_excerpt' => 'Short summary',
			)
		);
		Chronicle_Timeline_Sync::flush();
		assert_same( 'PATCH /events/' . Chronicle_Timeline_Sync::event_id( $post ), methods()[2] );
		$event = $events[ Chronicle_Timeline_Sync::event_id( $post ) ];
		assert_same( 'Apollo 11', $event['title'] );
		assert_matches( '/^Short summary\n\n\[Read more\]/', $event['body'] );
	}
);

test(
	'unpublishing, password-protecting, trashing and deleting remove the event',
	function () {
		enable_sync();
		$events = array();
		fake_events_api( $events );

		$draft = make_post();
		Chronicle_Timeline_Sync::flush();
		wp_update_post(
			array(
				'ID'          => $draft,
				'post_status' => 'draft',
			)
		);
		Chronicle_Timeline_Sync::flush();
		assert_false( isset( $events[ Chronicle_Timeline_Sync::event_id( $draft ) ] ), 'draft' );

		$protected = make_post();
		Chronicle_Timeline_Sync::flush();
		wp_update_post(
			array(
				'ID'            => $protected,
				'post_password' => 'secret',
			)
		);
		Chronicle_Timeline_Sync::flush();
		assert_false( isset( $events[ Chronicle_Timeline_Sync::event_id( $protected ) ] ), 'password' );

		$trashed = make_post();
		Chronicle_Timeline_Sync::flush();
		wp_trash_post( $trashed );
		Chronicle_Timeline_Sync::flush();
		assert_false( isset( $events[ Chronicle_Timeline_Sync::event_id( $trashed ) ] ), 'trash' );

		$deleted = make_post();
		Chronicle_Timeline_Sync::flush();
		wp_delete_post( $deleted, true );
		assert_false( isset( $events[ Chronicle_Timeline_Sync::event_id( $deleted ) ] ), 'delete' );
		Chronicle_Timeline_Sync::flush();

		assert_same( array(), $events );
		// A never-published draft makes no requests at all.
		$before = count( http_requests() );
		make_post( array( 'post_status' => 'draft' ) );
		Chronicle_Timeline_Sync::flush();
		assert_same( $before, count( http_requests() ) );
	}
);

test(
	'only the configured post types are synced, and nothing when sync is off',
	function () {
		enable_sync( array( 'sync_post_types' => array( 'page' ) ) );
		$events = array();
		fake_events_api( $events );
		make_post();
		Chronicle_Timeline_Sync::flush();
		assert_same( 0, count( http_requests() ) );

		enable_sync( array( 'sync_enabled' => false ) );
		make_post();
		Chronicle_Timeline_Sync::flush();
		assert_same( 0, count( http_requests() ) );
	}
);

test(
	'transient failures are retried with back-off; rejected events are not',
	function () {
		enable_sync();
		$events = array();
		$base   = '/api/v1/projects/' . SYNC_PROJECT;
		fake_events_api( $events, array( "POST {$base}/events" => array( 503, array( 'error' => array( 'code' => 'unavailable', 'message' => 'Down for maintenance' ) ) ) ) );
		$post = make_post();
		Chronicle_Timeline_Sync::flush();
		$next = wp_next_scheduled( Chronicle_Timeline_Sync::RETRY_HOOK, array( $post, 'upsert', 2 ) );
		assert_true( false !== $next && abs( $next - time() - 300 ) < 5, 'retry in 5 minutes' );
		$status = get_post_meta( $post, Chronicle_Timeline_Sync::META_STATUS, true );
		assert_false( $status['ok'] );
		assert_same( 'Down for maintenance', $status['message'] );

		// Second failure: 10 minutes.
		Chronicle_Timeline_Sync::retry( $post, 'upsert', 2 );
		$next = wp_next_scheduled( Chronicle_Timeline_Sync::RETRY_HOOK, array( $post, 'upsert', 3 ) );
		assert_true( false !== $next && abs( $next - time() - 600 ) < 5, 'retry in 10 minutes' );

		// The server recovers.
		fake_events_api( $events );
		Chronicle_Timeline_Sync::retry( $post, 'upsert', 3 );
		assert_true( isset( $events[ Chronicle_Timeline_Sync::event_id( $post ) ] ) );
		assert_true( get_post_meta( $post, Chronicle_Timeline_Sync::META_STATUS, true )['ok'] );

		// A validation error is permanent.
		_set_cron_array( array() );
		fake_events_api( $events, array( "POST {$base}/events" => array( 400, array( 'error' => array( 'code' => 'bad_request', 'message' => 'Invalid event' ) ) ) ) );
		$bad = make_post();
		Chronicle_Timeline_Sync::flush();
		assert_false( wp_next_scheduled( Chronicle_Timeline_Sync::RETRY_HOOK, array( $bad, 'upsert', 2 ) ) );
	}
);

test(
	'"publish after sync" publishes one version per batch of changes',
	function () {
		enable_sync( array( 'sync_publish' => true ) );
		$events = array();
		fake_events_api( $events );
		make_post();
		make_post( array( 'post_title' => 'Second' ) );
		Chronicle_Timeline_Sync::flush();
		$publishes = array_values(
			array_filter(
				http_requests(),
				static function ( $r ) {
					return 'POST' === $r['args']['method'] && '/revisions' === substr( $r['url'], -10 );
				}
			)
		);
		assert_same( 1, count( $publishes ) );
		assert_same( array( 'message' => 'Updated from WordPress' ), request_json( $publishes[0] ) );
		assert_same( 2, count( $events ) );

		// Nothing changed → no new version.
		$before = count( http_requests() );
		Chronicle_Timeline_Sync::process( array() );
		assert_same( $before, count( http_requests() ) );
	}
);

test(
	'markdown in excerpts is escaped so it shows as typed',
	function () {
		assert_same( '1\. \*not\* \_em\_ \[x\]\(y\) \#tag \\\\ \`code\` \!', Chronicle_Timeline_Sync::escape_markdown( '1. *not* _em_ [x](y) #tag \\ `code` !' ) );
	}
);
