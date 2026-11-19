<?php
/**
 * Entry point: boots WordPress (the plugin is loaded by the test mu-plugin)
 * and runs every *-test.php file in this directory.
 *
 * @package ChronicleTimeline
 */

require '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/admin.php';
require __DIR__ . '/harness.php';

if ( ! class_exists( 'Chronicle_Timeline_Renderer' ) ) {
	echo "PHP TESTS FAILED: the plugin is not loaded\n";
	exit( 1 );
}

foreach ( glob( __DIR__ . '/*-test.php' ) as $chronicle_test_file ) {
	require $chronicle_test_file;
}
run_tests();
