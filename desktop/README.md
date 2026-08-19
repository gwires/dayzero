# desktop spike (phase 0)

Feasibility spike for a Zig desktop shell around the static app build,
using the C API of [webview/webview](https://github.com/webview/webview)
0.12.0 (vendored under `lib/webview/`, MIT license).

See `../docs/DESKTOP-PLAN.md` for the findings — the short version: the
shell itself works (window + local http server + page load), but the
WebKitGTK engine it uses on Linux does not implement OPFS, which the app's
storage layer requires. The spike is kept as a canary: re-run it after
WebKitGTK releases to check whether OPFS has landed.

## Run it

```sh
nix develop                     # needs zig, gtk3, webkitgtk_4_1, pkg-config
cd desktop
spike/fetch-sqlite.sh           # one-time: copies sqlite-wasm from app/node_modules
zig build run
```

The binary serves `spike/www/` on an ephemeral `127.0.0.1` port (a secure
context, which OPFS requires — `file://` would not do) and opens a webview
on it. The page exercises exactly what `app/src/lib/db/worker.ts` does:
initialize sqlite-wasm in a dedicated worker, install the OPFS SAH pool
VFS, run a write/read round-trip. Results render in the window and are
POSTed back to the server's `/log` endpoint so they also appear in the
process log — useful headless:

```sh
Xvfb :99 -screen 0 1280x800x24 &
DISPLAY=:99 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  ./zig-out/bin/dayzero-desktop-spike
```

## Layout

```
build.zig, build.zig.zon     # compiles the webview C++ shim with the host
                             # c++ (zig's bundled clang can't find the nix
                             # store C++ headers) and links webkitgtk-4.1
src/main.zig                 # tiny static http server + webview window + /log sink
src/webview_shim.cpp         # single TU that instantiates the webview header
lib/webview/                 # vendored webview/webview 0.12.0 (MIT)
spike/www/index.html         # test page, reports each step via POST /log
spike/www/db-worker.mjs      # sqlite-wasm + OPFS SAH pool round-trip
spike/fetch-sqlite.sh        # copies the sqlite-wasm runtime from app/node_modules
spike/www/sqlite/            # gitignored copy destination
```
