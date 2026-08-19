const std = @import("std");

/// The static app build (app/build/), embedded at compile time. Generated
/// by build.zig: a path -> bytes table with an @embedFile per entry.
const web = @import("web");

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

    // `-dev [url]` points the window at a dev server (vite) instead of the
    // embedded build, and skips the local server entirely.
    var dev_url: ?[]const u8 = null;
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "-dev")) {
            i += 1;
            dev_url = if (i < args.len) args[i] else "http://localhost:5173";
        }
    }

    const url: [:0]const u8 = if (dev_url) |u|
        try std.fmt.allocPrintZ(allocator, "{s}", .{u})
    else blk: {
        // Serve the embedded build on an ephemeral localhost port.
        // http://127.0.0.1 counts as a secure context, which OPFS requires
        // (this is why we serve over http instead of loading a file:// URL —
        // the same reasoning as Capacitor's https://localhost on Android).
        const address = std.net.Address.initIp4(.{ 127, 0, 0, 1 }, 0);
        const server = try address.listen(.{ .reuse_address = true });
        const port = server.listen_address.getPort();

        const serve_thread = try std.Thread.spawn(.{}, serve, .{server});
        serve_thread.detach();

        std.log.info("serving embedded app build at http://127.0.0.1:{d}/", .{port});
        break :blk try std.fmt.allocPrintZ(allocator, "http://127.0.0.1:{d}/", .{port});
    };

    const w = webview.webview_create(1, null) orelse return error.WebViewCreateFailed;
    defer _ = webview.webview_destroy(w);
    _ = webview.webview_set_title(w, "dayzero");
    _ = webview.webview_set_size(w, 1100, 800, .none);
    _ = webview.webview_navigate(w, url);

    _ = webview.webview_run(w); // blocks until the window is closed
}

fn serve(server_arg: std.net.Server) void {
    var server = server_arg; // parameters are const; accept() needs a mutable pointer
    while (true) {
        const conn = server.accept() catch |err| {
            std.log.err("accept failed: {}", .{err});
            return;
        };
        // One thread per connection: keep-alive connections must not block
        // the accept loop while the browser holds them open.
        const thread = std.Thread.spawn(.{}, handleConnection, .{conn}) catch {
            conn.stream.close();
            continue;
        };
        thread.detach();
    }
}

fn handleConnection(conn: std.net.Server.Connection) void {
    defer conn.stream.close();
    var read_buf: [16 * 1024]u8 = undefined;
    var http_server = std.http.Server.init(conn, &read_buf);
    while (true) {
        var req = http_server.receiveHead() catch break;
        handleRequest(&req) catch |err| {
            std.log.err("request '{s}' failed: {}", .{ req.head.target, err });
            break;
        };
    }
}

fn handleRequest(req: *std.http.Server.Request) !void {
    if (req.head.method != .GET and req.head.method != .HEAD) {
        try req.respond("method not allowed", .{ .status = .method_not_allowed });
        return;
    }

    var path = req.head.target;
    if (std.mem.indexOfScalar(u8, path, '?')) |i| path = path[0..i];
    if (std.mem.indexOf(u8, path, "..") != null) {
        try req.respond("forbidden", .{ .status = .forbidden });
        return;
    }

    const rel = if (std.mem.eql(u8, path, "/")) "index.html" else path[1..];

    // SPA fallback: unknown paths get 200.html (adapter-static's fallback),
    // so client-side routes work on hard reload.
    var served_name: []const u8 = rel;
    const data = lookup(rel) orelse blk: {
        served_name = "200.html";
        break :blk lookup("200.html") orelse {
            try req.respond("not found", .{ .status = .not_found });
            return;
        };
    };
    const ct = contentType(served_name);

    // pmtiles fetches byte ranges of the bundled basemap; serving those
    // correctly is the same trap Capacitor's local server fell into
    // (see BUGS.md bug 3 and MapView.svelte). Never compress.
    const range_header = findHeader(req, "range");
    if (range_header) |value| {
        if (parseRange(value, data.len)) |r| {
            var cr_buf: [64]u8 = undefined;
            const content_range = try std.fmt.bufPrint(
                &cr_buf,
                "bytes {d}-{d}/{d}",
                .{ r.start, r.end, data.len },
            );
            try req.respond(data[r.start .. r.end + 1], .{
                .version = req.head.version,
                .status = .partial_content,
                .extra_headers = &.{
                    .{ .name = "Content-Type", .value = ct },
                    .{ .name = "Content-Range", .value = content_range },
                },
            });
            return;
        }
        if (unsatisfiable(value, data.len)) {
            var cr_buf: [32]u8 = undefined;
            const content_range = try std.fmt.bufPrint(&cr_buf, "bytes */{d}", .{data.len});
            try req.respond("", .{
                .version = req.head.version,
                .status = .range_not_satisfiable,
                .extra_headers = &.{.{ .name = "Content-Range", .value = content_range }},
            });
            return;
        }
        // Unparseable/multi-range: fall through with the full body (allowed).
    }

    try req.respond(data, .{
        .version = req.head.version,
        .extra_headers = &.{.{ .name = "Content-Type", .value = ct }},
    });
}

fn findHeader(req: *std.http.Server.Request, name: []const u8) ?[]const u8 {
    var it = req.iterateHeaders();
    while (it.next()) |h| {
        if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
    }
    return null;
}

const Range = struct { start: usize, end: usize }; // end inclusive

/// Parses a single-range `Range: bytes=...` header. Returns null for
/// unparseable or multi-range values (caller then sends the full body).
fn parseRange(header: []const u8, size: usize) ?Range {
    const prefix = "bytes=";
    if (!std.mem.startsWith(u8, header, prefix)) return null;
    const spec = std.mem.trim(u8, header[prefix.len..], " ");
    if (spec.len == 0 or std.mem.indexOfScalar(u8, spec, ',') != null) return null;

    const dash = std.mem.indexOfScalar(u8, spec, '-') orelse return null;
    if (dash == 0) {
        // suffix form: last N bytes
        const suffix = std.fmt.parseInt(usize, spec[1..], 10) catch return null;
        if (suffix == 0) return null;
        const start = size -| suffix;
        return .{ .start = start, .end = size -| 1 };
    }

    const start = std.fmt.parseInt(usize, spec[0..dash], 10) catch return null;
    if (start >= size) return null; // caller checks unsatisfiable() separately
    const end = if (dash + 1 < spec.len)
        std.fmt.parseInt(usize, spec[dash + 1 ..], 10) catch return null
    else
        size - 1;
    const clamped = @min(end, size - 1);
    if (clamped < start) return null;
    return .{ .start = start, .end = clamped };
}

/// True when the header is a well-formed `bytes=N-...` with N >= size.
fn unsatisfiable(header: []const u8, size: usize) bool {
    const prefix = "bytes=";
    if (!std.mem.startsWith(u8, header, prefix)) return false;
    const spec = std.mem.trim(u8, header[prefix.len..], " ");
    if (std.mem.indexOfScalar(u8, spec, ',') != null) return false;
    const dash = std.mem.indexOfScalar(u8, spec, '-') orelse return false;
    if (dash == 0) return false;
    const start = std.fmt.parseInt(usize, spec[0..dash], 10) catch return false;
    return start >= size;
}

fn lookup(path: []const u8) ?[]const u8 {
    for (web.files) |f| {
        if (std.mem.eql(u8, f.path, path)) return f.data;
    }
    return null;
}

fn contentType(path: []const u8) []const u8 {
    const ext = std.fs.path.extension(path);
    const known = .{
        .{ ".html", "text/html" },
        .{ ".js", "text/javascript" },
        .{ ".mjs", "text/javascript" },
        .{ ".wasm", "application/wasm" },
        .{ ".json", "application/json" },
        .{ ".webmanifest", "application/manifest+json" },
        .{ ".css", "text/css" },
        .{ ".svg", "image/svg+xml" },
        .{ ".png", "image/png" },
        .{ ".ico", "image/x-icon" },
        .{ ".txt", "text/plain" },
        // pmtiles isn't mime-db-registered; must stay an opaque binary type
        // (see the pmtilesContentType note in app/vite.config.ts).
        .{ ".pmtiles", "application/octet-stream" },
        .{ ".pbf", "application/octet-stream" },
    };
    inline for (known) |entry| {
        if (std.mem.eql(u8, ext, entry[0])) return entry[1];
    }
    return "application/octet-stream";
}
