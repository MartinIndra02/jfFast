<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    isPlayerVisible,
    getPlayerStatus,
    getPlayerTitle,
    getPlayerItemId,
    getTimePos,
    getDuration,
    getVolume,
    isMuted,
    getPlaybackRate,
    hidePlayer,
    setVolume,
    setMuted,
    setPlaybackRate,
    getVideoScaleMode,
    isPipMode,
    isPipTransitioning,
    setPipState,
  } from "../../lib/stores/player.svelte";
  import {
    mpvTogglePause,
    mpvSeek,
    mpvSeekAbsolute,
    mpvSetVolume,
    mpvSetMute,
    mpvSetPlaybackRate,
    mpvSetSubtitlePosition,
    mpvStop,
    mpvSetVideoScale,
    mpvEnterPip,
    mpvExitPip,
  } from "../../lib/api";
  import { getPreferences } from "../../lib/stores/preferences.svelte";
  import type { MediaItem, ChapterInfo } from "../../lib/types";

  import PlayerHeader from "./PlayerHeader.svelte";
  import PlayerTimeline from "./PlayerTimeline.svelte";
  import PlayerControls from "./PlayerControls.svelte";
  import SkipSegmentButton from "./SkipSegmentButton.svelte";
  import PipPlayer from "./PipPlayer.svelte";
  import { useAutoHide } from "./useAutoHide.svelte";
  import { usePlaybackContext } from "./usePlaybackContext.svelte";

  // ── Global Store states ──────────────────────────────────────
  const playerVisible = $derived(isPlayerVisible());
  const playerStatus = $derived(getPlayerStatus());
  const playerTitle = $derived(getPlayerTitle());
  const playerItemId = $derived(getPlayerItemId());
  const pos = $derived(getTimePos());
  const dur = $derived(getDuration());
  const vol = $derived(getVolume());
  const muted = $derived(isMuted());
  const rate = $derived(getPlaybackRate());
  const isPaused = $derived(playerStatus === "paused");
  const videoScaleMode = $derived(getVideoScaleMode());
  const preferences = $derived(getPreferences());
  const autoCropEnabled = $derived(preferences.playback.auto_crop_experimental);

  // ── Context and Auto-Hide Hooks ─────────────────────────────
  const ctx = usePlaybackContext();

  const autoHide = useAutoHide({
    isMenuOpenOrScrubbing: () => audioMenuOpen || subtitleMenuOpen || overflowMenuOpen || isScrubbing,
    closeMenus: () => closeTopMenus(),
  });

  // ── Local UI menu states ─────────────────────────────────────
  let isFullscreen = $state(false);
  let audioMenuOpen = $state(false);
  let subtitleMenuOpen = $state(false);
  let overflowMenuOpen = $state(false);

  // ── Scrubbing logic states ───────────────────────────────────
  let progressScrubEl = $state<HTMLElement | null>(null);
  let isScrubbing = $state(false);
  let scrubSeconds = $state<number | null>(null);
  let pendingSeekSeconds = $state<number | null>(null);
  let pendingSeekClearTimer: ReturnType<typeof setTimeout> | null = null;
  let clickTimeout: ReturnType<typeof setTimeout> | null = null;

  const SUBTITLE_POSITION_STORAGE_KEY = "jfgoat.player.subtitleBottomPercent";
  const DEFAULT_SUBTITLE_POSITION_PERCENT = 95;
  const SUBTITLE_POSITION_CONTROLS_OFFSET = 8;

  const effectivePos = $derived(
    isScrubbing && scrubSeconds !== null
      ? scrubSeconds
      : pendingSeekSeconds !== null
      ? pendingSeekSeconds
      : pos
  );

  const progressPercent = $derived(
    dur > 0 ? Math.max(0, Math.min((effectivePos / dur) * 100, 100)) : 0
  );

  // ── Derived labels & items ──────────────────────────────────
  const audioMenuLabel = $derived.by(() => {
    const language = ctx.selectedAudioTrack?.language?.trim();
    if (language) return language.toUpperCase();
    if (ctx.selectedAudioTrack?.display_title) return ctx.selectedAudioTrack.display_title;
    return "Default";
  });

  const subtitleMenuLabel = $derived.by(() => {
    if (ctx.selectedSubtitleIndex === null) return "Off";
    const language = ctx.selectedSubtitleTrack?.language?.trim();
    if (language) return language.toUpperCase();
    if (ctx.selectedSubtitleTrack?.display_title) return ctx.selectedSubtitleTrack.display_title;
    return "On";
  });

  const chapterMarkers = $derived.by(() => {
    if (dur <= 0) return [];
    return ctx.chapters
      .map((chapter) => {
        const startSeconds = chapter.start_ticks / 10_000_000;
        const percent = Math.max(0, Math.min((startSeconds / dur) * 100, 100));
        return {
          ...chapter,
          startSeconds,
          percent,
        };
      })
      .filter((chapter) => chapter.percent > 0 && chapter.percent < 100);
  });

  const outroStartSeconds = $derived.by(() => {
    if (dur <= 0 || ctx.chapters.length === 0) return null;

    const looksLikeOutro = (chapter: ChapterInfo): boolean => {
      const name = (chapter.name ?? "").toLowerCase();
      const marker = (chapter.marker_type ?? "").toLowerCase();
      const chapterType = (chapter.chapter_type ?? "").toLowerCase();

      return (
        name.includes("outro")
        || name.includes("credits")
        || name.includes("credit")
        || name.includes("end")
        || marker.includes("outro")
        || marker.includes("credit")
        || chapterType.includes("outro")
        || chapterType.includes("credit")
      );
    };

    const nearTailStartTicks = Math.floor(dur * 0.55 * 10_000_000);

    const candidates = ctx.chapters
      .filter(looksLikeOutro)
      .map((chapter) => chapter.start_ticks)
      .filter((ticks) => ticks >= nearTailStartTicks)
      .sort((a, b) => a - b);

    if (candidates.length === 0) return null;
    return candidates[0] / 10_000_000;
  });

  const isInOutroWindow = $derived.by(() => {
    if (!ctx.nextEpisode || !outroStartSeconds || dur <= 0) return false;
    return pos >= outroStartSeconds && pos < dur;
  });

  const PRE_ROLL_SECS = 5;

  const activeSegment = $derived.by(() => {
    if (dur <= 0 || !ctx.mediaSegments || ctx.mediaSegments.length === 0) return null;
    const posSeconds = pos;
    for (const seg of ctx.mediaSegments) {
      const startSec = seg.start_ticks / 10_000_000;
      const endSec = seg.end_ticks / 10_000_000;
      if (posSeconds >= Math.max(0, startSec - PRE_ROLL_SECS) && posSeconds < endSec) {
        return seg;
      }
    }
    return null;
  });

  const showSkipButton = $derived.by(() => {
    if (!activeSegment) return false;
    const type = activeSegment.segment_type.toLowerCase();
    return ["intro", "outro", "recap"].includes(type);
  });

  const skipButtonLabel = $derived.by(() => {
    if (!activeSegment) return "";
    switch (activeSegment.segment_type.toLowerCase()) {
      case "intro": return "Skip Intro";
      case "outro": return "Skip Credits";
      case "recap": return "Skip Recap";
      default: return "Skip";
    }
  });

  function skipSegment() {
    if (!activeSegment) return;
    void mpvSeekAbsolute(activeSegment.end_ticks / 10_000_000);
  }

  const previousChapterTime = $derived.by(() => {
    const currentSec = pos;
    const threshold = 2.0;
    const candidates = ctx.chapters
      .map((ch) => ch.start_ticks / 10_000_000)
      .filter((time) => time < currentSec - threshold)
      .sort((a, b) => b - a);
    return candidates[0] ?? null;
  });

  const nextChapterTime = $derived.by(() => {
    const currentSec = pos;
    const candidates = ctx.chapters
      .map((ch) => ch.start_ticks / 10_000_000)
      .filter((time) => time > currentSec)
      .sort((a, b) => a - b);
    return candidates[0] ?? null;
  });

  function skipToPreviousChapter() {
    if (previousChapterTime !== null) {
      void mpvSeekAbsolute(previousChapterTime);
    } else if (pos > 2.0) {
      void mpvSeekAbsolute(0);
    }
  }

  function skipToNextChapter() {
    if (nextChapterTime !== null) {
      void mpvSeekAbsolute(nextChapterTime);
    }
  }

  // ── Functions ────────────────────────────────────────────────
  function formatTime(seconds: number): string {
    if (!seconds || seconds < 0) return "0:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function endTimeEstimate(): string {
    const remaining = dur - effectivePos;
    if (remaining <= 0) return "";
    const end = new Date(Date.now() + remaining * 1000);
    return `Ends at ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  function closeTopMenus() {
    audioMenuOpen = false;
    subtitleMenuOpen = false;
    overflowMenuOpen = false;
  }

  function toggleTopMenu(menu: "audio" | "subtitle" | "overflow") {
    const openAudio = menu === "audio" ? !audioMenuOpen : false;
    const openSubtitle = menu === "subtitle" ? !subtitleMenuOpen : false;
    const openOverflow = menu === "overflow" ? !overflowMenuOpen : false;

    audioMenuOpen = openAudio;
    subtitleMenuOpen = openSubtitle;
    overflowMenuOpen = openOverflow;

    if (openAudio || openSubtitle || openOverflow) {
      ctx.ensureStreamContextLoadedNow();
    }
  }

  function clampSubtitlePositionPercent(value: number): number {
    return Math.max(70, Math.min(98, Math.round(value)));
  }

  function getStoredSubtitlePositionPercent(): number {
    if (typeof localStorage === "undefined") {
      return DEFAULT_SUBTITLE_POSITION_PERCENT;
    }
    const raw = localStorage.getItem(SUBTITLE_POSITION_STORAGE_KEY);
    if (!raw) return DEFAULT_SUBTITLE_POSITION_PERCENT;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampSubtitlePositionPercent(parsed) : DEFAULT_SUBTITLE_POSITION_PERCENT;
  }

  function syncFullscreenState() {
    isFullscreen = !!document.fullscreenElement;
  }

  async function exitFullscreenIfActive() {
    if (!document.fullscreenElement) return;
    try {
      await document.exitFullscreen();
    } catch (e) {
      console.warn("Failed to exit fullscreen", e);
    } finally {
      syncFullscreenState();
    }
  }

  async function stopPlayer(nextEpisodeHint: MediaItem | null = null) {
    if (isPipMode()) {
      setPipState({ mode: "exiting" });
      try {
        await mpvExitPip();
      } catch (e) {
        console.error("Failed to exit PiP on stop:", e);
      }
      setPipState({ mode: "normal" });
    }

    ctx.stopAutoplayCountdown();
    
    // Start reporting and cleanup tasks asynchronously
    const stopReportPromise = ctx.reportCurrentPlaybackStop(nextEpisodeHint);
    const exitFullscreenPromise = exitFullscreenIfActive();
    const mpvStopPromise = mpvStop();

    // Close/reset player UI immediately
    hidePlayer();

    // Await execution of background tasks
    try {
      await Promise.all([stopReportPromise, exitFullscreenPromise, mpvStopPromise]);
    } catch (e) {
      console.warn("Background stop errors:", e);
    }
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
      syncFullscreenState();
    } catch (e) {
      console.warn("Fullscreen toggle failed", e);
    }
  }

  const pipMode = $derived(isPipMode());

  async function enterPipMode() {
    if (isPipMode() || isPipTransitioning()) return;
    setPipState({ mode: "entering" });
    try {
      await mpvEnterPip();
      setPipState({ mode: "pip" });
    } catch (e) {
      console.error("Failed to enter PiP:", e);
      setPipState({ mode: "normal" });
    }
  }

  async function exitPipMode() {
    if (!isPipMode() || isPipTransitioning()) return;
    setPipState({ mode: "exiting" });
    try {
      await mpvExitPip();
      setPipState({ mode: "normal" });
    } catch (e) {
      console.error("Failed to exit PiP:", e);
      setPipState({ mode: "pip" });
    }
  }

  async function togglePause() {
    await mpvTogglePause();
  }

  function handleOverlayClick(e: MouseEvent) {
    if (audioMenuOpen || subtitleMenuOpen || overflowMenuOpen) {
      e.preventDefault();
      closeTopMenus();
      autoHide.resetHideTimer();
      return;
    }

    if (clickTimeout) {
      clearTimeout(clickTimeout);
      clickTimeout = null;
      void toggleFullscreen();
    } else {
      clickTimeout = setTimeout(() => {
        void togglePause();
        clickTimeout = null;
      }, 250);
    }
  }

  async function seekBack10() {
    const b = getPreferences()?.playback?.skip_backward_seconds ?? 10;
    await mpvSeek(-b);
  }

  async function seekForward30() {
    const f = getPreferences()?.playback?.skip_forward_seconds ?? 30;
    await mpvSeek(f);
  }

  async function seekToChapter(seconds: number) {
    await mpvSeekAbsolute(seconds);
  }

  async function toggleMute() {
    const nextMuted = !muted;
    setMuted(nextMuted);
    await mpvSetMute(nextMuted);
  }

  async function handleVolumeInput(e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    setVolume(v);
    await mpvSetVolume(v);
  }

  // ── Keyboard handler ─────────────────────────────────────────
  function handleKeydown(e: KeyboardEvent) {
    if (!playerVisible) return;

    switch (e.key) {
      case " ":
        e.preventDefault();
        void togglePause();
        break;
      case "ArrowLeft": {
        const b = getPreferences()?.playback?.skip_backward_seconds ?? 10;
        void mpvSeek(-b);
        break;
      }
      case "ArrowRight": {
        const f = getPreferences()?.playback?.skip_forward_seconds ?? 30;
        void mpvSeek(f);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const newVolUp = Math.min(vol + 5, 100);
        setVolume(newVolUp);
        void mpvSetVolume(newVolUp);
        break;
      }
      case "ArrowDown": {
        e.preventDefault();
        const newVolDown = Math.max(vol - 5, 0);
        setVolume(newVolDown);
        void mpvSetVolume(newVolDown);
        break;
      }
      case "Escape":
        if (isFullscreen) {
          void toggleFullscreen();
        } else {
          void stopPlayer();
        }
        break;
      case "m":
      case "M":
        void toggleMute();
        break;
      case "f":
      case "F":
        void toggleFullscreen();
        break;
      case "p":
      case "P":
        if (pipMode) {
          void exitPipMode();
        } else {
          void enterPipMode();
        }
        break;
      case "[": {
        e.preventDefault();
        const nextRateDown = Math.max(rate - 0.1, 0.5);
        setPlaybackRate(nextRateDown);
        void mpvSetPlaybackRate(nextRateDown);
        break;
      }
      case "]": {
        e.preventDefault();
        const nextRateUp = Math.min(rate + 0.1, 2);
        setPlaybackRate(nextRateUp);
        void mpvSetPlaybackRate(nextRateUp);
        break;
      }
      case "s":
      case "S":
        if (showSkipButton) {
          e.preventDefault();
          skipSegment();
        }
        break;
    }

    autoHide.resetHideTimer();
  }

  // ── Scrubbing utilities ──────────────────────────────────────
  function secondsFromPointer(clientX: number): number | null {
    if (!progressScrubEl || dur <= 0) return null;
    const rect = progressScrubEl.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const fraction = Math.max(0, Math.min((clientX - rect.left) / rect.width, 1));
    return fraction * dur;
  }

  function clearPendingSeekPreview() {
    pendingSeekSeconds = null;
    if (pendingSeekClearTimer) {
      clearTimeout(pendingSeekClearTimer);
      pendingSeekClearTimer = null;
    }
  }

  function beginTimelineScrub(e: PointerEvent) {
    if (dur <= 0) return;
    const seconds = secondsFromPointer(e.clientX);
    if (seconds === null) return;

    e.preventDefault();
    e.stopPropagation();

    clearPendingSeekPreview();
    isScrubbing = true;
    scrubSeconds = seconds;
    autoHide.controlsVisible = true;

    autoHide.resetHideTimer(); // clearing autohide during active scrub
  }

  function handleWindowPointerMove(e: PointerEvent) {
    if (!isScrubbing) return;
    const seconds = secondsFromPointer(e.clientX);
    if (seconds !== null) {
      scrubSeconds = seconds;
    }
  }

  function endTimelineScrub(e: PointerEvent) {
    if (!isScrubbing) return;
    const seconds = secondsFromPointer(e.clientX) ?? scrubSeconds;
    isScrubbing = false;
    scrubSeconds = null;

    if (seconds !== null) {
      pendingSeekSeconds = seconds;
      scrubSeconds = null;
      if (pendingSeekClearTimer) {
        clearTimeout(pendingSeekClearTimer);
      }
      pendingSeekClearTimer = setTimeout(() => {
        pendingSeekSeconds = null;
        pendingSeekClearTimer = null;
      }, 6000);
      void mpvSeekAbsolute(seconds);
    } else {
      scrubSeconds = null;
    }

    autoHide.resetHideTimer();
  }

  function cancelTimelineScrub() {
    if (!isScrubbing) return;
    isScrubbing = false;
    scrubSeconds = null;
    autoHide.resetHideTimer();
  }

  function handleProgressKeydown(e: KeyboardEvent) {
    let handled = false;
    let target = effectivePos;
    if (e.key === "ArrowLeft") {
      target = Math.max(0, effectivePos - 10);
      handled = true;
    } else if (e.key === "ArrowRight") {
      target = Math.min(dur, effectivePos + 10);
      handled = true;
    } else if (e.key === "Home") {
      target = 0;
      handled = true;
    } else if (e.key === "End") {
      target = dur;
      handled = true;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      void mpvSeekAbsolute(target);
    }
  }

  // ── Mount / Unmount ──────────────────────────────────────────
  onMount(() => {
    autoHide.resetHideTimer();
    syncFullscreenState();

    const onFullscreenChange = () => syncFullscreenState();
    document.addEventListener("fullscreenchange", onFullscreenChange);

    const handleStopPlayback = () => {
      void stopPlayer();
    };
    window.addEventListener("stop-playback", handleStopPlayback);

    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("stop-playback", handleStopPlayback);
    };
  });

  onDestroy(() => {
    if (pendingSeekClearTimer) clearTimeout(pendingSeekClearTimer);
    if (clickTimeout) clearTimeout(clickTimeout);
  });

  // ── Svelte effects coordination ─────────────────────────────
  $effect(() => {
    if (!playerVisible || !playerItemId) {
      void exitFullscreenIfActive();
      ctx.resetState();
      return;
    }

    if (ctx.autoplayStateItemId !== playerItemId) {
      ctx.autoplayStateItemId = playerItemId;
      ctx.resetAutoplayDismissal(); // resets dismissed & count
    }

    if (ctx.playbackContextItemId !== playerItemId) {
      ctx.playbackContextItemId = playerItemId;
      ctx.mediaStreams = null;
      ctx.streamContextItemId = null;
      ctx.selectedQualityKey = "direct-play";
      ctx.schedulePlaybackContextLoad(playerItemId);
    }
  });

  $effect(() => {
    if (!playerVisible || !playerItemId) return;
    if (playerStatus !== "playing") return;
    if (ctx.mediaStreams || ctx.streamContextItemId === playerItemId) return;

    ctx.scheduleStreamContextLoad(playerItemId);
  });

  $effect(() => {
    if (!playerVisible || !playerItemId || playerStatus !== "playing") {
      ctx.stopPlaybackLifecycleTimer();
      return;
    }

    if (ctx.lifecycleStartedForItemId !== playerItemId) {
      ctx.lifecycleStartedForItemId = playerItemId;
      void ctx.reportPlaybackHeartbeat("playing");
    }

    ctx.startPlaybackLifecycleTimer();
    return () => {
      ctx.stopPlaybackLifecycleTimer();
    };
  });

  $effect(() => {
    if (!playerVisible) {
      ctx.stopAutoplayCountdown();
      return;
    }

    if (playerStatus === "ended") {
      ctx.stopAutoplayCountdown();
      if (playerItemId && ctx.endAutoSkipHandledForItemId !== playerItemId) {
        if (!ctx.nextEpisode && ctx.playbackContextResolvedItemId !== playerItemId) {
          void ctx.loadPlaybackContext(playerItemId);
          return;
        }

        ctx.endAutoSkipHandledForItemId = playerItemId;
        if (ctx.nextEpisode && !ctx.autoplayDismissedForCurrentItem) {
          void ctx.playNextEpisode();
        } else if (ctx.nextEpisode && ctx.autoplayDismissedForCurrentItem) {
          void stopPlayer(ctx.nextEpisode);
        } else {
          void stopPlayer();
        }
      }
      return;
    }

    if (!ctx.nextEpisode) {
      ctx.stopAutoplayCountdown();
      return;
    }

    if (playerStatus !== "playing") {
      ctx.stopAutoplayCountdown();
      return;
    }

    if (isInOutroWindow && !ctx.autoplayDismissedForCurrentItem) {
      ctx.startAutoplayCountdown();
    } else {
      ctx.stopAutoplayCountdown();
    }
  });

  $effect(() => {
    if (!activeSegment || !playerVisible || playerStatus !== "playing") return;
    
    // Auto-skip ONLY when we are actually inside the segment (not in pre-roll buffer)
    const startSec = activeSegment.start_ticks / 10_000_000;
    if (pos < startSec) return;

    const prefs = getPreferences();
    const type = activeSegment.segment_type.toLowerCase();
    const shouldAutoSkip =
      (type === "intro" && prefs.playback.auto_skip_intro) ||
      (type === "outro" && prefs.playback.auto_skip_outro) ||
      (type === "recap" && prefs.playback.auto_skip_recap);

    if (shouldAutoSkip) {
      void mpvSeekAbsolute(activeSegment.end_ticks / 10_000_000);
    }
  });

  $effect(() => {
    if (pendingSeekSeconds === null || isScrubbing) return;
    if (Math.abs(pos - pendingSeekSeconds) <= 0.6) {
      clearPendingSeekPreview();
    }
  });

  $effect(() => {
    if (!playerVisible) return;

    if (!autoHide.controlsVisible) {
      closeTopMenus();
    }

    const storedSubtitlePosition = getStoredSubtitlePositionPercent();
    const subtitlePosition = autoHide.controlsVisible
      ? clampSubtitlePositionPercent(
        storedSubtitlePosition - SUBTITLE_POSITION_CONTROLS_OFFSET,
      )
      : storedSubtitlePosition;
    void mpvSetSubtitlePosition(subtitlePosition);
  });
</script>

<svelte:window
  onkeydown={handleKeydown}
  onpointermove={handleWindowPointerMove}
  onpointerup={endTimelineScrub}
  onpointercancel={cancelTimelineScrub}
/>

{#if playerVisible}
  {#if pipMode}
    <PipPlayer
      onExpand={exitPipMode}
      onClose={() => void stopPlayer()}
    />
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 z-[9999] flex flex-col justify-between"
      style:background-color={playerStatus === "loading" ? "black" : "transparent"}
      class:cursor-none={!autoHide.controlsVisible}
      class:player-cursor-hidden={!autoHide.controlsVisible}
      onmousemove={autoHide.handleMouseMove}
      onmouseleave={autoHide.handleMouseLeave}
    >
      <PlayerHeader
        title={playerTitle}
        controlsVisible={autoHide.controlsVisible}
        {isFullscreen}
        stopPlayer={() => void stopPlayer()}
        {toggleFullscreen}
        enterPip={enterPipMode}
      />

      <button
        class="absolute inset-0 z-0 w-full h-full"
        onclick={handleOverlayClick}
        aria-label={isPaused ? "Resume playback" : "Pause playback"}
      ></button>

      {#if showSkipButton}
        <div class="absolute bottom-[10.5rem] sm:bottom-[11.5rem] left-0 w-full px-3 sm:px-6 pointer-events-none z-[10000]">
          <div class="mx-auto w-full max-w-6xl flex justify-end">
            <SkipSegmentButton
              label={skipButtonLabel}
              onSkip={skipSegment}
            />
          </div>
        </div>
      {/if}

      <PlayerControls
        {playerTitle}
        selectedQualityLabel={ctx.selectedQualityLabel}
        {endTimeEstimate}
        mediaStreams={ctx.mediaStreams}
        {audioMenuLabel}
        {subtitleMenuLabel}
        {audioMenuOpen}
        {subtitleMenuOpen}
        {overflowMenuOpen}
        {toggleTopMenu}
        selectedAudioIndex={ctx.selectedAudioIndex}
        selectedSubtitleIndex={ctx.selectedSubtitleIndex}
        applyTrackSelection={ctx.applyTrackSelection}
        playbackRate={rate}
        {mpvSetPlaybackRate}
        {videoScaleMode}
        {mpvSetVideoScale}
        {autoCropEnabled}
        qualityOptions={ctx.qualityOptions}
        selectedQualityKey={ctx.selectedQualityKey}
        changeQuality={ctx.changeQuality}
        autoplayCountdown={ctx.autoplayCountdown}
        cancelAutoplayCountdown={ctx.cancelAutoplayCountdown}
        {formatTime}
        {effectivePos}
        {dur}
        previousEpisode={ctx.previousEpisode}
        nextEpisode={ctx.nextEpisode}
        playPreviousEpisode={() => ctx.playPreviousEpisode()}
        playNextEpisode={() => ctx.playNextEpisode()}
        {seekBack10}
        {seekForward30}
        {togglePause}
        {isPaused}
        {playerStatus}
        vol={vol}
        {handleVolumeInput}
        {toggleMute}
        muted={muted}
        controlsVisible={autoHide.controlsVisible}
        hasChapters={ctx.chapters.length > 0}
        onPrevChapter={skipToPreviousChapter}
        onNextChapter={skipToNextChapter}
        prevChapterDisabled={previousChapterTime === null && pos <= 2.0}
        nextChapterDisabled={nextChapterTime === null}
      >
        <PlayerTimeline
          {effectivePos}
          {dur}
          {progressPercent}
          {chapterMarkers}
          mediaSegments={ctx.mediaSegments}
          {isScrubbing}
          bind:progressScrubEl
          {beginTimelineScrub}
          {handleProgressKeydown}
          {seekToChapter}
        />
      </PlayerControls>
    </div>
  {/if}
{/if}

<style>
  :global(.player-cursor-hidden),
  :global(.player-cursor-hidden *) {
    cursor: none !important;
  }
</style>
