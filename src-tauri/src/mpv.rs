use serde::Serialize;
use std::sync::mpsc;
use tauri::Emitter;

#[cfg(target_os = "macos")]
use objc::{msg_send, sel, sel_impl};

/// Commands sent from Tauri command handlers to the MPV thread.
pub enum MpvCommand {
    LoadFile {
        item_id: String,
        url: String,
        start_seconds: f64,
        audio_track: Option<i64>,
        subtitle_track: Option<i64>,
        headers: Vec<String>,
    },
    TogglePause,
    SeekRelative(f64),
    SeekAbsolute(f64),
    SetVolume(f64),
    SetMute(bool),
    SetRate(f64),
    SetSubtitlePosition(i64),
    SetVideoScale(String),
    SetAudioTrack(i64),
    SetSubtitleTrack(Option<i64>),
    AddSubtitle { url: String, select: bool },
    Stop,
}

/// Emitted as Tauri event payloads for time position updates.
#[derive(Debug, Clone, Serialize)]
pub struct MpvTimeUpdate {
    pub position: f64,
    pub duration: f64,
}

/// Emitted as Tauri event payloads for pause/play state changes.
#[derive(Debug, Clone, Serialize)]
pub struct MpvStateChange {
    pub paused: bool,
}

/// Emitted as Tauri event payloads for mutable playback settings.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MpvPlaybackSettings {
    pub volume: f64,
    pub muted: bool,
    pub playback_rate: f64,
    pub video_scale_mode: String,
    pub audio_track: Option<i64>,
    pub subtitle_track: Option<i64>,
}

/// Managed Tauri state for the MPV player.
pub struct MpvState {
    pub cmd_tx: mpsc::Sender<MpvCommand>,
    pub child_hwnd: isize,
}

fn emit_playback_settings_if_changed(
    app: &tauri::AppHandle,
    last_emitted: &mut Option<MpvPlaybackSettings>,
    volume: f64,
    muted: bool,
    playback_rate: f64,
    video_scale_mode: &str,
    audio_track: Option<i64>,
    subtitle_track: Option<i64>,
) {
    let next = MpvPlaybackSettings {
        volume,
        muted,
        playback_rate,
        video_scale_mode: video_scale_mode.to_string(),
        audio_track,
        subtitle_track,
    };

    if last_emitted.as_ref() == Some(&next) {
        return;
    }

    let _ = app.emit("mpv-playback-settings", next.clone());
    *last_emitted = Some(next);
}

// ── Win32 child window management ───────────────────────────────────────

#[cfg(target_os = "windows")]
pub fn create_mpv_child_window(parent_hwnd: isize) -> Result<isize, String> {
    use windows_sys::Win32::Graphics::Gdi::GetStockObject;
    use windows_sys::Win32::Graphics::Gdi::BLACK_BRUSH;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    unsafe {
        let class_name: Vec<u16> = "JfgoatMpvHost\0".encode_utf16().collect();

        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: Some(DefWindowProcW),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: GetModuleHandleW(std::ptr::null()),
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: GetStockObject(BLACK_BRUSH),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: std::ptr::null_mut(),
        };

        RegisterClassExW(&wc);

        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            std::ptr::null(),
            WS_CHILD,
            0,
            0,
            1280,
            800,
            parent_hwnd as _,
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        );

        if hwnd.is_null() {
            return Err("CreateWindowExW returned null".to_string());
        }

        Ok(hwnd as isize)
    }
}

#[cfg(target_os = "windows")]
pub fn show_mpv_window(child_hwnd: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        ShowWindow(child_hwnd as _, SW_SHOW);
        SetWindowPos(
            child_hwnd as _,
            HWND_BOTTOM,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

#[cfg(target_os = "windows")]
pub fn hide_mpv_window(child_hwnd: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        ShowWindow(child_hwnd as _, SW_HIDE);
    }
}

#[cfg(target_os = "windows")]
pub fn resize_mpv_window(child_hwnd: isize, width: u32, height: u32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        SetWindowPos(
            child_hwnd as _,
            HWND_BOTTOM,
            0,
            0,
            width as i32,
            height as i32,
            SWP_NOACTIVATE,
        );
    }
}

/// Set the DLL search directory so libmpv2 can find mpv-2.dll at runtime.
#[cfg(target_os = "windows")]
pub fn set_mpv_dll_directory(resource_dir: &std::path::Path) {
    use windows_sys::Win32::System::LibraryLoader::SetDllDirectoryW;
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = resource_dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        SetDllDirectoryW(wide.as_ptr());
    }
}

#[cfg(target_os = "macos")]
pub fn create_mpv_child_view(parent_view: isize) -> Result<isize, String> {
    use cocoa::base::id;
    use cocoa::base::nil;
    use cocoa::appkit::NSView as CocoaNSView;

    unsafe {
        let view_class = objc::runtime::Class::get("NSView")
            .ok_or_else(|| "NSView class not found".to_string())?;
        let child_view: id = msg_send![view_class, alloc];
        let child_view: id = msg_send![child_view, init];

        if child_view.is_null() {
            return Err("Failed to allocate and initialize NSView".to_string());
        }

        // Get frame/bounds from parent and apply to child
        let parent: id = parent_view as id;
        let frame = parent.frame();
        let (): () = msg_send![child_view, setFrame: frame];

        // NSViewWidthSizable (2) | NSViewHeightSizable (8) = 10
        let mask: usize = 10;
        let (): () = msg_send![child_view, setAutoresizingMask: mask];

        // Add subview below all others (NSWindowBelow = -1)
        let () = msg_send![parent, addSubview:child_view positioned:-1isize relativeTo:nil];

        Ok(child_view as isize)
    }
}

#[cfg(target_os = "macos")]
pub fn show_mpv_window(child_view: isize) {
    use cocoa::base::id;
    unsafe {
        let () = msg_send![child_view as id, setHidden: false];
    }
}

#[cfg(target_os = "macos")]
pub fn hide_mpv_window(child_view: isize) {
    use cocoa::base::id;
    unsafe {
        let () = msg_send![child_view as id, setHidden: true];
    }
}

// ── MPV thread ──────────────────────────────────────────────────────────

pub fn spawn_mpv_thread(
    child_hwnd: isize,
    cmd_rx: mpsc::Receiver<MpvCommand>,
    app_handle: tauri::AppHandle,
) {
    std::thread::Builder::new()
        .name("mpv-player".to_string())
        .spawn(move || {
            run_mpv_loop(child_hwnd, cmd_rx, app_handle);
        })
        .expect("Failed to spawn mpv thread");
}

fn run_mpv_loop(
    child_hwnd: isize,
    cmd_rx: mpsc::Receiver<MpvCommand>,
    app_handle: tauri::AppHandle,
) {
    use libmpv2::Mpv;
    use tauri::Manager;

    let mut mpv = Mpv::new().expect("Failed to create mpv instance");

    // Render into the child HWND
    mpv.set_property("wid", child_hwnd as i64).unwrap();

    // Hardware decoding & subtitle styling loaded from preferences
    let app_state = app_handle.state::<crate::state::AppState>();
    let mut hwdec = "auto".to_string();
    let mut sub_scale = 1.0;
    let mut sub_color = "#ffffff".to_string();
    let mut sub_back_color = "#00000000".to_string();

    if let Ok(db) = app_state.db.read_conn() {
        let maybe_raw = db.query_row(
            "SELECT value FROM metadata WHERE key = 'user_preferences_v1'",
            [],
            |row| row.get::<_, String>(0),
        );
        if let Ok(raw) = maybe_raw {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(hwdec_str) = parsed.pointer("/playback/hwdec").and_then(|v| v.as_str()) {
                    hwdec = hwdec_str.to_string();
                }
                if let Some(sub_scale_val) = parsed.pointer("/playback/subtitle_size_percent").and_then(|v| v.as_i64()) {
                    sub_scale = (sub_scale_val as f64) / 100.0;
                }
                if let Some(sub_color_str) = parsed.pointer("/playback/subtitle_color").and_then(|v| v.as_str()) {
                    sub_color = sub_color_str.to_string();
                }
                if let Some(sub_bg_opacity_val) = parsed.pointer("/playback/subtitle_background_opacity").and_then(|v| v.as_i64()) {
                    let alpha_val = ((sub_bg_opacity_val as f64 / 100.0) * 255.0) as u8;
                    sub_back_color = format!("#{:02X}000000", alpha_val);
                }
            }
        }
    }

    mpv.set_property("hwdec", hwdec.as_str()).unwrap();
    mpv.set_property("sub-scale", sub_scale).ok();
    mpv.set_property("sub-color", sub_color.as_str()).ok();
    mpv.set_property("sub-back-color", sub_back_color.as_str()).ok();

    // Keep the window open after playback ends (for "ended" state)
    mpv.set_property("keep-open", "yes").unwrap();

    // Disable mpv's own OSD — Svelte provides controls
    mpv.set_property("osc", "no").unwrap();
    mpv.set_property("osd-level", 0i64).unwrap();
    mpv.set_property("input-default-bindings", "no").unwrap();
    mpv.set_property("input-vo-keyboard", "no").unwrap();

    // Observe properties for the event loop
    mpv.event_context_mut()
        .observe_property("time-pos", libmpv2::Format::Double, 0)
        .unwrap();
    mpv.event_context_mut()
        .observe_property("duration", libmpv2::Format::Double, 0)
        .unwrap();
    mpv.event_context_mut()
        .observe_property("pause", libmpv2::Format::Flag, 0)
        .unwrap();
    mpv.event_context_mut()
        .observe_property("volume", libmpv2::Format::Double, 0)
        .unwrap();
    mpv.event_context_mut()
        .observe_property("mute", libmpv2::Format::Flag, 0)
        .unwrap();
    mpv.event_context_mut()
        .observe_property("speed", libmpv2::Format::Double, 0)
        .unwrap();
    mpv.event_context_mut()
        .observe_property("aid", libmpv2::Format::Int64, 0)
        .unwrap();
    mpv.event_context_mut()
        .observe_property("sid", libmpv2::Format::Int64, 0)
        .unwrap();
    mpv.event_context_mut()
        .observe_property("eof-reached", libmpv2::Format::Flag, 0)
        .unwrap();

    let mut current_item_id: Option<String> = None;
    let mut time_pos: f64 = 0.0;
    let mut duration: f64 = 0.0;
    let mut volume: f64 = 100.0;
    let mut muted = false;
    let mut playback_rate: f64 = 1.0;
    let mut video_scale_mode = String::from("contain");
    let mut audio_track: Option<i64> = None;
    let mut subtitle_track: Option<i64> = None;
    let mut last_emitted_settings: Option<MpvPlaybackSettings> = None;
    let mut last_emit = std::time::Instant::now();
    let emit_interval = std::time::Duration::from_millis(250);

    // Autocrop tracking state
    let mut auto_crop_mode = String::from("static");
    let mut autocrop_active = false;
    let mut detection_start_time = std::time::Instant::now();
    let mut detection_stopped = false;
    let mut last_autocrop_check = std::time::Instant::now();
    let mut current_crop_w = 0i64;
    let mut current_crop_h = 0i64;
    let mut current_crop_x = 0i64;
    let mut current_crop_y = 0i64;
    let mut pending_crop_w = 0i64;
    let mut pending_crop_h = 0i64;
    let mut pending_crop_x = 0i64;
    let mut pending_crop_y = 0i64;
    let mut pending_crop_count = 0;

    emit_playback_settings_if_changed(
        &app_handle,
        &mut last_emitted_settings,
        volume,
        muted,
        playback_rate,
        &video_scale_mode,
        audio_track,
        subtitle_track,
    );

    loop {
        // 1. Drain the command queue (non-blocking)
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                MpvCommand::LoadFile {
                    item_id,
                    url,
                    start_seconds,
                    audio_track: initial_audio_track,
                    subtitle_track: initial_subtitle_track,
                    headers,
                } => {
                    current_item_id = Some(item_id);
                    // Set custom HTTP headers (such as X-Emby-Token) for stream and subtitle requests
                    if !headers.is_empty() {
                        let headers_str = headers.join(",");
                        let _ = mpv.set_property("http-header-fields", headers_str.as_str());
                    } else {
                        let _ = mpv.set_property("http-header-fields", "");
                    }
                    // Load hardware decoding & subtitle styling dynamically from preferences on each file load
                    let app_state = app_handle.state::<crate::state::AppState>();
                    if let Ok(db) = app_state.db.read_conn() {
                        let maybe_raw = db.query_row(
                            "SELECT value FROM metadata WHERE key = 'user_preferences_v1'",
                            [],
                            |row| row.get::<_, String>(0),
                        );
                        if let Ok(raw) = maybe_raw {
                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                                if let Some(hwdec_str) = parsed.pointer("/playback/hwdec").and_then(|v| v.as_str()) {
                                    let _ = mpv.set_property("hwdec", hwdec_str);
                                }
                                if let Some(sub_scale_val) = parsed.pointer("/playback/subtitle_size_percent").and_then(|v| v.as_i64()) {
                                    let scale = (sub_scale_val as f64) / 100.0;
                                    let _ = mpv.set_property("sub-scale", scale);
                                }
                                if let Some(sub_color_str) = parsed.pointer("/playback/subtitle_color").and_then(|v| v.as_str()) {
                                    let _ = mpv.set_property("sub-color", sub_color_str);
                                }
                                if let Some(sub_bg_opacity_val) = parsed.pointer("/playback/subtitle_background_opacity").and_then(|v| v.as_i64()) {
                                    let alpha_val = ((sub_bg_opacity_val as f64 / 100.0) * 255.0) as u8;
                                    let sub_back_color = format!("#{:02X}000000", alpha_val);
                                    let _ = mpv.set_property("sub-back-color", sub_back_color.as_str());
                                }
                            }
                        }
                    }

                    if start_seconds > 0.0 {
                        mpv.set_property("start", format!("+{}", start_seconds))
                            .ok();
                    } else {
                        mpv.set_property("start", "0").ok();
                    }
                    mpv.command("loadfile", &[&url, "replace"]).ok();

                    if let Some(track) = initial_audio_track {
                        audio_track = Some(track);
                        mpv.set_property("aid", track).ok();
                    }

                    if let Some(track) = initial_subtitle_track {
                        subtitle_track = if track < 0 { None } else { Some(track) };
                        if track < 0 {
                            mpv.set_property("sid", -1i64).ok();
                        } else {
                            mpv.set_property("sid", track).ok();
                        }
                    }

                    emit_playback_settings_if_changed(
                        &app_handle,
                        &mut last_emitted_settings,
                        volume,
                        muted,
                        playback_rate,
                        &video_scale_mode,
                        audio_track,
                        subtitle_track,
                    );

                    if autocrop_active {
                        let app_state = app_handle.state::<crate::state::AppState>();
                        if let Ok(db) = app_state.db.read_conn() {
                            let maybe_raw = db.query_row(
                                "SELECT value FROM metadata WHERE key = 'user_preferences_v1'",
                                [],
                                |row| row.get::<_, String>(0),
                            );
                            if let Ok(raw) = maybe_raw {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                                    if let Some(m) = parsed.pointer("/playback/auto_crop_mode").and_then(|v| v.as_str()) {
                                        auto_crop_mode = m.to_string();
                                    }
                                }
                            }
                        }

                        let _ = mpv.set_property("hwdec", "auto-copy");
                        let _ = mpv.set_property("stretch-image-subs-to-screen", "yes");
                        
                        detection_start_time = std::time::Instant::now();
                        detection_stopped = false;
                        current_crop_w = 0;
                        current_crop_h = 0;
                        current_crop_x = 0;
                        current_crop_y = 0;
                        pending_crop_w = 0;
                        pending_crop_h = 0;
                        pending_crop_x = 0;
                        pending_crop_y = 0;
                        pending_crop_count = 0;

                        let _ = mpv.command("vf", &["add", "@autocrop_detect:cropdetect=limit=24/255:round=2:reset=0"]);
                    } else {
                        let _ = mpv.set_property("hwdec", hwdec.as_str());
                    }
                }
                MpvCommand::TogglePause => {
                    let paused: bool = mpv.get_property("pause").unwrap_or(false);
                    mpv.set_property("pause", !paused).ok();
                }
                MpvCommand::SeekRelative(secs) => {
                    mpv.command("seek", &[&secs.to_string(), "relative"]).ok();
                }
                MpvCommand::SeekAbsolute(secs) => {
                    mpv.command("seek", &[&secs.to_string(), "absolute"]).ok();
                }
                MpvCommand::SetVolume(vol) => {
                    mpv.set_property("volume", vol).ok();
                    volume = vol;
                    emit_playback_settings_if_changed(
                        &app_handle,
                        &mut last_emitted_settings,
                        volume,
                        muted,
                        playback_rate,
                        &video_scale_mode,
                        audio_track,
                        subtitle_track,
                    );
                }
                MpvCommand::SetMute(should_mute) => {
                    mpv.set_property("mute", should_mute).ok();
                    muted = should_mute;
                    emit_playback_settings_if_changed(
                        &app_handle,
                        &mut last_emitted_settings,
                        volume,
                        muted,
                        playback_rate,
                        &video_scale_mode,
                        audio_track,
                        subtitle_track,
                    );
                }
                MpvCommand::SetRate(rate) => {
                    let safe_rate = if rate.is_finite() {
                        rate.clamp(0.25, 3.0)
                    } else {
                        1.0
                    };
                    mpv.set_property("speed", safe_rate).ok();
                    playback_rate = safe_rate;
                    emit_playback_settings_if_changed(
                        &app_handle,
                        &mut last_emitted_settings,
                        volume,
                        muted,
                        playback_rate,
                        &video_scale_mode,
                        audio_track,
                        subtitle_track,
                    );
                }
                MpvCommand::SetSubtitlePosition(position) => {
                    let clamped = position.clamp(0, 100);
                    mpv.set_property("sub-pos", clamped).ok();
                }
                MpvCommand::SetVideoScale(mode) => {
                    match mode.as_str() {
                        "auto-crop" => {
                            let app_state = app_handle.state::<crate::state::AppState>();
                            if let Ok(db) = app_state.db.read_conn() {
                                let maybe_raw = db.query_row(
                                    "SELECT value FROM metadata WHERE key = 'user_preferences_v1'",
                                    [],
                                    |row| row.get::<_, String>(0),
                                );
                                if let Ok(raw) = maybe_raw {
                                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                                        if let Some(m) = parsed.pointer("/playback/auto_crop_mode").and_then(|v| v.as_str()) {
                                            auto_crop_mode = m.to_string();
                                        }
                                    }
                                }
                            }

                            if !autocrop_active {
                                autocrop_active = true;
                                detection_start_time = std::time::Instant::now();
                                detection_stopped = false;
                                current_crop_w = 0;
                                current_crop_h = 0;
                                current_crop_x = 0;
                                current_crop_y = 0;
                                pending_crop_w = 0;
                                pending_crop_h = 0;
                                pending_crop_x = 0;
                                pending_crop_y = 0;
                                pending_crop_count = 0;

                                let _ = mpv.set_property("hwdec", "auto-copy");
                                let _ = mpv.set_property("stretch-image-subs-to-screen", "yes");
                                let _ = mpv.command("vf", &["add", "@autocrop_detect:cropdetect=limit=24/255:round=2:reset=0"]);
                            }
                            video_scale_mode = "auto-crop".to_string();
                        }
                        "cover" => {
                            if autocrop_active {
                                autocrop_active = false;
                                detection_stopped = true;
                                let _ = mpv.command("vf", &["remove", "@autocrop_detect"]);
                                let _ = mpv.command("vf", &["remove", "@autocrop_filter"]);
                                let _ = mpv.set_property("hwdec", hwdec.as_str());
                                let _ = mpv.set_property("stretch-image-subs-to-screen", "no");
                            }
                            mpv.set_property("keepaspect", true).ok();
                            mpv.set_property("panscan", 1.0f64).ok();
                            video_scale_mode = "cover".to_string();
                        }
                        "stretch" => {
                            if autocrop_active {
                                autocrop_active = false;
                                detection_stopped = true;
                                let _ = mpv.command("vf", &["remove", "@autocrop_detect"]);
                                let _ = mpv.command("vf", &["remove", "@autocrop_filter"]);
                                let _ = mpv.set_property("hwdec", hwdec.as_str());
                                let _ = mpv.set_property("stretch-image-subs-to-screen", "no");
                            }
                            mpv.set_property("keepaspect", false).ok();
                            mpv.set_property("panscan", 0.0f64).ok();
                            video_scale_mode = "stretch".to_string();
                        }
                        _ => {
                            if autocrop_active {
                                autocrop_active = false;
                                detection_stopped = true;
                                let _ = mpv.command("vf", &["remove", "@autocrop_detect"]);
                                let _ = mpv.command("vf", &["remove", "@autocrop_filter"]);
                                let _ = mpv.set_property("hwdec", hwdec.as_str());
                                let _ = mpv.set_property("stretch-image-subs-to-screen", "no");
                            }
                            mpv.set_property("keepaspect", true).ok();
                            mpv.set_property("panscan", 0.0f64).ok();
                            video_scale_mode = "contain".to_string();
                        }
                    }
                    emit_playback_settings_if_changed(
                        &app_handle,
                        &mut last_emitted_settings,
                        volume,
                        muted,
                        playback_rate,
                        &video_scale_mode,
                        audio_track,
                        subtitle_track,
                    );
                }
                MpvCommand::SetAudioTrack(track) => {
                    audio_track = Some(track);
                    mpv.set_property("aid", track).ok();
                    emit_playback_settings_if_changed(
                        &app_handle,
                        &mut last_emitted_settings,
                        volume,
                        muted,
                        playback_rate,
                        &video_scale_mode,
                        audio_track,
                        subtitle_track,
                    );
                }
                MpvCommand::SetSubtitleTrack(track) => {
                    subtitle_track = track;
                    if let Some(track_idx) = track {
                        mpv.set_property("sid", track_idx).ok();
                    } else {
                        mpv.set_property("sid", "no").ok();
                    }
                    emit_playback_settings_if_changed(
                        &app_handle,
                        &mut last_emitted_settings,
                        volume,
                        muted,
                        playback_rate,
                        &video_scale_mode,
                        audio_track,
                        subtitle_track,
                    );
                }
                MpvCommand::AddSubtitle { url, select } => {
                    let flag = if select { "select" } else { "none" };
                    mpv.command("sub-add", &[&url, flag]).ok();
                }
                MpvCommand::Stop => {
                    mpv.command("stop", &[]).ok();
                    let _ = app_handle.emit("mpv-stopped", ());
                }
            }
        }

        // 2. Process mpv events (50ms timeout keeps the loop responsive)
        if let Some(Ok(event)) = mpv.event_context_mut().wait_event(0.05) {
            use libmpv2::events::Event;
            use libmpv2::events::PropertyData;

            match event {
                Event::PropertyChange { name, change, .. } => match (name, change) {
                    ("time-pos", PropertyData::Double(v)) => {
                        time_pos = v;
                    }
                    ("duration", PropertyData::Double(v)) => {
                        duration = v;
                    }
                    ("pause", PropertyData::Flag(p)) => {
                        let _ = app_handle.emit("mpv-state-change", MpvStateChange { paused: p });
                    }
                    ("volume", PropertyData::Double(v)) => {
                        volume = v;
                        emit_playback_settings_if_changed(
                            &app_handle,
                            &mut last_emitted_settings,
                            volume,
                            muted,
                            playback_rate,
                            &video_scale_mode,
                            audio_track,
                            subtitle_track,
                        );
                    }
                    ("mute", PropertyData::Flag(v)) => {
                        muted = v;
                        emit_playback_settings_if_changed(
                            &app_handle,
                            &mut last_emitted_settings,
                            volume,
                            muted,
                            playback_rate,
                            &video_scale_mode,
                            audio_track,
                            subtitle_track,
                        );
                    }
                    ("speed", PropertyData::Double(v)) => {
                        playback_rate = v;
                        emit_playback_settings_if_changed(
                            &app_handle,
                            &mut last_emitted_settings,
                            volume,
                            muted,
                            playback_rate,
                            &video_scale_mode,
                            audio_track,
                            subtitle_track,
                        );
                    }
                    ("aid", PropertyData::Int64(v)) => {
                        audio_track = Some(v);
                        emit_playback_settings_if_changed(
                            &app_handle,
                            &mut last_emitted_settings,
                            volume,
                            muted,
                            playback_rate,
                            &video_scale_mode,
                            audio_track,
                            subtitle_track,
                        );
                    }
                    ("sid", PropertyData::Int64(v)) => {
                        subtitle_track = if v < 0 { None } else { Some(v) };
                        emit_playback_settings_if_changed(
                            &app_handle,
                            &mut last_emitted_settings,
                            volume,
                            muted,
                            playback_rate,
                            &video_scale_mode,
                            audio_track,
                            subtitle_track,
                        );
                    }
                    ("eof-reached", PropertyData::Flag(eof)) => {
                        if eof {
                            if let Some(ref item_id) = current_item_id {
                                let _ = app_handle.emit("mpv-file-ended", item_id);
                            }
                        }
                    }
                    _ => {}
                },
                Event::EndFile(_reason) => {}
                _ => {}
            }
        }

        if autocrop_active && !detection_stopped && last_autocrop_check.elapsed() >= std::time::Duration::from_millis(500) {
            last_autocrop_check = std::time::Instant::now();
            let video_h = mpv.get_property::<i64>("video-params/h").unwrap_or(0);

            let w = mpv.get_property::<String>("vf-metadata/autocrop_detect/lavfi.cropdetect.w").ok().and_then(|s| s.parse::<i64>().ok());
            let h = mpv.get_property::<String>("vf-metadata/autocrop_detect/lavfi.cropdetect.h").ok().and_then(|s| s.parse::<i64>().ok());
            let x = mpv.get_property::<String>("vf-metadata/autocrop_detect/lavfi.cropdetect.x").ok().and_then(|s| s.parse::<i64>().ok());
            let y = mpv.get_property::<String>("vf-metadata/autocrop_detect/lavfi.cropdetect.y").ok().and_then(|s| s.parse::<i64>().ok());

            if let (Some(w), Some(h), Some(x), Some(y)) = (w, h, x, y) {
                if w > 0 && h > 0 {
                    if w != current_crop_w || h != current_crop_h || x != current_crop_x || y != current_crop_y {
                        let is_expanding = current_crop_h == 0 || h > current_crop_h;

                        if is_expanding {
                            current_crop_w = w;
                            current_crop_h = h;
                            current_crop_x = x;
                            current_crop_y = y;
                            pending_crop_count = 0;

                            let _ = mpv.command("vf", &["add", &format!("@autocrop_filter:crop={}:{}:{}:{}", w, h, x, y)]);

                            if auto_crop_mode == "static" && video_h > 0 && h < video_h {
                                detection_stopped = true;
                                let _ = mpv.command("vf", &["remove", "@autocrop_detect"]);
                                let _ = mpv.set_property("hwdec", hwdec.as_str());
                            }
                        } else {
                            if w == pending_crop_w && h == pending_crop_h && x == pending_crop_x && y == pending_crop_y {
                                pending_crop_count += 1;
                            } else {
                                pending_crop_w = w;
                                pending_crop_h = h;
                                pending_crop_x = x;
                                pending_crop_y = y;
                                pending_crop_count = 1;
                            }

                            if pending_crop_count >= 4 {
                                current_crop_w = w;
                                current_crop_h = h;
                                current_crop_x = x;
                                current_crop_y = y;
                                pending_crop_count = 0;

                                let _ = mpv.command("vf", &["add", &format!("@autocrop_filter:crop={}:{}:{}:{}", w, h, x, y)]);

                                if auto_crop_mode == "static" && video_h > 0 && h < video_h {
                                    detection_stopped = true;
                                    let _ = mpv.command("vf", &["remove", "@autocrop_detect"]);
                                    let _ = mpv.set_property("hwdec", hwdec.as_str());
                                }
                            }
                        }
                    } else {
                        pending_crop_count = 0;
                    }
                }
            }

            if auto_crop_mode == "static" && detection_start_time.elapsed() >= std::time::Duration::from_secs(15) {
                detection_stopped = true;
                let _ = mpv.command("vf", &["remove", "@autocrop_detect"]);
                let _ = mpv.set_property("hwdec", hwdec.as_str());
            }
        }

        // 3. Throttled time position broadcast (~4 updates/sec)
        if last_emit.elapsed() >= emit_interval && duration > 0.0 {
            let _ = app_handle.emit(
                "mpv-time-update",
                MpvTimeUpdate {
                    position: time_pos,
                    duration,
                },
            );
            last_emit = std::time::Instant::now();
        }
    }
}
