import Matrix, { SingularValueDecomposition } from "ml-matrix";

export class VertexPrintParams {
    edgeDiameter: number;
    diameterTolerance: number;
    diameterTaper: number;
    wallThickness: number;
    scale: number;
    rodInset: number;
    maxPrinterOverhangAngle: number;
    offsetType: string;
    manualOffset: number;
};

export function vertexPrint(data: ArrayBuffer, params: VertexPrintParams): VertexPrintOutputs {
    return
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
            return [Math.atan2(-R.get(1, 2), R.get(1, 1)), 90.0, 0.0];
        } else {
            // y = -90 degrees
            return [Math.atan2(-R.get(1, 2), R.get(1, 1)), -90.0, 0.0];
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
                return [flipped, [180.0, 0.0, 0.0]];
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

type EdgeField = { length: number; offsetLength: number; name: number };

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
        let maxDist = 0;
        for (let i = 0; i < this.vertices.rows; i++) {
            const d = this.vertices.getRowVector(i).norm();
            if (d > maxDist) {
                maxDist = d;
            }
        }
        const scale = this.options.scale / maxDist;

        type KLO = { key: string; length: number; offsetLength: number };
        const klo: KLO[] = [];
        for (const key of this.edges.keys()) {
            const [v1, v2] = key.split(",").map(Number);
            const [v1_offset, v2_offset] = this.offsetForEdge(v1, v2);
            const v1_arr = this.vertices.getRowVector(v1);
            const v2_arr = this.vertices.getRowVector(v2);
            const length = Matrix.sub(v2_arr, v1_arr).norm();
            const offsetLength = scale * length - v1_offset - v2_offset;
            klo.push({ key, length, offsetLength });
        }

        klo.sort((x, y) => x.offsetLength - y.offsetLength);
        for (let i = 0; i < klo.length; i++) {
            const { key, length, offsetLength } = klo[i];
            this.edges.set(key, { length, offsetLength, name: i });
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
                        edges.set(key, { length: 0, offsetLength: 0, name: -1 });
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

class OpenScadArgs {
}

class VertexPrintOutputs {
}
