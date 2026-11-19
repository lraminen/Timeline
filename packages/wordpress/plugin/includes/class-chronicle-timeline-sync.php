<?php
/**
 * Optional sync of WordPress posts into a Chronicle timeline.
 *
 * @package ChronicleTimeline
 */

defined( 'ABSPATH' ) || exit;

/**
 * When enabled, each published post of the chosen types becomes an event
 * (title, publish date, excerpt with a link back, featured image, tags) in
 * one Chronicle timeline. Unpublishing, trashing, password-protecting or
 * deleting a post removes its event.
 *
 * Changes are collected during the request and sent once at shutdown, after
 * WordPress has finished saving (the featured image and tags are stored
 * after the status change). Failures are retried by WP-Cron with back-off.
 * Unchanged posts are not re-sent. With "publish after sync", each batch of
 * changes is published as a new timeline version.
 */
final class Chronicle_Timeline_Sync {

	const META_HASH = '_chronicle_timeline_hash';

	const META_STATUS = '_chronicle_timeline_sync';

	const LAST_RESULT_OPTION = 'chronicle_timeline_sync_last';

	const RETRY_HOOK = 'chronicle_timeline_sync_retry';

	const MAX_ATTEMPTS = 5;

	/**
	 * Pending work for this request: post ID => 'upsert' | 'delete'.
	 *
	 * @var array<int, string>
	 */
	private static $queue = array();

	/**
	 * Hooks.
	 */
	public static function init(): void {
		add_action( 'transition_post_status', array( __CLASS__, 'on_transition' ), 10, 3 );
		add_action( 'before_delete_post', array( __CLASS__, 'on_delete' ), 10, 1 );
		add_action( 'shutdown', array( __CLASS__, 'flush' ) );
		add_action( self::RETRY_HOOK, array( __CLASS__, 'retry' ), 10, 3 );
	}

	/**
	 * Whether sync is configured and applies to this post type.
	 *
	 * @param string $post_type Post type.
	 */
	public static function enabled_for( string $post_type ): bool {
		$settings = Chronicle_Timeline_Settings::get();
		return ! empty( $settings['sync_enabled'] )
			&& '' !== $settings['sync_project']
			&& in_array( $post_type, (array) $settings['sync_post_types'], true )
			&& Chronicle_Timeline_Settings::has_account();
	}

	/**
	 * Queues work when a post's status changes (also fires on every update).
	 *
	 * @param string  $new_status New status.
	 * @param string  $old_status Old status.
	 * @param WP_Post $post       Post.
	 */
	public static function on_transition( $new_status, $old_status, $post ): void {
		if ( ! $post instanceof WP_Post || wp_is_post_revision( $post ) || wp_is_post_autosave( $post ) || ! self::enabled_for( $post->post_type ) ) {
			return;
		}
		if ( 'publish' === $new_status ) {
			self::$queue[ $post->ID ] = 'upsert';
		} elseif ( 'publish' === $old_status || '' !== (string) get_post_meta( $post->ID, self::META_HASH, true ) ) {
			self::$queue[ $post->ID ] = 'delete';
		}
	}

	/**
	 * Queues removal of a synced post that is being deleted.
	 *
	 * @param int $post_id Post ID.
	 */
	public static function on_delete( $post_id ): void {
		$post = get_post( $post_id );
		if ( $post && self::enabled_for( $post->post_type ) && '' !== (string) get_post_meta( $post->ID, self::META_HASH, true ) ) {
			// The post is gone by shutdown, so remove the event now.
			self::process( array( (int) $post_id => 'delete' ) );
			unset( self::$queue[ (int) $post_id ] );
		}
	}

	/**
	 * Sends this request's queued changes.
	 */
	public static function flush(): void {
		if ( array() === self::$queue ) {
			return;
		}
		$queue       = self::$queue;
		self::$queue = array();
		self::process( $queue );
	}

	/**
	 * WP-Cron retry of one failed change.
	 *
	 * @param int    $post_id Post ID.
	 * @param string $action  'upsert' or 'delete'.
	 * @param int    $attempt Attempt number (1-based).
	 */
	public static function retry( $post_id, $action, $attempt = 1 ): void {
		$post = get_post( (int) $post_id );
		if ( 'upsert' === $action && ( ! $post || 'publish' !== $post->post_status ) ) {
			$action = 'delete';
		}
		self::process( array( (int) $post_id => 'delete' === $action ? 'delete' : 'upsert' ), (int) $attempt );
	}

	/**
	 * Applies a set of changes.
	 *
	 * @param array<int, string> $changes Post ID => action.
	 * @param int                $attempt Attempt number of these changes.
	 * @return int Number of changes that reached the server.
	 */
	public static function process( array $changes, int $attempt = 1 ): int {
		$client = Chronicle_Timeline_Settings::account_client();
		if ( is_wp_error( $client ) ) {
			return 0;
		}
		$project = (string) Chronicle_Timeline_Settings::get()['sync_project'];
		$changed = 0;
		foreach ( $changes as $post_id => $action ) {
			$result = 'delete' === $action
				? self::delete_event( $client, $project, $post_id )
				: self::upsert_event( $client, $project, $post_id );
			if ( is_wp_error( $result ) ) {
				self::record( $post_id, false, $result->get_error_message() );
				if ( $attempt < self::MAX_ATTEMPTS && self::is_transient_failure( $result ) ) {
					// 5, 10, 20, 40 minutes.
					wp_schedule_single_event( time() + 300 * ( 2 ** ( $attempt - 1 ) ), self::RETRY_HOOK, array( $post_id, $action, $attempt + 1 ) );
				}
			} elseif ( true === $result ) {
				++$changed;
				self::record( $post_id, true, 'delete' === $action ? __( 'Removed from the timeline.', 'chronicle-timeline' ) : __( 'Synced.', 'chronicle-timeline' ) );
			}
		}
		if ( $changed > 0 && ! empty( Chronicle_Timeline_Settings::get()['sync_publish'] ) ) {
			$published = $client->request( 'POST', '/api/v1/projects/' . rawurlencode( $project ) . '/revisions', array( 'message' => 'Updated from WordPress' ) );
			if ( is_wp_error( $published ) ) {
				self::record( 0, false, $published->get_error_message() );
			}
		}
		return $changed;
	}

	/**
	 * The event ID for a post. Includes a hash of the site URL so several
	 * sites can sync into one timeline.
	 *
	 * @param int $post_id Post ID.
	 */
	public static function event_id( int $post_id ): string {
		return 'wp-' . substr( md5( home_url() ), 0, 8 ) . '-' . $post_id;
	}

	/**
	 * The Chronicle event for a post.
	 *
	 * @param WP_Post $post Post.
	 * @return array<string, mixed>
	 */
	public static function event_for( WP_Post $post ): array {
		$title = trim( html_entity_decode( wp_strip_all_tags( get_the_title( $post ) ), ENT_QUOTES, 'UTF-8' ) );
		if ( '' === $title ) {
			$title = __( '(no title)', 'chronicle-timeline' );
		}

		$excerpt = has_excerpt( $post )
			? $post->post_excerpt
			: wp_trim_words( excerpt_remove_blocks( strip_shortcodes( $post->post_content ) ), 55, '…' );
		$excerpt = trim( html_entity_decode( wp_strip_all_tags( $excerpt ), ENT_QUOTES, 'UTF-8' ) );
		$link    = str_replace( array( '(', ')', ' ' ), array( '%28', '%29', '%20' ), (string) get_permalink( $post ) );
		$body    = ( '' !== $excerpt ? self::escape_markdown( $excerpt ) . "\n\n" : '' )
			. '[' . self::escape_markdown( __( 'Read more', 'chronicle-timeline' ) ) . '](' . $link . ')';

		$media    = array();
		$thumb_id = (int) get_post_thumbnail_id( $post );
		$image    = $thumb_id ? wp_get_attachment_image_url( $thumb_id, 'large' ) : false;
		if ( is_string( $image ) && 1 === preg_match( '#^https?://#i', $image ) ) {
			$item    = array(
				'type' => 'image',
				'url'  => $image,
				'alt'  => trim( wp_strip_all_tags( (string) get_post_meta( $thumb_id, '_wp_attachment_image_alt', true ) ) ),
			);
			$caption = trim( wp_strip_all_tags( (string) wp_get_attachment_caption( $thumb_id ) ) );
			if ( '' !== $caption ) {
				$item['caption'] = $caption;
			}
			$media[] = $item;
		}

		$tags  = array();
		$terms = get_the_terms( $post, 'post_tag' );
		if ( is_array( $terms ) ) {
			foreach ( array_slice( $terms, 0, 20 ) as $term ) {
				$tags[] = html_entity_decode( $term->name, ENT_QUOTES, 'UTF-8' );
			}
		}

		return array(
			'id'    => self::event_id( $post->ID ),
			'title' => $title,
			'date'  => array( 'start' => get_post_time( 'Y-m-d', false, $post ) ),
			'body'  => $body,
			'media' => $media,
			'tags'  => $tags,
		);
	}

	/**
	 * Backslash-escapes Markdown syntax so excerpts render as plain text.
	 *
	 * @param string $text Plain text.
	 */
	public static function escape_markdown( string $text ): string {
		return (string) preg_replace( '/([\\\\`*_\[\]()#+\-.!>])/', '\\\\$1', $text );
	}

	/**
	 * Creates or updates a post's event.
	 *
	 * @param Chronicle_Timeline_Client $client  Client.
	 * @param string                    $project Project ID.
	 * @param int                       $post_id Post ID.
	 * @return bool|WP_Error True when sent, false when there was nothing to send.
	 */
	private static function upsert_event( Chronicle_Timeline_Client $client, string $project, int $post_id ) {
		$post = get_post( $post_id );
		if ( ! $post || 'publish' !== $post->post_status || '' !== $post->post_password ) {
			return self::delete_event( $client, $project, $post_id );
		}
		$event = self::event_for( $post );
		$hash  = md5( $project . '|' . wp_json_encode( $event ) );
		if ( get_post_meta( $post_id, self::META_HASH, true ) === $hash ) {
			return false;
		}

		$base  = '/api/v1/projects/' . rawurlencode( $project ) . '/events';
		$patch = $event;
		unset( $patch['id'] );
		$res = $client->request( 'PATCH', $base . '/' . rawurlencode( $event['id'] ), $patch );
		if ( is_wp_error( $res ) && 404 === self::upstream_status( $res ) ) {
			$res = $client->request( 'POST', $base, $event );
		}
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		update_post_meta( $post_id, self::META_HASH, $hash );
		return true;
	}

	/**
	 * Removes a post's event (a missing event counts as removed).
	 *
	 * @param Chronicle_Timeline_Client $client  Client.
	 * @param string                    $project Project ID.
	 * @param int                       $post_id Post ID.
	 * @return bool|WP_Error True when removed, false when it was never synced.
	 */
	private static function delete_event( Chronicle_Timeline_Client $client, string $project, int $post_id ) {
		if ( '' === (string) get_post_meta( $post_id, self::META_HASH, true ) ) {
			return false;
		}
		$res = $client->request( 'DELETE', '/api/v1/projects/' . rawurlencode( $project ) . '/events/' . rawurlencode( self::event_id( $post_id ) ) );
		if ( is_wp_error( $res ) && 404 !== self::upstream_status( $res ) ) {
			return $res;
		}
		delete_post_meta( $post_id, self::META_HASH );
		return true;
	}

	/**
	 * The Chronicle server's HTTP status behind an error (0 when unreachable).
	 *
	 * @param WP_Error $error Error.
	 */
	private static function upstream_status( WP_Error $error ): int {
		$data = $error->get_error_data();
		return is_array( $data ) && isset( $data['upstream_status'] ) ? (int) $data['upstream_status'] : 0;
	}

	/**
	 * Network errors, rate limits and server errors are worth retrying;
	 * validation and permission errors are not.
	 *
	 * @param WP_Error $error Error.
	 */
	private static function is_transient_failure( WP_Error $error ): bool {
		$status = self::upstream_status( $error );
		return 0 === $status || 408 === $status || 429 === $status || $status >= 500;
	}

	/**
	 * Remembers the outcome for the post and for the settings page.
	 *
	 * @param int    $post_id Post ID (0 for project-level results).
	 * @param bool   $ok      Whether it succeeded.
	 * @param string $message Message.
	 */
	private static function record( int $post_id, bool $ok, string $message ): void {
		$entry = array(
			'ok'      => $ok,
			'message' => $message,
			'postId'  => $post_id,
			'at'      => time(),
		);
		if ( $post_id > 0 && get_post( $post_id ) ) {
			update_post_meta( $post_id, self::META_STATUS, $entry );
		}
		update_option( self::LAST_RESULT_OPTION, $entry, false );
	}
}
