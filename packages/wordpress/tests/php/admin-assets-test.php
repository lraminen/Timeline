<?php
/**
 * Scripts, the settings page and the editor data.
 *
 * @package ChronicleTimeline
 */

/** Re-registers scripts after a settings change (normally done on `init`). */
function reregister_scripts(): void {
	foreach ( array( Chronicle_Timeline_Assets::COMPONENT, Chronicle_Timeline_Assets::EDITOR ) as $handle ) {
		wp_deregister_script( $handle );
	}
	Chronicle_Timeline_Assets::register();
}

function script_tag( string $handle ): string {
	ob_start();
	wp_scripts()->do_items( array( $handle ) );
	wp_scripts()->done = array();
	return (string) ob_get_clean();
}

test(
	'the bundled component is used by default',
	function () {
		reregister_scripts();
		$script = wp_scripts()->registered[ Chronicle_Timeline_Assets::COMPONENT ];
		assert_same( CHRONICLE_TIMELINE_URL . 'build/chronicle-timeline.js', $script->src );
		assert_same( CHRONICLE_TIMELINE_VERSION, $script->ver );
		assert_true( file_exists( CHRONICLE_TIMELINE_DIR . 'build/chronicle-timeline.js' ), 'run the build first' );
		assert_true( file_exists( CHRONICLE_TIMELINE_DIR . 'build/editor.js' ), 'run the build first' );
	}
);

test(
	'a CDN copy gets an integrity check and falls back to the bundled copy',
	function () {
		$cdn = 'https://cdn.jsdelivr.net/npm/@chronicle/web-component@0.1.0/dist/cdn/chronicle-timeline.iife.js';
		configure(
			array(
				'script_source' => 'cdn',
				'cdn_url'       => $cdn,
				'cdn_integrity' => 'sha384-abc',
			)
		);
		reregister_scripts();
		$html = script_tag( Chronicle_Timeline_Assets::COMPONENT );
		assert_matches( '#<script integrity="sha384-abc" crossorigin="anonymous"[^>]* src="' . preg_quote( $cdn, '#' ) . '"#', $html );
		assert_contains( 'customElements.get("chronicle-timeline")', $html );
		assert_contains( 'build\/chronicle-timeline.js?ver=' . CHRONICLE_TIMELINE_VERSION, $html );
		reregister_scripts();
	}
);

test(
	'the editor gets the server and capabilities, never the API key',
	function () {
		connect();
		wp_set_current_user( make_user( 'author' ) );
		reregister_scripts();
		Chronicle_Timeline_Assets::editor_data();
		$before = implode( "\n", (array) wp_scripts()->get_data( Chronicle_Timeline_Assets::EDITOR, 'before' ) );
		assert_contains( '"serverUrl":"https:\/\/chronicle.test"', $before );
		assert_contains( '"hasAccount":true', $before );
		assert_contains( '"settingsUrl":""', $before, 'authors cannot open settings' );
		assert_not_contains( TEST_KEY, $before );
		assert_not_contains( 'chr_', $before );
		reregister_scripts();
	}
);

test(
	'the settings page shows the connection and a masked key',
	function () {
		connect();
		http_routes(
			array(
				'GET /api/v1/me'       => array(
					200,
					array(
						'id'    => 'u1',
						'name'  => 'Ada <script>',
						'email' => 'ada@example.org',
					),
				),
				'GET /api/v1/projects' => array( 200, array( 'projects' => array( array( 'id' => 'p1', 'title' => 'Mine', 'role' => 'owner' ), array( 'id' => 'p2', 'title' => 'Theirs', 'role' => 'viewer' ) ) ) ),
			)
		);
		wp_set_current_user( make_user( 'administrator' ) );
		ob_start();
		Chronicle_Timeline_Admin::render();
		$html = (string) ob_get_clean();
		assert_contains( 'Connected as Ada &lt;script&gt; (ada@example.org).', $html );
		assert_contains( 'chr_abcdefABCDEF_••••••••', $html );
		assert_not_contains( substr( TEST_KEY, 18 ), $html, 'the secret part of the key' );
		assert_contains( '<option value="p1"', $html );
		assert_not_contains( '<option value="p2"', $html, 'viewers cannot sync into a timeline' );
		assert_contains( 'name="_wpnonce"', $html );

		wp_set_current_user( make_user( 'editor' ) );
		ob_start();
		Chronicle_Timeline_Admin::render();
		assert_same( '', (string) ob_get_clean(), 'editors cannot see settings' );
	}
);
