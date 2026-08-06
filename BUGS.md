# known bugs

Observed on mobile (real phone, 2026-08-05). Desktop browsers are unaffected.
No devtools were available on the phone, so root causes below are code-level
diagnoses, not confirmed from console output — see the "meta" section at the
bottom for why that matters.

## 1. location times out even after permission is granted — FIXED

**Symptom**: in the entry editor, tapping "use current location" triggers the
browser permission prompt; after granting, the app reports a location timeout.

**Likely cause**: `app/src/lib/ui/EntryEditor.svelte` (`useCurrentLocation`,
~line 122) calls `getCurrentPosition` with:

```js
{ enableHighAccuracy: true, timeout: 10000 }
```

- `enableHighAccuracy: true` on a phone means a real GPS fix. A cold GPS fix
  (indoors, or first use after granting permission) routinely takes longer
  than 10 seconds, so the 10s `timeout` fires and rejects with `TIMEOUT` even
  though permission was granted. On desktop this never shows up because
  "high accuracy" there is wifi/IP-based and returns almost instantly.
- No `maximumAge` is set, so a recent cached fix the OS already has is not
  accepted either.

**Fix (2026-08-05)**: `useCurrentLocation` now tries a fast low-accuracy
request first (`maximumAge: 60000, timeout: 10000` — accepts a recent cached
fix), and only if that fails falls back to `enableHighAccuracy: true` with a
60s timeout, long enough for a cold GPS fix. Permission denial short-circuits
the fallback. A diary entry needs city-level accuracy, not meters, so low
accuracy is fine as the primary path.

**Update (2026-08-06) — same bug, native path**: confirmed on a real phone
with the APK from milestone 10 — the permission prompt appears and is
granted, but it still times out. Root cause: `useNativeCurrentLocation`
(`EntryEditor.svelte`) called `@capacitor/geolocation`'s `getCurrentPosition`
with only `{ timeout: 30000 }`. `enableHighAccuracy` defaults to `false`,
which on Android only ever requests coarse/network-based location (and only
the `ACCESS_COARSE_LOCATION` permission) — it never touches GPS, even though
`ACCESS_FINE_LOCATION` is declared in the manifest. If the device has no fast
network-based fix available (no recent Wi-Fi/cell scan, Wi-Fi scanning
disabled, etc.), the request just times out with nothing to fall back to.
**Fix**: mirrored the web path's two-tier strategy — fast low-accuracy
attempt (`maximumAge: 60000, timeout: 10000`) first, falling back to
`enableHighAccuracy: true` with a 60s timeout (a real GPS fix) unless the
first attempt was a permission denial.

**Verified on-device (2026-08-06)**: confirmed working, with a caveat —
on the very first attempt after granting permission the GPS chip had no
AGPS almanac/ephemeris data yet, so it needed a fix obtained via another
app (Maps) before our request would resolve. That's normal Android GPS
behavior (any app's fix warms up the chip for the next one, since AGPS
data is device-wide, not per-app) and not something our request options
control; the 60s high-accuracy timeout is meant to cover a genuine cold
start, but a *first-ever* fix on a device can occasionally exceed even
that. Not treating this as a further bug — just worth knowing if "use
current location" fails on a completely fresh device/permission grant,
try opening Maps once first.

## 2. "loading…" forever on timeline, tags, calendar, and map — FIXED (error surfacing)

**Symptom**: every db-backed page (`/`, `/tags`, `/calendar`, `/map`) shows
its `loading…` placeholder indefinitely. No error is shown.

**Likely cause — db worker init failure is silently swallowed**: the db
worker (`app/src/lib/db/worker.ts:80`) does:

```js
const ready = openDb().then((conn) => { ...; self.postMessage(ready-msg); });
```

If `openDb()` **rejects** — i.e. `installOpfsSAHPoolVfs` fails because the
browser/context doesn't provide OPFS `FileSystemSyncAccessHandle` — there is
no `.catch`: the ready message is never posted, `DbClient.ready`
(`app/src/lib/db/client.ts:11`) never resolves, and every `select()` from
every page awaits forever. The UI has no error path for this, hence the
permanent `loading…`.

Plausible triggers for `installOpfsSAHPoolVfs` failing on a phone:

- **Insecure context**: OPFS only exists on HTTPS (or localhost). If the app
  was opened over plain `http://` on a LAN IP, `navigator.storage.getDirectory`
  is undefined and init throws. (Would also affect geolocation, though the
  permission prompt reportedly did appear — worth confirming what URL/scheme
  the phone actually used.)
- Older mobile browser / iOS Safari < 17 / private-browsing mode, where
  sync access handles are unavailable or storage is blocked.
- An in-app browser / WebView (e.g. opened from a chat app link) with OPFS
  disabled.

**Fix (2026-08-05), part 1 — never hang silently**: the worker now catches
`openDb()` failures, posts `{ id: -1, ok: false, error }`, and answers every
subsequent request with that error; `DbClient.ready` rejects on it (and on
the worker's `error` event, covering worker-script load failures too). The
pages already had `error` states, so the failure now renders as a readable
message instead of `loading…`.

**Part 2 — still open**: with the error now visible on the phone, re-test and
fix the actual trigger (could be as simple as "serve over HTTPS").

**Update (2026-08-06)**: milestone 10 (see `APK-PLAN.md`, `PLAN.md`) packages
the app as an Android APK specifically because of the insecure-context
hypothesis above — a Capacitor-wrapped APK serves the app from a bundled
`https://localhost` origin, which is a secure context by construction,
sidestepping the failure mode entirely if that was the trigger. This isn't
confirmation of the hypothesis, just a fix that should work regardless of
which of the plausible triggers it was — on-device testing of the resulting
APK (does `/`, `/tags`, `/calendar`, `/map` load without the db-init error)
is still the open item to actually confirm or refute it.

## 3. offline basemap shows no country outlines or city labels in the APK — FIXED

**Symptom**: in the Android APK, the map view renders (background color, nav
control) but none of the bundled offline basemap's vector data shows up — no
country outlines, no city dots or labels. Desktop/web is unaffected.

**Cause — Capacitor Android's local WebView server mishandles HTTP Range
requests**: `MapView.svelte`'s offline style loads `basemap.pmtiles` via the
`pmtiles://` protocol (see the `pmtiles` npm package), which works by issuing
real HTTP byte-range requests (`Range: bytes=X-Y`) to read just the header,
then directory, then individual tile chunks out of the file — it never
downloads the whole 2.7MB archive up front. `@capacitor/android`'s
`WebViewLocalServer.handleLocalRequest`
(`node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/WebViewLocalServer.java`,
~line 339) has a bug in that path: it sets a `206`/`Content-Range` header
based on the requested range, but returns the **entire, unsliced file
stream** as the response body regardless of what range was asked for — the
`InputStream` is never seeked or truncated to `fromRange`/`range`. So every
`pmtiles` range fetch after the very first gets back the wrong bytes (always
starting from byte 0 of the file), and `pmtiles`' own directory/tile parsing
silently decodes garbage, producing no renderable features. This is an
upstream bug in `@capacitor/android`'s bundled server, not something fixable
from this repo's Gradle project.

**Fix (2026-08-06)**: `MapView.svelte` now detects
`Capacitor.isNativePlatform()` and, only when using the bundled offline style
(not a custom raster tile url), fetches `basemap.pmtiles` once via a plain
(non-ranged) `fetch()` — which hits a different, correct code path in the
same server — and hands the resulting `Blob` to `pmtiles`' `FileSource`,
registering it on the `Protocol` instance so all `pmtiles://` lookups resolve
to the in-memory copy instead of issuing HTTP range requests at all. The
archive is cached at module scope so repeated map views (entry editor, map
overview) don't redownload/reparse it. Web keeps the original lazy,
range-based fetching, since real static file servers handle `Range` requests
correctly and it avoids pulling the whole file for a single small viewport.

## meta: errors are invisible on mobile

Both bugs were painful to diagnose because the app has no way to show
unexpected errors and phones expose no console. Worth adding while in
milestone-9 polish:

- a global `window.onerror` / `unhandledrejection` handler that shows a
  dismissible error banner (or at minimum logs to a ring buffer viewable on
  `/settings`);
- the db-init error path from bug 2's fix.
