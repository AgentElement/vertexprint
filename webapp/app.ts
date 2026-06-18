import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const WHITE = 0xffffff;
const GRAY = 0x404040;
const BLUE = 0x6699cc;

async function init() {
  const output = await fetch("cube.stl").then((res) => res.arrayBuffer());

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(WHITE);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(20, 15, 20);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.append(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.update();

  scene.add(new THREE.AmbientLight(GRAY, 2));
  const dirLight = new THREE.DirectionalLight(WHITE, 2);
  dirLight.position.set(10, 20, 15);
  scene.add(dirLight);

  const loader = new STLLoader();
  const geometry = loader.parse(output);
  geometry.center();
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: BLUE,
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
