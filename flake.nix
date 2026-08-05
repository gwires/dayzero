{
  description = "dayzero: a local-first diary PWA with a zig sync server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.zig_0_14
            pkgs.zls_0_14
            pkgs.nodejs_22
            pkgs.sqlite
          ];
        };
      }
    );
}
