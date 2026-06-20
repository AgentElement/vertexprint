import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

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

document.getElementById('sidebar-close').addEventListener('click', () => {
    document.getElementById('sidebar').style.display = 'none';
});
