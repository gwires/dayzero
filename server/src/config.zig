const std = @import("std");

pub const Config = struct {
    port: u16,
    address: []const u8,
    db_path: []const u8,
    auth_token: ?[]const u8,

    pub fn fromEnv(allocator: std.mem.Allocator) !Config {
        const port_str = std.process.getEnvVarOwned(allocator, "DAYZERO_PORT") catch |err| switch (err) {
            error.EnvironmentVariableNotFound => null,
            else => return err,
        };
        defer if (port_str) |s| allocator.free(s);
        const port: u16 = if (port_str) |s| try std.fmt.parseInt(u16, s, 10) else 8080;

        const address = std.process.getEnvVarOwned(allocator, "DAYZERO_ADDRESS") catch |err| switch (err) {
            error.EnvironmentVariableNotFound => try allocator.dupe(u8, "127.0.0.1"),
            else => return err,
        };

        const db_path = std.process.getEnvVarOwned(allocator, "DAYZERO_DB_PATH") catch |err| switch (err) {
            error.EnvironmentVariableNotFound => try allocator.dupe(u8, "dayzero.sqlite"),
            else => return err,
        };

        const auth_token = std.process.getEnvVarOwned(allocator, "DAYZERO_AUTH_TOKEN") catch |err| switch (err) {
            error.EnvironmentVariableNotFound => null,
            else => return err,
        };

        return .{
            .port = port,
            .address = address,
            .db_path = db_path,
            .auth_token = auth_token,
        };
    }

    pub fn deinit(self: Config, allocator: std.mem.Allocator) void {
        allocator.free(self.address);
        allocator.free(self.db_path);
        if (self.auth_token) |t| allocator.free(t);
    }
};
