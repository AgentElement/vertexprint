import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
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

    scene.add(new THREE.AmbientLight(V_FG, 2));
    const dirLight = new THREE.DirectionalLight(V_FG, 2);
    dirLight.position.set(10, 20, 15);
    scene.add(dirLight);

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

    function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
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
    min: number;
    max: number;
    step: number;
    value: number;
};

type SelectParam = {
    kind: 'select';
    name: string;
    label: string;
    value: string;
    options: { value: string; label: string }[];
    reveal?: (v: string) => string | null;
};
type Param = SliderParam | SelectParam;

const OPTIONS: Param[] = [
    {
        kind: 'slider',
        name: 'edge_diameter',
        label: 'edge_diameter',
        min: 0,
        max: 100,
        step: 0.05,
        value: 3.0
    },
    {
        kind: 'slider',
        name: 'diameter_tolerance_fit',
        label: 'diameter_tolerance_fit (mm)',
        min: 0,
        max: 1,
        step: 0.01,
        value: 0.35
    },
    {
        kind: 'slider',
        name: 'diameter_taper_fit',
        label: 'diameter_taper_fit (mm)',
        min: 0,
        max: 1,
        step: 0.01,
        value: 0.1
    },
    {
        kind: 'slider',
        name: 'wall_thickness',
        label: 'wall_thickness (mm)',
        min: 0,
        max: 40,
        step: 0.01,
        value: 1.2,
    },
    {
        kind: 'slider',
        name: 'scale_factor',
        label: 'scale_factor',
        min: 0,
        max: 1000,
        step: 1,
        value: 100,
    },
    {
        kind: 'slider',
        name: 'rod_inset',
        label: 'rod_inset (mm)',
        min: 0,
        max: 100,
        step: 0.1,
        value: 10,
    },
    {
        kind: 'slider',
        name: 'max_printer_overhang_angle',
        label: 'max_printer_overhang_angle (deg)',
        min: 0,
        max: 30,
        step: 0.1,
        value: 15,
    },
    {
        kind: 'select',
        name: 'offset_type',
        label: 'offset_type',
        value: 'auto_global',
        options: [
            { value: 'fixed', label: 'fixed' },
            { value: 'auto_global', label: 'auto (global)' },
            { value: 'auto_per_vertex', label: 'auto (per_vertex)' },
        ],
        reveal: (v) => v === 'fixed' ? 'offset' : null,
    },
    {
        kind: 'slider',
        name: 'offset',
        label: 'offset (mm)',
        min: 0,
        max: 100,
        step: 0.01,
        value: 0,
    },
];

const TW_CLASS = {
    row: 'flex flex-col gap-0.5 px-1.5 py-1',
    top: 'flex items-center justify-between gap-1.5',
    label: 'font-mono text-[11px] text-v-fg truncate',
    num: 'w-16 min-w-16 font-mono text-[11px] text-v-fg bg-black border border-v-border rounded-sm px-1 py-0.5 text-right focus:outline-none focus:border-v-blue',
    slider: 'dh-slider w-full h-3.5 cursor-pointer appearance-none bg-transparent',
    select: 'w-full font-mono text-[11px] text-v-fg bg-black border border-v-border rounded-sm px-1 py-0.5 focus:outline-none focus:border-v-blue',
};

const sidebar = document.getElementById('sidebar')!;
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
        `<div class="${TW_CLASS.top}"><span class="${TW_CLASS.label}">${param.label}</span>` +
        `<input class="${TW_CLASS.num}" type="number" value="${param.value}"></div>` +
        `<input class="${TW_CLASS.slider}" type="range" min="${param.min}" max="${param.max}" step="${param.step}" value="${param.value}">`;
    return row
}

function makeSelect(param: SelectParam): HTMLElement {
    const row = document.createElement('div');
    row.className = TW_CLASS.row;
    row.dataset.param = param.name;
    const paramsHTML = param.options.map(o =>
        `<option value="${o.value}"${o.value === param.value ? ' selected' : ''}>${o.label}</option>`).join('');
    row.innerHTML =
        `<div class="${TW_CLASS.top}"><span class="${TW_CLASS.label}">${param.label}</span></div>` +
        `<select class="${TW_CLASS.select}">${paramsHTML}</select>`;
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
    const sync = (src: 'slider' | 'num') => {
        const raw = parseFloat(src === 'slider' ? r.slider.value : r.num.value);
        const v = clamp(isNaN(raw) ? 0 : raw, r.param.min, r.param.max);
        r.slider.value = String(v);
        r.num.value = String(v);
        values[r.param.name] = v;
    };
    r.slider.addEventListener('input', () => sync('slider'));
    r.num.addEventListener('input', () => sync('num'));
    r.num.addEventListener('change', () => sync('num'));
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
const reopen = document.getElementById('sidebar-reopen')!;
document.getElementById('sidebar-close')!.addEventListener('click', () => {
    sidebar.style.display = 'none';
    reopen.style.display = 'flex';
});
reopen.addEventListener('click', () => {
    sidebar.style.display = '';
    reopen.style.display = 'none';
});

// Resize sidebar
const resizer = document.getElementById('sidebar-resizer')!;
let dragging = false, startX = 0, startW = 0;
resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
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
    resizer.classList.remove('dragging');
    document.body.style.userSelect = '';
});
