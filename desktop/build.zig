const std = @import("std");

pub fn build(b: *std.Build) !void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // --- dayzero-desktop: the app build embedded into a webview shell ---
    const exe_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    exe_mod.link_libc = true;
    try addWebEmbed(b, exe_mod);
    try addWebview(b, exe_mod, target);

    const exe = b.addExecutable(.{
        .name = "dayzero-desktop",
        .root_module = exe_mod,
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }
    const run_step = b.step("run", "Run dayzero desktop");
    run_step.dependOn(&run_cmd.step);

    // --- dayzero-desktop-spike: OPFS canary for WebKitGTK (see README) ---
    const spike_mod = b.createModule(.{
        .root_source_file = b.path("src/spike.zig"),
        .target = target,
        .optimize = optimize,
    });
    spike_mod.link_libc = true;
    try addWebview(b, spike_mod, target);

    const spike_exe = b.addExecutable(.{
        .name = "dayzero-desktop-spike",
        .root_module = spike_mod,
    });
    const spike_install = b.addInstallArtifact(spike_exe, .{});

    const spike_step = b.step("spike", "Build the OPFS canary spike");
    spike_step.dependOn(&spike_install.step);

    const spike_run = b.addRunArtifact(spike_exe);
    spike_run.step.dependOn(&spike_install.step);
    if (b.args) |args| {
        spike_run.addArgs(args);
    }
    const spike_run_step = b.step("run-spike", "Run the OPFS canary spike");
    spike_run_step.dependOn(&spike_run.step);
}

/// webview/webview 0.12.0 (vendored under lib/webview, MIT license).
/// The library is a single C++ header; the shim is the one translation
/// unit that compiles it and exports the C API.
fn addWebview(b: *std.Build, exe_mod: *std.Build.Module, target: std.Build.ResolvedTarget) !void {
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
            const sdk = findMacosSdk(b) orelse @panic(
                "no macOS SDK found: set SDKROOT, or install the Command Line Tools (xcode-select --install)",
            );
            // Deliberately do NOT set b.sysroot. Forcing --sysroot reroutes
            // zig's MachO libSystem/libc resolution so it locates the SDK's
            // .tbd stubs without linking their symbols, leaving _malloc,
            // _objc_msgSend, __Unwind_*, etc. undefined. With sysroot unset,
            // zig's native SDK detection links libSystem cleanly (verified
            // with a minimal link_libc probe). The compiler and linker are
            // still pointed at the SDK explicitly below.
            exe_mod.addFrameworkPath(.{ .cwd_relative = try std.fs.path.join(b.allocator, &.{
                sdk, "System", "Library", "Frameworks",
            }) });
            // Library search path for -lobjc / -lc++. Absolute, and with no
            // sysroot set it is used verbatim (not re-rooted).
            exe_mod.addLibraryPath(.{ .cwd_relative = try std.fs.path.join(b.allocator, &.{
                sdk, "usr", "lib",
            }) });
            exe_mod.link_libcpp = true;
            exe_mod.addIncludePath(b.path("lib/webview"));
            var flags = std.ArrayList([]const u8).init(b.allocator);
            try flags.appendSlice(&.{ "-std=c++17", "-DWEBVIEW_STATIC", "-isysroot", sdk });
            // webview.h's Cocoa backend is written against the ObjC runtime,
            // and the macOS SDK's CF_ENUM macro expansion (enum X : T X;)
            // only parses in Objective-C++ mode: in plain C++ mode zig's
            // clang rejects it ("non-defining declaration of enumeration with
            // a fixed underlying type is only permitted as a standalone
            // declaration"). Force ObjC++ regardless of the .cpp extension.
            exe_mod.addCSourceFile(.{
                .file = b.path("src/webview_shim.cpp"),
                .flags = flags.items,
                .language = .objective_cpp,
            });
            // The ObjC runtime ships as libobjc.A.tbd in the SDK (no plain
            // libobjc.tbd). zig's -l search only tries lib<name>.{tbd,dylib},
            // so linkSystemLibrary("objc") never matches. Pass the .tbd stub
            // by absolute path instead.
            exe_mod.addObjectFile(.{
                .cwd_relative = try std.fs.path.join(b.allocator, &.{
                    sdk, "usr", "lib", "libobjc.A.tbd",
                }),
            });
            exe_mod.linkFramework("WebKit", .{});
            exe_mod.linkFramework("Foundation", .{});
        },
        .windows => {
            // Native Windows builds only; webview.h's built-in WebView2
            // loader needs no external DLL beyond the OS ones listed here.
            exe_mod.addIncludePath(b.path("lib/webview"));
            exe_mod.addCSourceFile(.{ .file = b.path("src/webview_shim.cpp"), .flags = &.{ "-std=c++17", "-DWEBVIEW_STATIC" } });
            for ([_][]const u8{ "user32", "ole32", "shell32", "shlwapi", "gdi32" }) |lib| {
                exe_mod.linkSystemLibrary(lib, .{});
            }
        },
        else => @panic("unsupported target: webview has no backend for this OS"),
    }
}

/// Embeds the static app build (app/build/) into the module as `web`:
/// a generated embed.zig holding a path -> bytes table. Run `npm run build`
/// in app/ first (or use scripts/build-desktop.sh).
fn addWebEmbed(b: *std.Build, exe_mod: *std.Build.Module) !void {
    const app_dir = findAppBuildDir() orelse {
        std.log.err("app/build not found: run `npm run build` in app/ first (or use scripts/build-desktop.sh)", .{});
        return error.AppBuildMissing;
    };

    var dir = try std.fs.cwd().openDir(app_dir, .{ .iterate = true });
    defer dir.close();

    const wf = b.addWriteFiles();
    var paths = std.ArrayList([]const u8).init(b.allocator);

    var walker = try dir.walk(b.allocator);
    defer walker.deinit();
    while (try walker.next()) |entry| {
        if (entry.kind != .file) continue;
        const rel = try b.allocator.dupe(u8, entry.path);
        try paths.append(rel);
        const src_path = try std.fs.path.join(b.allocator, &.{ app_dir, entry.path });
        const dest_path = try std.fs.path.join(b.allocator, &.{ "web", entry.path });
        _ = wf.addCopyFile(.{ .cwd_relative = src_path }, dest_path);
    }

    if (paths.items.len == 0) {
        std.log.err("app/build is empty: run `npm run build` in app/ first", .{});
        return error.AppBuildMissing;
    }
    std.mem.sort([]const u8, paths.items, {}, pathLessThan);

    var src = std.ArrayList(u8).init(b.allocator);
    try src.appendSlice(
        \\// Generated by desktop/build.zig from app/build — do not edit.
        \\pub const File = struct { path: []const u8, data: []const u8 };
        \\pub const files = [_]File{
        \\
    );
    for (paths.items) |p| {
        try src.writer().print(
            "    .{{ .path = \"{s}\", .data = @embedFile(\"{s}\") }},\n",
            .{ p, p },
        );
    }
    try src.appendSlice("};\n");

    // embed.zig sits next to the copied files so @embedFile's relative
    // paths resolve against the same directory.
    const web_module = b.createModule(.{
        .root_source_file = wf.add("web/embed.zig", src.items),
    });
    exe_mod.addImport("web", web_module);
}

fn pathLessThan(_: void, a: []const u8, cmp_b: []const u8) bool {
    return std.mem.order(u8, a, cmp_b) == .lt;
}

/// xcrun itself honors SDKROOT, so run it with a sanitized environment —
/// otherwise it just echoes the nix-store stub the devshell exports.
/// xcode-select is checked first, like zig's own detection: running xcrun
/// without the Command Line Tools installed triggers the CLT install popup.
fn runXcrunSdkPath(b: *std.Build) ?[]const u8 {
    var env_map = std.process.getEnvMap(b.allocator) catch return null;
    defer env_map.deinit();
    _ = env_map.remove("SDKROOT");
    const check = std.process.Child.run(.{
        .allocator = b.allocator,
        .argv = &.{ "xcode-select", "--print-path" },
        .env_map = &env_map,
    }) catch return null;
    defer b.allocator.free(check.stdout);
    defer b.allocator.free(check.stderr);
    if (check.term != .Exited or check.term.Exited != 0 or check.stdout.len == 0) return null;
    const result = std.process.Child.run(.{
        .allocator = b.allocator,
        .argv = &.{ "xcrun", "--show-sdk-path" },
        .env_map = &env_map,
    }) catch return null;
    defer b.allocator.free(result.stdout);
    defer b.allocator.free(result.stderr);
    if (result.term != .Exited or result.term.Exited != 0) return null;
    const path = std.mem.trim(u8, result.stdout, " \t\r\n");
    if (path.len == 0 or !std.fs.path.isAbsolute(path)) return null;
    if (std.mem.startsWith(u8, path, "/nix/store/")) return null;
    return b.dupe(path);
}

/// Locate the macOS SDK: honor SDKROOT, then ask xcrun, then probe the
/// well-known Command Line Tools / Xcode locations. Mirrors what clang's
/// driver does, because zig's own detection only tries xcrun and silently
/// gives up inside nix develop shells.
fn findMacosSdk(b: *std.Build) ?[]const u8 {
    // Honor SDKROOT unless it points into the nix store: there it refers
    // to nixpkgs' trimmed apple-sdk stub, which lacks the C++ standard
    // library headers the webview shim needs.
    if (std.posix.getenv("SDKROOT")) |env| {
        if (env.len > 0 and !std.mem.startsWith(u8, env, "/nix/store/")) {
            return b.dupe(env);
        }
    }
    if (runXcrunSdkPath(b)) |path| return path;
    for ([_][]const u8{
        "/Library/Developer/CommandLineTools/SDKs",
        "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs",
    }) |sdks_dir| {
        var dir = std.fs.cwd().openDir(sdks_dir, .{ .iterate = true }) catch continue;
        defer dir.close();
        var best: ?[]const u8 = null;
        var it = dir.iterate();
        while (it.next() catch null) |entry| {
            if (!std.mem.startsWith(u8, entry.name, "MacOSX")) continue;
            if (!std.mem.endsWith(u8, entry.name, ".sdk")) continue;
            // names are version-sorted (MacOSX14.5.sdk, ...), so the
            // lexicographically greatest entry is the newest SDK
            if (best == null or std.mem.order(u8, entry.name, best.?) == .gt) {
                best = b.dupe(entry.name);
            }
        }
        if (best) |name| return std.fs.path.join(b.allocator, &.{ sdks_dir, name }) catch null;
    }
    // Last resort (nix-darwin without Command Line Tools): accept the
    // nix-store SDK stub from SDKROOT after all; the shim's -idirafter
    // zig-bundled libc++ headers compensate for its missing C++ standard
    // library.
    if (std.posix.getenv("SDKROOT")) |env| {
        if (env.len > 0) return b.dupe(env);
    }
    return null;
}

/// zig build is invoked from desktop/, but accept the repo root too.
fn findAppBuildDir() ?[]const u8 {
    for ([_][]const u8{ "../app/build", "app/build" }) |candidate| {
        std.fs.cwd().access(candidate, .{}) catch continue;
        return candidate;
    }
    return null;
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
