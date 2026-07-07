import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";


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

const V_FG = cssVar("--color-v-fg");
const V_BG = cssVar("--color-v-bg");
const V_DARK = cssVar("--color-v-dark");
const V_BORDER = cssVar("--color-v-border");
const V_BLUE = cssVar("--color-v-blue");


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
async function init() {
    const output = await fetch("cube.stl").then((res) => res.arrayBuffer());

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(V_BG);

    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(20, 15, 20);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.position = "fixed";
    renderer.domElement.style.top = "0";
    renderer.domElement.style.left = "0";
    renderer.setPixelRatio(window.devicePixelRatio);
    document.body.prepend(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.update();

    scene.add(new THREE.AmbientLight(V_DARK, 2));
    const directionalLight = new THREE.DirectionalLight(V_FG, 2);
    directionalLight.position.set(10, 20, 15);
    scene.add(directionalLight);

    const loader = new STLLoader();
    const geometry = loader.parse(output);
    geometry.center();
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
        color: V_BLUE,
        flatShading: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const [cube, cubeScene, cubeCamera] = makeOrientationCube(renderer);

    const ORENT_CUBE_SIZE = 240;
    renderer.autoClear = false;
    renderer.setScissorTest(true);

    function animate() {
        requestAnimationFrame(animate);
        controls.update();

        const W = window.innerWidth;
        const H = window.innerHeight;

        // Full-screen main scene
        renderer.setViewport(0, 0, W, H);
        renderer.setScissor(0, 0, W, H);
        renderer.clear();
        renderer.render(scene, camera);

        // Counter-rotate the orientation cube so its faces track the camera's
        // orientation (ie the cube shows where the camera looks).
        cube.quaternion.copy(camera.quaternion).invert();

        const gx = W - ORENT_CUBE_SIZE;     // right edge
        const gy = 0;                       // bottom edge (GL y is measured from bottom)
        renderer.setViewport(gx, gy, ORENT_CUBE_SIZE, ORENT_CUBE_SIZE);
        renderer.setScissor(gx, gy, ORENT_CUBE_SIZE, ORENT_CUBE_SIZE);
        renderer.clearDepth();
        renderer.render(cubeScene, cubeCamera);
    }
    animate();

    window.addEventListener("resize", () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

init();


// Runtime page construction ---

type SliderParam = {
    kind: 'slider';
    name: string;
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
    name: string;
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
        name: 'edge_diameter',
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
        name: 'diameter_tolerance_fit',
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
        name: 'diameter_taper_fit',
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
        name: 'wall_thickness',
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
        name: 'scale_factor',
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
        name: 'rod_inset',
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
        name: 'max_printer_overhang_angle',
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
        name: 'offset_type',
        label: 'Offset type',
        desc: 'placeholder', // complicated explanation
        value: 'auto_global',
        options: [
            { value: 'fixed', label: 'Manual' },
            { value: 'auto_global', label: 'Auto (global)' },
            { value: 'auto_per_vertex', label: 'Auto (per-vertex)' },
        ],
        reveal: (v) => v === 'fixed' ? 'offset' : null,
    },
    {
        kind: 'slider',
        name: 'offset',
        label: 'Offset',
        desc: 'placeholder', // see comment above
        min: 0,
        max: 100,
        step: 0.01,
        value: 0,
        unit: 'mm',
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

const sidebar = document.getElementById('sidebar')!;
const inspector = document.getElementById('inspector')!;
const values: Record<string, number | string> = {};
const rows = new Map<string, HTMLElement>();

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

function makeSlider(param: SliderParam): HTMLElement {
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

function makeSelect(param: SelectParam): HTMLElement {
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

function enforceSelects() {
    for (const param of OPTIONS) {
        if (param.kind === 'select' && param.reveal) {
            const shown = param.reveal(String(values[param.name]));
            if (shown)
                rows.get(shown)!.style.display = '';
            for (const o of param.options) {
                const r = param.reveal(o.value);
                if (r && o.value !== String(values[param.name]))
                    rows.get(r)!.style.display = 'none';
            }
        }
    }
}

// Synchronize slider with corresponding num entry and vv
function syncSlider(r: SliderRow) {
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
        values[r.param.name] = v;
        setFill();
    };
    r.slider.addEventListener('input', () => sync('slider'));
    r.num.addEventListener('input', () => sync('num'));
    r.num.addEventListener('change', () => sync('num'));
    setFill();
}

function syncSelect(r: SelectRow) {
    r.sel.addEventListener('change', () => {
        values[r.param.name] = r.sel.value;
        enforceSelects();
    });
}

// Initialize sidebar input fields
const opts = document.getElementById('sidebar-opts')!;
for (const param of OPTIONS) {
    values[param.name] = param.value;
    let row: HTMLElement;
    if (param.kind === 'slider') {
        row = makeSlider(param);
        syncSlider({
            row,
            slider: row.querySelector('.dh-slider')!,
            num: row.querySelector('input[type="number"]')!,
            param
        });
    } else {
        row = makeSelect(param);
        syncSelect({
            row,
            sel: row.querySelector('select')!,
            param
        });
    }
    rows.set(param.name, row);
    opts.appendChild(row);
}
enforceSelects();

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

// Presets dropdown entries
const PRESETS: Record<string, Record<string, string>> = {
    'Platonic solids': {
        'Tetrahedron': 'Tetrahedron.txt',
        'Cube': 'Cube.txt',
        'Octahedron': 'Octahedron.txt',
        'Dodecahedron': 'Dodecahedron.txt',
        'Icosahedron': 'Icosahedron.txt',
    },
    'Archimedean solids': {
        'Truncated Tetrahedron': 'TruncatedTetrahedron.txt',
        'Cuboctahedron': 'Cuboctahedron.txt',
        'Truncated Cube': 'TruncatedCube.txt',
        'Truncated Octahedron': 'TruncatedOctahedron.txt',
        'Rhombicuboctahedron': 'Rhombicuboctahedron.txt',
        'Truncated Cuboctahedron': 'TruncatedCuboctahedron.txt',
        'Snub Cube (laevo)': 'LsnubCube.txt',
        'Icosidodecahedron': 'Icosidodecahedron.txt',
        'Truncated Dodecahedron': 'TruncatedDodecahedron.txt',
        'Truncated Icosahedron': 'TruncatedIcosahedron.txt',
        'Rhombicosidodecahedron': 'Rhombicosidodecahedron.txt',
        'Truncated Icosidodecahedron': 'TruncatedIcosidodecahedron.txt',
        'Snub Dodecahedron (laevo)': 'LsnubDodecahedron.txt',
    },
    'Catalan solids': {
        'Triakis Tetrahedron': 'TriakisTetrahedron.txt',
        'Rhombic Dodecahedron': 'RhombicDodecahedron.txt',
        'Triakis Octahedron': 'TriakisOctahedron.txt',
        'Tetrakis Hexahedron': 'TetrakisHexahedron.txt',
        'Deltoidal Icositetrahedron': 'DeltoidalIcositetrahedron.txt',
        'Disdyakis Dodecahedron': 'DisdyakisDodecahedron.txt',
        'Pentagonal Icositetrahedron (laevo)': 'LpentagonalIcositetrahedron.txt',
        'Rhombic Triacontahedron': 'RhombicTriacontahedron.txt',
        'Triakis Icosahedron': 'TriakisIcosahedron.txt',
        'Pentakis Dodecahedron': 'PentakisDodecahedron.txt',
        'Deltoidal Hexecontahedron': 'DeltoidalHexecontahedron.txt',
        'Disdyakis Triacontahedron': 'DisdyakisTriacontahedron.txt',
        'Pentagonal Hexecontahedron (laevo)': 'LpentagonalHexecontahedron.txt',
    },
    'Misc': {
        'Stanford Bunny': 'Bunny-LowPoly.stl',
        'Rhombic Dodecahedron Tiling': '13RhombicDodecahedra.obj',
    },
};

const presets_btn = document.getElementById('presets-btn')!;
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
        presets_menu.appendChild(item);
    }
}

presets_btn.addEventListener('click', (e) => {
    e.stopPropagation();
    presets_menu.classList.toggle('hidden');
});

// Close the menu when clicking outside it or selecting an item.
document.addEventListener('click', (e) => {
    if (!presets_menu.contains(e.target as Node) && e.target !== presets_btn) {
        presets_menu.classList.add('hidden');
    }
});
presets_menu.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON') {
        presets_menu.classList.add('hidden');
    }
});
