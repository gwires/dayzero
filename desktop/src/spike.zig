const std = @import("std");

/// Minimal bindings to the C API of webview/webview 0.12.0 (vendored under
/// lib/webview, implementation compiled via src/webview_shim.cpp).
const webview = struct {
    pub const WebView = opaque {};
    pub const Hint = enum(c_int) { none = 0, min = 1, max = 2, fixed = 3 };

    pub extern fn webview_create(debug: c_int, window: ?*anyopaque) ?*WebView;
    pub extern fn webview_destroy(w: ?*WebView) c_int;
    pub extern fn webview_run(w: ?*WebView) c_int;
    pub extern fn webview_terminate(w: ?*WebView) c_int;
    pub extern fn webview_set_title(w: ?*WebView, title: [*:0]const u8) c_int;
    pub extern fn webview_set_size(w: ?*WebView, width: c_int, height: c_int, hints: Hint) c_int;
    pub extern fn webview_navigate(w: ?*WebView, url: [*:0]const u8) c_int;
};

pub fn main() !void {
    var gpa: std.heap.GeneralPurposeAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);
    const www_dir = if (args.len > 1) args[1] else "spike/www";

    // Serve the static test page on an ephemeral localhost port.
    // http://127.0.0.1 counts as a secure context, which OPFS requires
    // (this is why we serve over http instead of loading a file:// URL).
    const address = std.net.Address.initIp4(.{ 127, 0, 0, 1 }, 0);
    const server = try address.listen(.{ .reuse_address = true });
    const port = server.listen_address.getPort();

    const serve_thread = try std.Thread.spawn(.{}, serve, .{ server, www_dir, allocator });
    serve_thread.detach();

    const w = webview.webview_create(1, null) orelse return error.WebViewCreateFailed;
    defer _ = webview.webview_destroy(w);
    _ = webview.webview_set_title(w, "dayzero desktop spike");
    _ = webview.webview_set_size(w, 900, 700, .none);

    var url_buf: [64]u8 = undefined;
    const url = try std.fmt.bufPrintZ(&url_buf, "http://127.0.0.1:{d}/", .{port});
    _ = webview.webview_navigate(w, url);

    std.log.info("serving {s} at {s}", .{ www_dir, url });
    _ = webview.webview_run(w); // blocks until the window is closed
}

fn serve(server_arg: std.net.Server, www_dir: []const u8, allocator: std.mem.Allocator) void {
    var server = server_arg; // parameters are const; accept() needs a mutable pointer
    while (true) {
        const conn = server.accept() catch |err| {
            std.log.err("accept failed: {}", .{err});
            return;
        };
        // One thread per connection: keep-alive connections must not block
        // the accept loop while the browser holds them open.
        const thread = std.Thread.spawn(.{}, handleConnection, .{ conn, www_dir, allocator }) catch {
            conn.stream.close();
            continue;
        };
        thread.detach();
    }
}

fn handleConnection(conn: std.net.Server.Connection, www_dir: []const u8, allocator: std.mem.Allocator) void {
    defer conn.stream.close();
    var read_buf: [16 * 1024]u8 = undefined;
    var http_server = std.http.Server.init(conn, &read_buf);
    while (true) {
        var req = http_server.receiveHead() catch break;
        handleRequest(&req, www_dir, allocator) catch |err| {
            std.log.err("request '{s}' failed: {}", .{ req.head.target, err });
            break;
        };
    }
}

fn handleRequest(req: *std.http.Server.Request, www_dir: []const u8, allocator: std.mem.Allocator) !void {
    std.log.info("{s} {s}", .{ @tagName(req.head.method), req.head.target });

    var path = req.head.target;
    if (std.mem.indexOfScalar(u8, path, '?')) |i| path = path[0..i];

    // The test page POSTs its progress here so results can be observed
    // from the process log (useful when running headless under Xvfb).
    if (req.head.method == .POST and std.mem.eql(u8, path, "/log")) {
        var reader = try req.reader();
        const body = try reader.readAllAlloc(allocator, 1024 * 1024);
        defer allocator.free(body);
        std.log.info("PAGE: {s}", .{body});
        try req.respond("ok", .{});
        return;
    }

    if (req.head.method != .GET and req.head.method != .HEAD) {
        try req.respond("method not allowed", .{ .status = .method_not_allowed });
        return;
    }

    if (std.mem.indexOf(u8, path, "..") != null) {
        try req.respond("forbidden", .{ .status = .forbidden });
        return;
    }

    var dir = try std.fs.cwd().openDir(www_dir, .{});
    defer dir.close();

    const rel = if (std.mem.eql(u8, path, "/")) "index.html" else path[1..];
    const file = dir.openFile(rel, .{}) catch |err| switch (err) {
        error.FileNotFound => {
            try req.respond("not found", .{ .status = .not_found });
            return;
        },
        else => return err,
    };
    defer file.close();

    const body = try file.readToEndAlloc(allocator, 64 * 1024 * 1024);
    defer allocator.free(body);
    try req.respond(body, .{
        .version = req.head.version,
        .extra_headers = &.{.{ .name = "Content-Type", .value = contentType(rel) }},
    });
}

fn contentType(path: []const u8) []const u8 {
    const ext = std.fs.path.extension(path);
    const known = .{
        .{ ".html", "text/html" },
        .{ ".js", "text/javascript" },
        .{ ".mjs", "text/javascript" },
        .{ ".wasm", "application/wasm" },
        .{ ".json", "application/json" },
        .{ ".css", "text/css" },
        .{ ".ico", "image/x-icon" },
    };
    inline for (known) |entry| {
        if (std.mem.eql(u8, ext, entry[0])) return entry[1];
    }
    return "application/octet-stream";
}
