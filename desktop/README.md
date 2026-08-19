# desktop

A minimalist desktop shell for dayzero: one Zig program that embeds the
static app build (`app/build/`), serves it on an ephemeral
`http://127.0.0.1` port (a secure context, which OPFS requires — same
reasoning as Capacitor's `https://localhost` on Android), and opens it in
a native window via the C API of
[webview/webview](https://github.com/webview/webview) 0.12.0 (vendored
under `lib/webview/`, MIT license).

See `../docs/DESKTOP-PLAN.md` for the full plan and phase-0 findings.
The short version: **macOS and Windows are the supported targets**;
webview/webview's only Linux backend is WebKitGTK, which does not
implement OPFS (the app's storage layer), so the Linux build currently
runs but can't open the database. The spike under `spike/` is kept as a
canary to re-check WebKitGTK releases.

## Build

```sh
nix develop -c scripts/build-desktop.sh      # from the repo root
# or by hand:
(cd app && npm run build) && (cd desktop && zig build -Doptimize=ReleaseSafe)
zig-out/bin/dayzero-desktop                  # run from desktop/
```

`-dev [url]` points the window at a dev server instead of the embedded
build (defaults to `http://localhost:5173`, i.e. `npm run dev` in
`app/`):

```sh
zig build run -- -dev
```

Note `zig build` must run from this directory (or use `scripts/build-desktop.sh`),
since the embed step locates `app/build` relative to the working directory.

## Implementation notes

- The build output is embedded at compile time: `build.zig` walks
  `app/build/`, copies the files into the build cache, and generates a
  path → bytes table (`@embedFile` per entry) imported as `web`.
- The server answers single-range `Range` requests with byte-exact 206s
  and a correct `Content-Range` — `basemap.pmtiles` relies on this (the
  trap Capacitor's local server fell into, see `BUGS.md` bug 3). Responses
  are never compressed, and `.pmtiles`/`.pbf` are served as
  `application/octet-stream` (see `pmtilesContentType` in
  `app/vite.config.ts`). Unknown paths fall back to `200.html` for SPA
  routing.
- On Linux the C++ shim is compiled with the host `c++` rather than zig's
  bundled clang (which can't find the nix store's C++ headers), and the
  host's `libstdc++`/`libgcc_s` are linked directly — zig maps `-lstdc++`
  to its own ABI-incompatible libc++. The shim needs `-DWEBVIEW_STATIC`,
  otherwise the C API is emitted as `inline` and nothing links.
- On macOS, zig's own SDK detection (running `xcrun`) fails inside the nix
  devshell, so `build.zig` locates the SDK itself (`SDKROOT` → `xcrun` →
  well-known Command Line Tools / Xcode paths) and passes it explicitly
  (`b.sysroot` for the linker's framework search, `-isysroot` for the
  shim).
- Window: 1100×800, resizable, title "dayzero", webview created with
  debug enabled (devtools).

## Layout

```
build.zig, build.zig.zon     # builds dayzero-desktop (+ the spike, below)
src/main.zig                 # embedded-build http server + webview window
src/webview_shim.cpp         # single TU instantiating the webview header
lib/webview/                 # vendored webview/webview 0.12.0 (MIT)
spike/                       # OPFS canary (see its README section below)
```

## spike/ — the OPFS canary

A small test page exercising exactly what `app/src/lib/db/worker.ts` does
(sqlite-wasm in a dedicated worker, `installOpfsSAHPoolVfs`, write/read
round-trip), served from disk instead of embedded. Re-run it after
WebKitGTK releases to check whether OPFS has landed:

```sh
spike/fetch-sqlite.sh        # one-time: copies sqlite-wasm from app/node_modules
zig build run-spike          # binary: zig-out/bin/dayzero-desktop-spike
```

Results render in the window and are POSTed to the server's `/log`
endpoint so they also appear in the process log — useful headless:

```sh
Xvfb :99 -screen 0 1280x800x24 &
DISPLAY=:99 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  ./zig-out/bin/dayzero-desktop-spike
```

Last run (WebKitGTK 2.52.5, WebKit 605.1.15): window, secure context,
module workers and WASM all work; `navigator.storage` is entirely absent,
so the OPFS SAH pool cannot be installed — see `../docs/DESKTOP-PLAN.md`.
