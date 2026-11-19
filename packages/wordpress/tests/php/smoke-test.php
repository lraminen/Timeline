<?php
/**
 * Harness sanity checks.
 *
 * @package ChronicleTimeline
 */

test(
	'the database is fresh for every run',
	function () {
		assert_false( get_option( 'chronicle_smoke' ), 'leftover from a previous run' );
		update_option( 'chronicle_smoke', 1 );
	}
);

test(
	'the plugin is loaded and registers its block and shortcode',
	function () {
		assert_true( WP_Block_Type_Registry::get_instance()->is_registered( 'chronicle/timeline' ) );
		assert_true( shortcode_exists( 'chronicle' ) );
	}
);
