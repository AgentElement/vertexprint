import Matrix, { SingularValueDecomposition } from "ml-matrix";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

let VERTEXPRINT_SOURCE: string | null = null;

async function loadSource(): Promise<string> {
    if (VERTEXPRINT_SOURCE !== null) {
        return VERTEXPRINT_SOURCE;
    }
    VERTEXPRINT_SOURCE = await fetch("vertexprint.scad").then((r) => r.text());
    return VERTEXPRINT_SOURCE;
}

export class VertexPrintParams {
    edgeDiameter: number;
    diameterTolerance: number;
    diameterTaper: number;
    wallThickness: number;
    scale: number;
    rodInset: number;
    minPrinterOverhangAngle: number;
    offsetType: string;
    manualOffset: number;
    renderQuality: "preview" | "final";
};

export class VertexPrintOutputs {
    polyhedron: Polyhedron;
    stls: ArrayBuffer[];

    constructor(polyhedron: Polyhedron, stls: ArrayBuffer[]) {
        this.polyhedron = polyhedron;
        this.stls = stls;
    }
}

export async function vertexPrint(
    name: string,
    data: ArrayBuffer,
    options: VertexPrintParams,
): Promise<VertexPrintOutputs> {
    const polyhedron = polyhedronFromFile(name, data, options);
    if (!polyhedron) {
        throw new Error(`Failed to parse polyhedron from ${name}`);
    }
    const scadSource = await loadSource();
    const args = new OpenscadArgs(polyhedron, options);
    const count = polyhedron.vertexFigures.length;
    const cliArgs: string[][] = [];
    for (let i = 0; i < count; i++) {
        cliArgs.push(args.toOpenscadArgs(i))
    }
    const stls = await renderVertices(polyhedron.name, scadSource, cliArgs);
    return new VertexPrintOutputs(polyhedron, stls);
}

// Render vertices in parallel by processing contiguous chunks of vertices
// through a pool of web workers.
async function renderVertices(
    name: string,
    scadSource: string,
    cliArgs: string[][],
): Promise<ArrayBuffer[]> {
    const count = cliArgs.length;
    const results: ArrayBuffer[] = new Array(count);
    if (count === 0) return results;

    const workerCount = Math.min(navigator.hardwareConcurrency || 1, count);
    const chunkSize = Math.ceil(count / workerCount);

    const workerUrl = new URL("./worker.js", import.meta.url);
    const workerPromises: Promise<void>[] = [];

    for (let w = 0; w < workerCount; w++) {
        const start = w * chunkSize;
        const end = Math.min(start + chunkSize, count);
        if (start >= end) break;

        const worker = new Worker(workerUrl, { type: "module" });

        workerPromises.push(new Promise<void>((resolve, reject) => {
            let pending = end - start;
            const onMessage = (e: MessageEvent) => {
                const m = e.data;
                if (m.type === "error") {
                    // TODO: visual cue when an openscad render fails
                    worker.removeEventListener("message", onMessage);
                    worker.terminate();
                    reject(new Error(m.message));
                    return;
                }
                results[m.index] = m.buffer;
                pending--;
                if (pending === 0) {
                    worker.removeEventListener("message", onMessage);
                    worker.terminate();
                    resolve();
                }
            };
            worker.addEventListener("message", onMessage);
            for (let i = start; i < end; i++) {
                worker.postMessage({
                    type: "render",
                    index: i,
                    cliArgs: cliArgs[i],
                    name,
                    source: scadSource,
                });
            }
        }));
    }
    await Promise.all(workerPromises);
    return results;
}


function polyhedronFromFile(name: string, data: ArrayBuffer, options: VertexPrintParams) {
    let polyhedron: Polyhedron;
    try {
        const isObj = name.toLowerCase().endsWith(".obj");
        polyhedron = isObj
            ? parseObj(data, name, options)
            : parseStl(data, name, options);
    } catch (e) {
        // TODO: show user an error message
        console.error("Failed to load", name, e);
        return;
    }
    return polyhedron;
}

// Parse OBJ files into Polyhedron objects.
function parseObj(
    data: ArrayBuffer,
    filename: string,
    options: VertexPrintParams,
): Polyhedron {
    const text = new TextDecoder().decode(data);
    const vertices: number[][] = [];
    const faces: string[][] = [];

    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
            continue;
        }

        const parts = line.split(/\s+/);
        if (parts.length === 0) {
            continue;
        }

        if (parts[0] === "v") {
            const vertex = [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])];
            vertices.push(vertex);
        } else if (parts[0] === "f") {
            // OBJ uses 1-based indexing, we convert to 0-based
            const face: string[] = [];
            for (let i = 1; i < parts.length; i++) {
                const vertDef = parts[i];
                const indices = vertDef.split("/")[0];
                face.push(String(parseInt(indices, 10) - 1));
            }
            faces.push(face);
        }
    }
    if (vertices.length === 0) {
        throw new Error(`No vertices found in OBJ file: ${filename}`);
    }

    // os.path.basename(filepath).replace(".obj", "")
    const base = filename.split(/[\\/]/).pop() ?? filename;
    const name = base.replace(/\.obj$/i, "");

    return new Polyhedron(
        name,
        faces,
        new Matrix(vertices),
        options,
    );
}

// Parse STL files into Polyhedron objects.
function parseStl(data: ArrayBuffer, filename: string, options: VertexPrintParams): Polyhedron {
    const parsed = new STLLoader().parse(data);
    // Three.js's mergeVertices function deduplicates by all vertex attributes.
    // Keep only the position attribute, to prevent vertices with per-face
    // normals/colors/other junk from not merging.
    for (const name of Object.keys(parsed.attributes)) {
        if (name !== "position") {
            parsed.deleteAttribute(name);
        }
    }
    const geometry = mergeVertices(parsed);
    const position = geometry.attributes.position;
    const index = geometry.index;
    if (!position || !index) {
        throw new Error("No positions found in STL data");
    }

    const arr = position.array as ArrayLike<number>;
    const vertices: number[][] = [];
    for (let i = 0; i < position.count; i++) {
        vertices.push([arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]]);
    }

    const faces: string[][] = [];
    for (let i = 0; i < index.count; i += 3) {
        faces.push([String(index.getX(i)), String(index.getX(i + 1)), String(index.getX(i + 2))]);
    }

    return new Polyhedron(filename, faces, new Matrix(vertices), options);
}

// For some godforsaken reason ml-matrix does not provide cross products.
function cross(a: Matrix, b: Matrix): Matrix {
    const [ax, ay, az] = a.to1DArray();
    const [bx, by, bz] = b.to1DArray();
    return Matrix.columnVector([
        ay * bz - az * by,
        az * bx - ax * bz,
        ax * by - ay * bx,
    ]);
}


class VertexFigure {
    vertex: Matrix;
    vertexIndex: number;
    vecs: Matrix;
    neighbors: number[];
    std: Matrix;
    euler: [number, number, number];
    options: VertexPrintParams;

    halfEdgeOffset: number[];
    vertexOffset: number;

    edges: number[] = [];
    tag: number;

    constructor(
        vertex: Matrix,
        vertexIndex: number,
        vecs: Matrix,
        neighbors: number[],
        tag: number,
        options: VertexPrintParams,
    ) {
        this.vertex = vertex;
        this.vertexIndex = vertexIndex;
        this.vecs = vecs;
        this.neighbors = neighbors;
        this.tag = tag;
        this.options = options;

        this.std = vecs;
        this.euler = [0.0, 0.0, 0.0];

        this.halfEdgeOffset = this.computeOffsets();
        this.vertexOffset = this.largestOffset();

        const planeNormal = this.planeNormal();
        const normal = this.normal();
        if (normal !== null && planeNormal !== null) {
            const direction = planeNormal.dot(normal) > 0 ? 1 : -1;
            const [rotated, euler] = this.reorientTo(
                Matrix.mul(planeNormal, direction),
            );
            this.std = rotated;
            this.euler = euler;
        }

    }

    // flag
    annotateEdgeNames(edges: Map<string, { name: number }>): void {
        this.edges = [];
        for (const neighbor of this.neighbors) {
            const edge: [number, number] =
                this.vertexIndex < neighbor
                    ? [this.vertexIndex, neighbor]
                    : [neighbor, this.vertexIndex];
            this.edges.push(edges.get(edge.join(","))!.name);
        }
    }

    normalizable(): boolean {
        return this.normal() !== null;
    }

    normal(): Matrix | null {
        const n = Matrix.columnVector(this.vecs.sum("column"));
        const norm = n.norm();
        return norm > 1e-10 ? Matrix.mul(n, 1 / norm) : null;
    }

    // flag
    planeNormal(): Matrix | null {
        const v = this.vecs.clone();
        if (this.options.offsetType === "auto_per_edge") {
            // vecs *= (half_edge_offset[:, None] + rod_inset): scale each row.
            const factors = Matrix.columnVector(
                this.halfEdgeOffset.map((o) => o + this.options.rodInset),
            ).repeat({ columns: v.columns });
            v.mul(factors);
        }
        if (v.rows < 3) {
            return null;
        }
        // centered = vecs - np.mean(vecs, axis=0)
        v.center("column");
        // _, _, vh = np.linalg.svd(centered); normal = vh[2]
        const svd = new SingularValueDecomposition(v);
        const diag = svd.diagonal;
        const V = svd.rightSingularVectors;
        let minIndex = 0;
        let min = diag[0];
        for (let i = 1; i < diag.length; i++) {
            if (diag[i] < min) {
                min = diag[i];
                minIndex = i;
            }
        }
        const normal = V.getColumnVector(minIndex);
        return Matrix.mul(normal, -1 / normal.norm());
    }

    matrixToRotation(R: Matrix): [number, number, number] {
        const sy = Math.sqrt(R.get(0, 0) ** 2 + R.get(1, 0) ** 2);
        const singular = sy < 1e-6;
        if (!singular) {
            return [
                Math.atan2(R.get(2, 1), R.get(2, 2)),
                Math.atan2(-R.get(2, 0), sy),
                Math.atan2(R.get(1, 0), R.get(0, 0)),
            ];
        } else if (R.get(2, 0) < 0) {
            // y = 90 degrees
            return [Math.atan2(-R.get(1, 2), R.get(1, 1)), Math.PI / 2, 0.0];
        } else {
            // y = -90 degrees
            return [Math.atan2(-R.get(1, 2), R.get(1, 1)), -Math.PI / 2, 0.0];
        }
    }

    // Orient normal to target, then apply this rotation to all vectors in the
    // figure
    reorientTo(
        normal: Matrix,
        target: Matrix = Matrix.columnVector([0.0, 0.0, 1.0]),
    ): [Matrix, [number, number, number]] {
        const nn = normal.norm();
        if (nn < 1e-9) {
            return [this.vecs, [0.0, 0.0, 0.0]];
        }
        const uMean = Matrix.mul(normal, 1 / nn);
        const axis = cross(uMean, target);
        const lenAxis = axis.norm();
        const dotVal = uMean.dot(target);
        if (lenAxis < 1e-6) {
            if (dotVal > 0) {
                return [this.vecs, [0.0, 0.0, 0.0]];
            } else {
                // Flip y and z of every row vector.
                const sign = new Matrix([[1, -1, -1]]).repeat({
                    rows: this.vecs.rows,
                });
                const flipped = Matrix.mul(this.vecs, sign);
                return [flipped, [Math.PI, 0.0, 0.0]];
            }
        }
        const u = axis.mul(1 / lenAxis);
        const u0 = u.get(0, 0);
        const u1 = u.get(1, 0);
        const u2 = u.get(2, 0);
        const c = dotVal;
        const s = lenAxis;
        const C = 1 - c;
        const R = new Matrix([
            [c + u0 * u0 * C, u0 * u1 * C - u2 * s, u0 * u2 * C + u1 * s],
            [u1 * u0 * C + u2 * s, c + u1 * u1 * C, u1 * u2 * C - u0 * s],
            [u2 * u0 * C - u1 * s, u2 * u1 * C + u0 * s, c + u2 * u2 * C],
        ]);
        const RT = R.transpose();
        const euler = this.matrixToRotation(RT);
        const rotated = this.vecs.mmul(RT);
        return [rotated, euler];
    }

    minCosDist(index: number): Matrix {
        const scores: number[] = [];
        const vIndex = this.vecs.getRowVector(index);
        for (let i = 0; i < this.vecs.rows; i++) {
            if (i === index) {
                scores.push(-1000);
            } else {
                const vi = this.vecs.getRowVector(i);
                scores.push(vIndex.dot(vi) / vi.norm());
            }
        }
        let max = scores[0];
        let maxIndex = 0;
        for (let i = 1; i < scores.length; i++) {
            if (scores[i] > max) {
                max = scores[i];
                maxIndex = i;
            }
        }
        return this.vecs.getRowVector(maxIndex);
    }

    axisOffset(v0: Matrix, v1: Matrix): number {
        const c = v0.dot(v1);
        const s = cross(v0, v1).norm();
        const outerTubeRadius =
            this.options.edgeDiameter / 2 + this.options.wallThickness;
        const lSide =
            (outerTubeRadius * c + this.options.edgeDiameter / 2) / s;
        const lBase = (this.options.edgeDiameter / 2 * (1 + c)) / s;
        if (s < 1e-9) {
            return c > 0 ? 1e9 : 0;
        }
        return Math.max(lSide, lBase);
    }

    offsetFromSingleVec(index: number): number {
        const closest = this.minCosDist(index);
        return this.axisOffset(
            this.vecs.getRowVector(index),
            closest,
        );
    }

    computeOffsets(): number[] {
        const out: number[] = [];
        for (let i = 0; i < this.vecs.rows; i++) {
            out.push(this.offsetFromSingleVec(i));
        }
        return out;
    }

    largestOffset(): number {
        return Math.max(...this.halfEdgeOffset);
    }
}

type EdgeField = { length: number; offsetLength: number; name: number, offsets: [number, number] };

class Polyhedron {
    name: string;
    faces: string[][];
    vertices: Matrix;
    options: VertexPrintParams;

    edges: Map<string, EdgeField>;
    vertexFigures: VertexFigure[];
    solidOffset: number;

    constructor(
        name: string,
        faces: string[][],
        vertices: Matrix,
        options: VertexPrintParams,
    ) {
        this.name = name;
        this.faces = faces;
        this.vertices = vertices;
        this.options = options;

        this.edges = this.makeEdgelist();
        this.vertexFigures = this.annotateVertexFigures();
        this.solidOffset = this.largestOffset();
        this.computeEdgeLengths();
        for (const vf of this.vertexFigures) {
            vf.annotateEdgeNames(this.edges);
        }
    }

    averageEdgeLength(): number {
        if (this.edges.size === 0) {
            return 0;
        }
        let total = 0;
        for (const e of this.edges.values()) {
            total += e.length;
        }
        return total / this.edges.size;
    }

    // Largest offset among all vertex figure max offsets
    largestOffset(): number {
        if (this.vertexFigures.length === 0) {
            return 0;
        }
        let max = this.vertexFigures[0].vertexOffset;
        for (let i = 1; i < this.vertexFigures.length; i++) {
            if (this.vertexFigures[i].vertexOffset > max) {
                max = this.vertexFigures[i].vertexOffset;
            }
        }
        return max;
    }

    // Determine offsets to be subtracted from each end of a given edge
    offsetForEdge(v1: number, v2: number): [number, number] {
        const vf1 = this.vertexFigures[v1];
        const vf2 = this.vertexFigures[v2];
        switch (this.options.offsetType) {
            case "fixed":
                return [this.options.manualOffset, this.options.manualOffset];
            case "auto_per_vertex":
                return [vf1.vertexOffset, vf2.vertexOffset];
            case "auto_per_edge": {
                const i1 = vf1.neighbors.findIndex((n) => n === v2);
                const i2 = vf2.neighbors.findIndex((n) => n === v1);
                return [
                    vf1.halfEdgeOffset[i1],
                    vf2.halfEdgeOffset[i2],
                ];
            }
            case "auto_global":
            default:
                return [this.solidOffset, this.solidOffset];
        }
    }

    // rod length = scale * |v1 - v2| - offset(v1, v2) - offset(v2, v1)
    // value appended to self.edges
    computeEdgeLengths(): void {
        type KLO = { key: string; length: number; offsetLength: number, offsets: [number, number] };
        const klo: KLO[] = [];
        for (const key of this.edges.keys()) {
            const [v1, v2] = key.split(",").map(Number);
            const [v1_offset, v2_offset] = this.offsetForEdge(v1, v2);
            const v1_arr = this.vertices.getRowVector(v1);
            const v2_arr = this.vertices.getRowVector(v2);
            const length = Matrix.sub(v2_arr, v1_arr).norm();
            const offsetLength = this.options.scale * length - v1_offset - v2_offset;
            console.log(this.options.scale * length)
            klo.push({ key, length, offsetLength, offsets: [v1_offset, v2_offset] });
        }

        klo.sort((x, y) => x.offsetLength - y.offsetLength);
        for (let i = 0; i < klo.length; i++) {
            const { key, length, offsetLength, offsets } = klo[i];
            this.edges.set(key, { length, offsetLength, name: i, offsets });
        }
    }

    // Convert facelist into edgelist
    makeEdgelist(): Map<string, EdgeField> {
        const edges = new Map<string, EdgeField>();
        for (const face of this.faces) {
            for (let k = 0; k < face.length; k++) {
                const v1 = parseInt(face[k], 10);
                const v2 = parseInt(face[(k + 1) % face.length], 10);
                if (Number.isNaN(v1) || Number.isNaN(v2)) {
                    continue;
                }
                if (v1 < this.vertices.rows && v2 < this.vertices.rows) {
                    const key =
                        v1 < v2 ? `${v1},${v2}` : `${v2},${v1}`;
                    if (!edges.has(key)) {
                        edges.set(key, { length: 0, offsetLength: 0, name: -1, offsets: [0, 0] });
                    }
                }
            }
        }
        return edges;
    }

    // Distinct vertex figures should have distinct signatures. Probably.
    vertexFigureSignature(vecs: Matrix): string {
        const precision = 100000;
        const n = vecs.rows;
        const rows: Matrix[] = [];
        for (let i = 0; i < n; i++) {
            rows.push(vecs.getRowVector(i));
        }
        const dots: number[] = [];
        for (let i = 0; i < n; i++) {
            for (let j = i; j < n; j++) {
                dots.push(Math.round(rows[i].dot(rows[j]) * precision));
            }
        }
        const triples: number[] = [];
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                for (let k = 0; k < n; k++) {
                    triples.push(
                        Math.round(cross(rows[i], rows[j]).dot(rows[k]) * precision),
                    );
                }
            }
        }
        dots.sort((a, b) => a - b);
        triples.sort((a, b) => a - b);
        return dots.join(",") + "|" + triples.join(",");
    }

    // Construct vertex figure list
    annotateVertexFigures(): VertexFigure[] {
        const tags = new Map<string, number>();
        let tag = 0;
        const vertexFigures: VertexFigure[] = [];

        for (let i = 0; i < this.vertices.rows; i++) {
            const neighbors: number[] = [];
            for (const key of this.edges.keys()) {
                const [a, b] = key.split(",").map(Number);
                if (a === i) {
                    neighbors.push(b);
                } else if (b === i) {
                    neighbors.push(a);
                }
            }
            const vertex = this.vertices.getRowVector(i);
            // Direction vectors from this vertex to each neighbor, normalized.
            const vecs = new Matrix(
                neighbors.map((n) => {
                    const nb = this.vertices.getRowVector(n);
                    const diff = Matrix.sub(nb, vertex);
                    const norm = diff.norm();
                    const f = norm > 0 ? 1 / norm : 1;
                    return Matrix.mul(diff, f).to1DArray();
                }),
            );

            const signature = this.vertexFigureSignature(vecs);
            if (!tags.has(signature)) {
                tags.set(signature, tag);
                tag++;
            }

            const t = tags.get(signature)!;
            vertexFigures.push(
                new VertexFigure(
                    vertex,
                    i,
                    vecs,
                    neighbors,
                    t,
                    this.options,
                ),
            );
        }

        return vertexFigures;
    }
}

class OpenscadArgs {
    vertices: Matrix;
    edges: number[][];
    vertexFigures: Matrix[];
    eulers: number[][];
    tags: number[];
    vertexFigureEdges: number[][];
    offsets: number[][];
    options: VertexPrintParams

    constructor(polyhedron: Polyhedron, options: VertexPrintParams) {
        const {
            vertices,
            edges,
            vertexFigures,
            eulers,
            tags,
            vertexFigureEdges,
        } = this.polyhedronOptionsArray(polyhedron);

        this.vertices = vertices;
        this.edges = edges;
        this.vertexFigures = vertexFigures;
        this.eulers = eulers;
        this.tags = tags;
        this.vertexFigureEdges = vertexFigureEdges;
        this.offsets = this.polyhedronOffsetArray(polyhedron);

        this.options = options
    }

    polyhedronOptionsArray(polyhedron: Polyhedron): {
        vertices: Matrix;
        edges: number[][];
        vertexFigures: Matrix[];
        eulers: number[][];
        tags: number[];
        vertexFigureEdges: number[][];
    } {
        const vertices = polyhedron.vertices;
        const edges: number[][] = [];
        for (const key of polyhedron.edges.keys()) {
            const [v1, v2] = key.split(",").map(Number);
            edges.push([v1, v2]);
        }
        const vertexFigures: Matrix[] = [];
        const eulers: number[][] = [];
        const tags: number[] = [];
        const vertexFigureEdges: number[][] = [];

        for (const vf of polyhedron.vertexFigures) {
            vertexFigures.push(vf.std);
            eulers.push(vf.euler);
            tags.push(vf.tag);
            vertexFigureEdges.push(vf.edges);
        }

        return { vertices, edges, vertexFigures, eulers, tags, vertexFigureEdges };
    }

    polyhedronOffsetArray(polyhedron: Polyhedron): number[][] {
        switch (polyhedron.options.offsetType) {
            case "fixed": {
                const value = polyhedron.options.manualOffset;
                return polyhedron.vertexFigures.map((vf) =>
                    Array(vf.vecs.rows).fill(value),
                );
            }
            case "auto_per_vertex": {
                return polyhedron.vertexFigures.map((vf) =>
                    Array(vf.vecs.rows).fill(vf.vertexOffset),
                );
            }
            case "auto_per_edge": {
                return polyhedron.vertexFigures.map((vf) =>
                    [...vf.halfEdgeOffset],
                );
            }
            case "auto_global":
            default: {
                const value = polyhedron.solidOffset;
                return polyhedron.vertexFigures.map((vf) =>
                    Array(vf.vecs.rows).fill(value),
                );
            }
        }
    }

    // Convert a vertex to an unholy argument list that is passed to an
    // openscad call
    toOpenscadArgs(vertex: number): string[] {
        const args: string[] = [];
        args.push(`-DEDGE_DIAMETER=${this.options.edgeDiameter}`);
        args.push(`-DDIAMETER_TOLERANCE_FIT=${this.options.diameterTolerance}`);
        args.push(`-DDIAMETER_TAPER_DECREASE=${this.options.diameterTaper}`);
        args.push(`-DWALL_THICKNESS=${this.options.wallThickness}`);
        args.push(`-DROD_INSET=${this.options.rodInset}`);
        args.push(
            `-DMIN_PRINTER_OVERHANG_ANGLE=${this.options.minPrinterOverhangAngle}`,
        );

        const fparams = {
            // fa, fs
            "preview": [12, 2],
            "final": [30, 0.2],
        }

        args.push(`-DFA=${fparams[this.options.renderQuality][0]}`)
        args.push(`-DFS=${fparams[this.options.renderQuality][1]}`)

        args.push(`-Dindex=${vertex}`)
        // vertexFigures (std)
        const vertexFigure = this.vertexFigures[vertex]
        const rows: string[] = [];
        for (let i = 0; i < vertexFigure.rows; i++) {
            rows.push(`[${vertexFigure.getRow(i).join(",")}]`);
        }
        const vfStr = `[${rows.join(",")}]`;
        args.push(`-Dvertex_figure=${vfStr}`);

        const tag = this.tags[vertex]
        args.push(`-Dtag=${tag}`);

        const offset = `[${this.offsets[vertex].join(",")}]`;
        args.push(`-Doffsets=${offset}`);

        const vertexFigureEdges = `[${this.vertexFigureEdges[vertex].join(",")}]`;
        args.push(`-Dvertex_figure_edge=${vertexFigureEdges}`);

        return args;
    }
}
