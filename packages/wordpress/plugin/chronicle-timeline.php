<?php
/**
 * Plugin Name:       Chronicle Timeline
 * Description:       Embed interactive, accessible Chronicle timelines with a block or a shortcode, and optionally publish your posts as timeline events.
 * Version:           0.1.0
 * Requires at least: 6.6
 * Requires PHP:      7.4
 * Author:            Chronicle
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       chronicle-timeline
 *
 * @package ChronicleTimeline
 */

defined( 'ABSPATH' ) || exit;

define( 'CHRONICLE_TIMELINE_VERSION', '0.1.0' );
define( 'CHRONICLE_TIMELINE_FILE', __FILE__ );
define( 'CHRONICLE_TIMELINE_DIR', plugin_dir_path( __FILE__ ) );
define( 'CHRONICLE_TIMELINE_URL', plugin_dir_url( __FILE__ ) );

require_once CHRONICLE_TIMELINE_DIR . 'includes/class-chronicle-timeline-urls.php';
require_once CHRONICLE_TIMELINE_DIR . 'includes/class-chronicle-timeline-settings.php';
require_once CHRONICLE_TIMELINE_DIR . 'includes/class-chronicle-timeline-client.php';
require_once CHRONICLE_TIMELINE_DIR . 'includes/class-chronicle-timeline-renderer.php';
require_once CHRONICLE_TIMELINE_DIR . 'includes/class-chronicle-timeline-assets.php';
require_once CHRONICLE_TIMELINE_DIR . 'includes/class-chronicle-timeline-block.php';
require_once CHRONICLE_TIMELINE_DIR . 'includes/class-chronicle-timeline-shortcode.php';
require_once CHRONICLE_TIMELINE_DIR . 'includes/class-chronicle-timeline-rest.php';
require_once CHRONICLE_TIMELINE_DIR . 'includes/class-chronicle-timeline-sync.php';
require_once CHRONICLE_TIMELINE_DIR . 'includes/class-chronicle-timeline-admin.php';

Chronicle_Timeline_Assets::init();
Chronicle_Timeline_Block::init();
Chronicle_Timeline_Shortcode::init();
Chronicle_Timeline_Rest::init();
Chronicle_Timeline_Sync::init();
Chronicle_Timeline_Admin::init();
