#!/usr/bin/env sh
# Copies the sqlite-wasm runtime files from app/node_modules into
# spike/www/sqlite/. Run once before the spike (and again after bumping
# @sqlite.org/sqlite-wasm).
set -e
cd "$(dirname "$0")"
src=../../app/node_modules/@sqlite.org/sqlite-wasm/dist
for f in index.mjs sqlite3.wasm sqlite3-worker1.mjs sqlite3-opfs-async-proxy.js; do
	cp "$src/$f" www/sqlite/
done
echo "copied sqlite-wasm files into spike/www/sqlite/"
