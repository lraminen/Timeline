<?php
/**
 * Rendering: markup, escaping, fallback sanitising, caching and outages.
 *
 * @package ChronicleTimeline
 */

function render_block_markup( array $attrs ): string {
	return do_blocks( '<!-- wp:chronicle/timeline ' . ( $attrs ? wp_json_encode( $attrs ) . ' ' : '' ) . '/-->' );
}

test(
	'renders the component with its data, attributes and server-rendered fallback',
	function () {
		connect();
		http_routes( array( 'GET /api/v1/embed/space-race' => array( 200, embed_body() ) ) );
		$html = render_block_markup(
			array(
				'slug'       => 'space-race',
				'layout'     => 'horizontal',
				'theme'      => 'dark',
				'height'     => '600',
				'filterTags' => ' space , moon,,',
				'align'      => 'wide',
			)
		);
		assert_matches( '#^<div class="(alignwide wp-block-chronicle-timeline|wp-block-chronicle-timeline alignwide)">#', $html );
		assert_contains( '<chronicle-timeline aria-label="Space Race" layout="horizontal" theme="dark" height="600px" filter-tags="space,moon">', $html );
		assert_contains( '<script type="application/json">{"schemaVersion":"1.0.0"', $html );
		assert_contains( '<h2 id="ev-e1">Sputnik</h2>', $html );
		assert_contains( '<a href="https://chronicle.test/timeline/space-race">View the full timeline</a>', $html );
		assert_true( wp_script_is( Chronicle_Timeline_Assets::COMPONENT, 'enqueued' ), 'component script not enqueued' );
	}
);

test(
	'timeline data cannot break out of its script element',
	function () {
		connect();
		$evil = sample_timeline( array( 'title' => '</script><script>alert(1)</script>' ) );
		http_routes( array( 'GET /api/v1/embed/x' => array( 200, embed_body( $evil ) ) ) );
		$html = render_block_markup( array( 'slug' => 'x' ) );
		assert_same( 1, substr_count( $html, '<script' ), 'only the JSON script element' );
		assert_contains( '</script>', $html );
		assert_contains( 'aria-label="&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;"', $html );
		preg_match( '#<script type="application/json">(.*?)</script>#s', $html, $m );
		assert_same( $evil, json_decode( $m[1], true ), 'JSON round-trips' );
	}
);

test(
	'the server-rendered fallback is sanitised before it is printed',
	function () {
		connect();
		$fallback = '<ol class="ssr-events"><li class="ssr-event" onclick="x()"><article><h2 id="ev-1">T</h2>'
			. '<script>alert(1)</script><img src="https://chronicle.test/a.webp" alt="a" onerror="alert(2)">'
			. '<a href="javascript:alert(3)">x</a><a href="https://ok.example" rel="noopener">ok</a>'
			. '<iframe src="https://evil.example"></iframe><style>body{display:none}</style>'
			. '<div class="ssr-body" style="position:fixed"><p><strong>b</strong></p></div></article></li></ol>';
		http_routes( array( 'GET /api/v1/embed/x' => array( 200, embed_body( array(), array( 'fallbackHtml' => $fallback ) ) ) ) );
		$html = render_block_markup( array( 'slug' => 'x' ) );
		foreach ( array( '<script>alert', 'onclick', 'onerror', 'javascript:', '<iframe', '<style', 'position:fixed' ) as $bad ) {
			assert_not_contains( $bad, $html );
		}
		assert_contains( '<img src="https://chronicle.test/a.webp" alt="a">', $html );
		assert_contains( '<a href="https://ok.example" rel="noopener">ok</a>', $html );
		assert_contains( '<div class="ssr-body"><p><strong>b</strong></p></div>', $html );
	}
);

test(
	'without fallback HTML from the server, a plain escaped list is rendered',
	function () {
		connect();
		$timeline = sample_timeline(
			array(
				'events' => array(
					array(
						'id'    => 'a',
						'title' => '<b>Moon</b>',
						'date'  => array(
							'start' => '1969-07-20',
							'end'   => '1969-07-24',
						),
						'body'  => 'Text <script>x</script>',
					),
				),
			)
		);
		http_routes( array( 'GET /api/v1/embed/x' => array( 200, array( 'timeline' => $timeline ) ) ) );
		$html = render_block_markup( array( 'slug' => 'x' ) );
		assert_contains( '<h2>&lt;b&gt;Moon&lt;/b&gt;</h2>', $html );
		assert_contains( '1969-07-20 – 1969-07-24', $html );
		assert_contains( 'Text &lt;script&gt;x&lt;/script&gt;', $html );
		assert_not_contains( 'View the full timeline', $html );
	}
);

test(
	'invalid display values are dropped, and site defaults fill in',
	function () {
		connect(
			array(
				'default_layout' => 'card',
				'default_theme'  => 'editorial',
			)
		);
		http_routes( array( 'GET /api/v1/embed/x' => array( 200, embed_body() ) ) );
		$args = Chronicle_Timeline_Renderer::normalize_args(
			array(
				'slug'        => 'x',
				'layout'      => 'spiral',
				'theme'       => '"><script>',
				'height'      => 'calc(100% - 1px)',
				'filter_tags' => str_repeat( 'a', 61 ) . ',ok',
				'version'     => '-3',
			)
		);
		assert_same( array( '', '', '', 'ok', 0 ), array( $args['layout'], $args['theme'], $args['height'], $args['filter_tags'], $args['version'] ) );

		$html = render_block_markup( array( 'slug' => 'x' ) );
		assert_contains( 'layout="card" theme="editorial"', $html );
		assert_not_contains( ' height=', $html );
	}
);

test(
	'timelines are cached; pinned versions longer',
	function () {
		connect( array( 'cache_minutes' => 7 ) );
		http_routes(
			array(
				'GET /api/v1/embed/x'     => array( 200, embed_body() ),
				'GET /api/v1/embed/x/v/1' => array( 200, embed_body() ),
			)
		);
		render_block_markup( array( 'slug' => 'x' ) );
		render_block_markup( array( 'slug' => 'x' ) );
		render_block_markup(
			array(
				'slug'    => 'x',
				'version' => 1,
			)
		);
		assert_same( 2, count( http_requests() ), 'second render came from the cache' );

		$key = md5( 'https://chronicle.test|x|0' );
		assert_true( (bool) get_transient( Chronicle_Timeline_Renderer::CACHE_PREFIX . $key ) );
		$timeout = (int) get_option( '_transient_timeout_' . Chronicle_Timeline_Renderer::CACHE_PREFIX . $key );
		assert_true( abs( $timeout - time() - 7 * MINUTE_IN_SECONDS ) < 5, 'fresh copy lives cache_minutes' );
		$pinned = (int) get_option( '_transient_timeout_' . Chronicle_Timeline_Renderer::CACHE_PREFIX . md5( 'https://chronicle.test|x|1' ) );
		assert_true( abs( $pinned - time() - DAY_IN_SECONDS ) < 5, 'pinned copy lives a day' );

		assert_true( Chronicle_Timeline_Renderer::clear_cache() >= 4 );
		render_block_markup( array( 'slug' => 'x' ) );
		assert_same( 3, count( http_requests() ) );
	}
);

test(
	'when the server is down the last good copy is shown, and the outage is remembered briefly',
	function () {
		connect();
		http_routes( array( 'GET /api/v1/embed/x' => array( 200, embed_body() ) ) );
		render_block_markup( array( 'slug' => 'x' ) );

		// The fresh copy expires; the server is now down.
		delete_transient( Chronicle_Timeline_Renderer::CACHE_PREFIX . md5( 'https://chronicle.test|x|0' ) );
		http_routes( array( 'GET /api/v1/embed/x' => new WP_Error( 'http_request_failed', 'timed out' ) ) );
		$html = render_block_markup( array( 'slug' => 'x' ) );
		assert_contains( '<h2 id="ev-e1">Sputnik</h2>', $html );
		render_block_markup( array( 'slug' => 'x' ) );
		assert_same( 1, count( http_requests() ), 'retried the down server immediately' );
	}
);

test(
	'a timeline that no longer exists is not served from the stale copy',
	function () {
		connect();
		http_routes( array( 'GET /api/v1/embed/x' => array( 200, embed_body() ) ) );
		render_block_markup( array( 'slug' => 'x' ) );
		delete_transient( Chronicle_Timeline_Renderer::CACHE_PREFIX . md5( 'https://chronicle.test|x|0' ) );
		http_routes( array() ); // Everything 404s: unpublished or made private.
		$html = render_block_markup( array( 'slug' => 'x' ) );
		assert_not_contains( 'Sputnik', $html );
		assert_false( get_transient( Chronicle_Timeline_Renderer::STALE_PREFIX . md5( 'https://chronicle.test|x|0' ) ) );
	}
);

test(
	'problems are explained to editors and hidden from visitors',
	function () {
		connect();
		http_routes( array( 'GET /api/v1/embed/x' => new WP_Error( 'http_request_failed', 'Connection <refused>' ) ) );
		$visitor = render_block_markup( array( 'slug' => 'x' ) );
		assert_same( '<!-- Chronicle timeline unavailable -->', $visitor );

		wp_set_current_user( make_user( 'author' ) );
		$editor = render_block_markup( array( 'slug' => 'x' ) );
		assert_contains( 'class="chronicle-timeline__problem" role="note"', $editor );
		assert_contains( 'Connection &lt;refused&gt;', $editor );

		assert_contains( 'No timeline has been chosen.', render_block_markup( array() ) );
	}
);

test(
	'shortcode: slug, full link, pinned version, display options and alignment',
	function () {
		connect();
		http_routes(
			array(
				'GET /api/v1/embed/space-race'     => array( 200, embed_body() ),
				'GET /api/v1/embed/space-race/v/4' => array( 200, embed_body() ),
			)
		);
		$html = do_shortcode( '[chronicle id="space-race" layout="vertical" theme="minimal" height="80vh" tags="space" align="full" class="mine x!y"]' );
		assert_matches( '#^<div class="wp-block-chronicle-timeline chronicle-timeline-shortcode alignfull mine xy">#', $html );
		assert_contains( 'layout="vertical" theme="minimal" height="80vh" filter-tags="space"', $html );

		do_shortcode( '[chronicle url="https://chronicle.test/timeline/space-race/v/4"]' );
		do_shortcode( '[chronicle id="https://chronicle.test/timeline/space-race" version="4"]' );
		$urls = wp_list_pluck( http_requests(), 'url' );
		assert_same( 'https://chronicle.test/api/v1/embed/space-race/v/4?include=fallback', end( $urls ) );
		assert_same( 2, count( $urls ), 'the pinned version was fetched once and cached' );
	}
);

test(
	'shortcode: share links and bad input are refused without a request',
	function () {
		connect();
		http_routes( array() );
		wp_set_current_user( make_user( 'editor' ) );
		assert_contains( 'private share link', do_shortcode( '[chronicle url="https://chronicle.test/timeline/x?token=abc"]' ) );
		assert_contains( 'No timeline has been chosen', do_shortcode( '[chronicle id="../../wp-config"]' ) );
		assert_contains( 'No timeline has been chosen', do_shortcode( '[chronicle]' ) );
		assert_same( 0, count( http_requests() ) );
	}
);
