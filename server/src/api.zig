const std = @import("std");
const httpz = @import("httpz");
const zqlite = @import("zqlite");

const db = @import("db.zig");
const tenants = @import("tenants.zig");

/// default/max page size for GET /api/changes, so a client that's very far
/// behind can't force one huge response.
const default_pull_limit: i64 = 500;
const max_pull_limit: i64 = 2000;

pub const Handler = struct {
    tenants: *tenants.TenantStore,
    auth_token: []const u8,

    pub fn uncaughtError(_: *Handler, req: *httpz.Request, res: *httpz.Response, err: anyerror) void {
        std.log.err("uncaught error at {s}: {}", .{ req.url.path, err });
        res.status = 500;
        try_json(res, .{ .@"error" = "internal_error" });
    }

    pub fn notFound(_: *Handler, _: *httpz.Request, res: *httpz.Response) !void {
        res.status = 404;
        try res.json(.{ .@"error" = "not_found" }, .{});
    }
};

fn try_json(res: *httpz.Response, value: anytype) void {
    res.json(value, .{}) catch {};
}

pub fn registerRoutes(router: anytype) void {
    router.get("/api/health", health, .{});
    router.post("/api/:username/changes", pushChanges, .{});
    router.get("/api/:username/changes", pullChanges, .{});
    router.put("/api/:username/blobs/:id", putBlob, .{});
    router.get("/api/:username/blobs/:id", getBlob, .{});
}

fn health(_: *Handler, _: *httpz.Request, res: *httpz.Response) !void {
    res.status = 200;
    try res.json(.{ .status = "ok" }, .{});
}

/// extracts and validates the `:username` route param, writing a 400
/// response and returning null if it's invalid — callers should return
/// immediately when null, exactly like `requireAuth`. See
/// tenants.zig's `validateUsername` for the exact rules.
fn requireUsername(req: *httpz.Request, res: *httpz.Response) ?[]const u8 {
    const username = req.param("username").?; // route can't match without it
    tenants.validateUsername(username) catch {
        res.status = 400;
        try_json(res, .{ .@"error" = "invalid_username" });
        return null;
    };
    return username;
}

/// derives this username's bearer token: hex(HMAC-SHA256(key =
/// DAYZERO_AUTH_TOKEN, message = username)). Stateless — no per-user secret
/// is stored server-side; scripts/invite-user.sh computes the identical
/// value from the same server token to hand to a new user. See
/// docs/protocol.md "auth". Known-answer vector (used in the test below):
/// deriveUserToken("alice", "secret") ==
/// "4360c67bc81025114044578d7c4e8e0f02fd0cae99f22d603390e8f9dc9888f8".
fn deriveUserToken(username: []const u8, server_token: []const u8) [64]u8 {
    var mac: [32]u8 = undefined;
    std.crypto.auth.hmac.sha2.HmacSha256.create(&mac, username, server_token);
    return std.fmt.bytesToHex(mac, .lower);
}

/// bearer-token auth: the header must carry `hex(HMAC-SHA256(key = server's
/// DAYZERO_AUTH_TOKEN, message = username))` — a per-user token derived
/// deterministically, never the raw server token itself (see
/// docs/protocol.md "auth"). writes a 401 response and returns false if the
/// request isn't authorized; callers should return immediately when false.
fn requireAuth(h: *Handler, username: []const u8, req: *httpz.Request, res: *httpz.Response) bool {
    const header_value = req.header("authorization") orelse {
        unauthorized(res);
        return false;
    };
    const prefix = "Bearer ";
    if (!std.mem.startsWith(u8, header_value, prefix)) {
        unauthorized(res);
        return false;
    }
    const expected = deriveUserToken(username, h.auth_token);
    if (!constantTimeEql(header_value[prefix.len..], &expected)) {
        unauthorized(res);
        return false;
    }
    return true;
}

fn unauthorized(res: *httpz.Response) void {
    res.status = 401;
    try_json(res, .{ .@"error" = "unauthorized" });
}

/// constant-time-ish comparison for secrets: the length check is not
/// constant-time (length isn't secret), but the byte comparison doesn't
/// short-circuit on the first mismatch.
fn constantTimeEql(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    var diff: u8 = 0;
    for (a, 0..) |byte, i| diff |= byte ^ b[i];
    return diff == 0;
}

const PushChange = struct {
    entry_id: []const u8,
    /// base64-encoded yjs update bytes — JSON has no binary type.
    update: []const u8,
};

const PushRequest = struct {
    changes: []const PushChange,
};

fn pushChanges(h: *Handler, req: *httpz.Request, res: *httpz.Response) !void {
    const username = requireUsername(req, res) orelse return;
    if (!requireAuth(h, username, req, res)) return;
    const conn = try h.tenants.getOrOpen(username);

    const parsed = req.json(PushRequest) catch {
        res.status = 400;
        return try res.json(.{ .@"error" = "invalid_json" }, .{});
    };
    const body = parsed orelse {
        res.status = 400;
        return try res.json(.{ .@"error" = "missing_body" }, .{});
    };

    const changes = try req.arena.alloc(db.Change, body.changes.len);
    for (body.changes, 0..) |c, i| {
        const decoded_len = std.base64.standard.Decoder.calcSizeForSlice(c.update) catch {
            res.status = 400;
            return try res.json(.{ .@"error" = "invalid_update_encoding" }, .{});
        };
        const decoded = try req.arena.alloc(u8, decoded_len);
        std.base64.standard.Decoder.decode(decoded, c.update) catch {
            res.status = 400;
            return try res.json(.{ .@"error" = "invalid_update_encoding" }, .{});
        };
        changes[i] = .{ .entry_id = c.entry_id, .update = decoded };
    }

    try db.pushChanges(conn, changes);

    res.status = 200;
    try res.json(.{ .status = "ok", .count = changes.len }, .{});
}

const PulledChangeJson = struct {
    seq: i64,
    entry_id: []const u8,
    /// base64-encoded yjs update bytes.
    update: []const u8,
};

fn pullChanges(h: *Handler, req: *httpz.Request, res: *httpz.Response) !void {
    const username = requireUsername(req, res) orelse return;
    if (!requireAuth(h, username, req, res)) return;
    const conn = try h.tenants.getOrOpen(username);

    const query = try req.query();
    const since = queryInt(query, "since", 0);
    const limit = @min(queryInt(query, "limit", default_pull_limit), max_pull_limit);

    const changes = try db.pullChanges(conn, req.arena, since, limit);

    const out = try req.arena.alloc(PulledChangeJson, changes.len);
    var cursor: i64 = since;
    for (changes, 0..) |c, i| {
        const encoded = try req.arena.alloc(u8, std.base64.standard.Encoder.calcSize(c.update.len));
        _ = std.base64.standard.Encoder.encode(encoded, c.update);
        out[i] = .{ .seq = c.seq, .entry_id = c.entry_id, .update = encoded };
        if (c.seq > cursor) cursor = c.seq;
    }

    res.status = 200;
    try res.json(.{ .changes = out, .cursor = cursor }, .{});
}

fn queryInt(query: anytype, name: []const u8, default: i64) i64 {
    const raw = query.get(name) orelse return default;
    return std.fmt.parseInt(i64, raw, 10) catch default;
}

fn putBlob(h: *Handler, req: *httpz.Request, res: *httpz.Response) !void {
    const username = requireUsername(req, res) orelse return;
    if (!requireAuth(h, username, req, res)) return;
    const conn = try h.tenants.getOrOpen(username);

    const id_param = req.param("id").?;
    const id = normalizeHex(req.arena, id_param) catch {
        res.status = 400;
        return try res.json(.{ .@"error" = "invalid_id" }, .{});
    };

    // `id` is a client-chosen opaque identifier, not verified against the
    // body's content hash — the client may be uploading an E2EE envelope
    // (see PLAN.md "encryption"), whose hash can never match a plaintext
    // content-address, and AES-GCM's own auth tag already gives the same
    // integrity guarantee on decrypt. this mirrors how `entry_id` is
    // already treated as fully opaque for CRDT updates.
    const bytes = req.body() orelse "";
    try db.putBlob(conn, id, bytes);

    res.status = 200;
    try res.json(.{ .status = "ok" }, .{});
}

fn getBlob(h: *Handler, req: *httpz.Request, res: *httpz.Response) !void {
    const username = requireUsername(req, res) orelse return;
    if (!requireAuth(h, username, req, res)) return;
    const conn = try h.tenants.getOrOpen(username);

    const id_param = req.param("id").?;
    const id = normalizeHex(req.arena, id_param) catch {
        res.status = 400;
        return try res.json(.{ .@"error" = "invalid_id" }, .{});
    };

    const bytes = try db.getBlob(conn, req.arena, id) orelse {
        res.status = 404;
        return try res.json(.{ .@"error" = "not_found" }, .{});
    };

    res.status = 200;
    res.content_type = .BINARY;
    res.body = bytes;
}

fn sha256Hex(bytes: []const u8) [64]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

/// lowercases and validates a sha256 hex string (64 hex chars).
fn normalizeHex(allocator: std.mem.Allocator, id: []const u8) ![]const u8 {
    if (id.len != 64) return error.InvalidId;
    const buf = try allocator.alloc(u8, 64);
    for (id, 0..) |ch, i| {
        buf[i] = switch (ch) {
            '0'...'9', 'a'...'f' => ch,
            'A'...'F' => ch + 32,
            else => return error.InvalidId,
        };
    }
    return buf;
}

fn testHandler(store: *tenants.TenantStore) Handler {
    return Handler{ .tenants = store, .auth_token = "secret" };
}

fn testTenantStore(dir_path: []const u8) tenants.TenantStore {
    return tenants.TenantStore.init(std.testing.allocator, dir_path);
}

fn bearerFor(username: []const u8, buf: []u8) ![]const u8 {
    const token = deriveUserToken(username, "secret");
    return std.fmt.bufPrint(buf, "Bearer {s}", .{token});
}

test "deriveUserToken matches a known HMAC-SHA256 test vector" {
    const token = deriveUserToken("alice", "secret");
    try std.testing.expectEqualStrings(
        "4360c67bc81025114044578d7c4e8e0f02fd0cae99f22d603390e8f9dc9888f8",
        &token,
    );
}

test "requireAuth rejects a missing Authorization header" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir_path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(dir_path);
    var store = testTenantStore(dir_path);
    defer store.deinit();
    var handler = testHandler(&store);

    var ht = httpz.testing.init(.{});
    defer ht.deinit();

    try std.testing.expect(!requireAuth(&handler, "alice", ht.req, ht.res));
    try ht.expectStatus(401);
}

test "requireAuth rejects the wrong token" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir_path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(dir_path);
    var store = testTenantStore(dir_path);
    defer store.deinit();
    var handler = testHandler(&store);

    var ht = httpz.testing.init(.{});
    defer ht.deinit();
    ht.header("Authorization", "Bearer wrong");

    try std.testing.expect(!requireAuth(&handler, "alice", ht.req, ht.res));
    try ht.expectStatus(401);
}

test "requireAuth accepts the correctly-derived per-username token" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir_path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(dir_path);
    var store = testTenantStore(dir_path);
    defer store.deinit();
    var handler = testHandler(&store);

    var buf: [64 + "Bearer ".len]u8 = undefined;
    const auth_header = try bearerFor("alice", &buf);

    var ht = httpz.testing.init(.{});
    defer ht.deinit();
    ht.header("Authorization", auth_header);

    try std.testing.expect(requireAuth(&handler, "alice", ht.req, ht.res));
}

test "requireAuth rejects alice's token used for bob's username" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir_path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(dir_path);
    var store = testTenantStore(dir_path);
    defer store.deinit();
    var handler = testHandler(&store);

    var buf: [64 + "Bearer ".len]u8 = undefined;
    const auth_header = try bearerFor("alice", &buf);

    var ht = httpz.testing.init(.{});
    defer ht.deinit();
    ht.header("Authorization", auth_header);

    try std.testing.expect(!requireAuth(&handler, "bob", ht.req, ht.res));
    try ht.expectStatus(401);
}

test "pushChanges then pullChanges via the handlers" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir_path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(dir_path);
    var store = testTenantStore(dir_path);
    defer store.deinit();
    var handler = testHandler(&store);

    var auth_buf: [64 + "Bearer ".len]u8 = undefined;
    const auth_header = try bearerFor("alice", &auth_buf);

    var push_ht = httpz.testing.init(.{});
    defer push_ht.deinit();
    push_ht.param("username", "alice");
    push_ht.header("Authorization", auth_header);

    var update_buf: [8]u8 = undefined;
    const encoded_len = std.base64.standard.Encoder.calcSize("hello".len);
    _ = std.base64.standard.Encoder.encode(update_buf[0..encoded_len], "hello");

    push_ht.json(.{ .changes = &.{
        .{ .entry_id = "entry-1", .update = update_buf[0..encoded_len] },
    } });
    try pushChanges(&handler, push_ht.req, push_ht.res);
    try push_ht.expectStatus(200);

    var pull_ht = httpz.testing.init(.{});
    defer pull_ht.deinit();
    pull_ht.param("username", "alice");
    pull_ht.header("Authorization", auth_header);
    pull_ht.query("since", "0");

    try pullChanges(&handler, pull_ht.req, pull_ht.res);
    try pull_ht.expectStatus(200);

    const json = try pull_ht.getJson();
    const changes = json.object.get("changes").?.array;
    try std.testing.expectEqual(@as(usize, 1), changes.items.len);
    try std.testing.expectEqualStrings("entry-1", changes.items[0].object.get("entry_id").?.string);
    try std.testing.expectEqual(@as(i64, 1), json.object.get("cursor").?.integer);
}

test "pushChanges then pullChanges are isolated per username" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir_path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(dir_path);
    var store = testTenantStore(dir_path);
    defer store.deinit();
    var handler = testHandler(&store);

    // alice pushes a change.
    var alice_buf: [64 + "Bearer ".len]u8 = undefined;
    const alice_auth = try bearerFor("alice", &alice_buf);

    var update_buf: [8]u8 = undefined;
    const encoded_len = std.base64.standard.Encoder.calcSize("hi".len);
    _ = std.base64.standard.Encoder.encode(update_buf[0..encoded_len], "hi");

    var push_ht = httpz.testing.init(.{});
    defer push_ht.deinit();
    push_ht.param("username", "alice");
    push_ht.header("Authorization", alice_auth);
    push_ht.json(.{ .changes = &.{
        .{ .entry_id = "entry-1", .update = update_buf[0..encoded_len] },
    } });
    try pushChanges(&handler, push_ht.req, push_ht.res);
    try push_ht.expectStatus(200);

    // bob (a different, also-valid username) pulls from scratch and sees
    // nothing — proves alice's db and bob's db are genuinely separate
    // files/connections, not just separately-authed views of one db.
    var bob_buf: [64 + "Bearer ".len]u8 = undefined;
    const bob_auth = try bearerFor("bob", &bob_buf);

    var pull_ht = httpz.testing.init(.{});
    defer pull_ht.deinit();
    pull_ht.param("username", "bob");
    pull_ht.header("Authorization", bob_auth);
    pull_ht.query("since", "0");
    try pullChanges(&handler, pull_ht.req, pull_ht.res);
    try pull_ht.expectStatus(200);
    const json = try pull_ht.getJson();
    try std.testing.expectEqual(@as(usize, 0), json.object.get("changes").?.array.items.len);
}

test "pushChanges rejects a reserved username" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir_path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(dir_path);
    var store = testTenantStore(dir_path);
    defer store.deinit();
    var handler = testHandler(&store);

    var ht = httpz.testing.init(.{});
    defer ht.deinit();
    ht.param("username", "health");
    try pushChanges(&handler, ht.req, ht.res);
    try ht.expectStatus(400);
}

test "pushChanges rejects an invalid-charset username" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir_path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(dir_path);
    var store = testTenantStore(dir_path);
    defer store.deinit();
    var handler = testHandler(&store);

    var ht = httpz.testing.init(.{});
    defer ht.deinit();
    ht.param("username", "Not-Valid!");
    try pushChanges(&handler, ht.req, ht.res);
    try ht.expectStatus(400);
}

test "putBlob then getBlob round-trips via the handlers" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir_path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(dir_path);
    var store = testTenantStore(dir_path);
    defer store.deinit();
    var handler = testHandler(&store);

    var auth_buf: [64 + "Bearer ".len]u8 = undefined;
    const auth_header = try bearerFor("alice", &auth_buf);

    const content = "hello world";
    const digest = sha256Hex(content);

    var put_ht = httpz.testing.init(.{});
    defer put_ht.deinit();
    put_ht.param("username", "alice");
    put_ht.header("Authorization", auth_header);
    put_ht.param("id", &digest);
    put_ht.body(content);

    try putBlob(&handler, put_ht.req, put_ht.res);
    try put_ht.expectStatus(200);

    var get_ht = httpz.testing.init(.{});
    defer get_ht.deinit();
    get_ht.param("username", "alice");
    get_ht.header("Authorization", auth_header);
    get_ht.param("id", &digest);

    try getBlob(&handler, get_ht.req, get_ht.res);
    try get_ht.expectStatus(200);
    try std.testing.expectEqualStrings(content, get_ht.res.body);
}

test "getBlob 404s for an unknown id" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir_path = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(dir_path);
    var store = testTenantStore(dir_path);
    defer store.deinit();
    var handler = testHandler(&store);

    var auth_buf: [64 + "Bearer ".len]u8 = undefined;
    const auth_header = try bearerFor("alice", &auth_buf);

    var ht = httpz.testing.init(.{});
    defer ht.deinit();
    ht.param("username", "alice");
    ht.header("Authorization", auth_header);
    ht.param("id", "1" ** 64);

    try getBlob(&handler, ht.req, ht.res);
    try ht.expectStatus(404);
}
