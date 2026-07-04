mod api;
mod commands;
mod db;
mod diagnostics;
mod download;
mod error;
mod image_cache;
mod mpv;
mod state;
mod sync;

use std::fs;
use tauri::Manager;
use std::sync::atomic::AtomicBool;
use tracing::info;

use state::{AppState, DbPool, SyncStatus};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|_window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                #[cfg(any(target_os = "windows", target_os = "macos"))]
                {
                    use tauri::Manager;
                    if let Some(mpv_state) = _window.try_state::<crate::mpv::MpvState>() {
                        let saved = mpv_state.pip_state.lock().take();
                        if let Some(saved) = saved {
                            _window.set_always_on_top(false).ok();
                            _window.set_skip_taskbar(false).ok();
                            _window.set_decorations(true).ok();
                            _window.set_min_size(None::<tauri::Size>).ok();
                            if saved.was_maximized {
                                _window.maximize().ok();
                            } else if !saved.was_fullscreen {
                                _window.set_size(tauri::Size::Physical(
                                    tauri::PhysicalSize::new(saved.width, saved.height)
                                )).ok();
                                _window.set_position(tauri::Position::Physical(
                                    tauri::PhysicalPosition::new(saved.x, saved.y)
                                )).ok();
                            }
                        }
                    }
                }
                #[cfg(target_os = "macos")]
                {
                    api.prevent_close();
                    let _ = _window.hide();
                }
                let _ = api;
            }
            _ => {}
        });

    image_cache::register_jfimage_protocol(builder)
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;

            if let Ok(cache_root) = app.path().app_cache_dir() {
                let image_cache_dir = cache_root.join("image_cache");
                let _ = fs::create_dir_all(&image_cache_dir);
                image_cache::cleanup_image_cache(&image_cache_dir);
            }

            let log_dir = app_data_dir.join("logs");
            let log_file_path = diagnostics::init_logging(&log_dir)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            info!(
                target: "bootstrap",
                app_data_dir = %app_data_dir.display(),
                log_file = %log_file_path.display(),
                "Application setup started"
            );

            // Initialize SQLite pools with WAL for concurrent read/write.
            let db_path = app_data_dir.join("jfgoat.db");
            let db = DbPool::new(&db_path)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            {
                let write_conn = db
                    .write_conn()
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
                db::init_db(&write_conn)?;
            }
            info!(target: "bootstrap", db_path = %db_path.display(), "Database initialized");

            // Create HTTP client with timeouts and pool tuning for large library sync
            let http_client = reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                .timeout(std::time::Duration::from_secs(120))
                .connect_timeout(std::time::Duration::from_secs(15))
                .tcp_keepalive(std::time::Duration::from_secs(20))
                .pool_idle_timeout(std::time::Duration::from_secs(30))
                .pool_max_idle_per_host(1)
                .build()
                .expect("Failed to build HTTP client");

            let (download_tx, download_rx) = tokio::sync::mpsc::unbounded_channel::<()>();

            // Create and manage AppState
            let app_state = AppState {
                db: db.clone(),
                http_client: http_client.clone(),
                server_url: std::sync::Arc::new(parking_lot::RwLock::new(None)),
                user_id: std::sync::Arc::new(parking_lot::RwLock::new(None)),
                token: std::sync::Arc::new(parking_lot::RwLock::new(None)),
                sync_status: parking_lot::RwLock::new(SyncStatus::Ready),
                user_data_refresh_running: AtomicBool::new(false),
                sync_running: AtomicBool::new(false),
                download_trigger: download_tx,
                login_attempts: parking_lot::Mutex::new(std::collections::HashMap::new()),
            };

            let app_handle_for_downloads = app.handle().clone();
            let db_for_downloads = db.clone();
            let http_client_for_downloads = http_client.clone();
            let server_url_for_downloads = app_state.server_url.clone();
            let user_id_for_downloads = app_state.user_id.clone();
            let token_for_downloads = app_state.token.clone();
            let download_trigger_for_downloads = app_state.download_trigger.clone();

            tauri::async_runtime::spawn(download::start_download_manager_loop(
                app_handle_for_downloads,
                download::DownloadContext {
                    db: db_for_downloads,
                    http_client: http_client_for_downloads,
                    server_url: server_url_for_downloads,
                    user_id: user_id_for_downloads,
                    token: token_for_downloads,
                    download_trigger: download_trigger_for_downloads,
                },
                download_rx,
            ));

            app.manage(app_state);

            // ── macOS Native Menu Setup ─────────────────────────────────────
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder};
                let app_menu = SubmenuBuilder::new(app, app.package_info().name.clone())
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu])
                    .build()?;
                app.set_menu(menu)?;
            }

            // ── MPV Player Setup (Windows/macOS) ───────────────────────────
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            {
                use raw_window_handle::HasWindowHandle;
                use raw_window_handle::RawWindowHandle;

                let window = app
                    .get_webview_window("main")
                    .expect("No 'main' window found");

                #[cfg(target_os = "windows")]
                let child_hwnd = {
                    // Set DLL search directory so libmpv2 can find mpv-2.dll
                    if let Ok(resource_dir) = app.path().resource_dir() {
                        mpv::set_mpv_dll_directory(&resource_dir);
                        info!(target: "mpv", dll_dir = %resource_dir.display(), "Configured MPV DLL search directory");
                    }

                    let parent_hwnd = match window
                        .window_handle()
                        .expect("Failed to get window handle")
                        .as_raw()
                    {
                        RawWindowHandle::Win32(h) => h.hwnd.get() as isize,
                        _ => panic!("Expected Win32 window handle"),
                    };

                    mpv::create_mpv_child_window(parent_hwnd)
                        .expect("Failed to create mpv child window")
                };

                #[cfg(target_os = "macos")]
                let child_hwnd = {
                    let parent_view = match window
                        .window_handle()
                        .expect("Failed to get window handle")
                        .as_raw()
                    {
                        RawWindowHandle::AppKit(h) => h.ns_view.as_ptr() as isize,
                        _ => panic!("Expected AppKit window handle"),
                    };

                    mpv::create_mpv_child_view(parent_view)
                        .expect("Failed to create mpv child view")
                };

                let (cmd_tx, cmd_rx) = std::sync::mpsc::channel();
                let app_handle = app.handle().clone();

                mpv::spawn_mpv_thread(child_hwnd, cmd_rx, app_handle);

                app.manage(mpv::MpvState {
                    cmd_tx,
                    child_hwnd,
                    pip_state: parking_lot::Mutex::new(None),
                    last_pip_geometry: parking_lot::Mutex::new(None),
                });

                // Resize mpv child window when the main window is resized (Windows only)
                #[cfg(target_os = "windows")]
                {
                    let mpv_hwnd = child_hwnd;
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::Resized(size) = event {
                            mpv::resize_mpv_window(mpv_hwnd, size.width, size.height);
                        }
                    });

                    // Sync initial window size
                    if let Ok(size) = window.inner_size() {
                        mpv::resize_mpv_window(child_hwnd, size.width, size.height);
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect_to_server,
            commands::login,
            commands::check_auth,
            commands::check_auth_offline,
            commands::logout,
            commands::search_items,
            commands::get_sync_status,
            commands::start_sync,
            commands::force_resync,
            commands::export_diagnostics,
            commands::get_recent_movies,
            commands::get_recent_series,
            commands::get_continue_watching,
            commands::get_latest_media,
            commands::get_item_by_id,
            commands::get_series_seasons,
            commands::get_season_episodes,
            commands::get_user_views,
            commands::get_resume_items,
            commands::get_next_up,
            commands::get_latest_items,
            commands::get_library_items,
            commands::get_item_people,
            commands::get_similar_items,
            commands::save_homepage_cache,
            commands::load_homepage_cache,
            commands::get_user_preferences,
            commands::save_user_preferences,
            commands::mpv_play,
            commands::mpv_toggle_pause,
            commands::mpv_seek,
            commands::mpv_seek_absolute,
            commands::mpv_set_volume,
            commands::mpv_set_mute,
            commands::mpv_set_playback_rate,
            commands::mpv_set_subtitle_position,
            commands::mpv_set_video_scale,
            commands::mpv_set_audio_track,
            commands::mpv_set_subtitle_track,
            commands::mpv_add_external_subtitle,
            commands::mpv_stop,
            commands::mpv_enter_pip,
            commands::mpv_exit_pip,
            commands::get_media_streams,
            commands::get_media_segments,
            commands::get_item_chapters,
            commands::log_from_frontend,
            commands::get_external_urls,
            commands::report_playback_lifecycle,
            commands::report_playback_stopped,
            commands::toggle_played,
            commands::toggle_favorite,
            commands::refresh_item_details,
            commands::start_download,
            commands::pause_download,
            commands::resume_download,
            commands::cancel_download,
            commands::delete_download,
            commands::get_download_status,
            commands::get_offline_downloads,
            commands::select_download_directory,
            commands::restart_app,
            commands::get_storage_usage,
            commands::clear_app_cache,
            commands::delete_all_offline_downloads,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = _app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}


