# plan: cross-platform desktop app (webview shell)

Goal: a minimalist desktop wrapper for dayzero. The app is already a pure
static SPA (`app/build/`), so a desktop shell only needs to (1) hold those
files, (2) serve them over `http://127.0.0.1` — a secure context, which
OPFS requires, and what Capacitor's `https://localhost` trick provides on
Android — and (3) open a native window on that URL.

Proposed tooling: a small Zig program in `desktop/` using the C API of
[webview/webview](https://github.com/webview/webview) 0.12.0, with the
static build embedded at compile time so the result is one self-contained
binary, in line with the Zig server. Zig was chosen over Go because it is
already the repo's compiled language and keeps the single-binary story
without a new toolchain.

## phase 0 — feasibility spike (done, 2026-08-19)

Built and ran `desktop/` (see `desktop/README.md`): a ~140-line Zig program
that serves the test page on an ephemeral localhost port and opens a
webview window on it. The page exercises exactly what
`app/src/lib/db/worker.ts` does: initialize sqlite-wasm in a dedicated
worker, install the OPFS SAH pool VFS, run a write/read round-trip.

### result: blocked on Linux by the engine, not the shell

What works (verified under Xvfb with WebKitGTK 2.52.5 / WebKit 605.1.15):

- the zig shell compiles and runs; webview/webview's C API binds cleanly
  (one caveat: the header must be compiled with `-DWEBVIEW_STATIC`, and
  inside the nix devshell the C++ shim must be compiled with the host `c++`
  because zig's bundled clang can't find nix-store C++ headers)
- the window opens and loads the served page
- `http://127.0.0.1` is a secure context (`isSecureContext: true`)
- ES module workers and WASM both work: sqlite-wasm 3.53.0 initializes in
  the worker

What fails:

- `navigator.storage` is **entirely absent** from this WebKitGTK build —
  main thread and worker — so `installOpfsSAHPoolVfs` fails with
  "Missing required OPFS APIs". The app has no non-OPFS persistence path.

This is not a build-flag or secure-context issue; it is missing upstream
support:

- WebKitGTK 2.52.5 (nixpkgs stable, checked via its derivation: built with
  `-DENABLE_EXPERIMENTAL_FEATURES=OFF`, though that flag only gates media
  features) exposes no OPFS
- the WebKit `webkitgtk-2.52.5` tag has no FileSystem-API wiring for the
  GTK port: no `FILE_SYSTEM` entries in `OptionsGTK.cmake`,
  `PlatformGTK.cmake`, `SourcesGTK.txt`, `WebKitSettings`, or
  `WebPreferencesStore`; the latest dev tag (`wpewebkit-2.53.90`) is the
  same
- for comparison: the Cocoa port ships the full FileSystem module, which is
  why Safari/WKWebView have OPFS

macOS and Windows were not tested from this (Linux) machine, but both
engines should work: WKWebView has OPFS (Safari 16.4-era WebKit) and
WebView2 is Chromium (OPFS since Chrome 102). Worth confirming before
committing to those platforms.

## decision point

The shell half of the plan is proven; the blocker is that webview/webview's
Linux engine (WebKitGTK is its only Linux backend) has no OPFS and no
near-term sign of one. Options:

1. **hybrid (current recommendation)**: keep the Zig shell as the single
   entry point on all platforms. On macOS/Windows open the webview window;
   on Linux the same shell serves the app and launches the system Chromium
   in `--app` mode (chromium is already in the devshell; `--user-data-dir`
   keeps the profile private). Minimalist, works today, no bundling. Cost:
   the Linux window is Chromium's, and system chromium becomes a runtime
   dependency there.
2. **webview-only, Linux later**: ship macOS/Windows now, keep the spike
   as a canary (`zig build run` in `desktop/`) and add Linux for free when
   WebKitGTK gains OPFS. Fine if Linux desktop can wait.
3. **Electron**: OPFS everywhere via bundled Chromium, but ~100MB+ of
   runtime and a Node toolchain — against this repo's grain.
4. **stay a PWA**: no packaging; desktop users install from the browser.

## remaining phases (contingent on the decision above)

- **phase 1 — real shell**: embed `app/build/` at compile time (build.zig
  walks the tree and generates an embed map), serve it (`.pmtiles` must be
  `application/octet-stream` with working Range requests — same trap
  Capacitor hit, see `BUGS.md` bug 3; SPA fallback to `200.html`), `-dev`
  flag pointing at vite's `localhost:5173`.
- **phase 2 — repo integration**: `scripts/build-desktop.sh`
  (`npm run build` in `app/` → `zig build`), README section, flake updates.
- **phase 3 — webview gaps**: backup export (`<a download>` likely no-ops
  in webviews → `webview_bind`'d Zig function writing to a chosen path,
  same fix pattern as Android's `@capacitor/filesystem`); confirm the app
  tolerates missing service workers (WebKitGTK has none; harmless for a
  local-first app but verify).
- packaging (icons, `.dmg`/`.msi`/`.deb`) is deliberately out of scope —
  webview/webview ships raw binaries by design.
