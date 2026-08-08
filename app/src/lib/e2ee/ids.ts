// well-known id for the E2EE bootstrap doc. kept in a leaf module (no
// imports) so entries/store.ts, the sync engine, and the settings ui can all
// depend on it without cycles — mirrors diaries/ids.ts.

/** reserved doc id for the E2EE bootstrap Y.Doc in the sync log (PBKDF2
 * salt/iterations + an AES-GCM verifier) — always plaintext, even once
 * every other synced doc and photo is encrypted. can't collide with entry
 * ids (uuidv7s) or `_diaries`. */
export const E2EE_META_DOC_ID = '_e2ee_meta';
