# scripts

## build-apk.sh

Builds a debug Android APK: production web build, `npx cap sync android`,
then `./gradlew assembleDebug`. See `APK-PLAN.md` for how the Android
project (`app/android/`) was set up.

```sh
nix develop -c scripts/build-apk.sh
```

Output lands at `app/android/app/build/outputs/apk/debug/app-debug.apk` —
sideload it to test on-device. Requires `node`, the Android SDK, and
JDK 21, all provided by the nix devshell (`flake.nix`); `app/node_modules`
must already be installed (`npm install` in `app/`, first time only).

## build-basemap.sh

Rebuilds `app/static/basemap.pmtiles`, the offline vector basemap bundled
with the app (country borders + the top 50,000 cities by population — see
PLAN.md "map"). It's checked into the repo like the vendored sqlite
amalgamation in `server/lib/`, so this script only needs to run when the
source data should be refreshed, not as part of every build.

```sh
nix develop -c scripts/build-basemap.sh
```

It downloads two public datasets, trims them down, and tiles them with
tippecanoe:

- [Natural Earth](https://www.naturalearthdata.com/) 1:110m admin-0
  countries (public domain), via the
  [nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
  GeoJSON mirror
- [GeoNames](https://www.geonames.org/) `cities5000` dump (CC BY 4.0,
  credited in `/settings`), filtered to the top 50,000 rows by population

Requires `node`, `tippecanoe`, and `pmtiles` — all provided by the nix
devshell (`flake.nix`).

City labels are drawn from GeoNames' `asciiname` field (not the native
name), so the map only ever needs a plain ASCII/Latin-1 glyph range — see
`build-glyphs.sh` below.

### deploying `basemap.pmtiles`

Whatever serves the built app in production must send `basemap.pmtiles`
with an explicit `Content-Type` (e.g. `application/octet-stream`) and must
not gzip/brotli its `Range` responses — the file is unregistered in most
mime databases, so servers that guess a compressible default (like
`text/plain`) for unknown extensions will corrupt byte-range reads (the
`pmtiles` JS library reads the archive via HTTP Range requests). `vite dev`
and `vite preview` already handle this (see `pmtilesContentType` in
`app/vite.config.ts`); a real host needs the equivalent.

## build-glyphs.sh

Rebuilds `app/static/glyphs/dejavu-sans/0-255.pbf`, the offline SDF glyph
range MapLibre needs to render the map's city name labels (any `symbol`
layer `text-field` requires pre-rendered glyph `.pbf` files — there's no
client-side text rasterization fallback). Checked into the repo like
`basemap.pmtiles`; only needs to run when the font or codepoint range
changes.

```sh
nix develop -c scripts/build-glyphs.sh
```

It renders codepoints 0-255 (ASCII + Latin-1) of DejaVu Sans (the
`dejavu_fonts` nix package) using `fontnik`, the same tool
[openmaptiles/fonts](https://github.com/openmaptiles/fonts) uses to
generate glyph sets. `fontnik` is a native addon, not a real app
dependency — the script `npm install --no-save`s it into `app/` and prunes
it again when done. Since city labels use GeoNames' `asciiname` field (see
`build-basemap.sh` above), this single range is all the map will ever
request.

Requires `node` and `dejavu_fonts` — provided by the nix devshell
(`flake.nix`).

## invite-user.sh

Computes a new user's per-user bearer token for the sync server's
multi-tenant auth (see `docs/protocol.md` "auth") — `hex(HMAC-SHA256(key =
DAYZERO_AUTH_TOKEN, message = username))`. Stateless: nothing is written
anywhere, and there's no revocation mechanism short of rotating
`DAYZERO_AUTH_TOKEN` (which invalidates every existing user's token).

```sh
DAYZERO_AUTH_TOKEN=your-server-secret nix develop -c scripts/invite-user.sh alice
```

Requires `openssl` (provided by the nix devshell, `flake.nix`).
