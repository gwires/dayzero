const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    exe_mod.link_libc = true;

    // webview/webview 0.12.0 (vendored under lib/webview, MIT license).
    // The library is a single C++ header; the shim is the one translation
    // unit that compiles it and exports the C API.
    switch (target.result.os.tag) {
        .linux => {
            // zig's bundled clang doesn't find the system C++ standard
            // library headers (notably inside the nix devshell), so compile
            // the shim with the host C++ compiler instead.
            const shim = b.addSystemCommand(&.{"c++"});
            shim.addArgs(&.{ "-std=c++17", "-fPIC", "-DWEBVIEW_STATIC", "-c" });
            for (pkgConfigCflags(b)) |flag| shim.addArg(flag);
            shim.addArg("-I");
            shim.addArg(b.path("lib/webview").getPath(b));
            shim.addFileArg(b.path("src/webview_shim.cpp"));
            shim.addArg("-o");
            exe_mod.addObjectFile(shim.addOutputFileArg("webview_shim.o"));

            exe_mod.linkSystemLibrary("webkit2gtk-4.1", .{});
            exe_mod.linkSystemLibrary("gtk+-3.0", .{});

            // Resolve the std:: symbols used by the shim object. Note:
            // linkSystemLibrary("stdc++") maps to zig's bundled libc++,
            // which is ABI-incompatible with objects compiled by the host
            // g++, so link the host compiler's libstdc++ (and libgcc_s,
            // for unwind support) directly instead.
            for ([_][]const u8{ "libstdc++.so", "libgcc_s.so.1" }) |lib| {
                const flag = b.fmt("-print-file-name={s}", .{lib});
                const argv = [_][]const u8{ "c++", flag };
                if (run(b, &argv)) |out| {
                    const path = std.mem.trim(u8, out, " \t\r\n");
                    if (std.fs.path.isAbsolute(path)) {
                        exe_mod.addObjectFile(.{ .cwd_relative = path });
                        if (std.fs.path.dirname(path)) |dir| exe_mod.addRPath(.{ .cwd_relative = dir });
                    }
                }
            }
        },
        .macos => {
            // macOS toolchains locate the SDK's C++ headers themselves.
            exe_mod.addIncludePath(b.path("lib/webview"));
            exe_mod.addCSourceFile(.{
                .file = b.path("src/webview_shim.cpp"),
                .flags = &.{ "-std=c++17", "-DWEBVIEW_STATIC" },
            });
            exe_mod.linkFramework("WebKit", .{});
        },
        else => {},
    }

    const exe = b.addExecutable(.{
        .name = "dayzero-desktop-spike",
        .root_module = exe_mod,
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Run the desktop spike");
    run_step.dependOn(&run_cmd.step);
}

/// `pkg-config --cflags gtk+-3.0 webkit2gtk-4.1`, tokenized. On systems
/// where these are in the default include paths (or injected via the nix
/// gcc wrapper's NIX_CFLAGS_COMPILE) pkg-config may be unnecessary, so a
/// failure here is not fatal.
fn pkgConfigCflags(b: *std.Build) [][]const u8 {
    const out = run(b, &.{ "pkg-config", "--cflags", "gtk+-3.0", "webkit2gtk-4.1" }) orelse return &.{};
    var flags = std.ArrayList([]const u8).init(b.allocator);
    var it = std.mem.tokenizeAny(u8, out, " \t\r\n");
    while (it.next()) |tok| flags.append(b.dupe(tok)) catch {};
    return flags.items;
}

fn run(b: *std.Build, argv: []const []const u8) ?[]const u8 {
    const result = std.process.Child.run(.{ .allocator = b.allocator, .argv = argv }) catch return null;
    if (result.term != .Exited or result.term.Exited != 0) return null;
    return result.stdout;
}
