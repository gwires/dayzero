# plan: packaging dayzero as an Android `.apk` (Capacitor)

This is an implementation handoff document. Follow it phase by phase, in
order. Each phase ends with a **verify** step — do not start the next phase
until it passes. If a verify step fails and the fix isn't obvious from the
error message, stop and report the error verbatim instead of improvising.

## approach (already decided — do not re-litigate)

Wrap the existing static SvelteKit build in **Capacitor**: the web assets are
bundled into the APK and served by Capacitor from an internal
`https://localhost` origin inside Android's System WebView. This was chosen
over a TWA/Bubblewrap wrapper because dayzero is local-first: no hosted
origin should be required, and the bundled WebView origin is a secure
context, which OPFS (the sqlite storage layer) requires.

## ground rules for this repo

- Every shell command must be run inside the Nix devshell:
  `nix develop /home/user/wd/dayzero -c <command>`. The bare sandbox shell
  does not have `node` on PATH.
- Use **npm**, never pnpm/yarn/bun. The lockfile is `app/package-lock.json`.
- The frontend lives in `app/`. There is **no `svelte.config.js`** — SvelteKit
  (including `adapter-static`) is configured inside `app/vite.config.ts`.
  The static build output directory is `app/build`.
- Typecheck with `npm run check` (in `app/`), lint with `npm run lint`,
  tests with `npm test`. All three must pass before each commit.
- Commit per phase, following the existing convention (see `git log`):
  short imperative title, detailed body explaining what/why, a
  "Verified: ..." paragraph.
- `PLAN.md` is the product spec; `BUGS.md` documents the mobile bugs that
  motivated this. Read both before starting. Do not edit `PLAN.md` except
  as instructed in phase 6.

## phase 0 — preflight

1. Confirm a clean working tree (`git status`) and that
   `nix develop /home/user/wd/dayzero -c bash -c "cd app && npm run check"`
   passes before touching anything.
2. Confirm the web build works:
   `nix develop /home/user/wd/dayzero -c bash -c "cd app && npm run build"`
   → must produce `app/build/index.html` (or `200.html`) without errors.

**Verify**: both commands exit 0.

## phase 1 — Android toolchain in the Nix devshell

Edit `flake.nix`. Two changes:

1. The `pkgs` import must allow unfree packages and accept the Android SDK
   license:

   ```nix
   pkgs = import nixpkgs {
     inherit system;
     config = {
       allowUnfree = true;
       android_sdk.accept_license = true;
     };
   };
   ```

2. Add an Android SDK composition and a JDK to the devshell:

   ```nix
   androidSdk = (pkgs.androidenv.composeAndroidPackages {
     platformVersions = [ "35" ];
     buildToolsVersions = [ "35.0.0" ];
     includeEmulator = false;
     includeNDK = false;
   }).androidsdk;
   ```

   Add `androidSdk` and `pkgs.jdk21` to `packages`, and a `shellHook`:

   ```nix
   shellHook = ''
     export ANDROID_HOME=${androidSdk}/libexec/android-sdk
     export ANDROID_SDK_ROOT=$ANDROID_HOME
     export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/35.0.0/aapt2"
   '';
   ```

   The `aapt2FromMavenOverride` line is required on NixOS-style stores:
   Gradle otherwise downloads a dynamically-linked `aapt2` binary that
   cannot run in a Nix environment.

Note on versions: platform 35 / build-tools 35.0.0 / JDK 21 match
Capacitor 7's requirements. After phase 2, check the installed Capacitor's
requirements (`npx cap doctor` prints them); if it's a newer major that
wants a different platform/JDK, adjust `flake.nix` to match — do not
downgrade Capacitor to fit the flake.

**Verify**:
`nix develop /home/user/wd/dayzero -c bash -c "java -version && sdkmanager --list_installed"`
shows JDK 21 and platform;android-35.

## phase 2 — add Capacitor to the app

All commands from `app/`, inside the devshell.

1. `npm install @capacitor/core @capacitor/android`
   `npm install -D @capacitor/cli`
2. Create `app/capacitor.config.ts`:

   ```ts
   import type { CapacitorConfig } from '@capacitor/cli';

   const config: CapacitorConfig = {
     appId: 'nl.defekt.dayzero',
     appName: 'dayzero',
     webDir: 'build'
   };

   export default config;
   ```

3. `npx cap add android` — generates `app/android/` (a Gradle project).
   Commit the whole directory; it is source, not build output. Add these
   build-output paths to `app/.gitignore` (they will appear later):

   ```
   android/app/build/
   android/build/
   android/.gradle/
   android/local.properties
   ```

4. Run `npm run build && npx cap sync android` to copy web assets in.

**Verify**: `npx cap doctor` reports no errors for android, and
`app/android/app/src/main/assets/public/index.html` exists after sync.

## phase 3 — first debug APK, baseline smoke test

1. `cd app/android && ./gradlew assembleDebug` (inside the devshell; first
   run downloads Gradle + dependencies, can take many minutes — it is not
   hung; if the sandbox blocks network for Gradle, stop and report).
2. Output lands at
   `app/android/app/build/outputs/apk/debug/app-debug.apk`.

**Verify**: the file exists. Report its path and size to the user for
sideloading — there is no emulator in this environment, so on-device
testing is the user's step. Ask the user to check specifically:
timeline/tags/calendar/map load (OPFS works in the WebView), and that no
`local database failed to open` error appears (that error path was added in
commit a3bb6d3; if it *does* appear, its message text is the diagnosis).

## phase 4 — native geolocation

The web geolocation API does not get a permission prompt inside a plain
Capacitor WebView (Android requires the host app to implement the prompt),
so the location feature must go through the Capacitor plugin on native.

1. `npm install @capacitor/geolocation`, then `npx cap sync android`.
2. Add to `app/android/app/src/main/AndroidManifest.xml` (inside
   `<manifest>`, alongside the existing `INTERNET` permission):

   ```xml
   <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
   <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
   ```

3. In `app/src/lib/ui/EntryEditor.svelte`, `useCurrentLocation()` currently
   uses `navigator.geolocation` with a low-accuracy-first strategy (see
   BUGS.md bug 1). Keep that web path, but branch on native:

   ```ts
   import { Capacitor } from '@capacitor/core';
   // inside useCurrentLocation, before the navigator.geolocation path:
   if (Capacitor.isNativePlatform()) {
     const { Geolocation } = await import('@capacitor/geolocation');
     const position = await Geolocation.getCurrentPosition({ timeout: 30000 });
     // same shape: position.coords.latitude / longitude
   }
   ```

   Use a dynamic import (as shown) so the plugin is not pulled into the
   plain web bundle's critical path. Map plugin errors into the existing
   `locationError` strings (permission denied → 'location permission
   denied', etc.). Match the file's existing code style.

**Verify**: `npm run check` and `npm run lint` pass; rebuild the APK
(phase 3 commands) and hand it to the user to confirm the OS location
permission dialog appears and a location is filled in.

## phase 5 — backup export inside the WebView

`app/src/lib/settings/backup.ts` downloads the sqlite backup via a Blob
object-URL and `<a download>`. Inside a WebView this silently does nothing.

1. `npm install @capacitor/filesystem`, then `npx cap sync android`.
2. In `exportBackup()`, branch on `Capacitor.isNativePlatform()`: on
   native, write the bytes with
   `Filesystem.writeFile({ path, data, directory: Directory.Documents })`
   (base64-encode the bytes; `Filesystem` expects base64 for binary) and
   surface the saved path to the user in the UI. Keep the existing anchor
   download for the web path.
3. Import needs no change: the existing `<input type="file">` opens
   Android's file picker inside the WebView.

**Verify**: `npm run check`, `npm run lint`, `npm test` pass; rebuild APK;
ask the user to confirm export writes a file into Documents and that
importing it back works.

## phase 6 — wrap up

1. Update `PLAN.md`: add the APK packaging as a milestone-10 line (mark
   which parts landed), same style as the existing milestone list.
2. Update `BUGS.md` if the user's on-device tests from phases 3–5 confirmed
   or refuted the OPFS-trigger hypothesis in bug 2 part 2.
3. Final commit per repo convention.

## known pitfalls / notes for the implementer

- **Do not** run `npx cap init` — `capacitor.config.ts` is created by hand
  in phase 2 (init is interactive and adds nothing else needed).
- **Sync server over plain http**: the sync server URL is user-configured
  at runtime (`/settings`). If the user syncs to an `http://` LAN address,
  Android blocks cleartext by default. Only if the user reports sync
  failing in the APK, add `android:usesCleartextTraffic="true"` to the
  `<application>` element in `AndroidManifest.xml`. Do not add it
  preemptively.
- **Service worker**: the PWA service worker (`SvelteKitPWA` in
  `vite.config.ts`) also registers inside the WebView. It is redundant
  there but harmless — leave it alone in this pass.
- **maplibre / pmtiles**: `vite.config.ts` has a middleware forcing the
  `.pmtiles` content-type for the *dev/preview* servers. Capacitor's asset
  server is a different code path; if the map renders blank in the APK but
  works on web, suspect Range-request handling of the bundled `.pmtiles`
  file and report findings rather than patching blind.
- **Gradle wrapper**: `app/android/gradlew` and its
  `gradle/wrapper/*.jar` are part of the generated project — commit them.
- Every `npm run build` must be followed by `npx cap sync android` before
  rebuilding the APK, or the APK ships stale assets.
