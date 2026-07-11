{
  description = "Generate print-in-place mesh assemblies";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.uv
          pkgs.ninja
          pkgs.cairo
          pkgs.openscad
          pkgs.python3
          pkgs.nodejs

          # openscad-wasm build dependencies
          pkgs.gnumake
          pkgs.git
          pkgs.wget
          pkgs.deno
          pkgs.docker
        ];

        nativeBuildInputs = with pkgs; [
          pkg-config
        ];

        # C libraries for numpy,
        LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
          pkgs.stdenv.cc.cc.lib
          pkgs.zlib
          pkgs.glib
          pkgs.libGL
          pkgs.e2fsprogs
          pkgs.gmp
        ];
      };
    };
}
