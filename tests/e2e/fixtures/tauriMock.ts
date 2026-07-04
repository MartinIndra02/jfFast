import type { Page } from "@playwright/test";

export async function installTauriMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const shouldAutologin =
      (globalThis as { __TAURI_MOCK_AUTOLOGIN__?: boolean })
        .__TAURI_MOCK_AUTOLOGIN__ === true;

    type ListenerMap = Map<string, Set<number>>;

    const listeners: ListenerMap = new Map();
    const callbacks = new Map<number, (payload: unknown) => void>();
    let callbackId = 1;

    const clone = <T>(value: T): T => {
      if (typeof structuredClone === "function") {
        return structuredClone(value);
      }
      return JSON.parse(JSON.stringify(value)) as T;
    };

    const createMediaItem = (overrides: Record<string, unknown>) => ({
      id: "",
      name: "",
      type: "Episode",
      parent_id: null,
      series_id: null,
      series_name: null,
      season_id: null,
      season_name: null,
      index_number: null,
      production_year: 2024,
      overview: null,
      image_tag: null,
      backdrop_tag: null,
      date_created: "2024-01-01T00:00:00.000Z",
      date_updated: "2024-01-01T00:00:00.000Z",
      community_rating: 8.4,
      official_rating: "TV-14",
      genres: "Drama, Sci-Fi",
      run_time_ticks: 12_000_000_000,
      played: false,
      play_count: 0,
      playback_ticks: 0,
      is_favorite: false,
      server_id: "srv-1",
      user_id: "user-1",
      ...overrides,
    });

    const episode1 = createMediaItem({
      id: "ep-1",
      name: "Pilot",
      type: "Episode",
      series_id: "series-1",
      series_name: "My Show",
      season_id: "season-1",
      season_name: "Season 1",
      index_number: 1,
      playback_ticks: 11_700_000_000,
      date_updated: "2024-03-10T00:00:00.000Z",
    });

    const episode2 = createMediaItem({
      id: "ep-2",
      name: "Nexus",
      type: "Episode",
      series_id: "series-1",
      series_name: "My Show",
      season_id: "season-1",
      season_name: "Season 1",
      index_number: 2,
      playback_ticks: 0,
      date_updated: "2024-03-11T00:00:00.000Z",
    });

    const series = createMediaItem({
      id: "series-1",
      name: "My Show",
      type: "Series",
      run_time_ticks: null,
      playback_ticks: 0,
    });

    const season = createMediaItem({
      id: "season-1",
      name: "Season 1",
      type: "Season",
      series_id: "series-1",
      series_name: "My Show",
      run_time_ticks: null,
      playback_ticks: 0,
    });

    const movie = createMediaItem({
      id: "movie-1",
      name: "Signal Fire",
      type: "Movie",
      run_time_ticks: 43_200_000_000,
    });

    const libraryLatest: Record<
      string,
      Array<ReturnType<typeof createMediaItem>>
    > = {
      "lib-1": [series, movie],
    };

    const state = {
      session: (shouldAutologin
        ? {
            user_id: "user-1",
            username: "demo",
            server_id: "srv-1",
            server_name: "Demo Jellyfin",
            server_url: "http://demo.local",
          }
        : null) as null | {
        user_id: string;
        username: string;
        server_id: string;
        server_name: string;
        server_url: string;
      },
      homepageCache: {
        resume_items: [episode1],
        next_up_items: [episode2],
        user_libraries: [
          {
            id: "lib-1",
            name: "Shows",
            collection_type: "tvshows",
          },
        ],
        library_latest: libraryLatest,
        featured_items: [series],
      },
      favorites: new Set<string>(),
      played: new Set<string>(),
      paused: false,
    };

    const emit = (event: string, payload: unknown): void => {
      const eventCallbacks = listeners.get(event);
      if (!eventCallbacks) return;

      for (const id of eventCallbacks) {
        const callback = callbacks.get(id);
        if (!callback) continue;
        callback({ event, id, payload });
      }
    };

    const handleInvoke = async (
      cmd: string,
      args: Record<string, unknown> = {},
    ) => {
      switch (cmd) {
        case "plugin:event|listen": {
          const event = String(args.event ?? "");
          const handler = Number(args.handler);
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)?.add(handler);
          return handler;
        }
        case "plugin:event|unlisten": {
          const event = String(args.event ?? "");
          const eventId = Number(args.eventId);
          listeners.get(event)?.delete(eventId);
          return null;
        }
        case "connect_to_server":
          return {
            id: "srv-1",
            name: "Demo Jellyfin",
            version: "10.10.0",
            url: String(args.url ?? "http://demo.local"),
          };
        case "login": {
          const checkRateLimit = (globalThis as any).__TAURI_MOCK_LOGIN_RATE_LIMIT__;
          if (checkRateLimit) {
            throw "Too many login attempts. Please wait 1 seconds.";
          }
          const failAttempts = (globalThis as any).__TAURI_MOCK_LOGIN_FAIL_ATTEMPTS__ ?? 0;
          if (failAttempts > 0) {
            (globalThis as any).__TAURI_MOCK_LOGIN_FAIL_ATTEMPTS__--;
            throw "Invalid username or password";
          }
          state.session = {
            user_id: "user-1",
            username: String(args.username ?? "demo"),
            server_id: "srv-1",
            server_name: "Demo Jellyfin",
            server_url: "http://demo.local",
          };
          return {
            user_id: state.session.user_id,
            username: state.session.username,
            server_id: state.session.server_id,
          };
        }
        case "check_auth_offline":
        case "check_auth":
          return state.session;
        case "logout":
          state.session = null;
          return null;
        case "start_sync":
          queueMicrotask(() => {
            emit("sync-progress", { current: 10, total: 10, percentage: 100 });
            emit("sync-complete", null);
          });
          return null;
        case "get_sync_status":
          return "ready";
        case "load_homepage_cache":
          return clone(state.homepageCache);
        case "save_homepage_cache":
          state.homepageCache = clone(args.data as typeof state.homepageCache);
          return null;
        case "get_resume_items":
          return clone(state.homepageCache.resume_items);
        case "get_next_up":
          return clone(state.homepageCache.next_up_items);
        case "get_user_views":
          return clone(state.homepageCache.user_libraries);
        case "get_latest_items": {
          const parentId = String(args.parentId ?? "");
          return clone(state.homepageCache.library_latest[parentId] ?? []);
        }
        case "get_latest_media":
          return clone(state.homepageCache.featured_items);
        case "search_items": {
          const query = String(args.query ?? "").toLowerCase();
          const allItems = [episode1, episode2, series, season, movie];
          const items = allItems.filter((item) =>
            item.name.toLowerCase().includes(query),
          );
          return {
            items: clone(items),
            source: "remote",
          };
        }
        case "get_item_by_id": {
          const id = String(args.id ?? "");
          const allItems = [episode1, episode2, series, season, movie];
          const found = allItems.find((item) => item.id === id);
          return found ? clone(found) : null;
        }
        case "get_series_seasons":
          return clone([season]);
        case "get_season_episodes":
          return clone([episode1, episode2]);
        case "get_item_people":
          return [];
        case "get_similar_items":
          return [];
        case "get_media_streams":
          return {
            video: [
              {
                index: 0,
                codec: "h264",
                display_title: "1080p",
                language: null,
                is_default: true,
                height: 1080,
                width: 1920,
              },
            ],
            audio: [
              {
                index: 1,
                codec: "aac",
                display_title: "English",
                language: "eng",
                is_default: true,
              },
            ],
            subtitle: [
              {
                index: 2,
                codec: "srt",
                display_title: "English (CC)",
                language: "eng",
                is_default: true,
                delivery_method: "embed",
                is_external: false,
              },
            ],
            video_label: "1080p",
          };
        case "get_item_chapters":
          return [
            { name: "Intro", start_ticks: 0, image_tag: null },
            {
              name: "Credits",
              start_ticks: 10_800_000_000,
              image_tag: null,
              marker_type: "Credits",
              chapter_type: "Credits",
            },
          ];
        case "get_external_urls":
          return [];
        case "report_playback_stopped":
          return null;
        case "toggle_played": {
          const id = String(args.id ?? "");
          const played = !Boolean(args.played);
          if (played) state.played.add(id);
          else state.played.delete(id);
          return played;
        }
        case "toggle_favorite": {
          const id = String(args.id ?? "");
          const isFavorite = !Boolean(args.isFavorite);
          if (isFavorite) state.favorites.add(id);
          else state.favorites.delete(id);
          return isFavorite;
        }
        case "mpv_play": {
          state.paused = false;
          const itemId = String(args.itemId ?? "");
          queueMicrotask(() => {
            emit("mpv-playback-settings", {
              volume: 85,
              muted: false,
              playback_rate: 1,
              video_scale_mode: "contain",
              audio_track: 1,
              subtitle_track: 2,
            });
            emit("mpv-state-change", { paused: false });
            emit("mpv-time-update", { item_id: itemId, position: 1195, duration: 1200 });
          });
          return null;
        }
        case "mpv_toggle_pause":
          state.paused = !state.paused;
          emit("mpv-state-change", { paused: state.paused });
          return null;
        case "mpv_seek":
        case "mpv_seek_absolute":
        case "mpv_set_volume":
        case "mpv_set_mute":
        case "mpv_set_playback_rate":
        case "mpv_set_subtitle_position":
        case "mpv_set_video_scale":
        case "mpv_set_audio_track":
        case "mpv_set_subtitle_track":
          return null;
        case "mpv_stop":
          emit("mpv-stopped", null);
          return null;
        default:
          return null;
      }
    };

    const internals =
      (window as Window & { __TAURI_INTERNALS__?: Record<string, unknown> })
        .__TAURI_INTERNALS__ ?? {};

    (
      window as Window & {
        __TAURI_EVENT_PLUGIN_INTERNALS__?: {
          unregisterListener: (event: string, eventId: number) => void;
        };
      }
    ).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(event: string, eventId: number) {
        listeners.get(event)?.delete(eventId);
      },
    };

    (
      window as Window & { __TAURI_INTERNALS__?: Record<string, unknown> }
    ).__TAURI_INTERNALS__ = {
      ...internals,
      transformCallback: (
        callback: (payload: unknown) => void,
        once = false,
      ): number => {
        const id = callbackId;
        callbackId += 1;

        if (once) {
          callbacks.set(id, (payload) => {
            callbacks.delete(id);
            callback(payload);
          });
        } else {
          callbacks.set(id, callback);
        }

        return id;
      },
      unregisterCallback: (id: number): void => {
        callbacks.delete(id);
      },
      runCallback: (id: number, payload: unknown): void => {
        callbacks.get(id)?.(payload);
      },
      convertFileSrc: (filePath: string): string => filePath,
      invoke: (cmd: string, args?: Record<string, unknown>) =>
        handleInvoke(cmd, args),
    };
  });
}
