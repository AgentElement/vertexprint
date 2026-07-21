# Vertexprint

![Vertexprint Preview](https://github.com/AgentElement/vertexprint/blob/master/docs/vertexprint-hero-image.png)

Vertexprint (https://agentelement.net/vertexprint) is a tool for converting
meshes into 3D printable assemblies. The tool takes a mesh as input and
generates:

- **STL files for vertex holders** - printed components that hold rods in
  place.
- **A table of edge lengths** - cut your rods to these lengths, either by hand
  or with a laser cutter.

The generated assemblies use interference fits: vertex holders have slots that
rods slide into. For complex parts, vertex pieces and edges can be labeled.
Each slot on each vertex is labeled with the corresponding edge; use these slot
numbers to determine which edges go where.

If you use a laser cutter to cut your rods, then vertexprint also generates SVG
files to cut rods in batches.

## Usage
Vertexprint is available as a webapp [here](https://agentelement.net/vertexprint).
It renders all your STLs in the browser, and no data leaves the browser.

You may also run it as a bare python script. See installation instructions below.

```bash
# View all options
uv run python scripts/vertexprint.py --help

# Openscad preview a cube
uv run python scripts/vertexprint.py --file data/cube.obj

# Generate vertex pieces for a cube
uv run python scripts/vertexprint.py --file data/cube.obj --generate-outputs

# Generate a stanford bunny.
uv run python scripts/vertexprint.py \
    --file data/Bunny-LowPoly.stl \     # Vertexprint works on ordinary STL files too!
    --offset-type per_half_edge \       # Vertex pieces can have nonuniform offsets
    --radius 750 \                      # Rescale object such that the vertex furthest from the origin has this distance from the origin
    --rod-inset 6 \                     # Rods are inset by this distance
    --isotropize \                      # Make faces as equilateral as possible (avoids small angles) -- good if your vertex pieces come out wonky
    --label-vertices \                  # Add labels to vertex pieces
    --generate-outputs
```

[David McCooey's website](https://dmccooey.com/polyhedra/) has a number of
polyhedra definitions in a uniform text format. The data/ directory includes
all Platonic, Archimedian, Catalan, and Kepler-Poinsot solids in this text
format. I have written a simple utility to convert from this text format to a
.obj format suitable for the main vertexprint program.

```bash
# View all options
uv run python scripts/convert_visual_polyhedra.py --help

# Convert a dodecahedron text file to .obj, then preview this dodecahedron
uv run python scripts/convert_visual_polyhedra.py data/dodecahedron.txt
uv run python scripts/vertexprint.py --file data/dodecahedron.obj
```

## Installation & Development

This project uses Nix for environment management and `uv` for Python
dependencies. You only need to have Nix installed to develop for this project.
Nix manages everything else for you.

```bash
# Enter the development shell
nix develop

# Install dependencies with uv
uv sync

# Run tests
uv run pytest
```

If you don't want to use nix and uv, then you must install
[openscad](https://openscad.org/) from your system package manager. After that,
install the dependencies listed out in `pyproject.toml` and run the vertexprint
script normally.
