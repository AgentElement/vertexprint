import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { VertexPrintOutputs, VertexPrintParams, vertexPrint } from "./core"
import Matrix from "ml-matrix";
import JSZip from "jszip";

const DATA_DIR = "data/";
const DEFAULT_MODEL = "DisdyakisTriacontahedron.obj";

const V_FG = cssVar("--color-v-fg");
const V_BG = cssVar("--color-v-bg");
const V_DARK = cssVar("--color-v-dark");
const V_BORDER = cssVar("--color-v-border");
const V_BLUE = cssVar("--color-v-blue");

const PARAMS = new VertexPrintParams();

// utils ---
function clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
}

function cssVar(name: string): number {
    const hex = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
    return parseInt(hex.replace("#", ""), 16);
}

function makeOrientationCube(renderer: THREE.WebGLRenderer):
    [THREE.Mesh, THREE.Scene, THREE.OrthographicCamera] {
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera();
    cam.position.set(0, 0, 1);

    const FACE_COLOR = '#' + V_BORDER.toString(16).padStart(6, '0');
    const TEXT_COLOR = '#' + V_FG.toString(16).padStart(6, '0');
    const TEXTURE_SIZE = 256;

    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    function makeFaceLabel(text: string): THREE.CanvasTexture {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = TEXTURE_SIZE;
        const context = canvas.getContext("2d")!;
        context.fillStyle = FACE_COLOR;
        context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
        context.fillStyle = TEXT_COLOR;
        context.font = `48px monospace`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(text, TEXTURE_SIZE / 2, TEXTURE_SIZE / 2);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = maxAnisotropy;
        return texture;
    }

    const faceLabels: string[] = [
        "Right",    // +x
        "Left",     // -x
        "Top",      // +y
        "Bottom",   // -y
        "Front",    // +z
        "Back"      // -z
    ];

    const cubeMaterials = faceLabels.map(label => {
        const texture = makeFaceLabel(label);
        return new THREE.MeshPhongMaterial({
            map: texture,
        });
    });

    const cube = new THREE.Mesh(
        new THREE.BoxGeometry(0.75, 0.75, 0.75),
        cubeMaterials
    );
    scene.add(cube);
    scene.add(new THREE.AmbientLight(0xffffff, 1));

    const directionalLight = new THREE.DirectionalLight(V_FG, 2);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    return [cube, scene, cam]
}

// Canvas logic. Placeholder. ---

class Canvas {
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
    controls: OrbitControls;
    root: THREE.Group;
    viewHalfHeight: number;

    currentMesh: THREE.Mesh | null;
    currentName: string;
    currentData: ArrayBuffer;

    currentVertices: THREE.Mesh[];
    vertexMaterial: THREE.MeshStandardMaterial;
    edgeMaterial: THREE.MeshStandardMaterial;
    meshMaterial: THREE.MeshStandardMaterial;

    constructor() {
        this.currentMesh = null;
        this.currentVertices = [];
        this.vertexMaterial = new THREE.MeshStandardMaterial({
            color: V_BLUE,
            flatShading: false,
        });
        this.edgeMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            flatShading: false,
        });
        this.meshMaterial = new THREE.MeshStandardMaterial({
            color: V_BLUE,
            flatShading: false,
        });
        this.currentName = DEFAULT_MODEL;
        this.currentData = new ArrayBuffer(0);

        this.initCanvas();
    }

    async initCanvas() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(V_BG);

        this.root = new THREE.Group();
        this.root.rotation.x = -Math.PI / 2;
        this.scene.add(this.root);

        this.camera = new THREE.OrthographicCamera();
        this.camera.position.set(20, 15, 20);
        this.camera.near = 0.1;
        this.camera.far = 1000;
        this.viewHalfHeight = 15;
        this.updateFrustum();

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.domElement.style.position = "fixed";
        renderer.domElement.style.top = "0";
        renderer.domElement.style.left = "0";
        renderer.setPixelRatio(window.devicePixelRatio);
        document.body.prepend(renderer.domElement);

        this.controls = new OrbitControls(this.camera, renderer.domElement);
        this.controls.update();

        this.scene.add(new THREE.HemisphereLight(V_FG, V_BG, 1));

        const keyLight = new THREE.DirectionalLight(V_FG, 2);
        this.camera.add(keyLight);
        this.camera.add(keyLight.target);
        keyLight.position.set(0, 0, 0);
        keyLight.target.position.set(0, 0, -1);

        const fillLight = new THREE.DirectionalLight(V_FG, 0.8);
        this.camera.add(fillLight);
        this.camera.add(fillLight.target);
        fillLight.position.set(1, -1, 0);
        fillLight.target.position.set(0, 0, -1);

        this.scene.add(this.camera);

        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.meshMaterial);
        this.root.add(mesh);
        this.currentMesh = mesh;
        const data = await fetch(DATA_DIR + DEFAULT_MODEL).then((r) => r.arrayBuffer());
        this.loadGeometry(DEFAULT_MODEL, data);

        const [cube, cubeScene, cubeCamera] = makeOrientationCube(renderer);

        const ORENT_CUBE_SIZE = 240;
        renderer.autoClear = false;
        renderer.setScissorTest(true);

        const animate = () => {
            requestAnimationFrame(animate);
            this.controls.update();

            const W = window.innerWidth;
            const H = window.innerHeight;

            // Full-screen main scene
            renderer.setViewport(0, 0, W, H);
            renderer.setScissor(0, 0, W, H);
            renderer.clear();
            renderer.render(this.scene, this.camera);

            // Counter-rotate the orientation cube so its faces track the camera's
            // orientation (ie the cube shows where the camera looks).
            cube.quaternion.copy(this.camera.quaternion).invert();

            const gx = W - ORENT_CUBE_SIZE;     // right edge
            const gy = 0;                       // bottom edge (GL y is measured from bottom)
            renderer.setViewport(gx, gy, ORENT_CUBE_SIZE, ORENT_CUBE_SIZE);
            renderer.setScissor(gx, gy, ORENT_CUBE_SIZE, ORENT_CUBE_SIZE);
            renderer.clearDepth();
            renderer.render(cubeScene, cubeCamera);
        };
        animate();

        window.addEventListener("resize", () => {
            this.updateFrustum();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    // Recompute the orthographic view frustum from the current half-height
    // and window aspect ratio.
    updateFrustum() {
        const aspect = window.innerWidth / window.innerHeight;
        const h = this.viewHalfHeight;
        const w = h * aspect;
        this.camera.left = -w;
        this.camera.right = w;
        this.camera.top = h;
        this.camera.bottom = -h;
        this.camera.updateProjectionMatrix();
    }

    // Reposition camera so every mesh currently in the scene is in frame,
    // preserving camera orientation.
    fitView() {
        const box = new THREE.Box3().setFromObject(this.root);
        if (box.isEmpty()) return;
        const sphere = new THREE.Sphere();
        box.getBoundingSphere(sphere);
        const radius = sphere.radius || 1;
        const center = sphere.center;

        const dist = radius * 3;

        const dir = new THREE.Vector3()
            .copy(this.camera.position)
            .sub(this.controls.target)
            .normalize();
        if (dir.lengthSq() === 0) dir.set(1, 0.75, 1).normalize();
        this.camera.position.copy(center).add(dir.multiplyScalar(dist));
        this.controls.target.copy(center);
        this.controls.update();

        const aspect = window.innerWidth / window.innerHeight;
        this.viewHalfHeight = (radius / Math.min(1, aspect)) * 1.25;

        this.camera.near = Math.max(0.1, radius / 100);
        this.camera.far = dist + radius * 10;
        this.updateFrustum();
    }

    // Load and display geometry. The file extension determines how `data` is
    // parsed.
    loadGeometry(name: string, data: ArrayBuffer) {
        if (!this.currentMesh) return;
        this.clear();
        this.currentName = name;
        this.currentData = data;
        let geometry: THREE.BufferGeometry;
        try {
            const isObj = name.toLowerCase().endsWith(".obj");
            geometry = isObj
                ? geometryFromObj(new TextDecoder().decode(data))
                : new STLLoader().parse(data);
        } catch (e) {
            // TODO: show user an error message
            console.error("Failed to load", name, e);
            return;
        }

        const count = geometry.attributes.position?.count ?? 0;
        if (count === 0) {
            console.error("Failed to load", name, "malformed file: no geometry parsed");
            return;
        }

        geometry.center();
        geometry.computeVertexNormals();
        this.currentMesh.geometry = geometry;

        disableDownloadButton();
        resetInspector();
        this.fitView();
    }

    loadVertexPrintOutputs(outputs: VertexPrintOutputs) {
        this.clear()
        const polyhedron = outputs.polyhedron;
        for (let i = 0; i < polyhedron.vertexFigures.length; ++i) {
            const geometry = new STLLoader().parse(outputs.stls[i]);
            geometry.computeVertexNormals();
            const mesh = new THREE.Mesh(geometry, this.vertexMaterial);
            const position = polyhedron.vertices.getRow(i);
            const rotation = polyhedron.vertexFigures[i].euler;
            const x = PARAMS.scale * position[0];
            const y = PARAMS.scale * position[1];
            const z = PARAMS.scale * position[2];
            mesh.position.set(x, y, z);
            mesh.rotation.set(rotation[0], rotation[1], rotation[2], "ZYX");
            this.root.add(mesh);
            this.currentVertices.push(mesh)
        }

        this.loadEdges(outputs)

        this.fitView();
    }

    // Draw edges. Identical to solids.scad/hedron_edges
    loadEdges(outputs: VertexPrintOutputs) {
        const polyhedron = outputs.polyhedron;
        const radius = polyhedron.options.edgeDiameter / 2;
        for (const [key, value] of polyhedron.edges) {
            const [v1, v2] = key.split(",").map(Number);
            const a = polyhedron.vertices.getRowVector(v1);
            const b = polyhedron.vertices.getRowVector(v2);
            const [o1, o2] = value.offsets;

            // v = b - a, as in the scad prototype
            const v = Matrix.sub(b, a);
            const dist = v.norm();
            const length = PARAMS.scale * dist - o1 - o2;

            if (length <= 0) {
                continue;
            }

            const vx = v.get(0, 0);
            const vy = v.get(0, 1);
            const vz = v.get(0, 2);

            const phi = Math.atan2(vy, vx);
            const theta = Math.acos(vz / dist);

            const geometry = new THREE.CylinderGeometry(radius, radius, length, 16);
            geometry.translate(0, length / 2, 0);
            geometry.rotateX(Math.PI / 2);

            const mesh = new THREE.Mesh(geometry, this.edgeMaterial);

            // Position at the scaled vertex a, inset by o1 along the edge
            const ux = vx / dist;
            const uy = vy / dist;
            const uz = vz / dist;

            mesh.position.set(
                PARAMS.scale * a.get(0, 0) + o1 * ux,
                PARAMS.scale * a.get(0, 1) + o1 * uy,
                PARAMS.scale * a.get(0, 2) + o1 * uz,
            );

            mesh.rotation.set(0, theta, phi, "ZYX");

            this.root.add(mesh);
            this.currentVertices.push(mesh);
        }
    }

    // Clear scene of all meshes
    clear() {
        for (const mesh of this.currentVertices) {
            mesh.geometry.dispose();
            this.root.remove(mesh);
        }
        this.currentVertices = [];
        if (this.currentMesh) {
            this.currentMesh.geometry.dispose();
            this.currentMesh.geometry = new THREE.BufferGeometry();
        }
    }
}

// Merge every mesh geometry contained in an OBJLoader-produced group.
function geometryFromObj(text: string): THREE.BufferGeometry {
    const group = new OBJLoader().parse(text);
    const geometries: THREE.BufferGeometry[] = [];
    group.traverse((o: THREE.Object3D) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) geometries.push(mesh.geometry);
    });
    if (geometries.length === 0) return new THREE.BufferGeometry();
    if (geometries.length === 1) return geometries[0];
    return mergeGeometries(geometries, false) ?? geometries[0];
}

// Runtime page construction ---

type NumberKeys = {
    [K in keyof VertexPrintParams]: VertexPrintParams[K] extends number ? K : never
}[keyof VertexPrintParams];
type StringKeys = {
    [K in keyof VertexPrintParams]: VertexPrintParams[K] extends string ? K : never
}[keyof VertexPrintParams];

type SliderParam = {
    kind: 'slider';
    name: NumberKeys;
    label: string;
    desc: string;
    min: number;
    max: number;
    step: number;
    value: number;
    unit: string;
};

type SelectParam = {
    kind: 'select';
    name: StringKeys;
    label: string;
    desc: string;
    value: string;
    options: { value: string; label: string }[];
    reveal?: (v: string) => string | null;
};
type Param = SliderParam | SelectParam;

const OPTIONS: Param[] = [
    {
        kind: 'slider',
        name: 'edgeDiameter',
        label: 'Rod diameter',
        desc: 'Diameter of your dowel rods.',
        min: 0,
        max: 100,
        step: 0.05,
        value: 3.0,
        unit: 'mm',
    },
    {
        kind: 'slider',
        name: 'diameterTolerance',
        label: 'Diameter tolerance',
        desc: 'Additional tolerance added to the diameter.\nI recommend adding about 12% of your diameter for wood dowel rods, and 5% for metal',
        min: 0,
        max: 1,
        step: 0.01,
        value: 0.35,
        unit: 'mm',
    },
    {
        kind: 'slider',
        name: 'diameterTaper',
        label: 'Diameter taper',
        desc: 'The rod holder diameter decreases by this amount. A small taper is helpful to account for small amounts of unevenness in the diameters of your dowel rods, particularly for wood dowel rods',
        min: 0,
        max: 1,
        step: 0.01,
        value: 0.1,
        unit: 'mm',
    },
    {
        kind: 'slider',
        name: 'wallThickness',
        label: 'Wall thickness',
        desc: 'Thickness of the tube walls.',
        min: 0,
        max: 40,
        step: 0.01,
        value: 1.2,
        unit: 'mm',
    },
    {
        kind: 'slider',
        name: 'scale',
        label: 'Scale',
        desc: 'Scale factor. Vertexprinted objects are typically larger than than the original object, so this starts out large.',
        min: 0,
        max: 1000,
        step: 1,
        value: 100,
        unit: '%',
    },
    {
        kind: 'slider',
        name: 'rodInset',
        label: 'Tube depth',
        desc: 'The depth of each tube',
        min: 0,
        max: 100,
        step: 0.1,
        value: 10,
        unit: 'mm',
    },
    {
        kind: 'slider',
        name: 'minPrinterOverhangAngle',
        label: 'Maximum overhang angle',
        desc: 'The maximum overhang angle your printer allows',
        min: 0,
        max: 90,
        step: 5,
        value: 15,
        unit: '°',
    },
    {
        kind: 'select',
        name: 'offsetType',
        label: 'Offset type',
        desc: 'placeholder', // complicated explanation
        value: 'auto_per_edge',
        options: [
            { value: 'fixed', label: 'Manual' },
            { value: 'auto_global', label: 'Auto (global)' },
            { value: 'auto_per_vertex', label: 'Auto (per-vertex)' },
            { value: 'auto_per_edge', label: 'Auto (per-edge)' },
        ],
        reveal: (v) => v === 'fixed' ? 'manualOffset' : null,
    },
    {
        kind: 'slider',
        name: 'manualOffset',
        label: 'Offset',
        desc: 'placeholder', // see comment above
        min: 0,
        max: 100,
        step: 0.01,
        value: 0,
        unit: 'mm',
    },
    {
        kind: 'select',
        name: 'renderQuality',
        label: 'Render quality',
        desc: 'placeholder',
        value: 'preview',
        options: [
            { value: 'preview', label: 'Preview' },
            { value: 'final', label: 'Final' },
        ],
    },
];

const TW_CLASS = {
    row: 'flex flex-col gap-0.5 px-1.5 py-1',
    top: 'flex items-center justify-between gap-1.5',
    label: 'opt-label font-mono text-[11px] text-v-fg truncate',
    num: 'w-16 min-w-16 font-mono text-[11px] leading-none text-v-fg bg-black border border-v-border py-0.5 pl-1 pr-5 text-left appearance-none focus:outline-none focus:border-v-blue',
    unit: 'pointer-events-none absolute right-1 inset-y-0 flex items-center translate-y-px font-mono text-[11px] leading-none text-v-fg/70',
    slider: 'dh-slider w-full h-3.5 cursor-pointer appearance-none',
    select: 'w-full font-mono text-[11px] text-v-fg bg-black border border-v-border px-1 py-0.5 focus:outline-none focus:border-v-blue',
};


type SliderRow = {
    row: HTMLElement;
    slider: HTMLInputElement;
    num: HTMLInputElement;
    param: SliderParam
};

type SelectRow = {
    row: HTMLElement;
    sel: HTMLSelectElement;
    param: SelectParam
};

class Sidebar {
    rows: Map<string, HTMLElement>;

    constructor() {
        this.rows = new Map();
        this.initSidebar();
    }

    makeSlider(param: SliderParam): HTMLElement {
        const row = document.createElement('div');
        row.className = TW_CLASS.row;
        row.dataset.param = param.name;
        row.innerHTML =
            `<div class="${TW_CLASS.top}"><span class="${TW_CLASS.label}" title="${param.desc}">${param.label}</span>`
            + `<div class="relative"><input class="${TW_CLASS.num}" type="number" value="${param.value}">`
            + `<span class="${TW_CLASS.unit}">${param.unit}</span></div></div>`
            + `<input class="${TW_CLASS.slider}" type="range" min="${param.min}" max="${param.max}" step="${param.step}" value="${param.value}">`;
        return row
    }

    makeSelect(param: SelectParam): HTMLElement {
        const row = document.createElement('div');
        row.className = TW_CLASS.row;
        row.dataset.param = param.name;
        const paramsHTML = param.options.map(o =>
            `<option value="${o.value}"${o.value === param.value ? ' selected' : ''}>${o.label}</option>`).join('');
        row.innerHTML =
            `<div class="${TW_CLASS.top}"><span class="${TW_CLASS.label}" title="${param.desc}">${param.label}</span></div>`
            + `<select class="${TW_CLASS.select}">${paramsHTML}</select>`;
        return row
    }

    enforceSelects() {
        for (const param of OPTIONS) {
            if (param.kind === 'select' && param.reveal) {
                const currentVal = String(PARAMS[param.name]);
                const shown = param.reveal(currentVal);
                if (shown)
                    this.rows.get(shown)!.style.display = '';
                for (const o of param.options) {
                    const r = param.reveal(o.value);
                    if (r && o.value !== currentVal)
                        this.rows.get(r)!.style.display = 'none';
                }
            }
        }
    }

    // Synchronize slider with corresponding num entry and vv
    syncSlider(r: SliderRow) {
        const setFill = () => {
            const pct = (clamp(r.slider.valueAsNumber, r.param.min, r.param.max) - r.param.min)
                / (r.param.max - r.param.min) * 100;
            r.slider.style.setProperty('--fill', `${pct}%`);
        };
        const sync = (src: 'slider' | 'num') => {
            const raw = parseFloat(src === 'slider' ? r.slider.value : r.num.value);
            const v = clamp(isNaN(raw) ? 0 : raw, r.param.min, r.param.max);
            r.slider.value = String(v);
            r.num.value = String(v);
            PARAMS[r.param.name] = v;
            setFill();
        };
        r.slider.addEventListener('input', () => sync('slider'));
        r.num.addEventListener('input', () => sync('num'));
        r.num.addEventListener('change', () => sync('num'));
        setFill();
    }

    syncSelect(r: SelectRow) {
        r.sel.addEventListener('change', () => {
            PARAMS[r.param.name] = r.sel.value;
            this.enforceSelects();
        });
    }

    initSidebar() {
        const sidebar = document.getElementById('sidebar')!;
        // Initialize sidebar input fields
        const opts = document.getElementById('sidebar-opts')!;
        for (const param of OPTIONS) {
            let row: HTMLElement;
            if (param.kind === 'slider') {
                PARAMS[param.name] = param.value;
                row = this.makeSlider(param);
                this.syncSlider({
                    row,
                    slider: row.querySelector('.dh-slider')!,
                    num: row.querySelector('input[type="number"]')!,
                    param
                });
            } else {
                PARAMS[param.name] = param.value;
                row = this.makeSelect(param);
                this.syncSelect({
                    row,
                    sel: row.querySelector('select')!,
                    param
                });
            }
            this.rows.set(param.name, row);
            opts.appendChild(row);
        }
        this.enforceSelects();

        // Open/close sidebar
        const sidebar_reopen = document.getElementById('sidebar-reopen')!;
        document.getElementById('sidebar-close')!.addEventListener('click', () => {
            sidebar.style.display = 'none';
            sidebar_reopen.style.display = 'flex';
        });
        sidebar_reopen.addEventListener('click', () => {
            sidebar.style.display = '';
            sidebar_reopen.style.display = 'none';
        });

        // Resize sidebar
        const sidebar_resizer = document.getElementById('sidebar-resizer')!;
        let dragging = false, startX = 0, startW = 0;
        sidebar_resizer.addEventListener('mousedown', (e) => {
            dragging = true;
            sidebar_resizer.classList.add('dragging');
            startX = e.clientX;
            startW = sidebar.offsetWidth;
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const w = clamp(startW + (e.clientX - startX), 160, window.innerWidth * 0.5);
            sidebar.style.width = w + 'px';
            sidebar.style.maxWidth = 'none';
        });
        window.addEventListener('mouseup', () => {
            dragging = false;
            sidebar_resizer.classList.remove('dragging');
            document.body.style.userSelect = '';
        });
    }
}


function initInspector() {
    const inspector = document.getElementById('inspector')!;

    // Switch tabs in inspector panel
    document.querySelectorAll<HTMLButtonElement>('#inspector-tabs .inspector-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            const name = tab.dataset.tab;
            document.querySelectorAll<HTMLButtonElement>('#inspector-tabs .inspector-tab').forEach((t) => {
                const active = t.dataset.tab === name;
                t.classList.toggle('text-v-blue', active);
                t.classList.toggle('border-v-blue', active);
                t.classList.toggle('bg-v-panel', active);
                t.classList.toggle('text-v-fg', !active);
                t.classList.toggle('border-transparent', !active);
            });
            document.querySelectorAll<HTMLElement>('.inspector-pane').forEach((p) => {
                p.style.display = p.dataset.pane === name ? '' : 'none';
            });
        });
    });


    // Open/close inspector
    const inspector_reopen = document.getElementById('inspector-reopen')!;
    document.getElementById('inspector-close')!.addEventListener('click', () => {
        inspector.style.display = 'none';
        inspector_reopen.style.display = 'flex';
    });

    inspector_reopen.addEventListener('click', () => {
        inspector.style.display = '';
        inspector_reopen.style.display = 'none';
    });
}

// Reset the inspector panes
function resetInspector() {
    const msg = 'This pane will populate after you generate artifacts';
    document.querySelectorAll<HTMLElement>('.inspector-pane').forEach((p) => {
        p.innerHTML = `<p class="text-v-fg/70">${msg}</p>`;
    });
}

// Fill the vertex inspector with vertex-edge adjacencies
// Fill the edge inspector with edge-vertex adjacencies, and offset-adjusted edge length
function populateInspector(outputs: VertexPrintOutputs) {
    const polyhedron = outputs.polyhedron;
    const verticesPane = document.querySelector<HTMLElement>('.inspector-pane[data-pane="vertices"]')!;
    const edgesPane = document.querySelector<HTMLElement>('.inspector-pane[data-pane="edges"]')!;

    const vertexCount = polyhedron.vertexFigures.length;
    let vhtml = `<p class="mb-1 text-v-fg/70">${vertexCount} vertices</p>`;
    vhtml += `<div class="mb-1 text-v-fg/50">index, edges</div>`;
    for (const vf of polyhedron.vertexFigures) {
        vhtml += `<div class="mb-0.5"><span class="text-v-blue">v${vf.vertexIndex}</span> <span class="text-v-fg/70">[${vf.edges.join(", ")}]</span></div>`;
    }
    verticesPane.innerHTML = vhtml;

    const edges = [...polyhedron.edges.entries()]
        .map(([key, field]) => {
            const [v1, v2] = key.split(",").map(Number);
            return { name: field.name, v1, v2, offsetLength: field.offsetLength };
        })
        .sort((a, b) => a.name - b.name);

    let ehtml = `<p class="mb-1 text-v-fg/70">${edges.length} edges</p>`;
    ehtml += `<div class="mb-1 text-v-fg/50">index, vertices, length (mm)</div>`;
    for (const e of edges) {
        ehtml += `<div class="mb-0.5"><span class="text-v-blue">e${e.name}</span> <span class="text-v-fg/70">[${e.v1} ${e.v2}]</span> ${e.offsetLength.toFixed(2)}</div>`;
    }
    edgesPane.innerHTML = ehtml;
}

// Presets dropdown entries
const PRESETS: Record<string, Record<string, string>> = {
    'Platonic solids': {
        'Tetrahedron': 'Tetrahedron.obj',
        'Cube': 'Cube.obj',
        'Octahedron': 'Octahedron.obj',
        'Dodecahedron': 'Dodecahedron.obj',
        'Icosahedron': 'Icosahedron.obj',
    },
    'Archimedean solids': {
        'Truncated Tetrahedron': 'TruncatedTetrahedron.obj',
        'Cuboctahedron': 'Cuboctahedron.obj',
        'Truncated Cube': 'TruncatedCube.obj',
        'Truncated Octahedron': 'TruncatedOctahedron.obj',
        'Rhombicuboctahedron': 'Rhombicuboctahedron.obj',
        'Truncated Cuboctahedron': 'TruncatedCuboctahedron.obj',
        'Snub Cube (laevo)': 'LsnubCube.obj',
        'Icosidodecahedron': 'Icosidodecahedron.obj',
        'Truncated Dodecahedron': 'TruncatedDodecahedron.obj',
        'Truncated Icosahedron': 'TruncatedIcosahedron.obj',
        'Rhombicosidodecahedron': 'Rhombicosidodecahedron.obj',
        'Truncated Icosidodecahedron': 'TruncatedIcosidodecahedron.obj',
        'Snub Dodecahedron (laevo)': 'LsnubDodecahedron.obj',
    },
    'Catalan solids': {
        'Triakis Tetrahedron': 'TriakisTetrahedron.obj',
        'Rhombic Dodecahedron': 'RhombicDodecahedron.obj',
        'Triakis Octahedron': 'TriakisOctahedron.obj',
        'Tetrakis Hexahedron': 'TetrakisHexahedron.obj',
        'Deltoidal Icositetrahedron': 'DeltoidalIcositetrahedron.obj',
        'Disdyakis Dodecahedron': 'DisdyakisDodecahedron.obj',
        'Pentagonal Icositetrahedron (laevo)': 'LpentagonalIcositetrahedron.obj',
        'Rhombic Triacontahedron': 'RhombicTriacontahedron.obj',
        'Triakis Icosahedron': 'TriakisIcosahedron.obj',
        'Pentakis Dodecahedron': 'PentakisDodecahedron.obj',
        'Deltoidal Hexecontahedron': 'DeltoidalHexecontahedron.obj',
        'Disdyakis Triacontahedron': 'DisdyakisTriacontahedron.obj',
        'Pentagonal Hexecontahedron (laevo)': 'LpentagonalHexecontahedron.obj',
    },
    'Misc': {
        'Stanford Bunny': 'bunny.stl',
        'Rhombic Dodecahedron Tiling': '13RhombicDodecahedra.obj',
    },
};

function initPresetsMenu(canvas: Canvas) {
    const presets_button = document.getElementById('presets-button')!;
    const presets_menu = document.getElementById('presets-menu')!;

    for (const [category, solids] of Object.entries(PRESETS)) {
        const header = document.createElement('p');
        header.textContent = category;
        header.className = 'font-mono text-xs px-3 pt-2 pb-1 text-v-fg/60 border-b border-v-border min-w-full';
        presets_menu.appendChild(header);
        for (const [label, file] of Object.entries(solids)) {
            const item = document.createElement('button');
            item.type = 'button';
            item.textContent = label;
            item.dataset.file = file;
            item.className = 'block w-full cursor-pointer text-left font-mono text-xs px-3 py-1 text-v-fg hover:bg-v-blue hover:text-v-dark';
            item.addEventListener('click', async () => {
                const data = await fetch(DATA_DIR + file).then((r) => r.arrayBuffer())
                canvas.loadGeometry(file, data);
            });
            presets_menu.appendChild(item);
        }
    }

    presets_button.addEventListener('click', (e) => {
        e.stopPropagation();
        presets_menu.classList.toggle('hidden');
    });

    // Close the menu when clicking outside it or selecting an item.
    document.addEventListener('click', (e) => {
        if (!presets_menu.contains(e.target as Node) && e.target !== presets_button) {
            presets_menu.classList.add('hidden');
        }
    });
    presets_menu.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'BUTTON') {
            presets_menu.classList.add('hidden');
        }
    });
}

function initUploadButton(canvas: Canvas) {
    const button = document.getElementById('upload-button')!;
    button.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.stl,.obj';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            const data = await file.arrayBuffer();
            const name = file.name;
            void canvas.loadGeometry(name, data);
        });
        input.click();
    });
}


function initConstructButton(canvas: Canvas) {
    const button = document.getElementById('construct-button')!;
    const label = button.querySelector('p')!;
    const IDLE_TEXT = 'Construct';

    button.addEventListener('click', async () => {
        if (canvas.currentData.byteLength === 0) {
            console.error('No model loaded to construct from');
            return;
        }

        button.classList.add('opacity-70', 'pointer-events-none');
        let dots = 0;
        label.textContent = 'Generating';
        const timer = window.setInterval(() => {
            dots = (dots + 1) % 4;
            label.textContent = 'Generating' + '.'.repeat(dots);
        }, 400);

        const outputs = await vertexPrint(canvas.currentName, canvas.currentData, PARAMS);
        canvas.loadVertexPrintOutputs(outputs);
        canvas.loadEdges(outputs);
        window.clearInterval(timer);
        label.textContent = IDLE_TEXT;
        button.classList.remove('opacity-70', 'pointer-events-none');
        enableDownloadButton(outputs);
        populateInspector(outputs);
    });
}

async function saveOutputs(outputs: VertexPrintOutputs) {
    const zip = new JSZip();
    const polyhedron = outputs.polyhedron;
    const baseName = (polyhedron.name || "vertexprint").replace(/[\\/:*?"<>|]/g, "_");
    for (let i = 0; i < outputs.stls.length; i++) {
        const blob = new Blob([outputs.stls[i]], { type: "application/octet-stream" });
        zip.file(`${baseName}_v${i}.stl`, blob);
    }

    return zip.generateAsync({ type: "blob" }).then((content) => {
        const url = URL.createObjectURL(content);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${baseName}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    });
}

function resetDownloadButton(): HTMLButtonElement {
    const old = document.getElementById('download-button')!;
    const button = old.cloneNode(true) as HTMLButtonElement;
    old.replaceWith(button);
    return button;
}

function enableDownloadButton(outputs: VertexPrintOutputs) {
    const button = resetDownloadButton();
    button.classList.remove('text-v-fg/70', 'cursor-not-allowed');
    button.classList.add('text-v-fg', 'cursor-pointer', 'hover:bg-v-blue', 'hover:text-v-dark');
    button.addEventListener('click', () => { void saveOutputs(outputs); });
}

function disableDownloadButton() {
    const button = resetDownloadButton();
    button.classList.add('text-v-fg/70', 'cursor-not-allowed');
    button.classList.remove('text-v-fg', 'cursor-pointer', 'hover:bg-v-blue', 'hover:text-v-dark');
}

async function init() {
    const canvas = new Canvas();
    new Sidebar();
    initInspector();
    initPresetsMenu(canvas);
    initUploadButton(canvas);
    initConstructButton(canvas);
    disableDownloadButton();
}

init();
