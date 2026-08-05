const std = @import("std");
const httpz = @import("httpz");

const config = @import("config.zig");
const db = @import("db.zig");
const api = @import("api.zig");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const cfg = try config.Config.fromEnv(allocator);
    defer cfg.deinit(allocator);

    const db_path = try allocator.dupeZ(u8, cfg.db_path);
    defer allocator.free(db_path);
    const conn = try db.open(db_path);
    defer conn.close();

    var handler = api.Handler{ .db = conn };

    var server = try httpz.Server(*api.Handler).init(
        allocator,
        .{ .port = cfg.port, .address = cfg.address },
        &handler,
    );
    defer server.deinit();
    defer server.stop();

    const router = try server.router(.{});
    api.registerRoutes(router);

    std.log.info("dayzero-server listening on http://{s}:{d} (db: {s})", .{ cfg.address, cfg.port, cfg.db_path });
    try server.listen();
}
