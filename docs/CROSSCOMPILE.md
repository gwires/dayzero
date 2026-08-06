# server cross compilation

Since the server is Zig-based, cross-compilation is built into the toolchain — no separate cross-compiler needed, even though the vendored sqlite C code
gets compiled too (Zig bundles clang plus libc/headers for its supported targets).

From the `server/` directory, inside the nix devshell:

```
nix develop -c zig build -Dtarget=x86_64-linux-musl -Doptimize=ReleaseSafe
```

Notes:

- Target triple: `x86_64-linux-musl` gives you a fully static binary with no libc dependency at runtime — matches the project's stated goal ("single static
binary, self-hostable"). If you specifically need glibc instead (e.g. to match a particular deploy host), use x86_64-linux-gnu.
- Output: lands at zig-out/bin/<binary-name> (per the README this is dayzero-server), just like a native build — cross-compiling doesn't change the
output path, only the target.
- Verify the architecture afterward with file zig-out/bin/dayzero-server — it should report x86-64 rather than aarch64.
- Prerequisite: build.zig needs to actually expose the target as a build option (typically via b.standardTargetOptions(.{})) for -Dtarget= to be accepted
at all. If it's hardcoded to build only for the host natively instead, that call needs to be added/enabled first — I don't have the current contents of
build.zig in front of me to confirm which way it's set up, so check that if the -Dtarget= flag itself gets rejected.
- Dependencies: http.zig and zqlite (declared in build.zig.zon) are fetched as Zig source/vendored C, so they cross-compile along with everything else
automatically — no per-dependency cross setup needed.
- You can drop -Doptimize=ReleaseSafe for a debug build, or use ReleaseFast/ReleaseSmall depending on what tradeoff you want for the deployed binary.


