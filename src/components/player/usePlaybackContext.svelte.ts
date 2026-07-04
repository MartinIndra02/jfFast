import { onDestroy } from "svelte";
import {
  getItemById,
  getItemChapters,
  getMediaSegments,
  getMediaStreams,
  logFromFrontend,
  mpvPlay,
  mpvSetAudioTrack,
  mpvSetSubtitleTrack,
  mpvAddExternalSubtitle,
  reportPlaybackLifecycle,
  loadHomepageCache,
  saveHomepageCache,
  getSeasonEpisodes,
} from "../../lib/api";
import {
  getPlayerItemId,
  getPlayerStatus,
  getTimePos,
  getDuration,
  getRequestedAudioIndex,
  getRequestedSubtitleIndex,
  getPreferredAudioStreamIndex,
  getPreferredSubtitleStreamIndex,
  setSubtitleTrack,
  showPlayer,
  setPreferredAudioStreamIndex,
  setPreferredSubtitleStreamIndex,
  setPreferredAudioMetadata,
  setPreferredSubtitleMetadata,
  resolvePreferredAudioStreamIndex,
  resolvePreferredSubtitleStreamIndex,
} from "../../lib/stores/player.svelte";
import {
  suppressNextUpItem,
  applyEpisodeCompletionToHomepageCache,
  emitHomepageCacheUpdated,
} from "../../lib/homepageFreshness";
import type { MediaItem, MediaStreamInfo, ChapterInfo, MediaSegment } from "../../lib/types";
import { generateQualityOptions } from "../../lib/mediaStreamHelpers";

const PLAYBACK_CONTEXT_DELAY_MS = 200;
const STREAM_CONTEXT_DELAY_MS = 200;
const PLAYBACK_PROGRESS_INTERVAL_MS = 15_000;

function matchName(name: string, keywords: string[], patternWords: string[] = []): boolean {
  for (const kw of keywords) {
    if (name.includes(kw)) return true;
  }
  if (patternWords.length > 0) {
    const tokens = name.split(/[\s\-_\(\)\[\]\.:]+/);
    for (const token of tokens) {
      if (patternWords.includes(token)) return true;
      if (/^(op|ed)\d+$/i.test(token)) return true;
    }
  }
  return false;
}

function buildFallbackSegments(chapters: ChapterInfo[], durationTicks: number): MediaSegment[] {
  const segments: MediaSegment[] = [];
  const sorted = [...chapters].sort((a, b) => a.start_ticks - b.start_ticks);

  for (let i = 0; i < sorted.length; i++) {
    const ch = sorted[i];
    const nextCh = sorted[i + 1];
    const name = (ch.name ?? "").toLowerCase();
    const marker = (ch.marker_type ?? "").toLowerCase();
    const chapterType = (ch.chapter_type ?? "").toLowerCase();

    const isIntro =
      matchName(name, ["intro", "prologue", "opening", "znělka", "znělky", "úvod", "předehra"], ["op"]) ||
      marker.includes("intro") ||
      chapterType.includes("intro");

    const isRecap =
      matchName(name, ["recap", "previous", "shrnut", "rekapitulace", "minule"]) ||
      marker.includes("recap") ||
      chapterType.includes("recap");

    const isOutro =
      matchName(name, ["outro", "credit", "ending", "titulk", "konec", "závěr"], ["end", "ed"]) ||
      marker.includes("outro") ||
      marker.includes("credit") ||
      chapterType.includes("outro") ||
      chapterType.includes("credit");

    if (isIntro || isRecap || isOutro) {
      const start = ch.start_ticks;
      let end = nextCh ? nextCh.start_ticks : (durationTicks > 0 ? durationTicks : start + 900_000_000);
      
      let type = "Intro";
      if (isRecap) type = "Recap";
      else if (isOutro) type = "Outro";

      // Sanity check
      if (type === "Intro" && (end - start) > 300_000_000) {
        end = start + 900_000_000;
      }
      if (type === "Recap" && (end - start) > 180_000_000) {
        end = start + 450_000_000;
      }

      segments.push({
        start_ticks: start,
        end_ticks: end,
        segment_type: type,
      });
    }
  }

  return segments;
}


export function usePlaybackContext() {
  let mediaStreams = $state<MediaStreamInfo | null>(null);
  let chapters = $state<ChapterInfo[]>([]);
  let mediaSegments = $state<MediaSegment[]>([]);
  let previousEpisode = $state<MediaItem | null>(null);
  let nextEpisode = $state<MediaItem | null>(null);
  let autoplayCountdown = $state<number | null>(null);
  let autoplayDismissedForCurrentItem = $state(false);
  let selectedAudioIndex = $state<number | null>(null);
  let selectedSubtitleIndex = $state<number | null>(null);
  let selectedQualityKey = $state("direct-play");

  let streamContextItemId = $state<string | null>(null);
  let playbackContextItemId = $state<string | null>(null);
  let playbackContextResolvedItemId = $state<string | null>(null);
  let autoplayStateItemId = $state<string | null>(null);
  let lifecycleStartedForItemId = $state<string | null>(null);
  let endAutoSkipHandledForItemId = $state<string | null>(null);

  let autoplayTimer: ReturnType<typeof setInterval> | null = null;
  let playbackLifecycleTimer: ReturnType<typeof setInterval> | null = null;
  let deferredPlaybackContextTimer: ReturnType<typeof setTimeout> | null = null;
  let deferredStreamLoadTimer: ReturnType<typeof setTimeout> | null = null;

  const qualityOptions = $derived.by(() => generateQualityOptions(mediaStreams));
  const selectedQuality = $derived.by(() => {
    return qualityOptions.find((option) => option.key === selectedQualityKey) ?? qualityOptions[0];
  });
  const selectedQualityLabel = $derived.by(() => selectedQuality.label);

  const selectedAudioTrack = $derived.by(() =>
    mediaStreams?.audio.find((s) => s.index === selectedAudioIndex) ?? null,
  );
  const selectedSubtitleTrack = $derived.by(() =>
    mediaStreams?.subtitle.find((s) => s.index === selectedSubtitleIndex) ?? null,
  );

  const effectiveSegments = $derived.by(() => {
    if (mediaSegments.length > 0) return mediaSegments;
    const durTicks = getDuration() * 10_000_000;
    return buildFallbackSegments(chapters, durTicks);
  });


  function mapAudioIndexToMpvId(streams: MediaStreamInfo, streamIndex: number): number | null {
    let mpvId = 1;
    for (const track of streams.audio) {
      if (track.index === streamIndex) {
        if (track.is_external) return null;
        return mpvId;
      }
      if (!track.is_external) mpvId += 1;
    }
    return null;
  }

  function mapSubtitleIndexToMpvId(streams: MediaStreamInfo, streamIndex: number): number | null {
    const isOffline = streams.video_label === "Offline";
    if (isOffline) {
      const embeddedTracks = streams.subtitle.filter(t => !t.is_external);
      const externalTracks = streams.subtitle.filter(t => t.is_external).sort((a, b) => a.index - b.index);
      
      const embeddedIdx = embeddedTracks.findIndex(t => t.index === streamIndex);
      if (embeddedIdx !== -1) return embeddedIdx + 1;
      
      const extIdx = externalTracks.findIndex(t => t.index === streamIndex);
      if (extIdx !== -1) return embeddedTracks.length + extIdx + 1;
      return null;
    }

    let mpvId = 1;
    for (const track of streams.subtitle) {
      if (track.index === streamIndex) {
        if (track.is_external) return null;
        return mpvId;
      }
      if (!track.is_external) mpvId += 1;
    }
    return null;
  }

  function subtitleIndexForRequest(value: number | null | undefined): number | null {
    if (value === undefined) return null;
    if (value === null) return -1;
    return value;
  }

  function isNearPlaybackEnd(positionSeconds: number, durationSeconds: number): boolean {
    if (durationSeconds <= 0) return false;
    const remaining = Math.max(durationSeconds - positionSeconds, 0);
    const remainingThreshold = 60;
    const percent = positionSeconds / durationSeconds;
    return remaining <= remainingThreshold || percent >= 0.95;
  }

  async function resolveEpisodeNeighbors(item: MediaItem): Promise<{
    previous: MediaItem | null;
    next: MediaItem | null;
  }> {
    if (item.type !== "Episode" || !item.season_id) {
      return { previous: null, next: null };
    }
    try {
      const episodes = await getSeasonEpisodes(item.season_id);
      if (episodes.length === 0) return { previous: null, next: null };

      const ordered = [...episodes].sort((a, b) => {
        const ai = a.index_number ?? 0;
        const bi = b.index_number ?? 0;
        return ai - bi;
      });

      const currentIndex = ordered.findIndex((ep) => ep.id === item.id);
      if (currentIndex < 0) return { previous: null, next: null };

      return {
        previous: ordered[currentIndex - 1] ?? null,
        next: ordered[currentIndex + 1] ?? null,
      };
    } catch {
      return { previous: null, next: null };
    }
  }

  async function loadPlaybackContext(id: string) {
    const [item, chapterList, segmentList] = await Promise.all([
      getItemById(id).catch(() => null),
      getItemChapters(id).catch(() => []),
      getMediaSegments(id).catch(() => []),
    ]);

    if (getPlayerItemId() !== id) return;

    console.log("[usePlaybackContext] loadPlaybackContext resolved:", {
      id,
      itemTitle: item?.name,
      chaptersCount: chapterList.length,
      segmentsCount: segmentList.length,
      chapterList,
      segmentList
    });

    const msg = `[loadPlaybackContext] Resolved. ID: ${id}, Title: ${item?.name}, chaptersCount: ${chapterList.length}, segmentsCount: ${segmentList.length}`;
    void logFromFrontend(msg);

    playbackContextResolvedItemId = id;
    chapters = chapterList;
    mediaSegments = segmentList;

    if (item) {
      const neighbors = await resolveEpisodeNeighbors(item);
      if (getPlayerItemId() !== id) return;
      previousEpisode = neighbors.previous;
      nextEpisode = neighbors.next;
    } else {
      previousEpisode = null;
      nextEpisode = null;
    }
  }

  async function loadStreamContext(id: string) {
    streamContextItemId = id;
    const streams = await getMediaStreams(id).catch(() => null);

    if (getPlayerItemId() !== id) return;

    mediaStreams = streams;
    if (streams) {
      selectedAudioIndex = resolvePreferredAudioStreamIndex(streams.audio);
      selectedSubtitleIndex = resolvePreferredSubtitleStreamIndex(streams.subtitle);
      setSubtitleTrack(selectedSubtitleIndex);

      const reqAudio = getRequestedAudioIndex();
      const reqSub = getRequestedSubtitleIndex();

      console.log("[usePlaybackContext] loadStreamContext resolved:", {
        selectedAudioIndex,
        selectedSubtitleIndex,
        reqAudio,
        reqSub
      });

      const audioChanged = reqAudio !== selectedAudioIndex;
      const subChanged = reqSub !== selectedSubtitleIndex;

      if (audioChanged || subChanged) {
        console.log("[usePlaybackContext] Initial tracks differ from requested, applying:", { selectedAudioIndex, selectedSubtitleIndex });
        void applyTrackSelection(selectedAudioIndex, selectedSubtitleIndex, false);
      } else {
        console.log("[usePlaybackContext] Initial tracks match requested, setting on MPV:", { selectedAudioIndex, selectedSubtitleIndex });
        if (selectedAudioIndex !== null) {
          const mpvAudioId = mapAudioIndexToMpvId(streams, selectedAudioIndex);
          if (mpvAudioId !== null) void mpvSetAudioTrack(mpvAudioId);
        }
        if (selectedSubtitleIndex === null) {
          void mpvSetSubtitleTrack(null);
        } else {
          const mpvSubtitleId = mapSubtitleIndexToMpvId(streams, selectedSubtitleIndex);
          if (mpvSubtitleId !== null) {
            void mpvSetSubtitleTrack(mpvSubtitleId);
          } else {
            const track = streams.subtitle.find((t) => t.index === selectedSubtitleIndex);
            const codec = track?.codec?.toLowerCase() ?? "vtt";
            console.log("[usePlaybackContext] Initial subtitle is external, calling mpvAddExternalSubtitle:", selectedSubtitleIndex, "codec:", codec);
            void mpvAddExternalSubtitle(id, selectedSubtitleIndex, codec);
          }
        }
      }
    } else {
      selectedAudioIndex = null;
      selectedSubtitleIndex = null;
      setSubtitleTrack(null);
    }
  }

  function schedulePlaybackContextLoad(id: string) {
    if (deferredPlaybackContextTimer) clearTimeout(deferredPlaybackContextTimer);
    deferredPlaybackContextTimer = setTimeout(() => {
      deferredPlaybackContextTimer = null;
      void loadPlaybackContext(id);
    }, PLAYBACK_CONTEXT_DELAY_MS);
  }

  function scheduleStreamContextLoad(id: string) {
    if (deferredStreamLoadTimer) clearTimeout(deferredStreamLoadTimer);
    deferredStreamLoadTimer = setTimeout(() => {
      deferredStreamLoadTimer = null;
      void loadStreamContext(id);
    }, STREAM_CONTEXT_DELAY_MS);
  }

  function ensureStreamContextLoadedNow() {
    const playerItemId = getPlayerItemId();
    if (!playerItemId) return;
    if (mediaStreams || streamContextItemId === playerItemId) return;

    if (deferredStreamLoadTimer) {
      clearTimeout(deferredStreamLoadTimer);
      deferredStreamLoadTimer = null;
    }
    void loadStreamContext(playerItemId);
  }

  async function applyTrackSelection(
    nextAudioIndex: number | null,
    nextSubtitleIndex: number | null,
    savePreferences = true,
  ) {
    const playerItemId = getPlayerItemId();
    if (!playerItemId) return;

    const currentAudioIndex = selectedAudioIndex;
    const currentSubtitleIndex = selectedSubtitleIndex;

    console.log("[usePlaybackContext] applyTrackSelection start:", {
      currentAudioIndex,
      currentSubtitleIndex,
      nextAudioIndex,
      nextSubtitleIndex,
      savePreferences
    });

    selectedAudioIndex = nextAudioIndex;
    selectedSubtitleIndex = nextSubtitleIndex;
    setSubtitleTrack(nextSubtitleIndex);

    if (savePreferences) {
      if (nextAudioIndex !== null) setPreferredAudioStreamIndex(nextAudioIndex);
      setPreferredSubtitleStreamIndex(nextSubtitleIndex);

      const selAudio = mediaStreams?.audio.find((t) => t.index === nextAudioIndex);
      const selSub = mediaStreams?.subtitle.find((t) => t.index === nextSubtitleIndex);
      setPreferredAudioMetadata(selAudio?.language, selAudio?.display_title);
      setPreferredSubtitleMetadata(selSub?.language, selSub?.display_title);
    }

    const currentAudioIsExternal =
      currentAudioIndex !== null &&
      mediaStreams !== null &&
      mapAudioIndexToMpvId(mediaStreams, currentAudioIndex) === null;

    let nextAudioIsExternal = false;
    if (mediaStreams && nextAudioIndex !== null) {
      nextAudioIsExternal = mapAudioIndexToMpvId(mediaStreams, nextAudioIndex) === null;
    }

    let requireStreamReload = (nextAudioIndex !== currentAudioIndex) && (currentAudioIsExternal || nextAudioIsExternal || !mediaStreams);

    console.log("[usePlaybackContext] checked audio tracks:", {
      currentAudioIndex,
      nextAudioIndex,
      currentAudioIsExternal,
      nextAudioIsExternal,
      requireStreamReload
    });

    if (!requireStreamReload && mediaStreams && nextAudioIndex !== null) {
      const mpvAudioId = mapAudioIndexToMpvId(mediaStreams, nextAudioIndex);
      if (mpvAudioId !== null) await mpvSetAudioTrack(mpvAudioId);
    }

    if (!requireStreamReload) {
      if (nextSubtitleIndex === null) {
        await mpvSetSubtitleTrack(null);
      } else if (mediaStreams) {
        const mpvSubtitleId = mapSubtitleIndexToMpvId(mediaStreams, nextSubtitleIndex);
        if (mpvSubtitleId !== null) {
          await mpvSetSubtitleTrack(mpvSubtitleId);
        } else {
          const track = mediaStreams.subtitle.find((t) => t.index === nextSubtitleIndex);
          const codec = track?.codec?.toLowerCase() ?? "vtt";
          await mpvAddExternalSubtitle(playerItemId, nextSubtitleIndex, codec);
        }
      }
    }

    if (requireStreamReload) {
      mediaStreams = null;
      streamContextItemId = null;
      const quality = selectedQuality;
      await mpvPlay({
        itemId: playerItemId,
        startTicks: Math.max(0, Math.floor(getTimePos() * 10_000_000)),
        audioStreamIndex: nextAudioIndex,
        subtitleStreamIndex: subtitleIndexForRequest(nextSubtitleIndex),
        maxStreamingBitrate: quality.maxStreamingBitrate,
        targetHeight: quality.targetHeight,
      });
    }
  }

  function stopAutoplayCountdown() {
    if (autoplayTimer) {
      clearInterval(autoplayTimer);
      autoplayTimer = null;
    }
    autoplayCountdown = null;
  }

  function cancelAutoplayCountdown() {
    autoplayDismissedForCurrentItem = true;
    stopAutoplayCountdown();
  }

  function resetAutoplayDismissal() {
    autoplayDismissedForCurrentItem = false;
    stopAutoplayCountdown();
  }

  function startAutoplayCountdown() {
    if (!nextEpisode || autoplayDismissedForCurrentItem || autoplayCountdown !== null) return;
    stopAutoplayCountdown();
    autoplayCountdown = 10;

    autoplayTimer = setInterval(() => {
      if (autoplayCountdown === null) return;
      if (autoplayCountdown <= 1) {
        stopAutoplayCountdown();
        void playNextEpisode();
        return;
      }
      autoplayCountdown -= 1;
    }, 1000);
  }

  function formatEpisodeTitle(item: MediaItem): string {
    if (item.type === "Episode" && item.series_name) {
      const season = item.season_name?.match(/(\d+)/)?.[1] ?? "?";
      const episode = item.index_number ?? "?";
      return `${item.series_name} - S${season} E${episode} - ${item.name}`;
    }
    return item.name;
  }

  async function applyOptimisticHomepageUpdate(
    completedEpisodeId: string,
    nextEpisodeHint: MediaItem | null,
  ) {
    suppressNextUpItem(completedEpisodeId);
    try {
      const cached = await loadHomepageCache();
      if (!cached) return;
      const updated = applyEpisodeCompletionToHomepageCache(
        cached,
        completedEpisodeId,
        nextEpisodeHint,
      );
      await saveHomepageCache(updated);
      emitHomepageCacheUpdated(updated);
    } catch (e) {
      console.warn("Failed to optimistically update homepage cache:", e);
    }
  }

  async function reportCurrentPlaybackStop(nextEpisodeHint: MediaItem | null = null) {
    const playerItemId = getPlayerItemId();
    if (!playerItemId) return;

    const currentItemId = playerItemId;
    const positionSeconds = Math.max(0, getTimePos());
    const durationSeconds = Math.max(0, getDuration());
    const positionTicks = Math.floor(positionSeconds * 10_000_000);
    const durationTicks = Math.floor(durationSeconds * 10_000_000);
    const nearEnd = isNearPlaybackEnd(positionSeconds, durationSeconds);

    try {
      await reportPlaybackLifecycle(
        currentItemId,
        positionTicks,
        durationTicks,
        "stopped",
      );
    } catch (e) {
      console.warn("Failed to report playback stop:", e);
      return;
    }

    if (nearEnd) {
      await applyOptimisticHomepageUpdate(currentItemId, nextEpisodeHint);
    }
  }

  async function playNextEpisode() {
    if (!nextEpisode) return;
    const target = nextEpisode;
    void reportCurrentPlaybackStop(target);
    stopAutoplayCountdown();
    showPlayer(target.id, formatEpisodeTitle(target));

    try {
      const preferredAudio = getPreferredAudioStreamIndex() ?? selectedAudioIndex;
      const preferredSubtitle = getPreferredSubtitleStreamIndex() ?? selectedSubtitleIndex;

      await mpvPlay({
        itemId: target.id,
        startTicks: 0,
        audioStreamIndex: preferredAudio,
        subtitleStreamIndex: subtitleIndexForRequest(preferredSubtitle),
      });
    } catch (e) {
      console.error("Failed to autoplay next episode:", e);
    }
  }

  async function playPreviousEpisode() {
    if (!previousEpisode) return;
    void reportCurrentPlaybackStop();
    const target = previousEpisode;
    stopAutoplayCountdown();
    showPlayer(target.id, formatEpisodeTitle(target));

    try {
      const preferredAudio = getPreferredAudioStreamIndex() ?? selectedAudioIndex;
      const preferredSubtitle = getPreferredSubtitleStreamIndex() ?? selectedSubtitleIndex;

      await mpvPlay({
        itemId: target.id,
        startTicks: 0,
        audioStreamIndex: preferredAudio,
        subtitleStreamIndex: subtitleIndexForRequest(preferredSubtitle),
      });
    } catch (e) {
      console.error("Failed to play previous episode:", e);
    }
  }

  async function reportPlaybackHeartbeat(event: "playing" | "progress") {
    const playerItemId = getPlayerItemId();
    if (!playerItemId) return;
    const posTicks = Math.floor(getTimePos() * 10_000_000);
    const durTicks = Math.floor(getDuration() * 10_000_000);
    await reportPlaybackLifecycle(playerItemId, posTicks, durTicks, event).catch(() => {});
  }

  function stopPlaybackLifecycleTimer() {
    if (playbackLifecycleTimer) {
      clearInterval(playbackLifecycleTimer);
      playbackLifecycleTimer = null;
    }
  }

  function startPlaybackLifecycleTimer() {
    stopPlaybackLifecycleTimer();
    playbackLifecycleTimer = setInterval(() => {
      const playerVisible = getPlayerItemId() !== null; // or visible check
      const playerStatus = getPlayerStatus();
      if (!playerVisible || playerStatus !== "playing") return;
      void reportPlaybackHeartbeat("progress");
    }, PLAYBACK_PROGRESS_INTERVAL_MS);
  }

  async function changeQuality(key: string) {
    const playerItemId = getPlayerItemId();
    if (!playerItemId) return;
    selectedQualityKey = key;

    // Use derived selectedQuality value
    const quality = selectedQuality;
    mediaStreams = null;
    streamContextItemId = null;

    await mpvPlay({
      itemId: playerItemId,
      startTicks: Math.max(0, Math.floor(getTimePos() * 10_000_000)),
      audioStreamIndex: selectedAudioIndex,
      subtitleStreamIndex: subtitleIndexForRequest(selectedSubtitleIndex),
      maxStreamingBitrate: quality.maxStreamingBitrate,
      targetHeight: quality.targetHeight,
    });
  }

  function resetState() {
    stopPlaybackLifecycleTimer();
    stopAutoplayCountdown();
    if (deferredStreamLoadTimer) {
      clearTimeout(deferredStreamLoadTimer);
      deferredStreamLoadTimer = null;
    }
    if (deferredPlaybackContextTimer) {
      clearTimeout(deferredPlaybackContextTimer);
      deferredPlaybackContextTimer = null;
    }
    mediaStreams = null;
    chapters = [];
    mediaSegments = [];
    previousEpisode = null;
    nextEpisode = null;
    selectedAudioIndex = null;
    selectedSubtitleIndex = null;
    selectedQualityKey = "direct-play";
    playbackContextItemId = null;
    playbackContextResolvedItemId = null;
    streamContextItemId = null;
    autoplayDismissedForCurrentItem = false;
    autoplayStateItemId = null;
    lifecycleStartedForItemId = null;
    endAutoSkipHandledForItemId = null;
  }

  onDestroy(() => {
    stopPlaybackLifecycleTimer();
    stopAutoplayCountdown();
    if (deferredPlaybackContextTimer) clearTimeout(deferredPlaybackContextTimer);
    if (deferredStreamLoadTimer) clearTimeout(deferredStreamLoadTimer);
  });

  return {
    // Getters / Setters
    get mediaStreams() { return mediaStreams; },
    set mediaStreams(v) { mediaStreams = v; },
    get chapters() { return chapters; },
    get mediaSegments() { return effectiveSegments; },
    get previousEpisode() { return previousEpisode; },
    get nextEpisode() { return nextEpisode; },
    get autoplayCountdown() { return autoplayCountdown; },
    get autoplayDismissedForCurrentItem() { return autoplayDismissedForCurrentItem; },
    get selectedAudioIndex() { return selectedAudioIndex; },
    set selectedAudioIndex(v) { selectedAudioIndex = v; },
    get selectedSubtitleIndex() { return selectedSubtitleIndex; },
    set selectedSubtitleIndex(v) { selectedSubtitleIndex = v; },
    get selectedQualityKey() { return selectedQualityKey; },
    set selectedQualityKey(v) { selectedQualityKey = v; },
    get qualityOptions() { return qualityOptions; },
    get selectedQuality() { return selectedQuality; },
    get selectedQualityLabel() { return selectedQualityLabel; },
    get selectedAudioTrack() { return selectedAudioTrack; },
    get selectedSubtitleTrack() { return selectedSubtitleTrack; },
    get streamContextItemId() { return streamContextItemId; },
    set streamContextItemId(v) { streamContextItemId = v; },
    get playbackContextItemId() { return playbackContextItemId; },
    set playbackContextItemId(v) { playbackContextItemId = v; },
    get playbackContextResolvedItemId() { return playbackContextResolvedItemId; },
    set playbackContextResolvedItemId(v) { playbackContextResolvedItemId = v; },
    get autoplayStateItemId() { return autoplayStateItemId; },
    set autoplayStateItemId(v) { autoplayStateItemId = v; },
    get lifecycleStartedForItemId() { return lifecycleStartedForItemId; },
    set lifecycleStartedForItemId(v) { lifecycleStartedForItemId = v; },
    get endAutoSkipHandledForItemId() { return endAutoSkipHandledForItemId; },
    set endAutoSkipHandledForItemId(v) { endAutoSkipHandledForItemId = v; },

    // Functions
    mapAudioIndexToMpvId,
    mapSubtitleIndexToMpvId,
    subtitleIndexForRequest,
    isNearPlaybackEnd,
    loadPlaybackContext,
    loadStreamContext,
    schedulePlaybackContextLoad,
    scheduleStreamContextLoad,
    ensureStreamContextLoadedNow,
    applyTrackSelection,
    stopAutoplayCountdown,
    cancelAutoplayCountdown,
    resetAutoplayDismissal,
    startAutoplayCountdown,
    playNextEpisode,
    playPreviousEpisode,
    reportCurrentPlaybackStop,
    reportPlaybackHeartbeat,
    stopPlaybackLifecycleTimer,
    startPlaybackLifecycleTimer,
    changeQuality,
    resetState,
  };
}
