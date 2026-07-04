<script lang="ts">
  import { onMount } from "svelte";
  import Router, { location, replace } from "svelte-spa-router";
  import { checkAuth, checkAuthOffline } from "./lib/api";
  import {
    getAuthStatus,
    setAuthenticated,
    setUnauthenticated,
  } from "./lib/stores/auth.svelte";
  import {
    initPlayerListeners,
    isPlayerVisible,
    getPlayerStatus,
    hidePlayer,
    isPipMode,
  } from "./lib/stores/player.svelte";
  import {
    getPreferences,
    loadPreferences,
  } from "./lib/stores/preferences.svelte";
  import {
    isOnline,
    setOnlineStatus,
    markDegraded,
    markHealthy,
  } from "./lib/stores/connectivity.svelte";
  import {
    getToasts,
    dismissToast,
    pushToast,
    pushErrorToast,
    normalizeErrorMessage,
    updateToast,
    type ToastSource,
  } from "./lib/stores/toast.svelte";
  import {
    getUpdateStatus,
    getUpdateInfo,
    getDownloadProgress,
    getUpdateError,
    checkForUpdates,
    installUpdate,
    performRestart,
    dismissUpdate,
  } from "./lib/stores/updater.svelte";
  import { registerMenu, closeActiveMenu } from "./lib/stores/contextMenu.svelte";
  import LoadingScreen from "./components/layout/LoadingScreen.svelte";
  import ErrorBanner from "./components/ui/ErrorBanner.svelte";
  import Player from "./components/player/Player.svelte";
  import MainLayout from "./components/layout/MainLayout.svelte";
  import ServerConnect from "./views/ServerConnect.svelte";
  import Login from "./views/Login.svelte";
  import ItemDetail from "./views/ItemDetail.svelte";
  import HomeDashboard from "./views/home/HomeDashboard.svelte";
  import LibraryView from "./views/home/LibraryView.svelte";
  import OfflineView from "./views/home/OfflineView.svelte";
  import SearchView from "./views/home/SearchView.svelte";
  import SettingsView from "./views/home/SettingsView.svelte";

  const routes = {
    "/connect": ServerConnect,
    "/login": Login,
    "/home": HomeDashboard,
    "/library": LibraryView,
    "/offline": OfflineView,
    "/search": SearchView,
    "/settings": SettingsView,
    "/item/:id": ItemDetail,
    "/item": ItemDetail,
    "*": HomeDashboard,
  };

  const playerActive = $derived(isPlayerVisible());
  const playerStatus = $derived(getPlayerStatus());
  const pipMode = $derived(isPipMode());
  const isVideoRevealed = $derived(
    playerActive && (playerStatus === "playing" || playerStatus === "paused" || playerStatus === "ended")
  );
  const toasts = $derived(getToasts());

  let updateToastId = $state<string | null>(null);

  async function startUpdateFromToast() {
    if (!updateToastId) return;

    updateToast(updateToastId, {
      message: "Downloading update...",
      action: undefined,
    });

    try {
      await installUpdate();
    } catch (e) {
      console.error("Failed to install update from toast:", e);
    }
  }

  $effect(() => {
    const status = getUpdateStatus();
    const progress = getDownloadProgress();
    const error = getUpdateError();

    if (updateToastId) {
      if (status === "downloading") {
        updateToast(updateToastId, {
          message: progress !== null ? `Downloading update: ${progress}%` : "Downloading update...",
          action: undefined,
        });
      } else if (status === "installing") {
        updateToast(updateToastId, {
          message: "Installing update...",
          action: undefined,
        });
      } else if (status === "readyToRestart") {
        updateToast(updateToastId, {
          level: "success",
          message: "Update ready. Restart the app to apply.",
          action: {
            label: "Restart Now",
            onClick: () => {
              void performRestart();
            },
          },
        });
      } else if (status === "error" && error) {
        updateToast(updateToastId, {
          level: "error",
          message: `Update failed: ${error}`,
          action: {
            label: "Retry",
            onClick: () => {
              void startUpdateFromToast();
            },
          },
        });
      } else if (status === "idle" || status === "upToDate") {
        dismissToast(updateToastId);
        updateToastId = null;
      }
    }
  });

  async function checkForUpdatesBackground() {
    try {
      await checkForUpdates();
      const status = getUpdateStatus();
      if (status === "available") {
        const info = getUpdateInfo();
        if (info) {
          updateToastId = pushToast({
            level: "info",
            source: "system",
            title: "App Update Available",
            message: `Version ${info.version} is available.`,
            dismissAfterMs: 0,
            action: {
              label: "Download",
              onClick: () => {
                void startUpdateFromToast();
              },
            },
          });
        }
      }
    } catch (e) {
      console.warn("Background update check failed:", e);
    }
  }

  let globalMenuOpen = $state(false);
  let globalMenuX = $state(0);
  let globalMenuY = $state(0);

  function handleGlobalContextMenu(event: MouseEvent) {
    if (getAuthStatus() !== "authenticated") return;
    if (event.defaultPrevented) return;

    event.preventDefault();
    
    const menuWidth = 160;
    const menuHeight = 50;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    globalMenuX = Math.min(event.clientX, viewportWidth - menuWidth - 12);
    globalMenuY = Math.min(event.clientY, viewportHeight - menuHeight - 12);
    globalMenuOpen = true;
    registerMenu(closeGlobalMenu);
  }

  function closeGlobalMenu() {
    globalMenuOpen = false;
  }

  function triggerGlobalBack() {
    closeGlobalMenu();
    if (playerActive) {
      window.dispatchEvent(new CustomEvent("stop-playback"));
    }
    if (window.history.length > 1) {
      window.history.back();
    } else {
      replace("/home");
    }
  }

  function triggerGlobalRefresh() {
    closeGlobalMenu();
    const hash = window.location.hash || "";
    if (hash.startsWith("#/item")) {
      const params = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
      const id = params.get("id");
      if (id) {
        window.dispatchEvent(new CustomEvent("refresh-current-item", { detail: { id } }));
      } else {
        const pathPart = hash.split("?")[0].replace("#/item/", "");
        if (pathPart && pathPart !== "#/item") {
          window.dispatchEvent(new CustomEvent("refresh-current-item", { detail: { id: decodeURIComponent(pathPart) } }));
        }
      }
    } else if (hash.startsWith("#/library")) {
      window.dispatchEvent(new CustomEvent("refresh-library"));
    } else {
      window.dispatchEvent(new CustomEvent("refresh-homepage"));
    }
  }

  $effect(() => {
    if (isVideoRevealed) {
      document.body.classList.add("video-revealed");
    } else {
      document.body.classList.remove("video-revealed");
    }
  });

  function applyPreferencesToLocalPlayerKeys() {
    if (typeof localStorage === "undefined") return;

    const prefs = getPreferences();
    localStorage.setItem(
      "jfgoat.player.defaultPlaybackRate",
      String(prefs.playback.default_playback_rate),
    );
    localStorage.setItem(
      "jfgoat.player.defaultQualityKey",
      prefs.quality.default_quality_key,
    );

    if (prefs.language.preferred_audio_language) {
      localStorage.setItem(
        "jfgoat.player.preferredAudioLanguage",
        prefs.language.preferred_audio_language,
      );
    }

    if (prefs.language.preferred_subtitle_language) {
      localStorage.setItem(
        "jfgoat.player.preferredSubtitleLanguage",
        prefs.language.preferred_subtitle_language,
      );
    }
  }

  function getDefaultRoute(): string {
    return getPreferences()?.playback?.default_startup_screen || "/home";
  }

  function sourceFromErrorMessage(message: string): ToastSource {
    const lower = message.toLowerCase();
    if (lower.includes("mpv") || lower.includes("playback")) {
      return "player";
    }
    return "api";
  }

  function isIgnorableRuntimeError(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes("resizeobserver loop") || lower.includes("script error");
  }

  async function init() {
    try {
      await loadPreferences();
      applyPreferencesToLocalPlayerKeys();

      // Phase 1: Fast offline check — shows homepage instantly from cached data
      const offlineSession = await checkAuthOffline();
      if (offlineSession) {
        setAuthenticated(offlineSession);
        
        // Phase 2: Verify token in the background; auto-login if expired
        checkAuth()
          .then((session) => {
            if (!session) {
              pushToast({
                level: "warning",
                source: "api",
                title: "Session expired",
                message: "Please sign in again.",
                dedupeKey: "session-expired",
              });
              setUnauthenticated();
            } else {
              setAuthenticated(session);
              markHealthy();
            }
          })
          .catch((error) => {
            markDegraded(normalizeErrorMessage(error));
            pushToast({
              level: "info",
              source: "api",
              title: "Offline mode",
              message: "Server verification failed. Using cached session.",
              dedupeKey: `offline-session-${normalizeErrorMessage(error)}`,
              dismissAfterMs: 4500,
            });
          });
        return;
      }

      // No cached token — attempt auto-login (network required) before connect
      const session = await checkAuth().catch(() => null);
      if (session) {
        setAuthenticated(session);
        markHealthy();
        return;
      }

      setUnauthenticated();
    } catch (error) {
      markDegraded(normalizeErrorMessage(error));
      pushErrorToast(
        "api",
        normalizeErrorMessage(error),
        "Startup failed",
        "startup-init-failed",
      );
      setUnauthenticated();
    }
  }

  // Reactive redirect based on authentication state
  $effect(() => {
    const authStatus = getAuthStatus();
    const currentLoc = $location || "/";

    if (authStatus === "authenticated") {
      if (currentLoc === "/connect" || currentLoc === "/login") {
        replace(getDefaultRoute());
      }
    } else if (authStatus === "unauthenticated") {
      if (currentLoc !== "/connect" && currentLoc !== "/login") {
        replace("/connect");
      }
    }
  });

  onMount(() => {
    hidePlayer();

    try {
      initPlayerListeners();
    } catch (error) {
      pushErrorToast(
        "player",
        normalizeErrorMessage(error),
        "Player initialization failed",
        "player-listener-init-failed",
      );
    }

    const initialOnline = typeof navigator === "undefined" ? true : navigator.onLine;
    setOnlineStatus(initialOnline);
    if (initialOnline) {
      markHealthy();
    }

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const message = normalizeErrorMessage(event.reason);
      if (isIgnorableRuntimeError(message)) return;

      const source = sourceFromErrorMessage(message);
      const title = source === "player" ? "Playback error" : "Request failed";
      pushErrorToast(source, message, title, `unhandled-rejection-${source}-${message}`);
    };

    const handleRuntimeError = (event: ErrorEvent) => {
      const message = normalizeErrorMessage(event.error ?? event.message);
      if (isIgnorableRuntimeError(message)) return;

      const source = sourceFromErrorMessage(message);
      const title = source === "player" ? "Playback error" : "Unexpected error";
      pushErrorToast(source, message, title, `runtime-error-${source}-${message}`);
    };

    const handleOnline = () => {
      setOnlineStatus(true);
      markHealthy();
      pushToast({
        level: "success",
        source: "system",
        title: "Back online",
        message: "Connection restored.",
        dedupeKey: "online-restored",
        dismissAfterMs: 3000,
      });
    };

    const handleOffline = () => {
      setOnlineStatus(false);
      markDegraded("Network connection unavailable");
      pushToast({
        level: "warning",
        source: "system",
        title: "Offline",
        message: "You are offline. Showing cached data when available.",
        dedupeKey: "offline-detected",
      });
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".global-context-menu") && !target.closest("[role='menu']")) {
        closeActiveMenu();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeActiveMenu();
      }
    };

    window.addEventListener("contextmenu", handleGlobalContextMenu);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("error", handleRuntimeError);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    void init();

    if (isOnline()) {
      void checkForUpdatesBackground();
    }

    return () => {
      window.removeEventListener("contextmenu", handleGlobalContextMenu);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      window.removeEventListener("error", handleRuntimeError);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  });
</script>

<!-- App shell background layers (hidden when player is active to reveal mpv video) -->
<div class="fixed inset-0 z-0 pointer-events-none" class:hidden={playerActive}>
  <div class="app-stage app-grid-sheen absolute inset-0"></div>
  <div
    class="absolute inset-0"
    style:background="radial-gradient(80% 50% at 50% 115%, rgba(102,216,255,0.12), transparent 72%)"
  ></div>
</div>

{#if getAuthStatus() === "loading"}
  <div class="relative z-10">
    <LoadingScreen />
  </div>
{:else}
  <div class:hidden={playerActive} class="relative z-10 app-animate-fade-up">
    {#if getAuthStatus() === "authenticated"}
      <MainLayout>
        <Router {routes} />
      </MainLayout>
    {:else}
      <Router {routes} />
    {/if}
  </div>
{/if}

{#if toasts.length > 0 && !pipMode}
  <div class="fixed bottom-4 right-4 z-[100] w-[min(92vw,24rem)] space-y-2 pointer-events-none">
    {#each toasts as toast (toast.id)}
      <div class="pointer-events-auto">
        <ErrorBanner
          message={toast.message}
          title={toast.title}
          tone={toast.level}
          variant="toast"
          dismissible={true}
          onDismiss={() => {
            dismissToast(toast.id);
            if (toast.id === updateToastId) {
              updateToastId = null;
              dismissUpdate();
            }
          }}
          action={toast.action}
        />
      </div>
    {/each}
  </div>
{/if}

{#if globalMenuOpen}
  <div 
    class="global-context-menu fixed z-[100001] w-52 bg-[rgba(15,22,40,0.92)] border border-white/15 rounded-xl py-1.5 shadow-2xl backdrop-blur-xl flex flex-col overflow-hidden"
    style="left: {globalMenuX}px; top: {globalMenuY}px;"
  >
    <button
      onclick={triggerGlobalBack}
      class="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/8 transition-colors flex items-center gap-2.5 group"
    >
      <svg class="w-4 h-4 text-gray-400 group-hover:text-cyan-400 group-hover:-translate-x-0.5 transition-all duration-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
      </svg>
      Back
    </button>
    <button
      onclick={triggerGlobalRefresh}
      class="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/8 transition-colors flex items-center gap-2.5 group"
    >
      <svg class="w-4 h-4 text-gray-400 group-hover:text-cyan-400 group-hover:rotate-180 transition-all duration-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
      </svg>
      Refresh
    </button>
  </div>
{/if}

<Player />

<style>
  .global-context-menu {
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    transform-origin: top left;
    animation: globalContextMenuScale 0.15s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  @keyframes globalContextMenuScale {
    from {
      opacity: 0;
      transform: scale(0.92);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
