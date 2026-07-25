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

    currentMeshes: THREE.Mesh[];
    vertexCount: number;
    vertexMaterial: THREE.MeshStandardMaterial;
    edgeMaterial: THREE.MeshStandardMaterial;
    meshMaterial: THREE.MeshStandardMaterial;
    highlightMaterial: THREE.MeshStandardMaterial;
    highlighted: number[];

    constructor() {
        this.currentMesh = null;
        this.currentMeshes = [];
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
        this.highlightMaterial = new THREE.MeshStandardMaterial({
            color: 0xff0000,
            flatShading: false,
        });
        this.currentName = DEFAULT_MODEL;
        this.currentData = new ArrayBuffer(0);
        this.highlighted = [];
        this.vertexCount = 0;

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
        this.vertexCount = polyhedron.vertexFigures.length;
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
            this.currentMeshes.push(mesh)
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
            this.currentMeshes.push(mesh);
        }
    }

    // Clear scene of all meshes
    clear() {
        for (const mesh of this.currentMeshes) {
            mesh.geometry.dispose();
            this.root.remove(mesh);
        }
        this.currentMeshes = [];
        if (this.currentMesh) {
            this.currentMesh.geometry.dispose();
            this.currentMesh.geometry = new THREE.BufferGeometry();
        }
        this.highlighted = [];
        this.vertexCount = 0;
    }

    highlightVertex(index: number) {
        this.currentMeshes[index].material = this.highlightMaterial;
        this.highlighted.push(index)
    }

    highlightEdge(index: number) {
        const meshIndex = this.vertexCount + index;
        this.currentMeshes[meshIndex].material = this.highlightMaterial;
        this.highlighted.push(meshIndex)
    }

    clearHighlights() {
        for (const v of this.highlighted) {
            const mat = v < this.vertexCount ? this.vertexMaterial : this.edgeMaterial;
            this.currentMeshes[v].material = mat;
        }
        this.highlighted = [];
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
        desc: 'Additional tolerance added to the diameter.\nAdd about 12% of your diameter for wood dowel rods, and 5% of your diameter for metal dowel rods',
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
        desc: 'The rod holder diameter decreases by this amount. A small taper is helpful to account for unevenness in the diameters of your dowel rods, particularly for wood dowel rods',
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
        desc: 'Scale factor. Vertexprinted objects are typically larger than than the original object. Objects that are too small risk having their vertex pieces collide.',
        min: 0,
        max: 100,
        step: 0.01,
        value: 1.00,
        unit: 'x',
    },
    {
        kind: 'slider',
        name: 'rodInset',
        label: 'Tube length',
        desc: 'Length of tube enveloping dowel rods.',
        min: 0,
        max: 100,
        step: 0.1,
        value: 6,
        unit: 'mm',
    },
    {
        kind: 'slider',
        name: 'minPrinterOverhangAngle',
        label: 'Overhang angle',
        desc: 'The angle by which your vertex pieces can overhang. At 0°, any overhang angle is permitted. At 90°, vertexprint minimizes overhangs.',
        min: 0,
        max: 90,
        step: 5,
        value: 45,
        unit: '°',
    },
    {
        kind: 'select',
        name: 'offsetType',
        label: 'Offset type',
        desc: 'Dowel rods are offset from the center of each vertex to avoid them from colliding with each other within a vertex piece.\n\
            "Auto (per-edge)" allows a different offset for each edge at a given vertex. It is the most space-efficient.\n\
            "Auto (per-vertex)" forces the same offset at each vertex, but allows different vertices to have different offsets.\n\
            "Auto (global)" forces the entire solid to share an offset value.\n\
            "Manual" allows you to select a global offset value.\n',
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
        desc: 'Manually set a global offset value.', // see comment above
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
        desc: 'Quality of part. "Preview" renderes with fewer triangles. Always render with "Final" before printing.',
        value: 'preview',
        options: [
            { value: 'preview', label: 'Preview' },
            { value: 'final', label: 'Final' },
        ],
    },
];

// Build and position a tooltip element for `host`, returning it.
function makeTooltip(host: HTMLElement, text: string): HTMLDivElement {
    const tip = document.createElement('div');
    tip.className = 'dh-tooltip';
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    tip.innerHTML = lines.map(l => `<p>${l}</p>`).join('');
    document.body.appendChild(tip);

    const r = host.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const gap = 6;

    // Place tooltip below the host element. Place it above if it overflows the
    // viewport.
    let top = r.bottom + gap;
    if (top + th > window.innerHeight) top = r.top - th - gap;
    if (top < 0) top = gap;

    // Left-align the tooltip with the host. Clamp to viewport if this is not possible.
    let left = r.left;
    if (left + tw > window.innerWidth - gap) left = window.innerWidth - tw - gap;
    if (left < gap) left = gap;
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
    return tip;
}

// Bind a tooltip to a html element
function bindTooltip(element: HTMLElement, text: string) {
    let tip: HTMLDivElement | null = null;
    let timer: number | null = null;
    const title = element.getAttribute('title');
    const show = () => {
        if (tip || timer) return;
        // strip title while tooltip shows, keep title otherwise for screen
        // readers
        if (title !== null) element.removeAttribute('title');
        // 1s delay before tooltip shows
        timer = window.setTimeout(() => {
            timer = null;
            tip = makeTooltip(element, text);
        }, 600);
    };
    const hide = () => {
        if (timer !== null) {
            window.clearTimeout(timer); timer = null;
        }
        if (title !== null) element.setAttribute('title', title);
        if (tip) {
            tip.remove(); tip = null;
        }
    };
    element.addEventListener('mouseenter', show);
    element.addEventListener('focus', show);
    element.addEventListener('mouseleave', hide);
    element.addEventListener('blur', hide);
    element.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

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
            `<div class="${TW_CLASS.top}"><span class="${TW_CLASS.label}">${param.label}</span>`
            + `<div class="relative"><input class="${TW_CLASS.num}" type="number" value="${param.value}">`
            + `<span class="${TW_CLASS.unit}">${param.unit}</span></div></div>`
            + `<input class="${TW_CLASS.slider}" type="range" min="${param.min}" max="${param.max}" step="${param.step}" value="${param.value}">`;
        bindTooltip(row.querySelector('.opt-label')!, param.desc);
        return row
    }

    makeSelect(param: SelectParam): HTMLElement {
        const row = document.createElement('div');
        row.className = TW_CLASS.row;
        row.dataset.param = param.name;
        const paramsHTML = param.options.map(o =>
            `<option value="${o.value}"${o.value === param.value ? ' selected' : ''}>${o.label}</option>`).join('');
        row.innerHTML =
            `<div class="${TW_CLASS.top}"><span class="${TW_CLASS.label}">${param.label}</span></div>`
            + `<select class="${TW_CLASS.select}">${paramsHTML}</select>`;
        bindTooltip(row.querySelector('.opt-label')!, param.desc);
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

    // Programmatically set a param value and update the corresponding UI
    // element.
    setParam(name: NumberKeys | StringKeys, value: number | string) {
        const row = this.rows.get(name as string);
        if (!row) return;
        const param = OPTIONS.find(p => p.name === name);
        if (!param) return;
        if (param.kind === 'slider') {
            const slider = row.querySelector('.dh-slider') as HTMLInputElement;
            const num = row.querySelector('input[type="number"]') as HTMLInputElement;
            const v = clamp(value as number, param.min, param.max);
            slider.value = String(v);
            num.value = String(v);
            PARAMS[param.name] = v;
            const pct = (v - param.min) / (param.max - param.min) * 100;
            slider.style.setProperty('--fill', `${pct}%`);
        } else {
            const sel = row.querySelector('select') as HTMLSelectElement;
            sel.value = String(value);
            PARAMS[param.name] = value as any;
            this.enforceSelects();
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
        const sidebar_close = document.getElementById('sidebar-close')!;
        bindTooltip(sidebar_close, 'Close sidebar');
        bindTooltip(sidebar_reopen, 'Show sidebar');
        sidebar_close.addEventListener('click', () => {
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
    const inspector_close = document.getElementById('inspector-close')!;
    bindTooltip(inspector_close, 'Close inspector');
    bindTooltip(inspector_reopen, 'Show inspector');
    inspector_close.addEventListener('click', () => {
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
function populateInspector(outputs: VertexPrintOutputs, canvas: Canvas) {
    const polyhedron = outputs.polyhedron;
    const verticesPane = document.querySelector<HTMLElement>('.inspector-pane[data-pane="vertices"]')!;
    const edgesPane = document.querySelector<HTMLElement>('.inspector-pane[data-pane="edges"]')!;

    const vertexCount = polyhedron.vertexFigures.length;
    let vhtml = `<p class="mb-1 text-v-fg/70">${vertexCount} vertices</p>`;
    vhtml += `<div class="mb-1 text-v-fg/50">index, edges</div>`;
    for (const vf of polyhedron.vertexFigures) {
        vhtml += `<div class="mb-0.5"><span class="text-v-blue cursor-pointer opt-label" id=v${vf.vertexIndex}>v${vf.vertexIndex}</span> <span class="text-v-fg/70">[${vf.edges.join(", ")}]</span></div>`;
    }
    verticesPane.innerHTML = vhtml;

    for (let i = 0; i < polyhedron.vertexFigures.length; ++i) {
        const vi = document.getElementById(`v${i}`);
        vi.addEventListener('click', () => {
            canvas.highlightVertex(i);
        });
    }

    const edges = [...polyhedron.edges.entries()]
        .map(([key, field]) => {
            const [v1, v2] = key.split(",").map(Number);
            return { name: field.name, v1, v2, offsetLength: field.offsetLength };
        })
        .sort((a, b) => a.name - b.name);

    let ehtml = `<p class="mb-1 text-v-fg/70">${edges.length} edges</p>`;
    ehtml += `<div class="mb-1 text-v-fg/50">index, vertices, length (mm)</div>`;
    for (const e of edges) {
        ehtml += `<div class="mb-0.5"><span class="text-v-blue cursor-pointer opt-label" id=e${e.name}>e${e.name}</span> <span class="text-v-fg/70">[${e.v1} ${e.v2}]</span> ${e.offsetLength.toFixed(2)}</div>`;
    }
    edgesPane.innerHTML = ehtml;

    for (let i = 0; i < edges.length; ++i) {
        const vi = document.getElementById(`e${i}`);
        vi.addEventListener('click', () => {
            canvas.highlightEdge(i);
        });
    }

    document.addEventListener('click', (e) => {
        const t = e.target as Node;
        if (!verticesPane.contains(t) && !edgesPane.contains(t)) {
            canvas.clearHighlights();
        }
    });
}

const PRESETS: Record<string, Record<string, { file: string; scale: number }>> = {
    'Platonic solids': {
        'Tetrahedron': { file: 'Tetrahedron.obj', scale: 50 },
        'Cube': { file: 'Cube.obj', scale: 50 },
        'Octahedron': { file: 'Octahedron.obj', scale: 50 },
        'Dodecahedron': { file: 'Dodecahedron.obj', scale: 50 },
        'Icosahedron': { file: 'Icosahedron.obj', scale: 50 },
    },
    'Archimedean solids': {
        'Truncated Tetrahedron': { file: 'TruncatedTetrahedron.obj', scale: 50 },
        'Cuboctahedron': { file: 'Cuboctahedron.obj', scale: 50 },
        'Truncated Cube': { file: 'TruncatedCube.obj', scale: 50 },
        'Truncated Octahedron': { file: 'TruncatedOctahedron.obj', scale: 50 },
        'Rhombicuboctahedron': { file: 'Rhombicuboctahedron.obj', scale: 50 },
        'Truncated Cuboctahedron': { file: 'TruncatedCuboctahedron.obj', scale: 50 },
        'Snub Cube (laevo)': { file: 'LsnubCube.obj', scale: 50 },
        'Icosidodecahedron': { file: 'Icosidodecahedron.obj', scale: 50 },
        'Truncated Dodecahedron': { file: 'TruncatedDodecahedron.obj', scale: 50 },
        'Truncated Icosahedron': { file: 'TruncatedIcosahedron.obj', scale: 50 },
        'Rhombicosidodecahedron': { file: 'Rhombicosidodecahedron.obj', scale: 50 },
        'Truncated Icosidodecahedron': { file: 'TruncatedIcosidodecahedron.obj', scale: 50 },
        'Snub Dodecahedron (laevo)': { file: 'LsnubDodecahedron.obj', scale: 50 },
    },
    'Catalan solids': {
        'Triakis Tetrahedron': { file: 'TriakisTetrahedron.obj', scale: 50 },
        'Rhombic Dodecahedron': { file: 'RhombicDodecahedron.obj', scale: 50 },
        'Triakis Octahedron': { file: 'TriakisOctahedron.obj', scale: 50 },
        'Tetrakis Hexahedron': { file: 'TetrakisHexahedron.obj', scale: 50 },
        'Deltoidal Icositetrahedron': { file: 'DeltoidalIcositetrahedron.obj', scale: 50 },
        'Disdyakis Dodecahedron': { file: 'DisdyakisDodecahedron.obj', scale: 50 },
        'Pentagonal Icositetrahedron (laevo)': { file: 'LpentagonalIcositetrahedron.obj', scale: 50 },
        'Rhombic Triacontahedron': { file: 'RhombicTriacontahedron.obj', scale: 50 },
        'Triakis Icosahedron': { file: 'TriakisIcosahedron.obj', scale: 50 },
        'Pentakis Dodecahedron': { file: 'PentakisDodecahedron.obj', scale: 50 },
        'Deltoidal Hexecontahedron': { file: 'DeltoidalHexecontahedron.obj', scale: 50 },
        'Disdyakis Triacontahedron': { file: 'DisdyakisTriacontahedron.obj', scale: 50 },
        'Pentagonal Hexecontahedron (laevo)': { file: 'LpentagonalHexecontahedron.obj', scale: 50 },
    },
    'Misc': {
        'Stanford Bunny': { file: 'bunny.stl', scale: 6 },
        'Rhombic Dodecahedron Tiling': { file: '13RhombicDodecahedra.obj', scale: 50 },
    },
};

function initPresetsMenu(canvas: Canvas, sidebar: Sidebar) {
    const presets_button = document.getElementById('presets-button')!;
    const presets_menu = document.getElementById('presets-menu')!;
    bindTooltip(presets_button, 'Open presets');

    for (const [category, solids] of Object.entries(PRESETS)) {
        const header = document.createElement('p');
        header.textContent = category;
        header.className = 'font-mono text-xs px-3 pt-2 pb-1 text-v-fg/60 border-b border-v-border min-w-full';
        presets_menu.appendChild(header);
        for (const [label, preset] of Object.entries(solids)) {
            const { file, scale } = preset;
            const item = document.createElement('button');
            item.type = 'button';
            item.textContent = label;
            item.dataset.file = file;
            item.className = 'block w-full cursor-pointer text-left font-mono text-xs px-3 py-1 text-v-fg hover:bg-v-blue hover:text-v-dark';
            item.addEventListener('click', async () => {
                sidebar.setParam('scale', scale);
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
    bindTooltip(button, 'Upload files');
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
    bindTooltip(button, 'Vertexprint your structure');
    const label = button.querySelector('p')!;
    const IDLE_TEXT = 'Construct';

    button.addEventListener('click', async () => {
        if (canvas.currentData.byteLength === 0) {
            console.error('No model loaded to construct from');
            return;
        }

        button.classList.add('opacity-70', 'pointer-events-none');
        label.textContent = 'Generating';

        const outputs = await vertexPrint(
            canvas.currentName, canvas.currentData, PARAMS,
            (done, total) => {
                label.textContent = `Generating (${done}/${total})`;
            },
        );
        canvas.loadVertexPrintOutputs(outputs);
        canvas.loadEdges(outputs);
        label.textContent = IDLE_TEXT;
        button.classList.remove('opacity-70', 'pointer-events-none');
        enableDownloadButton(outputs);
        populateInspector(outputs, canvas);
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
    bindTooltip(button, 'Download generated artifacts.\nYou must generate artifacts before a download.');
    button.addEventListener('click', () => { void saveOutputs(outputs); });
}

function disableDownloadButton() {
    const button = resetDownloadButton();
    button.classList.add('text-v-fg/70', 'cursor-not-allowed');
    button.classList.remove('text-v-fg', 'cursor-pointer', 'hover:bg-v-blue', 'hover:text-v-dark');
    bindTooltip(button, 'Download generated artifacts.\nYou must generate artifacts before a download.');
}

async function initMesh(canvas: Canvas, sidebar: Sidebar) {
    sidebar.setParam('scale', 50);
    const data = await fetch(DATA_DIR + DEFAULT_MODEL).then((r) => r.arrayBuffer());
    canvas.loadGeometry(DEFAULT_MODEL, data);
}

async function init() {
    const canvas = new Canvas();
    const sidebar = new Sidebar();
    initInspector();
    initPresetsMenu(canvas, sidebar);
    initUploadButton(canvas);
    initConstructButton(canvas);
    disableDownloadButton();
    bindTooltip(document.getElementById('help-button')!, 'Help');
    bindTooltip(document.getElementById('source-link')!, 'Source code');
    initMesh(canvas, sidebar);
}

init();
