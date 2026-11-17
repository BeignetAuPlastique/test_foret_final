import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MindARThree } from 'mindar-image-three';
import { MarkerCameraSolver } from './math-utils.js';

// ============================================================================
// PARAMÈTRES TERRAIN
// ============================================================================
const CONFIG = {
  targetFile: './assets/targets/marqueur-sol.mind',
  modelFile: './assets/models/batiment.glb',
  // Largeur réelle en mètres de ton image imprimée (ex: 0.20 pour 20 cm)
  physicalMarkerWidthMeters: 0.15,
  // Taille cible en mètres pour le test (mettre null pour garder l'échelle réelle Blender 5m x 5m)
  forceTestSizeMeters: 0.30,
  // Décalage du bâtiment par rapport au centre du marqueur (en mètres)
  buildingOffset: new THREE.Vector3(0, 0, 0),
  buildingRotationDeg: 0
};

const statusBanner = document.getElementById('status-banner');
const reticleGuide = document.getElementById('reticle-guide');
const btnLock = document.getElementById('btn-lock');
const btnReset = document.getElementById('btn-reset');

let mindarThree = null;
let buildingModel = null;
let solver = new MarkerCameraSolver(CONFIG.physicalMarkerWidthMeters, 15);
let isTargetVisible = false;
let xrSession = null;
let xrRenderer = null;

// ============================================================================
// CHARGEMENT ET NORMALISATION DU MODÈLE 3D
// ============================================================================
async function loadBuildingModel() {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(
      CONFIG.modelFile,
      (gltf) => {
        const rawModel = gltf.scene;
        const container = new THREE.Group();

        const box = new THREE.Box3().setFromObject(rawModel);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        // Recentrer X/Z et poser la base exactement à Y = 0
        rawModel.position.x = -center.x;
        rawModel.position.y = -box.min.y;
        rawModel.position.z = -center.z;

        const maxDim = Math.max(size.x, size.y, size.z);
        if (CONFIG.forceTestSizeMeters && maxDim > 0) {
          const autoScale = CONFIG.forceTestSizeMeters / maxDim;
          rawModel.scale.setScalar(autoScale);
          rawModel.position.multiplyScalar(autoScale);
        }

        container.add(rawModel);
        resolve(container);
      },
      undefined,
      (err) => reject(err)
    );
  });
}

// ============================================================================
// LIBÉRATION MATÉRIELLE COMPLÈTE DE LA CAMÉRA ET DU CONTEXTE WEBGL
// ============================================================================
function hardKillMindAR() {
  if (mindarThree) {
    try {
      mindarThree.stop();
      mindarThree.renderer.setAnimationLoop(null);
      mindarThree.renderer.dispose();
      mindarThree.renderer.forceContextLoss();
    } catch (e) {
      console.warn('Arrêt MindAR :', e);
    }
    mindarThree = null;
  }

  const videos = document.querySelectorAll('video');
  videos.forEach((video) => {
    if (video.srcObject) {
      video.srcObject.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
    video.remove();
  });

  document.querySelector('#mindar-container').innerHTML = '';
}

// ============================================================================
// PHASE 1 : CALAGE MINDAR EN TEMPS RÉEL
// ============================================================================
async function startMindARPhase() {
  document.body.classList.remove('xr-active');
  statusBanner.textContent = 'Chargement du modèle 3D...';
  reticleGuide.classList.remove('hidden');
  btnLock.classList.add('hidden');
  btnReset.classList.add('hidden');
  solver.reset();

  if (!buildingModel) {
    buildingModel = await loadBuildingModel();
  }

  mindarThree = new MindARThree({
    container: document.querySelector('#mindar-container'),
    imageTargetSrc: CONFIG.targetFile,
    uiScanning: 'no',
    uiLoading: 'no',
    filterMinCF: 0.0005,
    filterBeta: 0.005
  });

  const { renderer, scene, camera } = mindarThree;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.6);
  scene.add(hemiLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 10, 5);
  scene.add(dirLight);

  const anchor = mindarThree.addAnchor(0);

  const metersToMarkerUnits = 1 / CONFIG.physicalMarkerWidthMeters;
  const previewGroup = new THREE.Group();
  previewGroup.scale.setScalar(metersToMarkerUnits);
  previewGroup.rotation.x = Math.PI / 2;

  const basePlate = new THREE.Mesh(
    new THREE.RingGeometry(0.11, 0.14, 32),
    new THREE.MeshBasicMaterial({ color: 0x10b981, side: THREE.DoubleSide })
  );
  basePlate.rotation.x = -Math.PI / 2;
  previewGroup.add(basePlate);

  const modelClone = buildingModel.clone();
  modelClone.position.copy(CONFIG.buildingOffset);
  modelClone.rotation.y = THREE.MathUtils.degToRad(CONFIG.buildingRotationDeg);
  previewGroup.add(modelClone);

  anchor.group.add(previewGroup);

  anchor.onTargetFound = () => {
    isTargetVisible = true;
    reticleGuide.style.opacity = '0.15';
  };

  anchor.onTargetLost = () => {
    isTargetVisible = false;
    reticleGuide.style.opacity = '1';
    btnLock.classList.add('hidden');
    solver.reset();
    statusBanner.textContent = 'Marqueur perdu — Visez à nouveau l’image au sol';
  };

  await mindarThree.start();
  statusBanner.textContent = 'Pointez la caméra vers l’image au sol';

  renderer.setAnimationLoop(() => {
    if (isTargetVisible) {
      anchor.group.updateMatrixWorld(true);
      solver.addSample(anchor.group.matrixWorld);
      const pct = Math.round(solver.progress * 100);

      if (!solver.isReady) {
        statusBanner.textContent = `Stabilisation du rep