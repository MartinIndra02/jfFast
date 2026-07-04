# jfgoat 🐐

An ultra-fast, native-feeling, offline-first Jellyfin desktop client for Windows. 

`jfgoat` is built using **Tauri (Rust)**, **Svelte (TypeScript)**, and **Tailwind CSS**. It is designed to handle massive media libraries (100,000+ items) with sub-50ms load times and zero UI blocking by using a local offline-first SQLite database and native video rendering through `libmpv`.

---

## 🏗️ Architecture & Core Concepts

### 1. High-Performance Technology Stack
* **Frontend**: Svelte (Vite) - compiler-based UI framework (no Virtual DOM) providing extremely fast rendering, precise control, and smooth transitions.
* **Backend**: Tauri (Rust) - safe, performant, and lightweight framework replacing heavy Electron wrappers.
* **Video Player**: `libmpv` (C/Rust) - industry-standard for hardware-accelerated video playback (DXVA2/D3D11VA) and custom format decoding.
* **Local Storage**: SQLite (via Rust) - offline-first database that acts as the primary data source, eliminating API request overhead on application startup.
* **Security**: `tauri-plugin-stronghold` - Jellyfin access tokens are stored securely in the Windows Credential Manager rather than insecure web storage.

### 2. Synchronization Strategy (Two-Track System)
To keep the application responsive, loading is split into two tracks:
* **Track A (UI Priority)**: Instantly fetches the resume state (`/Users/{userId}/Items/Resume`) and next-up items (`/Shows/NextUp`) with minimal payloads (only IDs and progress). The titles and local poster paths are pulled from the local SQLite database for instant rendering.
* **Track B (Background Sync)**: Runs a rate-limited background worker that paginates through the Jellyfin server items and builds/updates the local SQLite database. It compares modification dates (`DateUpdated`) and cleans up deleted items (ghost cleaning).

### 3. Transparent Underlay Video Player
To avoid bottlenecking UI rendering inside the webview when playing 4K or hardware-demanding video, `jfgoat` uses a layered layout:
1. **Native MPV Window (Bottom)**: Rust spawns a borderless Windows window where `libmpv` renders video directly.
2. **Transparent Tauri Webview (Top)**: Svelte runs on a transparent webview on top of the MPV window.
3. **Hole Punching**: Svelte renders a transparent `<div>` where the video is playing, allowing the user to see the video underneath while drawing responsive web-based player controls over it.
4. **Mini-Player Transitions**: Resizing or moving the player tells Svelte to animate and IPC to Rust to dynamically reposition and scale the underlying MPV window.

### 4. Hybrid Search Routing
* During `INITIAL_SYNC` (indexing in progress), the search command automatically bypasses the incomplete local database and queries the remote Jellyfin API (`/Users/{userId}/Items?searchTerm=...`).
* Once the state is `READY` (sync completed), queries route to the local SQLite FTS5 (Full-Text Search) virtual table for sub-millisecond typo-tolerant results.

---

## 🚀 Getting Started

### Prerequisites
* [Node.js](https://nodejs.org/) (v18+)
* [Rust toolchain](https://www.rust-lang.org/tools/install)
* `libmpv` headers and binaries (required for build/link steps)

### Setup & Development
1. Install node dependencies:
   ```bash
   npm install
   ```
2. Run the development server (starts Svelte dev server and launches the Tauri window):
   ```bash
   npm run tauri dev
   ```

### Building for Production
To bundle the application into a production-ready Windows executable:
```bash
npm run release:tauri
```

### Running Tests
* **Run Unit Tests**:
  ```bash
  npm run test:unit
  ```
* **Run E2E Smoke Tests**:
  ```bash
  npm run test:e2e:smoke
  ```
* **Run Rust Backend Tests**:
  ```bash
  npm run test:rust
  ```
* **Run Baseline Test Suite (frontend, e2e, and compile check)**:
  ```bash
  npm run test:baseline
  ```

---

## 📝 Changelog

### v1.5.1 (Current)
This release introduces Picture-in-Picture (PiP) mode, double-click to toggle fullscreen, playback improvements, and E2E test suite fixes:

* **Picture-in-Picture (PiP) Mode**: Added support for Picture-in-Picture video playback.
* **Double-Click Fullscreen**: Added support for toggling fullscreen mode by double-clicking on the media player.
* **Playback Fixes**: Fixed video pausing unexpectedly at startup, and resolved bugs when playing the next video in sequence.
* **Test Suite Updates**: Fixed E2E smoke test failure in search propagation timing.

### v1.5.0
This release includes aspect ratio controls, intro/chapter skipping, async player closing, network resilience improvements, and various navigation and layout fixes:

* **Aspect Ratio Selection**: Added aspect ratio adjustments in the video player.
* **Skip Intro & Chapters**: Support for skipping intro sequences and navigating/skipping video chapters.
* **Async Player Closing**: Optimized player teardown to run asynchronously in the background, eliminating delays when exiting the player.
* **Degraded Network Banner**: Improved UI warnings and handling when network connection is degraded.
* **Navigation & Layout Fixes**: Fixed player back button behavior, resolved library navigation lock, corrected mouse drag interactions, and fixed two-rows display issues.

### v1.4.2
This release includes router implementation, Rust refactoring, security improvements, player code cleanup, and UI enhancements:

* **Svelte Router Implementation**: Replaced monolithic home component with a modular routing structure and a centralized home data store.
* **Rust Command Refactoring**: Split large command structures into separate playback, library, and media modules, enhancing code maintainability.
* **Security & Hardening**: Configured Content Security Policy (CSP) headers, added brute force and rate limit protection for authentication, and introduced corresponding E2E test coverage.
* **Player Refactoring**: Modularized the media player into focused sub-components (header, timeline, controls, custom playback contexts, autohide hooks).
* **Context Menu Unification**: Unified right-click context menu states across views to prevent overlapping menu overlays.
* **Stale Cache Refresh**: Added a manual data refresh action and loading spinner to allow user-initiated updates of stale cached data.

### v1.4.1
This release includes settings UI, update checks, and download system enhancements:

* **Automatic Update Checks**: Added automated update checking on application startup and interactive update notification/popup flows in the notification stack.
* **Modernized Settings UI**: Fully reworked the settings screen interface for improved configuration layout and visual appeal.
* **Download & Offline View Enhancements**: Added file size estimates before initiating downloads, displayed active download progress in MBs alongside percentages, displayed series names on the offline page, and resolved cover art loading issues for offline episodes.
* **Download Stream Resiliency**: Integrated automatic retry logic to recover and resume downloads affected by connection-reset and decoding stream errors.

### v1.4.0
This release introduces cross-platform support and authentication persistence:

* **Initial macOS Support**: Brought initial compatibility to macOS, including native MPV video player rendering, window/event management, and macOS build pipelines.
* **Secure Auth Persistence**: Implemented a SQLite session token fallback to prevent post-update relogin requirements.
* **Multiplatform Updater Automation**: Integrated automated multiplatform updater generator and build-merging pipeline utilities.
* **Build Configuration Fixes**: Patched Raw Window Handle pointer access, linker library paths on macOS, and beforeBundleCommand scripts.

### v1.3.0
This release includes backend updates and fixes:

* **Backend Refactoring**: Refactored the backend structure and optimized updater generator logic.

### v1.2.2
This release includes a critical bugfix:

* **Updater Endpoint Hotfix**: Fixed the application updater endpoint URL by pointing it to the correct `jfFast` repository name instead of the old `JF-Goat` name, resolving the update check 404 error.

### v1.2.1
This release includes download options and fixes:

* **Download Quality Selection**: Added support for choosing download qualities (Original, 720p, 480p, 360p) with on-the-fly transcoding parameters to save bandwidth and local disk space.

### v1.2.0
This release includes new features, stability improvements, and layout fixes:

* **App Updater**: Added a built-in application updater featuring auto-detection, manual update check, background downloading with progress tracking, and seamless installation.
* **Offline Authentication Persistence**: Fixed offline login issues by preventing token clearing during network errors and connection timeouts, allowing players to launch and play offline.
* **Next Up Layout Fit**: Resolved a styling bug to prevent the Next Up section elements from overflowing or breaking out of the Carousel container.

### v1.1.0
This release includes major new features, performance enhancements, and UI design updates:

* **Offline Downloads**: Added full support for downloading series/episodes for offline playback, featuring auto-resuming of interrupted or failed downloads and offline sync logic.
* **Next Up Carousel**: Integrated a custom, high-performance "Next Up" carousel (HeroCarousel) on the homepage that is responsive and allows quick access to in-progress media.
* **Unbounded Delta Sync**: Removed the 3,000 items limitation on delta updates, allowing full synchronization of large libraries in the background.
* **Top Header Navigation**: Migrated the application's layout from a sidebar-based navigation to a modern top header layout (Home, Library, Offline, Settings).
* **UI & Detail Refinements**: Refined detail views (especially episodes detail page) to include direct action buttons for downloads, clear offline availability status, and smooth layouts.

### v1.0.2
This release includes new features, styling enhancements, and bug fixes:

* **Application Icon**: Configured and integrated native icons across multiple formats and resolutions for the system tray, taskbar, window header, and package installers (Windows, macOS, Android, iOS).
* **Refresh Context Menu**: Added a right-click context menu with a "Refresh from Jellyfin API" option to manually trigger a fresh sync for an item, compare changes, and write updates directly to the local SQLite database.
* **Navigation Enhancements**: Integrated a right-click "Go Back" context menu action for improved mouse-only navigation.
* **Design Unification**: Unified design and layout across the series, seasons, and episodes detail pages to match the home screen and player aesthetics. Removed obsolete resolution/quality selectors (HD SDR and Original) on the episode screen.
* **Search Delta Sync Fix**: Resolved an issue where unscheduled incremental delta syncs triggered unexpectedly during search and general app navigation.
* **Dependency Updates**: Patched security vulnerabilities across frontend and backend dependencies.

### v1.0.1
This release includes crucial fixes and stability improvements addressing GitHub issues **#15-20** and **#23-26**:

* **CI/CD & Builds (Issue #15)**: Disabled updater artifacts in `tauri.conf.json` to bypass code-signing key errors during build pipelines.
* **Watch Status Propagation (Issue #16)**: Resolved watch status propagation issues across home page postcards and item detail views, ensuring accurate played-state synchronization with the Jellyfin server.
* **Subtitles & Rendering (Issues #17-20)**: 
  * Fixed external subtitles failing to load or parse.
  * Adjusted subtitle overlay position coordinates inside the player container.
* **Player UI & Layout (Issues #23-26)**:
  * Fixed native video player resizing issues when toggling windowed/maximized states.
  * Resolved webview window transparency and underlay layout issues.
  * Added season number indicators on postcard items displayed on the home page.

### v1.0.0
* Initial release.
* Offline-first library synchronization and SQLite/FTS5 integration.
* Hardware-accelerated transparent underlay video player powered by `libmpv`.
* Secure token storage via Tauri Stronghold.
