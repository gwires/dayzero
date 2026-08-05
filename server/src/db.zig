const std = @import("std");
const zqlite = @import("zqlite");

/// per-entry append-only log of yjs updates, plus content-addressed attachment blobs.
/// see docs/protocol.md.
const schema =
    \\create table if not exists updates (
    \\  seq integer primary key autoincrement,
    \\  entry_id text not null,
    \\  update_ blob not null,
    \\  received_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    \\);
    \\create index if not exists updates_entry_id on updates(entry_id);
    \\create table if not exists blobs (
    \\  id text primary key,
    \\  bytes blob not null
    \\);
;

pub fn open(path: [:0]const u8) !zqlite.Conn {
    const flags = zqlite.OpenFlags.Create | zqlite.OpenFlags.ReadWrite | zqlite.OpenFlags.EXResCode;
    const conn = try zqlite.open(path, flags);
    errdefer conn.close();

    try conn.execNoArgs("pragma journal_mode=WAL");
    try conn.execNoArgs(schema);

    return conn;
}
