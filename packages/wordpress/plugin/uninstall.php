<?php
/**
 * Removes the plugin's data when it is deleted from the Plugins screen.
 *
 * Synced events stay on the Chronicle server; only this site's settings,
 * caches and sync bookkeeping are removed.
 *
 * @package ChronicleTimeline
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

delete_option( 'chronicle_timeline_settings' );
delete_option( 'chronicle_timeline_sync_last' );
delete_post_meta_by_key( '_chronicle_timeline_hash' );
delete_post_meta_by_key( '_chronicle_timeline_sync' );
// Every pending retry, whatever its arguments.
wp_unschedule_hook( 'chronicle_timeline_sync_retry' );

global $wpdb;
// Transients have no "delete by prefix" API.
// phpcs:ignore WordPress.DB.DirectDatabaseQuery
$chronicle_timeline_names = $wpdb->get_col(
	$wpdb->prepare(
		"SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
		$wpdb->esc_like( '_transient_chronicle_tl' ) . '%',
		$wpdb->esc_like( '_transient_timeout_chronicle_tl' ) . '%'
	)
);
foreach ( $chronicle_timeline_names as $chronicle_timeline_name ) {
	delete_option( $chronicle_timeline_name );
}
