import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MindARThree } from 'mindar-image-three';
import { PoseStabilizer } from './math-utils.js';

// ============================================================================
// PARAMÈTRES TERRAIN
// ============================================================================
const CONFIG = {
  targetFile: './assets/targets/marqueur-sol.mind',
  modelFile: './assets/models/batiment.glb',
  // Largeur réelle en mètres de ton marqueur imprimé (ex: 0.20 pour une feuille A4)
  physicalMarkerWidthMeters: 0.20,
  // Taille cible souhaitée en mètres pour le test (mettre null pour garder l'échelle réelle Blender)
  forceTestSizeMeters: 0.30,
  // Décalage par rapport au marqueur (en mètres)
  buildingOffset: new THREE.Vector3(0, 0, 0),
  buildingRotationDeg: 0
};

const statusBanner = document.getElementById('status-banner');
const reticleGuide = document.getElementById('reticle-guide');
const btnLock = document.getElementById('btn-lock');
const btnReset = document.getElementById('btn-reset');

let mindarThree = null;
let buildingModel = null;
let stabilizer = new PoseStabilizer(20);
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

        // Calcul de la boîte englobante pour corriger les problèmes d'échelle/origine Blender
        const box = new THREE.Box3().setFromObject(rawModel);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        // Recentrer le modèle en X/Z et poser sa base exactement à Y = 0
        rawModel.position.x = -center.x;
        rawModel.position.y = -box.min.y;
        rawModel.position.z = -center.z;

        // Mise à l'échelle de sécurité si forceTestSizeMeters est défini
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

  // Coupe physique de tous les flux vidéo actifs pour éviter le flou et la chute de FPS WebXR
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
// PHASE 1 : CALAGE MINDAR SUR LE MARQUEUR
// ============================================================================
async function startMindARPhase() {
  statusBanner.textContent = 'Chargement du modèle 3D...';
  reticleGuide.classList.remove('hidden');
  btnLock.classList.add('hidden');
  btnReset.classList.add('hidden');
  stabilizer.reset();

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

  // Conversion unités MindAR (1 = largeur marqueur) -> mètres réels
  const metersToMarkerUnits = 1 / CONFIG.physicalMarkerWidthMeters;
  const previewGroup = new THREE.Group();
  previewGroup.scale.setScalar(metersToMarkerUnits);
  // Oriente l'axe Y vertical du modèle perpendiculairement à l'image posée au sol
  previewGroup.rotation.x = Math.PI / 2;

  // Repère visuel (socle vert) pour vérifier immédiatement que l'ancre fonctionne
  const basePlate = new THREE.Mesh(
    new THREE.RingGeometry(0.12, 0.15, 32),
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
    reticleGuide.style.opacity = '0.2';
    statusBanner.textContent = 'Marqueur détecté — Calage en cours...';
  };

  anchor.onTargetLost = () => {
    isTargetVisible = false;
    reticleGuide.style.opacity = '1';
    if (!stabilizer.isReady) {
      statusBanner.textContent = 'Visez le marqueur au sol';
    }
  };

  await mindarThree.start();
  statusBanner.textContent = 'Pointez la caméra vers l’image au sol';

  renderer.setAnimationLoop(() => {
    if (isTargetVisible) {
      stabilizer.addMatrix(anchor.group.matrixWorld);
      const pct = Math.round(stabilizer.progress * 100);
      if (!stabilizer.isReady) {
        statusBanner.textContent = `Calage : ${pct}%`;
      } else {
        statusBanner.textContent = 'Calage prêt ! Verrouillez pour tourner autour.';
        btnLock.classList.remove('hidden');
      }
    }
    renderer.render(scene, camera);
  });
}

// ============================================================================
// PHASE 2 : BASCULE WEBXR FLUIDE (60 FPS) + ANCRAGE AU SOL RÉEL
// ============================================================================
async function switchToWebXRLock() {
  const calibratedPose = stabilizer.getLevelPose();
  if (!calibratedPose) return;

  statusBanner.textContent = 'Libération caméra et passage en mode 360°...';
  btnLock.classList.add('hidden');
  reticleGuide.classList.add('hidden');

  // 1. Arrêt matériel total de MindAR avant d'ouvrir WebXR
  hardKillMindAR();
  // Courte pause de 250 ms pour laisser le pilote caméra Android libérer le capteur haute résolution
  await new Promise((r) => setTimeout(r, 250));

  if (!navigator.xr || !(await navigator.xr.isSessionSupported('immersive-ar'))) {
    statusBanner.textContent = 'WebXR non supporté sur ce navigateur (utilisez Chrome Android).';
    btnReset.classList.remove('hidden');
    return;
  }

  // 2. Renderer WebXR optimisé (pixelRatio plafonné = caméra nette + 60 FPS)
  xrRenderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });
  xrRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  xrRenderer.setSize(window.innerWidth, window.innerHeight);
  xrRenderer.xr.enabled = true;
  document.querySelector('#mindar-container').appendChild(xrRenderer.domElement);

  const xrScene = new THREE.Scene();
  const xrCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.6);
  xrScene.add(hemiLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 10, 5);
  xrScene.add(dirLight);

  // 3. Session WebXR avec hit-test pour détecter l'altitude réelle du sol
  xrSession = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor', 'hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.getElementById('hud') }
  });

  xrRenderer.xr.setReferenceSpaceType('local-floor');
  await xrRenderer.xr.setSession(xrSession);

  const viewerSpace = await xrSession.requestReferenceSpace('viewer');
  const hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });

  // Groupe contenant le modèle verrouillé dans le monde
  const worldAnchorGroup = new THREE.Group();
  worldAnchorGroup.visible = false; // Affiché dès que le sol est détecté (1ère frame)
  worldAnchorGroup.quaternion.copy(calibratedPose.quaternion);

  const finalModel = buildingModel.clone();
  finalModel.position.copy(CONFIG.buildingOffset);
  finalModel.rotation.y = THREE.MathUtils.degToRad(CONFIG.buildingRotationDeg);
  worldAnchorGroup.add(finalModel);
  xrScene.add(worldAnchorGroup);

  let isPlacedOnFloor = false;

  xrSession.addEventListener('end', () => {
    if (xrRenderer) {
      xrRenderer.setAnimationLoop(null);
      xrRenderer.dispose();
    }
    xrSession = null;
  });

  xrRenderer.setAnimationLoop((timestamp, frame) => {
    // Au premier rayon frappant le sol devant la caméra, on verrouille définitivement la position
    if (frame && !isPlacedOnFloor && hitTestSource) {
      const referenceSpace = xrRenderer.xr.getReferenceSpace();
      const hitTestResults = frame.getHitTestResults(hitTestSource);
      if (hitTestResults.length > 0) {
        const hitPose = hitTestResults[0].getPose(referenceSpace);
        worldAnchorGroup.position.set(
          hitPose.transform.position.x,
          hitPose.transform.position.y,
          hitPose.transform.position.z
        );
        worldAnchorGroup.visible = true;
        isPlacedOnFloor = true;
        hitTestSource.cancel();
        statusBanner.textContent = 'Modèle verrouillé au sol ! Tournez autour à 360°.';
        btnReset.classList.remove('hidden');
      } else {
        statusBanner.textContent = 'Inclinez légèrement le téléphone vers le sol pour verrouiller...';
      }
    }

    xrRenderer.render(xrScene, xrCamera);
  });
}

btnLock.addEventListener('click', () => {
  switchToWebXRLock().catch((err) => {
    console.error(err);
    statusBanner.textContent = `Erreur WebXR : ${err.message}`;
    btnReset.classList.remove('hidden');
  });
});

btnReset.addEventListener('click', async () => {
  if (xrSession) {
    await xrSession.end();
  }
  document.querySelector('#mindar-container').innerHTML = '';
  startMindARPhase();
});

startMindARPhase().catch((err) => {
  console.error(err);
  statusBanner.textContent = 'Erreur d’accès à la caméra. Vérifiez les permissions HTTPS.';
});