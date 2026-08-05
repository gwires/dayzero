{
  description = "dayzero: a local-first diary PWA with a zig sync server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config = {
            allowUnfree = true;
            android_sdk.accept_license = true;
          };
        };
        androidSdkRaw = (pkgs.androidenv.composeAndroidPackages {
          platformVersions = [ "36" ];
          buildToolsVersions = [ "36.0.0" ];
          includeEmulator = false;
          includeNDK = false;
        }).androidsdk;

        # Google only publishes build-tools' native binaries (aapt2, aapt,
        # dexdump, zipalign, split-select) for linux-x86_64 — there is no
        # linux-aarch64 build. On an aarch64 host, nixpkgs' autoPatchelf
        # correctly refuses to touch them (architecture mismatch), leaving
        # unpatched x86_64 ELFs whose hardcoded /lib64/ld-linux-x86-64.so.2
        # interpreter doesn't exist on a Nix store. If the host has x86_64
        # binfmt_misc/qemu emulation registered, patching just the
        # interpreter + rpath to Nix-store x86_64 glibc/libstdc++ (fetched
        # as substitutes, no cross-compilation needed) is enough to let
        # them run under emulation. Only the handful of native binaries are
        # copied and patched; everything else is symlinked back to the
        # original derivation to avoid duplicating the whole SDK on disk.
        pkgsX86 = import nixpkgs { system = "x86_64-linux"; };
        androidSdk =
          if system == "aarch64-linux" then
            pkgs.runCommand "androidsdk-x86-patched" { nativeBuildInputs = [ pkgs.patchelf ]; } ''
              mkdir -p $out/libexec/android-sdk
              for entry in ${androidSdkRaw}/libexec/android-sdk/*; do
                name=$(basename "$entry")
                if [ "$name" = "build-tools" ]; then
                  mkdir -p $out/libexec/android-sdk/build-tools
                  for verdir in "$entry"/*; do
                    ver=$(basename "$verdir")
                    mkdir -p $out/libexec/android-sdk/build-tools/$ver
                    for f in "$verdir"/*; do
                      fname=$(basename "$f")
                      dest=$out/libexec/android-sdk/build-tools/$ver/$fname
                      if [ -f "$f" ] && patchelf --print-interpreter "$f" >/dev/null 2>&1; then
                        cp "$f" "$dest"
                        chmod u+w "$dest"
                        patchelf \
                          --set-interpreter ${pkgsX86.glibc}/lib/ld-linux-x86-64.so.2 \
                          --set-rpath "${pkgsX86.glibc}/lib:${pkgsX86.stdenv.cc.cc.lib}/lib" \
                          "$dest"
                      else
                        ln -s "$f" "$dest"
                      fi
                    done
                  done
                else
                  ln -s "$entry" $out/libexec/android-sdk/$name
                fi
              done
            ''
          else
            androidSdkRaw;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.zig_0_14
            pkgs.zls_0_14
            pkgs.nodejs_22
            pkgs.sqlite
            pkgs.tippecanoe
            pkgs.pmtiles
            pkgs.unzip
            pkgs.dejavu_fonts
            androidSdk
            pkgs.jdk21
          ];

          shellHook = ''
            export ANDROID_HOME=${androidSdk}/libexec/android-sdk
            export ANDROID_SDK_ROOT=$ANDROID_HOME
            export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/36.0.0/aapt2"
          '';
        };
      }
    );
}
