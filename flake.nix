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
        androidSdk = (pkgs.androidenv.composeAndroidPackages {
          platformVersions = [ "35" ];
          buildToolsVersions = [ "35.0.0" ];
          includeEmulator = false;
          includeNDK = false;
        }).androidsdk;
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
            export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/35.0.0/aapt2"
          '';
        };
      }
    );
}
