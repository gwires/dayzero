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

## meta: errors are invisible on mobile

Both bugs were painful to diagnose because the app has no way to show
unexpected errors and phones expose no console. Worth adding while in
milestone-9 polish:

- a global `window.onerror` / `unhandledrejection` handler that shows a
  dismissible error banner (or at minimum logs to a ring buffer viewable on
  `/settings`);
- the db-init error path from bug 2's fix.
