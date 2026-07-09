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
        if (this.options.offsetType === "PerHalfEdge") {
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
        // rotated = np.array([R @ v for v in self.vecs]) -- apply R to each
        // row of the N×3 matrix is a single product with R transpose.
        const rotated = this.vecs.mmul(RT);
        return [rotated, euler];
    }

    minCosDist(index: number): Matrix {
        const scores: number[] = [];
        const vIndex = Matrix.columnVector(this.vecs.getRow(index));
        for (let i = 0; i < this.vecs.rows; i++) {
            if (i === index) {
                scores.push(-1000);
            } else {
                const vi = Matrix.columnVector(this.vecs.getRow(i));
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
        return Matrix.columnVector(this.vecs.getRow(maxIndex));
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
            Matrix.columnVector(this.vecs.getRow(index)),
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

class Polyhedron {
}

class OpenScadArgs {
}

class VertexPrintOutputs {
}
