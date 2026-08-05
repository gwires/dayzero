const std = @import("std");
const httpz = @import("httpz");
const zqlite = @import("zqlite");

pub const Handler = struct {
    db: zqlite.Conn,

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
}

fn health(_: *Handler, _: *httpz.Request, res: *httpz.Response) !void {
    res.status = 200;
    try res.json(.{ .status = "ok" }, .{});
}
