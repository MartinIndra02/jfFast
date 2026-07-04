<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import {
    getPlayerTitle,
    getTimePos,
    getDuration,
    getPlayerStatus,
  } from "../../lib/stores/player.svelte";
  import { mpvTogglePause } from "../../lib/api";

  let { onExpand, onClose }: {
    onExpand: () => void;
    onClose: () => void;
  } = $props();

  const title = $derived(getPlayerTitle());
  const pos = $derived(getTimePos());
  const dur = $derived(getDuration());
  const isPaused = $derived(getPlayerStatus() === "paused");
  const progress = $derived(dur > 0 ? (pos / dur) * 100 : 0);

  // ── Pointermove-based controls reveal ──
  let controlsVisible = $state(true); // Start visible, auto-hide after 2s
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function showControls() {
    controlsVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      controlsVisible = false;
    }, 2000);
  }

  function handlePointerMove() {
    showControls();
  }

  onMount(() => {
    // Auto-hide after initial 2s
    hideTimer = setTimeout(() => {
      controlsVisible = false;
    }, 2000);
    return () => {
      if (hideTimer) clearTimeout(hideTimer);
    };
  });

  function handleDragBar(e: PointerEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    e.preventDefault(); // Prevent text selection during drag
    getCurrentWindow().startDragging();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="pip-overlay" onpointermove={handlePointerMove}>
  <!-- Clickable area for video expand (beneath overlay) -->
  <button
    class="pip-video-click-area"
    onclick={onExpand}
    aria-label="Expand to full player"
  ></button>

  <!-- Top drag bar + controls -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="pip-top-bar"
    class:pip-top-bar--visible={controlsVisible}
    onpointerdown={handleDragBar}
  >
    <button
      class="pip-btn"
      onclick={() => void mpvTogglePause()}
      aria-label={isPaused ? "Play" : "Pause"}
    >
      {#if isPaused}
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      {:else}
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
        </svg>
      {/if}
    </button>

    <span class="pip-title">{title}</span>

    <div class="pip-actions">
      <button class="pip-btn" onclick={onExpand} aria-label="Expand">
        <svg
          class="w-3.5 h-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5"
          />
        </svg>
      </button>
      <button class="pip-btn" onclick={onClose} aria-label="Close">
        <svg
          class="w-3.5 h-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  </div>

  <!-- Progress bar -->
  <div class="pip-progress">
    <div class="pip-progress-fill" style:width="{progress}%"></div>
  </div>
</div>
