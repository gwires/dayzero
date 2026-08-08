# secure storage investigation

Written while designing end-to-end encryption (see the E2EE implementation
plan). Two related "how securely can we store this locally" questions came up
along the way and were investigated in depth before being decided one way or
the other:

1. **whole-database at-rest encryption** — instead of encrypting CRDT
   updates/photos at the application level, could the local sqlite file
   itself be transparently encrypted (à la SQLCipher), so every existing
   query (search, calendar, tags, streak, map, photos) keeps working
   unmodified?
2. **secure storage of the derived encryption key** — once E2EE is
   mandatory, a session key has to survive app restarts without re-prompting
   for the passphrase every time. How much better than "a plaintext row in
   `sync_state`" can we realistically do, per platform?

Both are written up below with the options considered, what was found, and a
tradeoff table. Neither conclusion is locked in by this document alone — it's
a record of the investigation, referenced by the E2EE plan.

## part 1: whole-database at-rest encryption

Today, `app/src/lib/db/worker.ts` opens the local database via the official
`@sqlite.org/sqlite-wasm` package's `installOpfsSAHPoolVfs`, unencrypted —
local OPFS/sqlite storage is the app's existing trust boundary, same as any
local-first app.

### options considered

**SQLite Encryption Extension (SEE)** — SQLite's own official encryption
extension. Ruled out immediately: it's a paid, closed-source extension from
the SQLite Consortium, and even its own documentation notes there's no
reliable way to hide a SEE key from JavaScript running in the same page (the
key has to be supplied by the app at open time, in cleartext, every time) —
a poor fit for a self-hosted, dependency-light personal project.

**SQLite3 Multiple Ciphers** (`utelle/SQLite3MultipleCiphers`, the actively
maintained open successor to SQLCipher) — this looked promising at first
glance:
- **License**: MIT, fully open source, no paid tiers for any cipher
  (unlike SQLCipher proper, which has commercial licensing options). Actively
  maintained (v2.5.0 as of August 2026, healthy commit history).
- Search results surfaced an `opfs-encrypted` VFS name and mentions of WASM
  support, which read as "just swap the engine."

Digging past the marketing-level search snippets changed the picture:
- **No official WASM/OPFS documentation exists on the project's own docs
  site.** The docs cover desktop/server SQLite encryption; WASM isn't a
  documented target at all.
- The only WASM support comes from a community PR (#88), and the tracking
  issue for "how do I compile this for WASM?" (#129) shows real friction:
  compile errors (`nTableLock` missing from the generated `Parse` struct) and
  linker failures (missing `SecRandomCopyBytes`/`kSecRandomDefault` symbols
  under Emscripten on macOS). The issue is closed, meaning someone eventually
  got past it, but there's no clean documented path from the project itself.
- The one real-world example found, `evoluhq/sqlite-wasm-cipher-old`, is
  literally named "old" with no explanation of what superseded it, and its
  README carries a "please don't file issues" disclaimer about how it wraps
  the official build — the signature of a scrappy patch someone needed for
  their own project, not a maintained integration others can safely depend
  on.
- Nothing confirms compatibility with this app's specific VFS
  (`installOpfsSAHPoolVfs`) or with the Capacitor Android WebView — both
  would need first-hand verification, not just reading docs.

### why this was rejected for v1

Taking this path means depending on an unmaintained-looking fork, or
becoming the one who fixes SQLite3MultipleCiphers' WASM build — a second
fragile native/WASM toolchain to maintain, layered on top of the APK build
environment's already-documented quirks (aarch64 sandbox needing a patched
`aapt2`, disk filling fast). The likely engineering cost of chasing this
route looked larger and more open-ended than the bounded, well-understood
application-level diff (encrypt CRDT updates, photos, and locally-materialized
data individually, using the Web Crypto primitives already needed for sync
regardless). **Decision: stay on the official `@sqlite.org/sqlite-wasm`
package; do encryption at the application level, not the storage-engine
level.**

### tradeoffs

| approach | what it protects | app code impact | new dependency risk | verdict |
|---|---|---|---|---|
| do nothing (today) | nothing at rest | none | none | baseline |
| SQLite SEE | whole db file | none (transparent) | paid, closed-source, key still has to live in JS at open time | ruled out |
| SQLite3 Multiple Ciphers + OPFS | whole db file, transparently — search/calendar/tags/streak/map/photos all keep working unmodified | none (transparent) | **high** — undocumented WASM path, community-fork-only precedent, unverified OPFS-SAHPool/Capacitor compatibility | rejected for v1 |
| application-level (chosen) | CRDT updates, photos, materialized data — each encrypted individually | large — touches `entries/store.ts`'s whole query surface, needs an in-memory index + encrypted FTS blob | none — reuses Web Crypto, already required for sync | **chosen** |

## part 2: secure storage of the derived encryption key

Once a passphrase is entered and verified, the derived AES-256 key needs to
persist across app restarts — otherwise every reload prompts for the
passphrase again, which is a bigger UX regression than E2EE is worth. The
baseline design (from the E2EE plan) persists the exported raw key bytes,
base64-encoded, as a row in `sync_state` — **the same trust model this app
already uses for the plaintext-stored sync bearer token.**

The question: given dayzero ships to two real targets (a plain browser/PWA,
and Android via Capacitor 8 — no iOS package is installed today), how much
better than that baseline can each realistically do?

### threat model note

A plaintext `sync_state` row protects against nothing beyond normal OS file
permissions and browser-origin sandboxing — anyone who can read the app's
local storage (a stolen unlocked device, another process with filesystem
access, a backup extraction tool) gets the key outright. The options below
raise that bar by different amounts and against different attackers; none of
them are absolute, and that's called out per-option below rather than
oversold.

### android (via capacitor)

Real, usable options exist here, since Capacitor bridges to native code:

- **`aparajita/capacitor-secure-storage`** (MIT, actively maintained, `198`
  commits, explicitly documented as Capacitor-8-compatible). Generates its
  wrapping key **inside the Android Keystore** (hardware-backed on most
  devices) and uses it to AES-GCM encrypt whatever value the app hands it,
  before persisting the ciphertext in SharedPreferences. The key material we
  care about (the derived E2EE key, exported as base64) never touches disk
  unwrapped. No mandatory biometric gate in the free tier — Keystore
  protection is "this app's data is separate from other apps'/root
  extraction," not "the user must scan a fingerprint every time."
- **Capawesome's Vault plugin** — same Keystore/Keychain backing, plus a
  built-in biometric/passcode unlock ceremony (fingerprint/face/device
  passcode) gating access to the vault. Nicer security UX, but **paid**
  (subscription, "Capawesome Insiders" tier) and proprietary — a poor fit
  for a self-hosted, dependency-light personal project unless premium
  polish is specifically wanted.
- **`@capgo/capacitor-native-biometric`** — similar Keystore/Keychain
  backing with biometric support, another viable free alternative, less
  deeply investigated than the above two.

### browser / PWA (non-Capacitor)

There is **no way to reach an OS-level keychain (macOS Keychain, Windows
Credential Manager, GNOME Keyring) from web JavaScript at all** — it's
simply not exposed to pages, regardless of library choice. The ceiling of
what's achievable in a pure browser context:

- Generate the derived key as a **non-extractable** `CryptoKey`
  (`extractable: false`), then persist the `CryptoKey` **object itself**
  (not its bytes) via `IndexedDB` — browsers support structured-cloning
  `CryptoKey` objects into IndexedDB. Once non-extractable,
  `crypto.subtle.exportKey()` permanently throws on that key — there is no
  way to ever pull the raw bytes back out via JS, from this session or any
  future one.
- What this protects against: copying the key off the device for offline
  reuse, or reading it out of an IndexedDB file via disk forensics.
- What it does **not** protect against: malicious JS running live in the
  same origin (e.g. an XSS payload) — that code can still call
  `crypto.subtle.decrypt()` using the key while the page is open, same as
  any other same-origin script could touch app data today. It's a real but
  narrower guarantee than Android Keystore's.
- **Architectural wrinkle**: a non-extractable key can never be exported to
  base64, so this can't reuse the same `exportKeyMaterial`/`sync_state`
  interchange the Android path (and the do-nothing baseline) use — it needs
  its own IndexedDB-based persistence function, not a shared one.

### tradeoffs

| option | platform | protects against | doesn't protect against | dependency | cost |
|---|---|---|---|---|---|
| plaintext `sync_state` row (baseline) | both | nothing beyond OS file/origin sandboxing | everything else | none | none — already the design |
| `capacitor-secure-storage` (Keystore) | android only | disk extraction, other apps, root-level file reads | live compromise of this app's own process | new, free, MIT | one plugin + one platform-specific code path |
| Capawesome Vault (Keystore + biometric) | android only | same as above, plus requires a fingerprint/passcode prompt to unlock | live compromise of this app's own process | new, **paid** | subscription cost, proprietary |
| non-extractable `CryptoKey` + IndexedDB | browser/PWA only | key exfiltration/offline reuse, disk forensics | malicious JS live in the same origin | none (native Web Crypto/IndexedDB) | separate persistence code path, incompatible with the base64 interchange used elsewhere |

### decision

**Deferred for v1.** Ship the plaintext-`sync_state` baseline on every
platform, matching today's bearer-token precedent — no new native
dependency, no platform-specific persistence code. Revisit Android Keystore
hardening (`aparajita/capacitor-secure-storage`) as a follow-up if it turns
out to matter in practice. See the E2EE implementation plan.

## part 3: how far "no plaintext stored" should reach

The single biggest driver of this feature's size turned out not to be the
sync-facing encryption (CRDT updates + photos, the original ask) — it's
**whether "no plaintext stored" also applies to local on-device storage**,
not just to what's sent to the server. That one boundary decision determines
whether `entries/store.ts`'s entire SQL-backed query surface (search,
calendar, tags, on-this-day, streak, map, photo gallery) needs to be rebuilt,
or can stay untouched.

### why local-at-rest scope, not search, is the real lever

It's tempting to think dropping full-text search is the way to shrink this
design, since search is what forced the encrypted-FTS5-index subsystem
(a second in-memory sqlite connection, incremental index maintenance,
debounced re-encrypt-to-disk, decrypt-on-query). That subsystem is real and
is the single most novel, least-precedented piece of the whole design — but
it's also the *smallest* of the three things "no local plaintext" forces:

1. an in-memory materialized index replacing SQL columns for calendar/tags/
   on-this-day/streak/map/photos — needed regardless of whether search
   exists, since none of those are full-text search but all currently read
   plaintext materialized columns
2. the encrypted FTS5 subsystem, specifically for markdown search — this is
   the part dropping search actually removes
3. a mandatory passphrase before *any* local app usage, sync configured or
   not — because a session key must exist before the first entry can be
   written to (encrypted) local storage at all

Dropping search removes only (2). (1) and (3) both stem directly from the
"no plaintext, period" boundary, not from search, and remain exactly as
large either way.

### three scope options and their actual size

| scope | what stays plaintext locally | passphrase timing | new subsystems required | `entries/store.ts` impact |
|---|---|---|---|---|
| **sync-only** (original proposal) — encrypt only what leaves the device (CRDT updates + photos over the wire); local sqlite remains the existing trust boundary, unencrypted, same as today | everything local: markdown, dates, tags, locations, photo bytes, search index | only when sync is configured — local-only usage needs no passphrase at all | none — reuses the sync/engine.ts integration point already designed for the core ask | **none** — search, calendar, tags, streak, map, photos all keep working completely unchanged |
| **no local plaintext, search dropped** | nothing | before the first entry can ever be written, regardless of sync | in-memory materialized index (calendar/tags/streak/map/photos) | large — every SQL-backed listing/filter function rewritten as JS over in-memory decrypted state; markdown search feature removed entirely |
| **no local plaintext, search kept** (current design) | nothing | before the first entry can ever be written, regardless of sync | in-memory materialized index **+** encrypted FTS5-index subsystem | largest — everything above, plus a second sqlite connection, incremental index maintenance, and its own encrypt/decrypt lifecycle |

### decision

**Sync-only.** Encrypt only what leaves the device — CRDT updates and photo
blobs. Local SQLite/OPFS storage stays exactly as it is today: unencrypted,
with `entries/store.ts`'s full SQL-backed query surface (search, calendar,
tags, on-this-day, streak, map, photo gallery) completely untouched. No
in-memory materialized index, no encrypted FTS5 subsystem, and no mandatory
passphrase for local-only usage — a passphrase is only required once sync is
configured. See the E2EE implementation plan for the resulting design.
