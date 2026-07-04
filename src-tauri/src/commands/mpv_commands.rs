use tauri::State;

use crate::api::client::JellyfinClient;
use crate::api::media as media_api;
use crate::commands::playback_commands::{
    report_playback_lifecycle_internal, PlaybackLifecycleEvent,
};
use crate::error::JfgoatError;
use crate::mpv::{MpvCommand, MpvState};
use crate::state::AppState;

#[cfg(any(target_os = "windows", target_os = "macos"))]
use crate::mpv::{hide_mpv_window, show_mpv_window};

fn to_absolute_url(server_url: &str, raw_url: &str) -> String {
    let trimmed = raw_url.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }

    let server_base = server_url.trim_end_matches('/');
    if trimmed.starts_with('/') {
        format!("{}{}", server_base, trimmed)
    } else {
        format!("{}/{}", server_base, trimmed)
    }
}

fn resolve_stream_url_from_playback_context(
    server_url: &str,
    fallback_payload: &media_api::PlaybackConfigPayload,
    playback_info: &media_api::JellyfinPlaybackInfoResponse,
    prefer_transcode: bool,
) -> Option<String> {
    let source = playback_info.media_sources.first()?;

    let play_method = source
        .play_method
        .as_deref()
        .and_then(media_api::PlayMethod::from_wire);

    let direct_stream_url = source
        .direct_stream_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| to_absolute_url(server_url, value));

    let transcode_stream_url = source
        .transcoding_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| to_absolute_url(server_url, value));

    if prefer_transcode {
        if let Some(url) = transcode_stream_url.as_ref() {
            return Some(url.clone());
        }
    }

    match play_method {
        Some(media_api::PlayMethod::DirectPlay) => {
            return Some(fallback_payload.url().to_string());
        }
        Some(media_api::PlayMethod::DirectStream) => {
            if let Some(url) = direct_stream_url.as_ref() {
                return Some(url.clone());
            }
            return Some(fallback_payload.url().to_string());
        }
        Some(media_api::PlayMethod::Transcode) => {
            if let Some(url) = transcode_stream_url.as_ref() {
                return Some(url.clone());
            }
        }
        None => {}
    }

    if source.supports_direct_play.unwrap_or(false) {
        return Some(fallback_payload.url().to_string());
    }

    if source.supports_direct_stream.unwrap_or(false) {
        if let Some(url) = direct_stream_url {
            return Some(url);
        }
        return Some(fallback_payload.url().to_string());
    }

    if source.supports_transcoding.unwrap_or(false) {
        if let Some(url) = transcode_stream_url {
            return Some(url);
        }
    }

    None
}

async fn build_playback_url_with_options(
    state: &AppState,
    item_id: &str,
    audio_stream_index: Option<i64>,
    subtitle_stream_index: Option<i64>,
    max_streaming_bitrate: Option<i64>,
    target_height: Option<i64>,
) -> Result<String, JfgoatError> {
    let (server_url, token, user_id, device_id) = state.get_connection_params()?;

    let payload = media_api::build_playback_config_payload(
        &server_url,
        &token,
        item_id,
        audio_stream_index,
        subtitle_stream_index,
        max_streaming_bitrate,
        target_height,
    );

    let prefer_transcode =
        max_streaming_bitrate.unwrap_or(0) > 0 || target_height.unwrap_or(0) > 0;

    let playback_client = JellyfinClient::new(&state.http_client, &server_url, &device_id)
        .with_token(&token);

    let resolved_from_context = match media_api::fetch_playback_info(
        &playback_client,
        &user_id,
        item_id,
        audio_stream_index,
        subtitle_stream_index,
        max_streaming_bitrate,
        target_height,
    )
    .await
    {
        Ok(playback_info) => resolve_stream_url_from_playback_context(
            &server_url,
            &payload,
            &playback_info,
            prefer_transcode,
        ),
        Err(err) => {
            eprintln!(
                "[mpv] PlaybackInfo lookup failed for {}. Falling back to default stream URL: {}",
                item_id, err
            );
            None
        }
    };

    if let Some(url) = resolved_from_context {
        return Ok(url);
    }

    Ok(payload.url().to_string())
}

#[tauri::command]
pub async fn mpv_play(
    app: tauri::AppHandle,
    mpv: State<'_, MpvState>,
    app_state: State<'_, AppState>,
    item_id: String,
    start_ticks: i64,
    audio_stream_index: Option<i64>,
    subtitle_stream_index: Option<i64>,
    max_streaming_bitrate: Option<i64>,
    target_height: Option<i64>,
) -> Result<(), JfgoatError> {
    let local_path = {
        let db = app_state.db.read_conn().map_err(|e| JfgoatError::Internal(e.to_string()))?;
        db.query_row(
            "SELECT local_path FROM offline_downloads WHERE id = ?1 AND status = 'Completed'",
            rusqlite::params![item_id],
            |row| row.get::<_, String>(0),
        ).ok()
    };
    let is_offline = local_path.is_some();

    let mut local_subs = Vec::new();
    let url = if let Some(path) = local_path {
        println!("[mpv] Playing offline downloaded file: {}", path);
        let path_buf = std::path::PathBuf::from(&path);
        let mut sub_tuples = Vec::new();
        if let Some(parent) = path_buf.parent() {
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.filter_map(Result::ok) {
                    let p = entry.path();
                    if p.is_file() {
                        if let Some(fname) = p.file_name().and_then(|s| s.to_str()) {
                            if fname.starts_with(&item_id) && fname != path_buf.file_name().and_then(|s| s.to_str()).unwrap_or("") {
                                let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                                if ext == "srt" || ext == "vtt" || ext == "ass" || ext == "sub" {
                                    let idx = parse_subtitle_index(fname, &item_id).unwrap_or(i64::MAX);
                                    sub_tuples.push((idx, p.to_string_lossy().into_owned()));
                                }
                            }
                        }
                    }
                }
            }
        }
        sub_tuples.sort_by_key(|t| t.0);
        for (_idx, sub_path) in sub_tuples {
            local_subs.push(sub_path);
        }
        path
    } else {
        build_playback_url_with_options(
            &app_state,
            &item_id,
            audio_stream_index,
            subtitle_stream_index,
            max_streaming_bitrate,
            target_height,
        )
        .await?
    };
    let safe_ticks = start_ticks.max(0);
    let start_seconds = safe_ticks as f64 / 10_000_000.0;

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        show_mpv_window(mpv.child_hwnd);
        #[cfg(target_os = "windows")]
        {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(size) = window.inner_size() {
                    crate::mpv::resize_mpv_window(mpv.child_hwnd, size.width, size.height);
                }
            }
        }
    }

    let (_server_url, token, _user_id, _device_id) = app_state.get_connection_params()?;
    let headers = if is_offline {
        Vec::new()
    } else {
        vec![format!("X-Emby-Token: {}", token)]
    };

    mpv.cmd_tx
        .send(MpvCommand::LoadFile {
            item_id,
            url,
            start_seconds,
            // Stream selection is applied via the Jellyfin URL query parameters.
            // Avoid setting mpv aid/sid directly because those are runtime-local IDs.
            audio_track: None,
            subtitle_track: None,
            headers,
        })
        .map_err(|e| JfgoatError::Internal(format!("mpv send failed: {}", e)))?;

    for sub in local_subs {
        let _ = mpv.cmd_tx.send(MpvCommand::AddSubtitle { url: sub, select: false });
    }

    Ok(())
}

#[tauri::command]
pub async fn report_playback_lifecycle(
    state: State<'_, AppState>,
    item_id: String,
    position_ticks: i64,
    duration_ticks: i64,
    event: String,
) -> Result<(), JfgoatError> {
    let event = PlaybackLifecycleEvent::from_wire(event.as_str()).ok_or_else(|| {
        JfgoatError::Internal(format!("Invalid playback lifecycle event: {}", event))
    })?;

    report_playback_lifecycle_internal(
        &state,
        &item_id,
        position_ticks,
        duration_ticks,
        event,
    )
    .await
}

#[tauri::command]
pub fn mpv_toggle_pause(mpv: State<'_, MpvState>) -> Result<(), JfgoatError> {
    mpv.cmd_tx
        .send(MpvCommand::TogglePause)
        .map_err(|e| JfgoatError::Internal(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn mpv_seek(mpv: State<'_, MpvState>, seconds: f64) -> Result<(), JfgoatError> {
    mpv.cmd_tx
        .send(MpvCommand::SeekRelative(seconds))
        .map_err(|e| JfgoatError::Internal(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn mpv_seek_absolute(mpv: State<'_, MpvState>, seconds: f64) -> Result<(), JfgoatError> {
    mpv.cmd_tx
        .send(MpvCommand::SeekAbsolute(seconds))
        .map_err(|e| JfgoatError::Internal(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn mpv_set_volume(mpv: State<'_, MpvState>, volume: f64) -> Result<(), JfgoatError> {
    mpv.cmd_tx
        .send(MpvCommand::SetVolume(volume))
        .map_err(|e| JfgoatError::Internal(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn mpv_set_mute(mpv: State<'_, MpvState>, muted: bool) -> Result<(), JfgoatError> {
    mpv.cmd_tx
        .send(MpvCommand::SetMute(muted))
        .map_err(|e| JfgoatError::Internal(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn mpv_set_playback_rate(mpv: State<'_, MpvState>, rate: f64) -> Result<(), JfgoatError> {
    mpv.cmd_tx
        .send(MpvCommand::SetRate(rate))
        .map_err(|e| JfgoatError::Internal(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn mpv_set_subtitle_position(
    mpv: State<'_, MpvState>,
    position: i64,
) -> Result<(), JfgoatError> {
    mpv.cmd_tx
        .send(MpvCommand::SetSubtitlePosition(position))
        .map_err(|e| JfgoatError::Internal(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn mpv_set_video_scale(mpv: State<'_, MpvState>, mode: String) -> Result<(), JfgoatError> {
    mpv.cmd_tx
        .send(MpvCommand::SetVideoScale(mode))
        .map_err(|e| JfgoatError::Internal(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn mpv_set_audio_track(mpv: State<'_, MpvState>, track: i64) -> Result<(), JfgoatError> {
    mpv.cmd_tx
        .send(MpvCommand::SetAudioTrack(track))
        .map_err(|e| JfgoatError::Internal(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn mpv_set_subtitle_track(
    mpv: State<'_, MpvState>,
    track: Option<i64>,
) -> Result<(), JfgoatError> {
    mpv.cmd_tx
        .send(MpvCommand::SetSubtitleTrack(track))
        .map_err(|e| JfgoatError::Internal(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn mpv_add_external_subtitle(
    mpv: State<'_, MpvState>,
    app_state: State<'_, AppState>,
    item_id: String,
    index: i64,
    format: String,
) -> Result<(), JfgoatError> {
    let (server_url, _token, _user_id, _device_id) = app_state.get_connection_params()?;
    let server_base = server_url.trim_end_matches('/');

    let format_lower = format.to_ascii_lowercase();
    let format_ext = match format_lower.as_str() {
        "subrip" | "srt" => "srt",
        "webvtt" | "vtt" => "vtt",
        "ass" | "ssa" | "substationalpha" => "ass",
        other => other,
    };

    let url = format!(
        "{}/Videos/{}/{}/Subtitles/{}/Stream.{}",
        server_base, item_id, item_id, index, format_ext
    );

    mpv.cmd_tx
        .send(MpvCommand::AddSubtitle { url, select: true })
        .map_err(|e| JfgoatError::Internal(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub fn mpv_stop(mpv: State<'_, MpvState>) -> Result<(), JfgoatError> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    hide_mpv_window(mpv.child_hwnd);

    mpv.cmd_tx
        .send(MpvCommand::Stop)
        .map_err(|e| JfgoatError::Internal(e.to_string()))?;
    Ok(())
}

fn parse_subtitle_index(fname: &str, item_id: &str) -> Option<i64> {
    let prefix = format!("{}.", item_id);
    if fname.starts_with(&prefix) {
        let remaining = &fname[prefix.len()..];
        let parts: Vec<&str> = remaining.split('.').collect();
        if let Some(first) = parts.first() {
            if let Ok(idx) = first.parse::<i64>() {
                return Some(idx);
            }
        }
    }
    None
}
