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

pub const Change = struct {
    entry_id: []const u8,
    update: []const u8,
};

pub const PulledChange = struct {
    seq: i64,
    entry_id: []const u8,
    update: []const u8,
};

/// appends each change to the updates log in one transaction, assigning each
/// a monotonic seq (sqlite's rowid). order within the batch is preserved.
pub fn pushChanges(conn: zqlite.Conn, changes: []const Change) !void {
    if (changes.len == 0) return;

    try conn.transaction();
    errdefer conn.rollback();
    for (changes) |change| {
        try conn.exec(
            "insert into updates (entry_id, update_) values (?, ?)",
            .{ change.entry_id, zqlite.blob(change.update) },
        );
    }
    try conn.commit();
}

/// all updates with seq > since, oldest first, capped at limit. returned
/// slice and its entry_id/update fields are allocated from `allocator`.
pub fn pullChanges(conn: zqlite.Conn, allocator: std.mem.Allocator, since: i64, limit: i64) ![]PulledChange {
    var rows = try conn.rows(
        "select seq, entry_id, update_ from updates where seq > ? order by seq asc limit ?",
        .{ since, limit },
    );
    defer rows.deinit();

    var out = std.ArrayList(PulledChange).init(allocator);
    while (rows.next()) |row| {
        try out.append(.{
            .seq = row.int(0),
            .entry_id = try allocator.dupe(u8, row.text(1)),
            .update = try allocator.dupe(u8, row.blob(2)),
        });
    }
    if (rows.err) |err| return err;
    return out.toOwnedSlice();
}

/// stores a content-addressed blob. `id` must already be the verified sha256
/// hex of `bytes` (see api.zig) — re-uploading the same id is a harmless
/// no-op, since content-addressed bytes are immutable.
pub fn putBlob(conn: zqlite.Conn, id: []const u8, bytes: []const u8) !void {
    try conn.exec(
        "insert into blobs (id, bytes) values (?, ?) on conflict(id) do nothing",
        .{ id, zqlite.blob(bytes) },
    );
}

/// null if no blob with that id exists. returned slice is allocated from `allocator`.
pub fn getBlob(conn: zqlite.Conn, allocator: std.mem.Allocator, id: []const u8) !?[]const u8 {
    const maybe_row = try conn.row("select bytes from blobs where id = ?", .{id});
    if (maybe_row) |row| {
        defer row.deinit();
        return try allocator.dupe(u8, row.blob(0));
    }
    return null;
}

test "pushChanges then pullChanges round-trips in order" {
    const conn = try open(":memory:");
    defer conn.close();

    try pushChanges(conn, &.{
        .{ .entry_id = "a", .update = "one" },
        .{ .entry_id = "b", .update = "two" },
    });

    const changes = try pullChanges(conn, std.testing.allocator, 0, 100);
    defer {
        for (changes) |c| {
            std.testing.allocator.free(c.entry_id);
            std.testing.allocator.free(c.update);
        }
        std.testing.allocator.free(changes);
    }

    try std.testing.expectEqual(@as(usize, 2), changes.len);
    try std.testing.expectEqual(@as(i64, 1), changes[0].seq);
    try std.testing.expectEqualStrings("a", changes[0].entry_id);
    try std.testing.expectEqualStrings("one", changes[0].update);
    try std.testing.expectEqual(@as(i64, 2), changes[1].seq);
    try std.testing.expectEqualStrings("b", changes[1].entry_id);
    try std.testing.expectEqualStrings("two", changes[1].update);
}

test "pullChanges only returns seq greater than since" {
    const conn = try open(":memory:");
    defer conn.close();

    try pushChanges(conn, &.{
        .{ .entry_id = "a", .update = "one" },
        .{ .entry_id = "b", .update = "two" },
        .{ .entry_id = "c", .update = "three" },
    });

    const changes = try pullChanges(conn, std.testing.allocator, 1, 100);
    defer {
        for (changes) |c| {
            std.testing.allocator.free(c.entry_id);
            std.testing.allocator.free(c.update);
        }
        std.testing.allocator.free(changes);
    }

    try std.testing.expectEqual(@as(usize, 2), changes.len);
    try std.testing.expectEqual(@as(i64, 2), changes[0].seq);
    try std.testing.expectEqual(@as(i64, 3), changes[1].seq);
}

test "pullChanges respects limit" {
    const conn = try open(":memory:");
    defer conn.close();

    try pushChanges(conn, &.{
        .{ .entry_id = "a", .update = "one" },
        .{ .entry_id = "b", .update = "two" },
        .{ .entry_id = "c", .update = "three" },
    });

    const changes = try pullChanges(conn, std.testing.allocator, 0, 2);
    defer {
        for (changes) |c| {
            std.testing.allocator.free(c.entry_id);
            std.testing.allocator.free(c.update);
        }
        std.testing.allocator.free(changes);
    }

    try std.testing.expectEqual(@as(usize, 2), changes.len);
}

test "putBlob then getBlob round-trips bytes" {
    const conn = try open(":memory:");
    defer conn.close();

    try putBlob(conn, "deadbeef", "hello world");

    const bytes = try getBlob(conn, std.testing.allocator, "deadbeef");
    defer if (bytes) |b| std.testing.allocator.free(b);

    try std.testing.expect(bytes != null);
    try std.testing.expectEqualStrings("hello world", bytes.?);
}

test "getBlob returns null for unknown id" {
    const conn = try open(":memory:");
    defer conn.close();

    const bytes = try getBlob(conn, std.testing.allocator, "unknown");
    try std.testing.expectEqual(@as(?[]const u8, null), bytes);
}

test "putBlob is a no-op when the id already exists" {
    const conn = try open(":memory:");
    defer conn.close();

    try putBlob(conn, "deadbeef", "hello world");
    try putBlob(conn, "deadbeef", "hello world");

    const bytes = try getBlob(conn, std.testing.allocator, "deadbeef");
    defer if (bytes) |b| std.testing.allocator.free(b);
    try std.testing.expectEqualStrings("hello world", bytes.?);
}
