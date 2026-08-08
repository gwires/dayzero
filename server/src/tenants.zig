const std = @import("std");
const zqlite = @import("zqlite");

const db = @import("db.zig");

/// see docs/protocol.md "auth" for the full multi-tenant design.
pub const max_username_len = 32;

/// literal `/api/...` path segments that must never be accepted as a
/// username: httpz's router matches a literal child before trying the
/// `:username` param sibling at the same trie depth, with no backtracking —
/// a real user with this name would get inexplicable 404s on every one of
/// their own routes (e.g. `/api/health/changes` descends into the literal
/// `health` leaf, finds no `changes` child under it, and 404s rather than
/// falling back to treating `health` as `:username`). `health` is the only
/// one today (see `registerRoutes` in api.zig) — add to this list if a new
/// literal `/api/...` route is ever introduced.
const reserved_usernames = [_][]const u8{"health"};

pub const ValidateError = error{ TooShort, TooLong, InvalidChar, Reserved };

/// validates `username` against the filesystem-safe charset used both as a
/// sqlite filename component and as the HMAC message in
/// `api.zig`'s `deriveUserToken` — lowercase ascii letters, digits,
/// underscore, hyphen; 1-32 bytes. Deliberately rejects anything outside
/// this set (including uppercase) rather than normalizing it: the HMAC must
/// be computed over one unambiguous canonical byte string on both the
/// server and `scripts/invite-user.sh`, and requiring the canonical form up
/// front removes any chance the two disagree about what "normalized" means.
/// This also directly prevents path traversal (`/`, `..`, null bytes are
/// all outside the charset).
pub fn validateUsername(username: []const u8) ValidateError!void {
    if (username.len == 0) return error.TooShort;
    if (username.len > max_username_len) return error.TooLong;
    for (username) |ch| {
        switch (ch) {
            'a'...'z', '0'...'9', '_', '-' => {},
            else => return error.InvalidChar,
        }
    }
    for (reserved_usernames) |reserved| {
        if (std.mem.eql(u8, username, reserved)) return error.Reserved;
    }
}

/// one sqlite connection per tenant (`<db_dir>/<username>.sqlite`), opened
/// lazily on first access and cached for the rest of the process's
/// lifetime. `getOrOpen` is safe to call concurrently from httpz's worker
/// threads: `mutex` serializes map access (including the lazy open itself —
/// opening happens at most once per unique username ever, for an
/// admin-invited-only user base, so brief one-time contention on someone's
/// very first request is an acceptable cost against the complexity of an
/// unlock/reacquire/re-check pattern to avoid it); each returned
/// `zqlite.Conn` is then safe to use lock-free from multiple threads, since
/// sqlite is compiled `-DSQLITE_THREADSAFE=1` ("serialized" mode — see
/// server/build.zig and db.zig).
pub const TenantStore = struct {
    allocator: std.mem.Allocator,
    db_dir: []const u8,
    mutex: std.Thread.Mutex = .{},
    conns: std.StringHashMap(zqlite.Conn),

    pub fn init(allocator: std.mem.Allocator, db_dir: []const u8) TenantStore {
        return .{
            .allocator = allocator,
            .db_dir = db_dir,
            .conns = std.StringHashMap(zqlite.Conn).init(allocator),
        };
    }

    /// closes every open per-tenant connection. Only safe to call once all
    /// requests have finished (see main.zig's `defer` ordering) — not
    /// guarded by `mutex` itself, since nothing should still be calling
    /// `getOrOpen` concurrently at that point.
    pub fn deinit(self: *TenantStore) void {
        var it = self.conns.iterator();
        while (it.next()) |entry| {
            entry.value_ptr.close();
            self.allocator.free(entry.key_ptr.*);
        }
        self.conns.deinit();
    }

    /// returns the (lazily opened, cached) connection for `username`. The
    /// caller must already have validated `username` via `validateUsername`
    /// — this function trusts it enough to build a filesystem path from it.
    pub fn getOrOpen(self: *TenantStore, username: []const u8) !zqlite.Conn {
        self.mutex.lock();
        defer self.mutex.unlock();

        if (self.conns.get(username)) |conn| return conn;

        const path = try std.fmt.allocPrintZ(self.allocator, "{s}/{s}.sqlite", .{ self.db_dir, username });
        defer self.allocator.free(path);

        const conn = try db.open(path);
        errdefer conn.close();

        const key = try self.allocator.dupe(u8, username);
        errdefer self.allocator.free(key);
        try self.conns.put(key, conn);

        return conn;
    }
};

test "validateUsername accepts a plain lowercase username" {
    try validateUsername("alice");
    try validateUsername("a");
    try validateUsername("a" ** max_username_len);
    try validateUsername("user_2-name");
}

test "validateUsername rejects empty and over-length usernames" {
    try std.testing.expectError(error.TooShort, validateUsername(""));
    try std.testing.expectError(error.TooLong, validateUsername("a" ** (max_username_len + 1)));
}

test "validateUsername rejects characters outside [a-z0-9_-]" {
    try std.testing.expectError(error.InvalidChar, validateUsername("Alice"));
    try std.testing.expectError(error.InvalidChar, validateUsername("alice!"));
    try std.testing.expectError(error.InvalidChar, validateUsername("../etc"));
    try std.testing.expectError(error.InvalidChar, validateUsername("a/b"));
    try std.testing.expectError(error.InvalidChar, validateUsername("a b"));
}

test "validateUsername rejects reserved words" {
    try std.testing.expectError(error.Reserved, validateUsername("health"));
}

test "TenantStore.getOrOpen lazily creates and caches a per-username db file" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir_path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(dir_path);

    var store = TenantStore.init(std.testing.allocator, dir_path);
    defer store.deinit();

    const conn1 = try store.getOrOpen("alice");
    try db.pushChanges(conn1, &.{.{ .entry_id = "e", .update = "hi" }});

    // second call for the same username returns the same underlying
    // connection (proven by seeing the write above without re-pushing).
    const conn2 = try store.getOrOpen("alice");
    const changes = try db.pullChanges(conn2, std.testing.allocator, 0, 10);
    defer {
        for (changes) |c| {
            std.testing.allocator.free(c.entry_id);
            std.testing.allocator.free(c.update);
        }
        std.testing.allocator.free(changes);
    }
    try std.testing.expectEqual(@as(usize, 1), changes.len);

    // the file actually landed on disk at <dir>/alice.sqlite.
    try tmp.dir.access("alice.sqlite", .{});
}

test "TenantStore.getOrOpen isolates different usernames" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir_path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(dir_path);

    var store = TenantStore.init(std.testing.allocator, dir_path);
    defer store.deinit();

    const alice = try store.getOrOpen("alice");
    try db.pushChanges(alice, &.{.{ .entry_id = "e", .update = "alice's data" }});

    const bob = try store.getOrOpen("bob");
    const bob_changes = try db.pullChanges(bob, std.testing.allocator, 0, 10);
    defer std.testing.allocator.free(bob_changes);
    try std.testing.expectEqual(@as(usize, 0), bob_changes.len);
}
