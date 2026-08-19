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

## decision point (resolved: option 2)

The shell half of the plan is proven; the blocker is that webview/webview's
Linux engine (WebKitGTK is its only Linux backend) has no OPFS and no
near-term sign of one. Options considered:

1. **hybrid**: zig shell everywhere; on Linux launch system Chromium in
   `--app` mode.
2. **webview-only, Linux later** — **chosen**: ship macOS/Windows now,
   keep the spike as a canary (`zig build run-spike` in `desktop/`) and
   add Linux for free if WebKitGTK ever gains OPFS.
3. **Electron**: OPFS everywhere via bundled Chromium, but ~100MB+ of
   runtime and a Node toolchain — against this repo's grain.
4. **stay a PWA**: no packaging; desktop users install from the browser.

## phase 1 — real shell (done)

`desktop/src/main.zig` serves the app build embedded at compile time
(`build.zig` walks `app/build/` and generates a path → bytes table of
`@embedFile` entries, imported as `web`) and opens a webview window on it:

- verified: index + assets serve with correct content types; SPA routes
  fall back to `200.html`; `.pmtiles` served as `application/octet-stream`,
  never compressed
- verified byte-exact against the files on disk: full-body GET, explicit
  `Range: bytes=a-b`, open-end `bytes=a-`, and suffix `bytes=-n` ranges
  (206 + correct `Content-Range`); unsatisfiable ranges get 416 with
  `Content-Range: bytes */size` — this is the trap Capacitor's local server
  fell into (`BUGS.md` bug 3), pmtiles depends on it
- `-dev [url]` points the window at a dev server (defaults to vite's
  `http://localhost:5173`) and skips the local server
- one caveat found and documented in `build.zig`: the webview header must
  be compiled with `-DWEBVIEW_STATIC`, and on Linux the shim is compiled by
  the host `c++` with the host's `libstdc++`/`libgcc_s` linked directly
  (zig maps `-lstdc++` to its ABI-incompatible bundled libc++)
- second caveat (found on a real Mac): zig resolves the WebKit framework
  via an SDK path it detects by running `xcrun`, which fails inside
  `nix develop` ("unable to find framework 'WebKit'. searched paths:
  none"). `build.zig` now finds the SDK itself — `SDKROOT` env, then
  `xcrun --show-sdk-path`, then the well-known Command Line Tools / Xcode
  directories — and passes it as both `b.sysroot` (`--sysroot`, which
  feeds the MachO linker's framework search) and `-isysroot` for the shim
  compilation

The webview window itself was exercised under Xvfb: page loads, JS runs.
On Linux it fails at database open ("Missing required OPFS APIs" — the
phase-0 finding, expected); macOS/Windows verification on real hardware is
still outstanding.

## phase 2 — repo integration (done)

- `scripts/build-desktop.sh`: `npm run build` in `app/`, then
  `zig build -Doptimize=ReleaseSafe` in `desktop/` →
  `desktop/zig-out/bin/dayzero-desktop`
- `flake.nix`: `pkg-config`, `gtk3`, `webkitgtk_4_1` added to the devshell
- README sections (`README.md`, `desktop/README.md`, `scripts/README.md`)

## remaining phases

- **phase 3 — webview gaps**: backup export (`<a download>` likely no-ops
  at least in WKWebView — webview/webview installs no download handler →
  `webview_bind`'d Zig function writing to a chosen path, same fix pattern
  as Android's `@capacitor/filesystem`); confirm the app tolerates missing
  service workers (harmless for a local-first app but verify). Requires
  macOS/Windows hardware.
- **macOS/Windows verification**: the window + storage + sync round-trip on
  real hardware (WKWebView has OPFS since Safari 16.4-era WebKit; WebView2
  is Chromium, OPFS since 102 — both high-confidence but untested here).
- packaging (icons, `.dmg`/`.msi`/`.deb`) is deliberately out of scope —
  webview/webview ships raw binaries by design.
