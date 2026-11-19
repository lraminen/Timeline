<?php
/**
 * Runs last (files load alphabetically): uninstalling and the wp-config key.
 *
 * @package ChronicleTimeline
 */

test(
	'uninstall removes settings, caches, sync bookkeeping and scheduled retries',
	function () {
		connect();
		http_routes( array( 'GET /api/v1/embed/x' => array( 200, embed_body() ) ) );
		Chronicle_Timeline_Renderer::fetch( '', 'x', 0 );
		update_option( Chronicle_Timeline_Sync::LAST_RESULT_OPTION, array( 'ok' => true ) );
		$post = wp_insert_post(
			array(
				'post_title'  => 'x',
				'post_status' => 'draft',
			)
		);
		update_post_meta( $post, Chronicle_Timeline_Sync::META_HASH, 'abc' );
		update_post_meta( $post, Chronicle_Timeline_Sync::META_STATUS, array( 'ok' => true ) );
		wp_schedule_single_event( time() + 60, Chronicle_Timeline_Sync::RETRY_HOOK, array( $post, 'upsert', 2 ) );

		define( 'WP_UNINSTALL_PLUGIN', 'chronicle-timeline/chronicle-timeline.php' );
		include CHRONICLE_TIMELINE_DIR . 'uninstall.php';
		wp_cache_flush();

		assert_false( get_option( Chronicle_Timeline_Settings::OPTION ) );
		assert_false( get_option( Chronicle_Timeline_Sync::LAST_RESULT_OPTION ) );
		assert_same( '', get_post_meta( $post, Chronicle_Timeline_Sync::META_HASH, true ) );
		assert_same( '', get_post_meta( $post, Chronicle_Timeline_Sync::META_STATUS, true ) );
		assert_false( wp_next_scheduled( Chronicle_Timeline_Sync::RETRY_HOOK, array( $post, 'upsert', 2 ) ) );
		global $wpdb;
		$left = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE '%chronicle_tl%'" );
		assert_same( 0, $left, 'cached timelines left behind' );
	}
);

test(
	'an API key defined in wp-config.php overrides the stored one',
	function () {
		configure(
			array(
				'server_url' => 'https://chronicle.test',
				'api_key'    => '',
			)
		);
		assert_false( Chronicle_Timeline_Settings::has_account() );
		define( 'CHRONICLE_TIMELINE_API_KEY', TEST_KEY );
		assert_true( Chronicle_Timeline_Settings::key_from_constant() );
		assert_true( Chronicle_Timeline_Settings::has_account() );
		assert_same( TEST_KEY, Chronicle_Timeline_Settings::get()['api_key'] );
	}
);
