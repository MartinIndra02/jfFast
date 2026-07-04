import { listen } from "@tauri-apps/api/event";
import type {
  MpvTimeUpdate,
  MpvStateChange,
  MpvPlaybackSettings,
  VideoScaleMode,
  StreamOption,
} from "../types";

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "ended";

// ── Reactive state ──────────────────────────────────────────────

let status = $state<PlayerStatus>("idle");

export type PipState =
  | { mode: "normal" }
  | { mode: "entering" }
  | { mode: "pip" }
  | { mode: "exiting" };

let pipState = $state<PipState>({ mode: "normal" });
let visible = $state(false);
let title = $state("");
let itemId = $state<string | null>(null);
let timePos = $state(0);
let duration = $state(0);
let volume = $state(100);
let muted = $state(false);
let playbackRate = $state(1);
let videoScaleMode = $state<VideoScaleMode>("contain");
let audioTrack = $state<number | null>(null);
let subtitleTrack = $state<number | null>(null);

const PREF_AUDIO_KEY = "jfgoat.player.preferredAudioStreamIndex";
const PREF_SUBTITLE_KEY = "jfgoat.player.preferredSubtitleStreamIndex";
const PREF_AUDIO_LANG_KEY = "jfgoat.player.preferredAudioLanguage";
const PREF_AUDIO_TITLE_KEY = "jfgoat.player.preferredAudioDisplayTitle";
const PREF_SUB_LANG_KEY = "jfgoat.player.preferredSubtitleLanguage";
const PREF_SUB_TITLE_KEY = "jfgoat.player.preferredSubtitleDisplayTitle";

function readStoredPreference(key: string): number | null | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const raw = localStorage.getItem(key);
  if (raw === null) return undefined;
  if (raw === "null") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function writeStoredPreference(key: string, value: number | null): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, value === null ? "null" : String(value));
}

function readStoredText(key: string): string | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const raw = localStorage.getItem(key);
  return raw === null ? undefined : raw;
}

function writeStoredText(key: string, value: string | null | undefined): void {
  if (typeof localStorage === "undefined") return;
  if (value === undefined) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, value ?? "");
}

function normalizeText(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().toLowerCase();
}

function normalizeLanguage(
  value: string | null | undefined,
): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized || normalized === "und") return undefined;
  return normalized;
}

let preferredAudioStreamIndex = $state<number | undefined>(
  readStoredPreference(PREF_AUDIO_KEY) ?? undefined,
);

let preferredSubtitleStreamIndex = $state<number | null | undefined>(
  readStoredPreference(PREF_SUBTITLE_KEY),
);

let preferredAudioLanguage = $state<string | undefined>(
  readStoredText(PREF_AUDIO_LANG_KEY),
);

let preferredAudioDisplayTitle = $state<string | undefined>(
  readStoredText(PREF_AUDIO_TITLE_KEY),
);

let preferredSubtitleLanguage = $state<string | undefined>(
  readStoredText(PREF_SUB_LANG_KEY),
);

let preferredSubtitleDisplayTitle = $state<string | undefined>(
  readStoredText(PREF_SUB_TITLE_KEY),
);

let requestedAudioIndex = $state<number | null>(null);
let requestedSubtitleIndex = $state<number | null>(null);


// ── Getters ─────────────────────────────────────────────────────

export function getPlayerStatus(): PlayerStatus {
  return status;
}

export function isPlayerVisible(): boolean {
  return visible;
}

export function getPlayerTitle(): string {
  return title;
}

export function getPlayerItemId(): string | null {
  return itemId;
}

export function getTimePos(): number {
  return timePos;
}

export function getDuration(): number {
  return duration;
}

export function getVolume(): number {
  return volume;
}

export function isMuted(): boolean {
  return muted;
}

export function getPlaybackRate(): number {
  return playbackRate;
}

export function getVideoScaleMode(): VideoScaleMode {
  return videoScaleMode;
}

export function getAudioTrack(): number | null {
  return audioTrack;
}

export function getSubtitleTrack(): number | null {
  return subtitleTrack;
}

export function getPreferredAudioStreamIndex(): number | undefined {
  return preferredAudioStreamIndex;
}

export function getPreferredSubtitleStreamIndex(): number | null | undefined {
  return preferredSubtitleStreamIndex;
}

export function getPreferredAudioLanguage(): string | undefined {
  return preferredAudioLanguage;
}

export function getPreferredAudioDisplayTitle(): string | undefined {
  return preferredAudioDisplayTitle;
}

export function getPreferredSubtitleLanguage(): string | undefined {
  return preferredSubtitleLanguage;
}

export function getPreferredSubtitleDisplayTitle(): string | undefined {
  return preferredSubtitleDisplayTitle;
}

export function getRequestedAudioIndex(): number | null {
  return requestedAudioIndex;
}

export function getRequestedSubtitleIndex(): number | null {
  return requestedSubtitleIndex;
}

export function getPipState(): PipState {
  return pipState;
}

export function isPipMode(): boolean {
  return pipState.mode === "pip";
}

export function isPipTransitioning(): boolean {
  return pipState.mode === "entering" || pipState.mode === "exiting";
}

export function setPipState(s: PipState) {
  pipState = s;
}


// ── Actions ─────────────────────────────────────────────────────

let firstTimeUpdatePos: number | null = null;
let loadingTimeout: ReturnType<typeof setTimeout> | null = null;

export function showPlayer(id: string, displayTitle: string) {
  if (loadingTimeout) {
    clearTimeout(loadingTimeout);
    loadingTimeout = null;
  }
  firstTimeUpdatePos = null;
  itemId = id;
  title = displayTitle;
  status = "loading";
  visible = true;
  timePos = 0;
  duration = 0;
  requestedAudioIndex = null;
  requestedSubtitleIndex = null;
}

export function resetPlayerState() {
  if (loadingTimeout) {
    clearTimeout(loadingTimeout);
    loadingTimeout = null;
  }
  firstTimeUpdatePos = null;
  status = "idle";
  visible = false;
  title = "";
  itemId = null;
  timePos = 0;
  duration = 0;
  requestedAudioIndex = null;
  requestedSubtitleIndex = null;
  pipState = { mode: "normal" };
}

export function hidePlayer() {
  resetPlayerState();
}

export function setVolume(v: number) {
  volume = Math.max(0, Math.min(100, v));
}

export function setMuted(v: boolean) {
  muted = v;
}

export function setPlaybackRate(v: number) {
  playbackRate = Math.max(0.25, Math.min(3, v));
}

export function setVideoScaleMode(v: VideoScaleMode) {
  videoScaleMode = v;
}

export function setAudioTrack(v: number | null) {
  audioTrack = v;
}

export function setSubtitleTrack(v: number | null) {
  subtitleTrack = v;
}

export function setRequestedTracks(audio: number | null, subtitle: number | null) {
  requestedAudioIndex = audio;
  requestedSubtitleIndex = subtitle;
}


export function setPreferredAudioStreamIndex(v: number | undefined) {
  preferredAudioStreamIndex = v;
  if (v === undefined) {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(PREF_AUDIO_KEY);
    }
    return;
  }
  writeStoredPreference(PREF_AUDIO_KEY, v);
}

export function setPreferredSubtitleStreamIndex(v: number | null | undefined) {
  preferredSubtitleStreamIndex = v;
  if (v === undefined) {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(PREF_SUBTITLE_KEY);
    }
    return;
  }
  writeStoredPreference(PREF_SUBTITLE_KEY, v);
}

export function setPreferredAudioMetadata(
  language: string | null | undefined,
  displayTitle: string | null | undefined,
) {
  preferredAudioLanguage = normalizeLanguage(language);
  preferredAudioDisplayTitle = normalizeText(displayTitle);
  writeStoredText(PREF_AUDIO_LANG_KEY, preferredAudioLanguage);
  writeStoredText(PREF_AUDIO_TITLE_KEY, preferredAudioDisplayTitle);
}

export function setPreferredSubtitleMetadata(
  language: string | null | undefined,
  displayTitle: string | null | undefined,
) {
  preferredSubtitleLanguage = normalizeLanguage(language);
  preferredSubtitleDisplayTitle = normalizeText(displayTitle);
  writeStoredText(PREF_SUB_LANG_KEY, preferredSubtitleLanguage);
  writeStoredText(PREF_SUB_TITLE_KEY, preferredSubtitleDisplayTitle);
}

export function resolvePreferredAudioStreamIndex(
  streams: StreamOption[],
): number | null {
  if (!streams.length) return null;

  if (
    preferredAudioStreamIndex !== undefined &&
    streams.some((s) => s.index === preferredAudioStreamIndex)
  ) {
    return preferredAudioStreamIndex;
  }

  if (preferredAudioDisplayTitle) {
    const byTitle = streams.find(
      (s) => normalizeText(s.display_title) === preferredAudioDisplayTitle,
    );
    if (byTitle) return byTitle.index;
  }

  if (preferredAudioLanguage) {
    const byLanguage = streams.find(
      (s) => normalizeLanguage(s.language) === preferredAudioLanguage,
    );
    if (byLanguage) return byLanguage.index;
  }

  const defaultTrack = streams.find((s) => s.is_default);
  return (defaultTrack ?? streams[0])?.index ?? null;
}

export function resolvePreferredSubtitleStreamIndex(
  streams: StreamOption[],
): number | null {
  if (preferredSubtitleStreamIndex === null) return null;
  if (!streams.length) return null;

  if (
    preferredSubtitleStreamIndex !== undefined &&
    streams.some((s) => s.index === preferredSubtitleStreamIndex)
  ) {
    return preferredSubtitleStreamIndex;
  }

  if (preferredSubtitleDisplayTitle) {
    const byTitle = streams.find(
      (s) => normalizeText(s.display_title) === preferredSubtitleDisplayTitle,
    );
    if (byTitle) return byTitle.index;
  }

  if (preferredSubtitleLanguage) {
    const byLanguage = streams.find(
      (s) => normalizeLanguage(s.language) === preferredSubtitleLanguage,
    );
    if (byLanguage) return byLanguage.index;
  }

  return streams.find((s) => s.is_default)?.index ?? null;
}

// ── Event listeners (called once from App.svelte) ───────────────

let listenersAttached = false;

export function initPlayerListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  listen<MpvTimeUpdate>("mpv-time-update", (event) => {
    if (event.payload.item_id !== getPlayerItemId()) return;

    timePos = event.payload.position;
    duration = event.payload.duration;
    if (status === "loading" && !loadingTimeout) {
      if (firstTimeUpdatePos === null) {
        firstTimeUpdatePos = event.payload.position;
      } else {
        const diff = Math.abs(event.payload.position - firstTimeUpdatePos);
        if (diff > 2.0) {
          // This is a seek/jump to the resume position. Keep loading from this new position.
          firstTimeUpdatePos = event.payload.position;
        } else if (diff > 0.0) {
          // Playhead is advancing normally. Playback has started!
          loadingTimeout = setTimeout(() => {
            status = "playing";
            firstTimeUpdatePos = null;
            loadingTimeout = null;
          }, 150);
        }
      }
    }
  });

  listen<MpvStateChange>("mpv-state-change", (event) => {
    if (status === "loading") return;
    status = event.payload.paused ? "paused" : "playing";
  });

  listen<MpvPlaybackSettings>("mpv-playback-settings", (event) => {
    volume = event.payload.volume;
    muted = event.payload.muted;
    playbackRate = event.payload.playback_rate;
    videoScaleMode = event.payload.video_scale_mode;
    audioTrack = event.payload.audio_track;
    subtitleTrack = event.payload.subtitle_track;
  });

  listen<string>("mpv-file-ended", (event) => {
    if (event.payload === getPlayerItemId()) {
      status = "ended";
    }
  });

  listen("mpv-stopped", () => {
    status = "idle";
    visible = false;
  });
}
