import { invoke } from "@tauri-apps/api/core";
import { setRequestedTracks } from "./stores/player.svelte";

import type {
  ServerPublicInfo,
  LoginResult,
  SessionInfo,
  SearchResult,
  MediaItem,
  PaginatedResult,
  PaginationRequest,
  UserLibrary,
  HomepageCache,
  DiagnosticsExportResult,
  StorageUsage,
  UserPreferences,
  Person,
  MediaStreamInfo,
  ChapterInfo,
  ExternalUrl,
  PlaybackRequest,
  PlaybackConfigPayload,
  DirectPlaybackQuery,
  TranscodePlaybackQuery,
  VideoScaleMode,
  OfflineDownload,
  MediaSegment,
} from "./types";


function encodeQueryValue(value: string | number): string {
  return encodeURIComponent(String(value));
}

function toQueryString<T extends object>(query: T): string {
  return Object.entries(query as Record<string, string | number | undefined>)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeQueryValue(value as string | number)}`,
    )
    .join("&");
}

type ApiRequestOptions = {
  signal?: AbortSignal;
};

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

async function invokeWithAbort<T>(
  command: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);

  if (!signal) {
    return invoke(command, args);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });

    invoke<T>(command, args).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(createAbortError());
          return;
        }
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(createAbortError());
          return;
        }
        reject(error);
      },
    );
  });
}

export async function connectToServer(url: string): Promise<ServerPublicInfo> {
  return invoke("connect_to_server", { url });
}

export async function login(
  username: string,
  password: string,
): Promise<LoginResult> {
  return invoke("login", { username, password });
}

export async function checkAuth(): Promise<SessionInfo | null> {
  return invoke("check_auth");
}

export async function checkAuthOffline(): Promise<SessionInfo | null> {
  return invoke("check_auth_offline");
}

export async function logout(): Promise<void> {
  return invoke("logout");
}

export async function startSync(): Promise<void> {
  return invoke("start_sync");
}

export async function searchItems(query: string): Promise<SearchResult> {
  return invoke("search_items", { query });
}

export async function getSyncStatus(): Promise<string> {
  return invoke("get_sync_status");
}

export async function forceResync(): Promise<void> {
  return invoke("force_resync");
}

export async function getRecentMovies(limit: number): Promise<MediaItem[]> {
  return invoke("get_recent_movies", { limit });
}

export async function getRecentSeries(limit: number): Promise<MediaItem[]> {
  return invoke("get_recent_series", { limit });
}

export async function getContinueWatching(limit: number): Promise<MediaItem[]> {
  return invoke("get_continue_watching", { limit });
}

export async function getLatestMedia(limit: number): Promise<MediaItem[]> {
  return invoke("get_latest_media", { limit });
}

// ── Live Jellyfin API commands ──────────────────────────────────────────

export async function getUserViews(): Promise<UserLibrary[]> {
  return invoke("get_user_views");
}

export async function getResumeItems(limit: number): Promise<MediaItem[]> {
  return invoke("get_resume_items", { limit });
}

export async function getNextUp(limit: number): Promise<MediaItem[]> {
  return invoke("get_next_up", { limit });
}

export async function getLatestItems(
  parentId: string,
  limit: number,
): Promise<MediaItem[]> {
  return invoke("get_latest_items", { parentId, limit });
}

export async function getLibraryItems(
  parentId: string,
  page: number,
  limit: number,
): Promise<PaginatedResult<MediaItem>> {
  const safePage = Math.max(1, Math.trunc(page));
  const safeLimit = Math.max(1, Math.trunc(limit));
  const preferOffline =
    typeof navigator !== "undefined" && navigator.onLine === false;
  return invoke("get_library_items", {
    parentId,
    page: safePage,
    limit: safeLimit,
    preferOffline,
  });
}

export async function getLibraryItemsPage(
  parentId: string,
  pagination: PaginationRequest,
): Promise<PaginatedResult<MediaItem>> {
  const safeLimit = Math.max(1, Math.trunc(pagination.limit));
  const safeStartIndex = Math.max(0, Math.trunc(pagination.start_index));
  const page = Math.floor(safeStartIndex / safeLimit) + 1;
  return getLibraryItems(parentId, page, safeLimit);
}

export function buildPlaybackConfigPayload(
  serverUrl: string,
  apiKey: string,
  request: PlaybackRequest,
): PlaybackConfigPayload {
  const normalizedServerUrl = serverUrl.replace(/\/+$/, "");
  const endpoint = `/Videos/${request.itemId}/stream`;
  const shouldTranscode =
    (request.maxStreamingBitrate ?? 0) > 0 || (request.targetHeight ?? 0) > 0;

  if (shouldTranscode) {
    const query: TranscodePlaybackQuery = {
      api_key: apiKey,
      static: "false",
    };

    if (
      typeof request.audioStreamIndex === "number" &&
      request.audioStreamIndex >= 0
    ) {
      query.AudioStreamIndex = request.audioStreamIndex;
    }

    if (typeof request.subtitleStreamIndex === "number") {
      query.SubtitleStreamIndex =
        request.subtitleStreamIndex >= 0 ? request.subtitleStreamIndex : -1;
    }

    if ((request.maxStreamingBitrate ?? 0) > 0) {
      query.MaxStreamingBitrate = request.maxStreamingBitrate as number;
    }

    if ((request.targetHeight ?? 0) > 0) {
      query.MaxHeight = request.targetHeight as number;
    }

    const url = `${normalizedServerUrl}${endpoint}?${toQueryString(query)}`;

    return {
      mode: "transcode",
      item_id: request.itemId,
      endpoint,
      url,
      query,
    };
  }

  const query: DirectPlaybackQuery = {
    api_key: apiKey,
    static: "true",
    mediaSourceId: request.itemId,
  };

  const url = `${normalizedServerUrl}${endpoint}?${toQueryString(query)}`;

  return {
    mode: "direct",
    item_id: request.itemId,
    endpoint,
    url,
    query,
  };
}

// ── Detail page commands ─────────────────────────────────────────────

export async function getItemById(
  id: string,
  options: ApiRequestOptions = {},
): Promise<MediaItem | null> {
  return invokeWithAbort("get_item_by_id", { id }, options.signal);
}

export async function getSeriesSeasons(
  seriesId: string,
  options: ApiRequestOptions = {},
): Promise<MediaItem[]> {
  return invokeWithAbort("get_series_seasons", { seriesId }, options.signal);
}

export async function getSeasonEpisodes(
  seasonId: string,
  options: ApiRequestOptions = {},
): Promise<MediaItem[]> {
  return invokeWithAbort("get_season_episodes", { seasonId }, options.signal);
}

export async function getItemPeople(
  id: string,
  options: ApiRequestOptions = {},
): Promise<Person[]> {
  return invokeWithAbort("get_item_people", { id }, options.signal);
}

export async function getSimilarItems(
  id: string,
  limit: number,
  options: ApiRequestOptions = {},
): Promise<MediaItem[]> {
  return invokeWithAbort("get_similar_items", { id, limit }, options.signal);
}

// ── Homepage cache commands ─────────────────────────────────────────────

export async function saveHomepageCache(data: HomepageCache): Promise<void> {
  return invoke("save_homepage_cache", { data });
}

export async function loadHomepageCache(): Promise<HomepageCache | null> {
  return invoke("load_homepage_cache");
}

export async function getUserPreferences(): Promise<UserPreferences> {
  return invoke("get_user_preferences");
}

export async function saveUserPreferences(
  preferences: UserPreferences,
): Promise<UserPreferences> {
  return invoke("save_user_preferences", { preferences });
}

export async function exportDiagnostics(): Promise<DiagnosticsExportResult> {
  return invoke("export_diagnostics");
}

// ── MPV player commands ─────────────────────────────────────────

export async function mpvPlay(request: PlaybackRequest): Promise<void> {
  const audio = request.audioStreamIndex ?? null;
  const subtitle = request.subtitleStreamIndex === -1 ? null : (request.subtitleStreamIndex ?? null);
  setRequestedTracks(audio, subtitle);
  return invoke("mpv_play", { ...request });
}

export async function mpvTogglePause(): Promise<void> {
  return invoke("mpv_toggle_pause");
}

export async function mpvSeek(seconds: number): Promise<void> {
  return invoke("mpv_seek", { seconds });
}

export async function mpvSeekAbsolute(seconds: number): Promise<void> {
  return invoke("mpv_seek_absolute", { seconds });
}

export async function mpvSetVolume(volume: number): Promise<void> {
  return invoke("mpv_set_volume", { volume });
}

export async function mpvSetMute(muted: boolean): Promise<void> {
  return invoke("mpv_set_mute", { muted });
}

export async function mpvSetPlaybackRate(rate: number): Promise<void> {
  return invoke("mpv_set_playback_rate", { rate });
}

export async function mpvSetSubtitlePosition(position: number): Promise<void> {
  return invoke("mpv_set_subtitle_position", { position });
}

export async function mpvSetVideoScale(mode: VideoScaleMode): Promise<void> {
  return invoke("mpv_set_video_scale", { mode });
}

export async function mpvSetAudioTrack(track: number): Promise<void> {
  return invoke("mpv_set_audio_track", { track });
}

export async function mpvSetSubtitleTrack(track: number | null): Promise<void> {
  return invoke("mpv_set_subtitle_track", { track });
}

export async function mpvAddExternalSubtitle(itemId: string, index: number, format: string): Promise<void> {
  return invoke("mpv_add_external_subtitle", { itemId, index, format });
}

export async function mpvStop(): Promise<void> {
  return invoke("mpv_stop");
}

export async function mpvEnterPip(): Promise<void> {
  return invoke("mpv_enter_pip");
}

export async function mpvExitPip(): Promise<void> {
  return invoke("mpv_exit_pip");
}

export async function getMediaStreams(
  id: string,
  options: ApiRequestOptions = {},
): Promise<MediaStreamInfo> {
  return invokeWithAbort("get_media_streams", { id }, options.signal);
}

export async function getItemChapters(id: string): Promise<ChapterInfo[]> {
  return invoke("get_item_chapters", { id });
}

export async function getMediaSegments(id: string): Promise<MediaSegment[]> {
  return invoke("get_media_segments", { id });
}

export async function logFromFrontend(message: string): Promise<void> {
  return invoke("log_from_frontend", { message });
}


export async function getExternalUrls(
  id: string,
  options: ApiRequestOptions = {},
): Promise<ExternalUrl[]> {
  return invokeWithAbort("get_external_urls", { id }, options.signal);
}

export type PlaybackLifecycleEvent = "playing" | "progress" | "stopped";

export async function reportPlaybackLifecycle(
  itemId: string,
  positionTicks: number,
  durationTicks: number,
  event: PlaybackLifecycleEvent,
): Promise<void> {
  return invoke("report_playback_lifecycle", {
    itemId,
    positionTicks,
    durationTicks,
    event,
  });
}

export async function reportPlaybackStopped(
  itemId: string,
  positionTicks: number,
  durationTicks: number,
): Promise<void> {
  return reportPlaybackLifecycle(
    itemId,
    positionTicks,
    durationTicks,
    "stopped",
  );
}

// ── User data mutations ──────────────────────────────────────────────

export async function togglePlayed(
  id: string,
  played: boolean,
): Promise<boolean> {
  return invoke("toggle_played", { id, played });
}

export async function toggleFavorite(
  id: string,
  isFavorite: boolean,
): Promise<boolean> {
  return invoke("toggle_favorite", { id, isFavorite });
}

export async function refreshItemDetails(id: string): Promise<void> {
  return invoke("refresh_item_details", { id });
}

// ── Offline Downloads ──────────────────────────────────────────────────

export async function startDownload(
  itemId: string,
  audioTracks?: number[],
  subtitleTracks?: number[],
  transcodeHeight?: number | null,
  transcodeBitrate?: number | null,
  mediaStreamsJson?: string | null,
): Promise<void> {
  return invoke("start_download", {
    itemId,
    audioTracks: audioTracks ?? null,
    subtitleTracks: subtitleTracks ?? null,
    transcodeHeight: transcodeHeight ?? null,
    transcodeBitrate: transcodeBitrate ?? null,
    mediaStreamsJson: mediaStreamsJson ?? null,
  });
}

export async function pauseDownload(itemId: string): Promise<void> {
  return invoke("pause_download", { itemId });
}

export async function resumeDownload(itemId: string): Promise<void> {
  return invoke("resume_download", { itemId });
}

export async function cancelDownload(itemId: string): Promise<void> {
  return invoke("cancel_download", { itemId });
}

export async function deleteDownload(itemId: string): Promise<void> {
  return invoke("delete_download", { itemId });
}

export async function getDownloadStatus(itemId: string): Promise<OfflineDownload | null> {
  return invoke("get_download_status", { itemId });
}

export async function getOfflineDownloads(): Promise<OfflineDownload[]> {
  return invoke("get_offline_downloads");
}

export async function selectDownloadDirectory(): Promise<string | null> {
  return invoke("select_download_directory");
}

// ── App Updater ────────────────────────────────────────────────────────

export async function restartApp(): Promise<void> {
  return invoke("restart_app");
}

export async function getStorageUsage(): Promise<StorageUsage> {
  return invoke("get_storage_usage");
}

export async function clearAppCache(): Promise<void> {
  return invoke("clear_app_cache");
}

export async function deleteAllOfflineDownloads(): Promise<void> {
  return invoke("delete_all_offline_downloads");
}
