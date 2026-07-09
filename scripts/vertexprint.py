from enum import Enum
from typing import Any, Optional, Union

import argparse
import os
import subprocess
import copy
import time
from concurrent.futures import ProcessPoolExecutor
from functools import partial

import numpy as np
import pymeshlab
import stl_reader
import matplotlib.pyplot as plt
import cairo


class VertexType(Enum):
    TUBULAR = "tubular"
    CONICAL = "conical"


class OffsetType(Enum):
    PER_SOLID = "per_solid"
    GLOBAL = "global"
    PER_VERTEX = "per_vertex"
    PER_HALF_EDGE = "per_half_edge"


class ObjectType(Enum):
    VERTEX_HOLDER = "vertex_holder"
    SOLID = "solid"
    ALL_VERTEX_HOLDERS = "all_vertex_holders"


class GlobalOptions:
    def __init__(
        self,
        edge_diameter: float = 3.0,
        diameter_tolerance_fit: float = 0.35,
        diameter_taper_fit: float = 0.10,
        wall_thickness: float = 1.2,
        radius: float = 200,
        rod_inset: float = 8,
        global_offset: float = 7.72,
        rod_stock_length: float = 300,
        rods_per_cut: int = 0,
        min_printer_overhang_angle: float = 30,
        vertex_type: VertexType = VertexType.TUBULAR,
        offset_type: OffsetType = OffsetType.PER_SOLID,
        object_type: ObjectType = ObjectType.SOLID,
        by_tag: bool = True,
        index: int = 0,
        colors: Optional[list[str]] = None,
        label_vertices: bool = True,
        tubular_supports: bool = True,
        dry_run: bool = False,
    ) -> None:
        self.edge_diameter = edge_diameter
        self.diameter_tolerance_fit = diameter_tolerance_fit
        self.diameter_taper_fit = diameter_taper_fit
        self.wall_thickness = wall_thickness
        self.radius = radius
        self.rod_inset = rod_inset
        self.global_offset = global_offset
        self.rod_stock_length = rod_stock_length
        self.rods_per_cut = rods_per_cut
        self.min_printer_overhang_angle = min_printer_overhang_angle
        self.vertex_type = vertex_type
        self.offset_type = offset_type
        self.object_type = object_type
        self.by_tag = by_tag
        self.index = index
        self.colors = colors or ["red", "green", "blue"]
        self.label_vertices = label_vertices
        self.tubular_supports = tubular_supports
        self.dry_run = dry_run

        self.tube_depth = rod_inset + wall_thickness
        self.outer_tube_radius = edge_diameter / 2 + wall_thickness


# ┌───────────────────────────────────────────────────────────────────────────┐
# │ Geometry                                                                  │
# └───────────────────────────────────────────────────────────────────────────┘


class VertexFigure:
    def __init__(
        self,
        vertex: np.ndarray,
        vertex_index: int,
        vecs: np.ndarray,
        neighbors: list[int],
        tag: int,
        options: GlobalOptions,
    ) -> None:
        self.vertex: np.ndarray = vertex
        self.vertex_index: int = vertex_index
        self.vecs: np.ndarray = vecs
        self.neighbors: list[int] = neighbors
        self.tag = tag
        self.options: GlobalOptions = options

        self.std: np.ndarray = vecs
        self.euler: list[float] = [0.0, 0.0, 0.0]

        self.half_edge_offset = self.compute_offsets()
        self.vertex_offset = self.largest_offset()

        plane_normal = self.plane_normal()
        normal = self.normal()
        if normal is not None and plane_normal is not None:
            direction = 1 if np.dot(plane_normal, normal) > 0 else -1
            rotated, euler = self.reorient_to(direction * plane_normal)
            self.std = rotated
            self.euler = euler

    def annotate_edge_names(self, edges: dict[tuple[int, int], dict[str, Any]]) -> None:
        self.edges = []
        for neighbor in self.neighbors:
            edge = (
                (self.vertex_index, neighbor)
                if self.vertex_index < neighbor
                else (neighbor, self.vertex_index)
            )
            self.edges.append(edges[edge]["name"])

    def normalizable(self) -> bool:
        return self.normal() is not None

    # mean(norm(v for all v in self.vecs))
    def normal(self) -> Optional[np.ndarray]:
        n = np.sum(self.vecs, axis=0)
        norm = np.linalg.norm(n)
        return n / norm if norm > 1e-10 else None

    # Compute the plane of best fit, then return a vector normal to that plane
    def plane_normal(self) -> Optional[np.ndarray]:
        vecs = copy.deepcopy(self.vecs)
        if self.options.offset_type == OffsetType.PER_HALF_EDGE:
            vecs *= self.half_edge_offset[:, np.newaxis] + self.options.rod_inset
        if len(vecs) < 3:
            return None
        center = np.mean(vecs, axis=0)
        centered = vecs - center
        _, _, vh = np.linalg.svd(centered)
        normal = vh[2]
        return -normal / np.linalg.norm(normal)

    # Convert a rotation matrix to an euler angle triple
    def matrix_to_rotation(self, R: np.ndarray) -> list[float]:
        sy = np.sqrt(R[0, 0] ** 2 + R[1, 0] ** 2)
        singular = sy < 1e-6
        if not singular:
            return [
                float(np.atan2(R[2, 1], R[2, 2])),
                float(np.atan2(-R[2, 0], sy)),
                float(np.atan2(R[1, 0], R[0, 0])),
            ]
        # Handle gimbal lock cases
        elif R[2, 0] < 0:
            # y = 90 degrees
            return [float(np.atan2(-R[1, 2], R[1, 1])), 90.0, 0.0]
        else:
            # y = -90 degrees
            return [float(np.atan2(-R[1, 2], R[1, 1])), -90.0, 0.0]

    # Orient normal to target, then apply this rotation to all vectors in the
    # figure
    def reorient_to(
        self, normal, target: np.ndarray = np.array([0.0, 0.0, 1.0])
    ) -> tuple[np.ndarray, list[float]]:
        nn = np.linalg.norm(normal)
        if nn < 1e-9:
            return (self.vecs, [0.0, 0.0, 0.0])
        u_mean = normal / nn
        axis = np.cross(u_mean, target)
        len_axis = np.linalg.norm(axis)
        dot_val = np.dot(u_mean, target)
        if len_axis < 1e-6:
            if dot_val > 0:
                return (self.vecs, [0.0, 0.0, 0.0])
            else:
                flipped = np.array([np.array([v[0], -v[1], -v[2]]) for v in self.vecs])
                return (flipped, [180.0, 0.0, 0.0])
        u = axis / len_axis
        c = dot_val
        s = len_axis
        C = 1 - c
        R = np.array(
            [
                [
                    c + u[0] * u[0] * C,
                    u[0] * u[1] * C - u[2] * s,
                    u[0] * u[2] * C + u[1] * s,
                ],
                [
                    u[1] * u[0] * C + u[2] * s,
                    c + u[1] * u[1] * C,
                    u[1] * u[2] * C - u[0] * s,
                ],
                [
                    u[2] * u[0] * C - u[1] * s,
                    u[2] * u[1] * C + u[0] * s,
                    c + u[2] * u[2] * C,
                ],
            ]
        )
        euler = self.matrix_to_rotation(R.T)
        rotated = np.array([R @ v for v in self.vecs])
        return (rotated, euler)

    # Return a vector in self.vecs with the minimum cosine distance between it
    # and self.vecs[index]
    def min_cos_dist(self, index: int) -> np.ndarray:
        scores = [
            -1000
            if i == index
            else (self.vecs[index] @ self.vecs[i]) / np.linalg.norm(self.vecs[i])
            for i in range(len(self.vecs))
        ]
        max_score = max(scores)
        max_idx = scores.index(max_score)
        return self.vecs[max_idx]

    # Compute the offset distance from the origin required to ensure a single
    # pair of vectors do not have intersecting tube regions
    def axis_offset(self, v0: np.ndarray, v1: np.ndarray) -> float:
        c = np.dot(v0, v1)
        s = np.linalg.norm(np.cross(v0, v1))
        l_side = (
            self.options.outer_tube_radius * c + self.options.edge_diameter / 2
        ) / s
        l_base = (self.options.edge_diameter / 2 * (1 + c)) / s
        if s < 1e-9:
            return 1e9 if c > 0 else 0
        return max(l_side, l_base)

    # Offset required to ensure that self.vecs[index] does not intesect any
    # other
    def offset_from_single_vec(self, index: int) -> float:
        closest = self.min_cos_dist(index)
        return self.axis_offset(self.vecs[index], closest)

    # Array of vec offsets
    def compute_offsets(self) -> np.ndarray:
        return np.array([self.offset_from_single_vec(i) for i in range(len(self.vecs))])

    def largest_offset(self) -> float:
        return float(max(self.half_edge_offset))


class Polyhedron:
    def __init__(
        self,
        name: str,
        vertices: np.ndarray,
        faces: list[list[str]],
        options: GlobalOptions,
    ) -> None:
        self.name: str = name
        self.faces: list[list[str]] = faces
        self.vertices: np.ndarray = vertices
        self.options: GlobalOptions = options

        self.edges: dict[tuple[int, int], dict[str, int | float]] = self.make_edgelist()
        self.vertex_figures = self.annotate_vertex_figures()
        self.solid_offset = self.largest_offset()
        self.compute_edge_lengths()
        for vf in self.vertex_figures:
            vf.annotate_edge_names(self.edges)

    def average_edge_length(self) -> float:
        return np.sum([e["length"] for e in self.edges.values()]) / len(self.edges)

    # Largest offset among all vertex figure max offsets
    def largest_offset(self) -> float:
        if len(self.vertex_figures) == 0:
            return 0
        offsets = [vf.vertex_offset for vf in self.vertex_figures]
        return max(offsets)

    def print_offset_edge_lengths(self):
        sorted_edges = sorted(self.edges.items(), key=lambda x: x[1]["offset_length"])
        for edge, data in sorted_edges:
            print(f"{data['name']}, {data['offset_length']:.6f}")

    # Determine offsets to be subtracted from each end of a given edge
    def offset_for_edge(self, v1, v2):
        vf1 = self.vertex_figures[v1]
        vf2 = self.vertex_figures[v2]
        match self.options.offset_type:
            case OffsetType.GLOBAL:
                return (self.options.global_offset, self.options.global_offset)
            case OffsetType.PER_VERTEX:
                return (
                    vf1.vertex_offset,
                    vf2.vertex_offset,
                )
            case OffsetType.PER_HALF_EDGE:
                v1_neighbor = next(ix for ix, n in enumerate(vf1.neighbors) if n == v2)
                v2_neighbor = next(ix for ix, n in enumerate(vf2.neighbors) if n == v1)
                return (
                    vf1.half_edge_offset[v1_neighbor],
                    vf2.half_edge_offset[v2_neighbor],
                )
            case OffsetType.PER_SOLID | _:
                return (self.solid_offset, self.solid_offset)

    # rod length = scale * |v1 - v2| - offset(v1, v2) - offset(v2, v1)
    # value appended to self.edges
    def compute_edge_lengths(self):
        edge_lengths = []
        max_dist = max([np.linalg.norm(v) for v in self.vertices])
        for v1, v2 in self.edges:
            v1_offset, v2_offset = self.offset_for_edge(v1, v2)
            v1_arr = self.vertices[v1]
            v2_arr = self.vertices[v2]
            length = float(np.linalg.norm(v2_arr - v1_arr))
            scale_factor = self.options.radius / max_dist
            offset_length = scale_factor * length - v1_offset - v2_offset
            edge_lengths.append(((v1, v2), length, offset_length))

        sorted_edges = sorted(edge_lengths, key=lambda x: x[2])
        for i, (edge, length, offset_length) in enumerate(sorted_edges):
            self.edges[edge] = {
                "length": length,
                "offset_length": offset_length,
                "name": i,
            }

    # Convert facelist into edgelist
    def make_edgelist(self) -> dict[tuple[int, int], dict[str, int | float]]:
        edges = set()
        for face in self.faces:
            for v1, v2 in zip(face, face[1:] + [face[0]]):
                v1_int = int(v1)
                v2_int = int(v2)
                if v1_int < len(self.vertices) and v2_int < len(self.vertices):
                    edges.add((v1_int, v2_int) if v1_int < v2_int else (v2_int, v1_int))
        return {e: {} for e in edges}

    # Distinct vertex figures should have distinct signatures. Probably.
    def vertex_figure_signature(self, vecs) -> tuple[int, ...]:
        precision = 100000
        n = len(vecs)
        dots = sorted(
            [
                round(np.dot(vecs[i], vecs[j]) * precision)
                for i in range(n)
                for j in range(i, n)
            ]
        )
        triples = sorted(
            [
                round(np.dot(np.cross(vecs[i], vecs[j]), vecs[k]) * precision)
                for i in range(n)
                for j in range(n)
                for k in range(n)
            ]
        )
        return tuple(dots + triples)

    # Construct vertex figure list
    def annotate_vertex_figures(self) -> list[VertexFigure]:
        vertices_arr = self.vertices

        tags = {}
        tag = 0
        vertex_figures = []
        for i, vertex in enumerate(vertices_arr):
            neighbors = [
                e[1] if e[0] == i else e[0] for e in self.edges.keys() if i in e
            ]
            vecs = [(vertices_arr[n] - vertex) for n in neighbors]
            vecs = [
                v / (np.linalg.norm(v) if np.linalg.norm(v) > 0 else 1) for v in vecs
            ]
            signature = self.vertex_figure_signature(vecs)
            if signature not in tags:
                tags[signature] = tag
                tag += 1

            vertex_figures.append(
                VertexFigure(
                    vertex,
                    i,
                    np.array(vecs),
                    neighbors,
                    tags[signature],
                    self.options,
                )
            )

        return vertex_figures

    # For triangular meshes, attempt to make all faces as equilateral as
    # possible.
    def isotropize(self):
        ms = pymeshlab.MeshSet()

        ms.add_mesh(pymeshlab.Mesh(self.vertices, self.faces))

        average_edge_length = self.average_edge_length()

        ms.apply_filter(
            "meshing_isotropic_explicit_remeshing",
            iterations=8,
            targetlen=pymeshlab.PureValue(average_edge_length),
            featuredeg=15,
            adaptive=False,
        )

        mesh = ms.current_mesh()

        # Reinitialize with new mesh data
        Polyhedron.__init__(
            self,
            name=self.name,
            vertices=mesh.vertex_matrix(),
            faces=mesh.face_matrix().tolist(),
            options=self.options,
        )


class OpenscadArgs:
    def __init__(self, polyhedron: Polyhedron, options: GlobalOptions):
        self.options = options
        self.polyhedron = polyhedron

        vertices, edges, vertex_figures, eulers, tags, vertex_figure_edges = (
            self.polyhedron_options_array(polyhedron)
        )
        self.vertices = vertices
        self.edges = edges
        self.vertex_figures = vertex_figures
        self.eulers = eulers
        self.tags = tags
        self.vertex_figure_edges = vertex_figure_edges
        self.offsets = self.polyhedron_offset_array(polyhedron)

    def polyhedron_options_array(self, polyhedron: Polyhedron):
        vertices = polyhedron.vertices
        edges = polyhedron.edges.keys()
        vertex_figures = []
        eulers = []
        tags = []
        vertex_figure_edges = []

        for vertex_figure in polyhedron.vertex_figures:
            vertex_figures.append(vertex_figure.std)
            eulers.append(vertex_figure.euler)
            tags.append(vertex_figure.tag)
            vertex_figure_edges.append(vertex_figure.edges)

        return vertices, edges, vertex_figures, eulers, tags, vertex_figure_edges

    def polyhedron_offset_array(
        self, polyhedron: Polyhedron
    ) -> list[Union[np.ndarray, list[float]]]:
        match self.options.offset_type:
            case OffsetType.GLOBAL:
                value = self.options.global_offset
                return [[value] * len(vf.vecs) for vf in polyhedron.vertex_figures]
            case OffsetType.PER_VERTEX:
                return [
                    [vf.vertex_offset] * len(vf.vecs)
                    for vf in polyhedron.vertex_figures
                ]
            case OffsetType.PER_HALF_EDGE:
                return [vf.half_edge_offset for vf in polyhedron.vertex_figures]
            case OffsetType.PER_SOLID | _:
                value = polyhedron.solid_offset
                return [[value] * len(vf.vecs) for vf in polyhedron.vertex_figures]

    # Convert this object to an unholy argument list that is passed to an
    # openscad call
    def to_openscad_args(self) -> list[str]:
        args = []
        args.append(f"-DEDGE_DIAMETER={self.options.edge_diameter}")
        args.append(f"-DDIAMETER_TOLERANCE_FIT={self.options.diameter_tolerance_fit}")
        args.append(f"-DDIAMETER_TAPER_FIT={self.options.diameter_taper_fit}")
        args.append(f"-DWALL_THICKNESS={self.options.wall_thickness}")
        args.append(f"-DRADIUS={self.options.radius}")
        args.append(f"-DROD_INSET={self.options.rod_inset}")
        args.append(f"-DGLOBAL_OFFSET={self.options.global_offset}")
        args.append(
            f"-DMIN_PRINTER_OVERHANG_ANGLE={self.options.min_printer_overhang_angle}"
        )
        args.append(f'-DVERTEX_TYPE="{self.options.vertex_type.value}"')
        args.append(f'-DOFFSET_TYPE="{self.options.offset_type.value}"')
        args.append(f'-DOBJECT="{self.options.object_type.value}"')
        args.append(f"-DBY_TAG={'true' if self.options.by_tag else 'false'}")
        args.append(f"-DINDEX={self.options.index}")
        colors_str = "[" + ",".join(f'"{c}"' for c in self.options.colors) + "]"
        args.append(f"-DCOLORS={colors_str}")
        args.append(
            f"-DLABEL_VERTICES={'true' if self.options.label_vertices else 'false'}"
        )
        args.append(
            f"-DTUBULAR_SUPPORTS={'true' if self.options.tubular_supports else 'false'}"
        )
        vertices_str = (
            "["
            + ",".join(
                f"[{','.join(str(v) for v in vertex)}]" for vertex in self.vertices
            )
            + "]"
        )
        args.append(f"-Dvertices={vertices_str}")
        edges_str = (
            "[" + ",".join(f"[{start},{end}]" for start, end in self.edges) + "]"
        )
        args.append(f"-Dedges={edges_str}")
        vertex_figures_str = (
            "["
            + ",".join(
                f"[{','.join(str(v) for v in vf.tolist())}]"
                for vf in self.vertex_figures
            )
            + "]"
        )
        args.append(f"-Dvertex_figures={vertex_figures_str}")
        eulers_str = (
            "[" + ",".join(f"[{e[0]},{e[1]},{e[2]}]" for e in self.eulers) + "]"
        )
        args.append(f"-Deulers={eulers_str}")
        tags_str = "[" + ",".join(str(t) for t in self.tags) + "]"
        args.append(f"-Dtags={tags_str}")
        offsets_str = (
            "["
            + ",".join(
                "[" + ",".join(str(v) for v in o.tolist()) + "]"
                if isinstance(o, np.ndarray)
                else "[" + ",".join(str(v) for v in o) + "]"
                for o in self.offsets
            )
            + "]"
        )
        args.append(f"-Doffsets={offsets_str}")
        vertex_figure_edges_str = (
            "["
            + ",".join(
                f"[{','.join(str(e) for e in vf)}]" for vf in self.vertex_figure_edges
            )
            + "]"
        )
        args.append(f"-Dvertex_figure_edges={vertex_figure_edges_str}")
        return args


# ┌───────────────────────────────────────────────────────────────────────────┐
# │ main() and helpers                                                        │
# └───────────────────────────────────────────────────────────────────────────┘


# Parse STL files into Polyhedron objects
def parse_stl(filepath: str, options: GlobalOptions) -> Polyhedron:
    vertices_arr, indices = stl_reader.read(filepath)

    return Polyhedron(
        name="stl_model",
        vertices=vertices_arr,
        faces=indices.tolist(),
        options=options,
    )


# Parse OBJ files into Polyhedron objects
def parse_obj(filepath: str, options: GlobalOptions) -> Polyhedron:
    """Parse an OBJ file and return a Polyhedron object."""
    vertices = []
    faces = []

    with open(filepath, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            parts = line.split()
            if not parts:
                continue

            if parts[0] == "v":
                vertex = [float(x) for x in parts[1:4]]
                vertices.append(vertex)
            elif parts[0] == "f":
                # OBJ uses 1-based indexing, we convert to 0-based
                face = []
                for vert_def in parts[1:]:
                    indices = vert_def.split("/")[0]
                    face.append(int(indices) - 1)
                faces.append(face)
                print(face)
    if not vertices:
        raise ValueError(f"No vertices found in OBJ file: {filepath}")

    return Polyhedron(
        name=os.path.basename(filepath).replace(".obj", ""),
        vertices=np.array(vertices, dtype=float),
        faces=faces,
        options=options,
    )


def save_histogram(polyhedron: Polyhedron, output_dir: str):
    offset_lengths = [data["offset_length"] for data in polyhedron.edges.values()]
    offset_lengths.sort()

    plt.figure(figsize=(24, 12))
    plt.bar(range(len(polyhedron.edges)), offset_lengths, edgecolor="black")
    plt.title("Rod Lengths Distribution")
    plt.xlabel("Rod Index")
    plt.ylabel("Rod Length")
    plt.xticks(rotation=45, ha="right")
    plt.tight_layout()
    plt.savefig(f"{output_dir}/histogram.png")
    plt.close()


def call_openscad_for_vertex(polyhedron, options, output_dir, vertex_index):
    vertex_options = copy.deepcopy(options)
    vertex_options.object_type = ObjectType.VERTEX_HOLDER
    vertex_options.index = vertex_index
    openscad_args = OpenscadArgs(polyhedron, vertex_options)
    command = (
        ["openscad"]
        + openscad_args.to_openscad_args()
        + ["-o", f"{output_dir}/v{vertex_index:03}.stl", "scad/interface.scad"]
    )
    if not options.dry_run:
        subprocess.run(command)


# Chunk a list into parts of size n (last part has size len(lst) % n)
def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i : i + n]


# Convert polyhedron edge list into a set of svgs for a laser cutter
def save_svg(polyhedron: Polyhedron, output_dir: str):
    edges = sorted(polyhedron.edges.items(), key=lambda x: x[1]["offset_length"])
    diameter = polyhedron.options.edge_diameter
    height = polyhedron.options.rod_stock_length

    rods_per_cut = (
        len(edges)
        if polyhedron.options.rods_per_cut == 0
        else polyhedron.options.rods_per_cut
    )

    for i, edges_chunk in enumerate(chunks(edges, rods_per_cut)):
        width = diameter * len(edges_chunk)
        scaled_diameter = diameter / width
        surface = cairo.SVGSurface(f"{output_dir}/lasercut{i:03}.svg", width, height)
        surface.set_document_unit(cairo.SVGUnit.MM)
        context = cairo.Context(surface)
        context.scale(width, height)

        scaled_zero_height = 1 - edges_chunk[0][1]["offset_length"] / height
        context.move_to(0, scaled_zero_height)
        context.line_to(scaled_diameter, scaled_zero_height)

        for i, (edge, data) in enumerate(edges_chunk[1:], start=1):
            scaled_height = 1 - data["offset_length"] / height
            context.line_to(scaled_diameter * i, scaled_height)
            context.line_to(scaled_diameter * (i + 1), scaled_height)
        context.line_to(1, 1)
        context.line_to(0, 1)
        context.fill_preserve()
        surface.finish()
        surface.flush()


# Call openscad in parallel each vertex and save stls.
def call_openscad(
    polyhedron: Polyhedron,
    options: GlobalOptions,
    generate_outputs: bool = False,
    output_dir: str = "out/",
):

    if generate_outputs:
        start_time = time.time()
        os.makedirs(output_dir, exist_ok=True)
        with open(f"{output_dir}/lengths.csv", "w") as f:
            for edge, data in sorted(
                polyhedron.edges.items(), key=lambda x: x[1]["offset_length"]
            ):
                f.write(f"{data['name']},{data['offset_length']:.6f}\n")

        with open(f"{output_dir}/vertices.csv", "w") as f:
            for vf in polyhedron.vertex_figures:
                index = vf.vertex_index
                degree = len(vf.neighbors)
                edge_names = ",".join(str(e) for e in vf.edges)
                f.write(f"{index},{degree},{edge_names}\n")

        save_histogram(polyhedron, output_dir)
        save_svg(polyhedron, output_dir)

        call_with_args = partial(
            call_openscad_for_vertex, polyhedron, options, output_dir
        )
        with ProcessPoolExecutor() as executor:
            list(executor.map(call_with_args, range(len(polyhedron.vertices))))
        time_delta = time.time() - start_time
        print(
            f"{len(polyhedron.vertices)} vertices generated in {time_delta:.2f} seconds"
        )

    else:
        openscad_args = OpenscadArgs(polyhedron, options)
        command = (
            ["openscad"] + openscad_args.to_openscad_args() + ["scad/interface.scad"]
        )
        if not options.dry_run:
            subprocess.run(command)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", "-f", required=True, help="Specific file to process")
    parser.add_argument(
        "--output-dir", default="out/", help="Output directory for generated files"
    )
    parser.add_argument(
        "--generate-outputs",
        action="store_true",
        help="Generate outputs to output directory",
    )

    parser.add_argument("--edge-diameter", type=float, help="Diameter of edge struts")
    parser.add_argument(
        "--diameter-tolerance-fit",
        type=float,
        help="Additional tolerance added to interior diameter of generated vertex holders",
    )
    parser.add_argument(
        "--diameter-taper-fit",
        type=float,
        help="Interior diameter of generated vertex holders decrease by this amount towards their bases",
    )
    parser.add_argument(
        "--wall-thickness", type=float, help="Vertex holder wall thickness"
    )
    parser.add_argument("--radius", type=float, help="Radius of your solid")
    parser.add_argument(
        "--rod-inset", type=float, help="Vertex holders will inset edges by this amount"
    )
    parser.add_argument(
        "--rod-stock-length", type=float, help="Height of rod stock material"
    )
    parser.add_argument(
        "--rods-per-cut",
        type=int,
        help="Number of rods per cut. If 0 (default), then cut all rods",
    )
    parser.add_argument(
        "--global-offset",
        type=float,
        help="If --offset-type is global, then set all offsets to this value",
    )
    parser.add_argument(
        "--min-printer-overhang-angle",
        type=float,
        help="Minimum printer overhang angle",
    )
    parser.add_argument(
        "--vertex-type",
        choices=["tubular", "conical"],
        help="Tubular vertices require less material. Conical vertices are bulky but strong.",
    )
    parser.add_argument(
        "--offset-type",
        choices=["per_solid", "global", "per_vertex", "per_half_edge"],
        help="Offset type. per_solid computes an identical offset for each vertex in your solid. "
        "per_vertex computes a unique offset for each vertex. "
        "per_half_edge computes a unique offset for each (vertex, edge) pair. "
        "Global sets all offsets to the value of --global-offset",
    )
    parser.add_argument(
        "--object-type",
        choices=["vertex_holder", "solid", "all_vertex_holders"],
        help="Preview either a single vertex holder (selected with --index), "
        "an entire solid, or all vertex holders at once",
    )
    parser.add_argument("--index", help="Preview vertex with this index")
    parser.add_argument("--colors", nargs="+", help="Color scheme for previews")

    parser.add_argument(
        "--group-identical-vertices",
        action="store_true",
        help="Group vertices that are equivalent under rotations",
    )
    parser.add_argument(
        "--label-vertices",
        action="store_true",
        help="Label vertices in output",
    )
    parser.add_argument(
        "--no-tubular-supports",
        action="store_true",
        help="Disable supports for tubular vertices",
    )
    parser.add_argument(
        "--isotropize",
        action="store_true",
        help="Enable isotropic remeshing",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Don't produce stl outputs",
    )

    args = parser.parse_args()
    options_dict = {
        "edge_diameter": args.edge_diameter,
        "diameter_tolerance_fit": args.diameter_tolerance_fit,
        "diameter_taper_fit": args.diameter_taper_fit,
        "wall_thickness": args.wall_thickness,
        "radius": args.radius,
        "rod_inset": args.rod_inset,
        "global_offset": args.global_offset,
        "rod_stock_length": args.rod_stock_length,
        "rods_per_cut": args.rods_per_cut,
        "min_printer_overhang_angle": args.min_printer_overhang_angle,
        "vertex_type": args.vertex_type,
        "offset_type": args.offset_type,
        "object_type": args.object_type,
        "by_tag": args.group_identical_vertices,
        "index": args.index,
        "colors": args.colors,
        "label_vertices": args.label_vertices,
        "tubular_supports": not args.no_tubular_supports,
        "dry_run": args.dry_run,
    }
    options_dict = {k: v for k, v in options_dict.items() if v is not None}
    if "vertex_type" in options_dict:
        options_dict["vertex_type"] = VertexType(options_dict["vertex_type"])
    if "offset_type" in options_dict:
        options_dict["offset_type"] = OffsetType(options_dict["offset_type"])
    if "object_type" in options_dict:
        options_dict["object_type"] = ObjectType(options_dict["object_type"])
    options = GlobalOptions(**options_dict)

    file_ext = os.path.splitext(args.file)[1].lower()
    if file_ext == ".stl":
        polyhedron = parse_stl(args.file, options)
    elif file_ext == ".obj":
        polyhedron = parse_obj(args.file, options)
    else:
        raise ValueError(f"Unsupported file format: {file_ext}. Use .stl or .obj")

    if args.isotropize:
        polyhedron.isotropize()
    call_openscad(polyhedron, options, args.generate_outputs, args.output_dir)


if __name__ == "__main__":
    main()
