<?php
/**
 * URL parsing and settings validation.
 *
 * @package ChronicleTimeline
 */

test(
	'parses timeline page and embed links, with and without a pinned version',
	function () {
		$cases = array(
			'https://chronicle.test/timeline/space-race'          => array( 'https://chronicle.test', 'space-race', 0 ),
			'https://chronicle.test/timeline/space-race/v/3'      => array( 'https://chronicle.test', 'space-race', 3 ),
			'https://chronicle.test/api/v1/embed/space-race/v/12' => array( 'https://chronicle.test', 'space-race', 12 ),
			'https://Example.ORG:8443/sub/dir/timeline/a_b-1/'    => array( 'https://example.org:8443/sub/dir', 'a_b-1', 0 ),
			'http://127.0.0.1:3999/timeline/x'                    => array( 'http://127.0.0.1:3999', 'x', 0 ),
		);
		foreach ( $cases as $url => $expected ) {
			$parsed = Chronicle_Timeline_Urls::parse_timeline_url( $url );
			assert_same(
				array(
					'server'  => $expected[0],
					'slug'    => $expected[1],
					'version' => $expected[2],
				),
				$parsed,
				$url
			);
		}
	}
);

test(
	'refuses share links, credentials and anything that is not a timeline link',
	function () {
		assert_wp_error( Chronicle_Timeline_Urls::parse_timeline_url( 'https://chronicle.test/timeline/x?token=a.b' ), 'chronicle_share_link' );
		$bad = array(
			'',
			'space-race',
			'javascript:alert(1)//timeline/x',
			'https://chronicle.test/blog/post',
			'https://chronicle.test/timeline/',
			'https://chronicle.test/timeline/has%20space',
			'https://chronicle.test/timeline/a/b',
			'https://chronicle.test/timeline/x/v/abc',
			'https://user:pw@chronicle.test/timeline/x',
			'ftp://chronicle.test/timeline/x',
			'https://chronicle.test/timeline/' . str_repeat( 'a', 101 ),
			array( 'not a string' ),
		);
		foreach ( $bad as $url ) {
			assert_wp_error( Chronicle_Timeline_Urls::parse_timeline_url( $url ), 'chronicle_invalid_url' );
		}
	}
);

test(
	'normalises server URLs',
	function () {
		assert_same( 'https://example.org/chronicle', Chronicle_Timeline_Urls::normalize_server_url( ' https://Example.org/chronicle/ ' ) );
		assert_same( '', Chronicle_Timeline_Urls::normalize_server_url( 'https://example.org/?a=1' ) );
		assert_same( '', Chronicle_Timeline_Urls::normalize_server_url( 'https://example.org/#x' ) );
		assert_same( '', Chronicle_Timeline_Urls::normalize_server_url( 'https://u:p@example.org' ) );
		assert_same( '', Chronicle_Timeline_Urls::normalize_server_url( 'data:text/html,hi' ) );
		assert_same( '', Chronicle_Timeline_Urls::normalize_server_url( 'https://exa mple.org' ) );
		assert_true( Chronicle_Timeline_Urls::same_server( 'https://A.test/', 'https://a.test' ) );
		assert_false( Chronicle_Timeline_Urls::same_server( '', '' ) );
	}
);

test(
	'settings: valid values are saved and invalid ones keep the previous value with an error',
	function () {
		connect();
		$out = Chronicle_Timeline_Settings::sanitize(
			array(
				'server_url'     => 'not a url',
				'api_key'        => 'nope',
				'default_layout' => 'spiral',
				'default_theme'  => 'dark',
				'cache_minutes'  => '99999',
			)
		);
		assert_same( 'https://chronicle.test', $out['server_url'] );
		assert_same( TEST_KEY, $out['api_key'] );
		assert_same( '', $out['default_layout'] );
		assert_same( 'dark', $out['default_theme'] );
		assert_same( 1440, $out['cache_minutes'] );
		$codes = wp_list_pluck( get_settings_errors( Chronicle_Timeline_Settings::OPTION ), 'code' );
		assert_same( array( 'chronicle_server_url', 'chronicle_api_key' ), $codes );
	}
);

test(
	'settings: an empty key field keeps the saved key; the clear box removes it',
	function () {
		connect();
		$kept = Chronicle_Timeline_Settings::sanitize(
			array(
				'server_url' => 'https://chronicle.test/',
				'api_key'    => '',
			)
		);
		assert_same( TEST_KEY, $kept['api_key'] );
		assert_same( 'https://chronicle.test', $kept['server_url'] );

		$replacement = 'chr_ZZZZZZZZZZZZ_' . str_repeat( 'k', 43 );
		assert_same( $replacement, Chronicle_Timeline_Settings::sanitize( array( 'api_key' => " {$replacement} " ) )['api_key'] );
		assert_same(
			'',
			Chronicle_Timeline_Settings::sanitize(
				array(
					'api_key'       => $replacement,
					'api_key_clear' => '1',
				)
			)['api_key']
		);
		assert_same( 'chr_abcdefABCDEF_••••••••', Chronicle_Timeline_Settings::mask_key( TEST_KEY ) );
	}
);

test(
	'settings: CDN URLs must be https, pinned to a version, and point to a script',
	function () {
		$good = 'https://cdn.jsdelivr.net/npm/@chronicle/web-component@0.1.0/dist/cdn/chronicle-timeline.iife.js';
		assert_true( Chronicle_Timeline_Settings::is_pinned_cdn_url( $good ) );
		assert_true( Chronicle_Timeline_Settings::is_pinned_cdn_url( 'https://cdn.example/chronicle/v1.2.3-beta.1/x.js' ) );
		foreach ( array(
			'http://cdn.jsdelivr.net/npm/@chronicle/web-component@0.1.0/x.js',
			'https://cdn.jsdelivr.net/npm/@chronicle/web-component@latest/x.js',
			'https://cdn.jsdelivr.net/npm/@chronicle/web-component/x.js',
			'https://cdn.jsdelivr.net/npm/@chronicle/web-component@0.1.0/x.css',
			'javascript:alert(1)//@0.1.0/x.js',
		) as $bad ) {
			assert_false( Chronicle_Timeline_Settings::is_pinned_cdn_url( $bad ), $bad );
		}

		$out = Chronicle_Timeline_Settings::sanitize(
			array(
				'script_source' => 'cdn',
				'cdn_url'       => $good,
				'cdn_integrity' => 'sha384-abc+/def=',
			)
		);
		assert_same( array( 'cdn', $good, 'sha384-abc+/def=' ), array( $out['script_source'], $out['cdn_url'], $out['cdn_integrity'] ) );
		update_option( Chronicle_Timeline_Settings::OPTION, $out );

		$rejected = Chronicle_Timeline_Settings::sanitize(
			array(
				'script_source' => 'cdn',
				'cdn_url'       => 'https://cdn.example/latest.js',
				'cdn_integrity' => '"><script>',
			)
		);
		assert_same( array( 'cdn', $good, 'sha384-abc+/def=' ), array( $rejected['script_source'], $rejected['cdn_url'], $rejected['cdn_integrity'] ) );

		$no_url = Chronicle_Timeline_Settings::sanitize(
			array(
				'script_source' => 'cdn',
				'cdn_url'       => '',
			)
		);
		assert_same( 'bundled', $no_url['script_source'] );
	}
);

test(
	'settings: post sync needs a timeline and existing post types',
	function () {
		connect();
		$off = Chronicle_Timeline_Settings::sanitize(
			array(
				'sync_section'    => '1',
				'sync_enabled'    => '1',
				'sync_project'    => '',
				'sync_post_types' => array( 'post' ),
			)
		);
		assert_false( $off['sync_enabled'] );

		$on = Chronicle_Timeline_Settings::sanitize(
			array(
				'sync_section'    => '1',
				'sync_enabled'    => '1',
				'sync_project'    => 'AAAAAAAA-1111-2222-3333-444444444444',
				'sync_post_types' => array( 'post', 'no_such_type', '<b>' ),
				'sync_publish'    => '1',
			)
		);
		assert_true( $on['sync_enabled'] );
		assert_true( $on['sync_publish'] );
		assert_same( 'aaaaaaaa-1111-2222-3333-444444444444', $on['sync_project'] );
		assert_same( array( 'post' ), $on['sync_post_types'] );

		$bad_project = Chronicle_Timeline_Settings::sanitize(
			array(
				'sync_section' => '1',
				'sync_project' => '../../etc',
			)
		);
		assert_same( '', $bad_project['sync_project'] );
	}
);
