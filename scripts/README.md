# scripts

## build-basemap.sh

Rebuilds `app/static/basemap.pmtiles`, the offline vector basemap bundled
with the app (country borders + the top 10,000 cities by population — see
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
- [GeoNames](https://www.geonames.org/) `cities15000` dump (CC BY 4.0,
  credited in `/settings`), filtered to the top 10,000 rows by population

Requires `node`, `tippecanoe`, and `pmtiles` — all provided by the nix
devshell (`flake.nix`).

### deploying `basemap.pmtiles`

Whatever serves the built app in production must send `basemap.pmtiles`
with an explicit `Content-Type` (e.g. `application/octet-stream`) and must
not gzip/brotli its `Range` responses — the file is unregistered in most
mime databases, so servers that guess a compressible default (like
`text/plain`) for unknown extensions will corrupt byte-range reads (the
`pmtiles` JS library reads the archive via HTTP Range requests). `vite dev`
and `vite preview` already handle this (see `pmtilesContentType` in
`app/vite.config.ts`); a real host needs the equivalent.
