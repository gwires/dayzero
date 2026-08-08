const std = @import("std");
const httpz = @import("httpz");

const config = @import("config.zig");
const api = @import("api.zig");
const tenants_mod = @import("tenants.zig");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const cfg = config.Config.fromEnv(allocator) catch |err| {
        switch (err) {
            error.MissingAuthToken, error.EmptyAuthToken => std.log.err(
                "DAYZERO_AUTH_TOKEN must be set to a non-empty bearer token",
                .{},
            ),
            else => {},
        }
        return err;
    };
    defer cfg.deinit(allocator);

    std.fs.cwd().makePath(cfg.db_path) catch |err| {
        std.log.err(
            "failed to create/access DAYZERO_DB_PATH directory '{s}': {}",
            .{ cfg.db_path, err },
        );
        return err;
    };

    var tenants = tenants_mod.TenantStore.init(allocator, cfg.db_path);
    defer tenants.deinit();

    var handler = api.Handler{ .tenants = &tenants, .auth_token = cfg.auth_token };

    var server = try httpz.Server(*api.Handler).init(
        allocator,
        .{ .port = cfg.port, .address = cfg.address },
        &handler,
    );
    defer server.deinit();
    defer server.stop();

    // browser clients (the PWA) call this server cross-origin — it's a
    // separate self-hosted service, not served from the same origin as the
    // app in general. "*" is fine here: requests never use credentialed mode
    // (cookies), just a bearer token in a header, which CORS doesn't
    // restrict the same way.
    const cors = try server.middleware(httpz.middleware.Cors, .{
        .origin = "*",
        .headers = "content-type,authorization",
        .methods = "GET,POST,PUT,OPTIONS",
        .max_age = "300",
    });
    const router = try server.router(.{ .middlewares = &.{cors} });
    api.registerRoutes(router);

    std.log.info(
        "dayzero-server listening on http://{s}:{d} (tenant db dir: {s})",
        .{ cfg.address, cfg.port, cfg.db_path },
    );
    try server.listen();
}

test {
    // `zig build test` only discovers tests reachable through analyzed
    // declarations; a plain `@import` that's merely called from `main` isn't
    // enough, since main() itself is never analyzed during a test build.
    // `refAllDecls` forces every imported module (and transitively, its
    // "test" blocks) to be analyzed too.
    std.testing.refAllDecls(@This());
}
