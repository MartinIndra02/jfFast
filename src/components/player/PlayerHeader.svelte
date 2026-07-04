<script lang="ts">
  let {
    title,
    controlsVisible,
    isFullscreen,
    stopPlayer,
    toggleFullscreen,
    enterPip,
  }: {
    title: string;
    controlsVisible: boolean;
    isFullscreen: boolean;
    stopPlayer: () => void;
    toggleFullscreen: () => void;
    enterPip: () => void;
  } = $props();
</script>

<div
  class="relative z-10 px-3 sm:px-6 pt-3 sm:pt-5 pb-10 bg-gradient-to-b from-[rgba(4,7,14,0.88)] via-[rgba(4,7,14,0.52)] to-transparent transition-all duration-300 ease-out"
  class:opacity-0={!controlsVisible}
  class:-translate-y-full={!controlsVisible}
>
  <div class="mx-auto w-full max-w-6xl flex items-center justify-between gap-3">
    <div class="flex items-center gap-2 sm:gap-3 min-w-0">
      <button
        onclick={stopPlayer}
        aria-label="Close player"
        class="h-10 w-10 grid place-items-center rounded-xl bg-[rgba(10,18,31,0.64)] border border-white/22 backdrop-blur-xl text-[var(--text-primary)] hover:bg-[rgba(22,34,54,0.76)] transition-colors"
      >
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <div class="min-w-0 rounded-xl border border-white/20 bg-[linear-gradient(145deg,rgba(255,255,255,0.16),rgba(255,255,255,0.04))] px-3 py-2 backdrop-blur-xl">
        <p class="text-white text-sm sm:text-base font-semibold truncate">{title}</p>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <button
        onclick={enterPip}
        aria-label="Picture in Picture"
        class="h-10 w-10 grid place-items-center rounded-xl bg-[rgba(10,18,31,0.64)] border border-white/22 backdrop-blur-xl text-[var(--text-primary)] hover:bg-[rgba(22,34,54,0.76)] transition-colors"
      >
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <rect x="12" y="10" width="8" height="6" rx="1" fill="currentColor" stroke="none"/>
        </svg>
      </button>

      <button
        onclick={toggleFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        class="h-10 w-10 grid place-items-center rounded-xl bg-[rgba(10,18,31,0.64)] border border-white/22 backdrop-blur-xl text-[var(--text-primary)] hover:bg-[rgba(22,34,54,0.76)] transition-colors"
      >
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 3H5a2 2 0 00-2 2v3m16-5h-3m3 0v3M3 16v3a2 2 0 002 2h3m11-5v3a2 2 0 01-2 2h-3"/>
        </svg>
      </button>
    </div>
  </div>
</div>
