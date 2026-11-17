import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MindARThree } from 'mindar-image-three';
import { PoseStabilizer } from './math-utils.js';

// ============================================================================
// PARAMÈTRES TERRAIN À AJUSTER SELON TON MARQUEUR PHYSIQUE ET TON MODÈLE
// ============================================================================
const CONFIG = {
  targetFile: './assets/targets/marqueur-sol.mind',
  modelFile: './assets/models/batiment.glb',
  // Largeur réelle en mètres de ton image imprimée au sol (ex: 0.40 pour 40 cm)
  physicalMarkerWidthMeters: 0.40,
  // Décalage du centre du bâtiment par rapport au centre du marqueur au sol (en mètres)
  // Exemple : si le marqueur est placé devant l'entrée Sud à 3.5 m du centre du bâtiment :
  buildingOffset: new THREE.Vector3(0, 0, 0),
  // Rotation supplémentaire du bâtiment autour de l'axe vertical (en degrés)
  buildingRotationDeg: 0
};

const statusBanner = document.getElementById('status-banner');
const reticleGuide = document.getElementById('reticle-guide');
const btnLock = document.getElementById('btn-lock');
const btnReset = document.getElementById('btn-reset');

let mindarThree = null;
let buildingModel = null;
let stabilizer = new PoseStabilizer(25);
let isTargetVisible = false;
let xrSession = null;

// Préchargement du modèle 3D (.glb)
async function loadBuildingModel() {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(
      CONFIG.modelFile,
      (gltf) => {
        const model = gltf.scene;
        // Activation des ombres si nécessaire
        model.traverse((node) => {
          if (node.isMesh) {
            node.castShadow = true;
            node.receiveShadow = true;
          }
        });
        resolve(model);
      },
      undefined,
      (err) => reject(err)
    );
  });
}

// ============================================================================
// PHASE 1 : INITIALISATION MINDAR (CALAGE SUR IMAGE AU SOL)
// ============================================================================
async function startMindARPhase() {
  statusBanner.textContent = 'Chargement du modèle 3D et de la caméra...';
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
    filterMinCF: 0.0001, // Filtrage anti-tremblement renforcé
    filterBeta: 0.001
  });

  const { renderer, scene, camera } = mindarThree;

  // Éclairage naturel extérieur
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.4);
  scene.add(hemiLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(10, 20, 10);
  scene.add(dirLight);

  // Création de l'ancre MindAR (index 0 = première image du fichier .mind)
  const anchor = mindarThree.addAnchor(0);

  // Groupe contenant le bâtiment mis à l'échelle réelle
  // Dans MindAR, la largeur du marqueur vaut 1 unité. On divise par physicalMarkerWidthMeters
  // pour que 1 unité de notre modèle .glb corresponde exactement à 1 mètre réel.
  const scaleFactor = 1 / CONFIG.physicalMarkerWidthMeters;
  const previewContainer = new THREE.Group();
  previewContainer.scale.set(scaleFactor, scaleFactor, scaleFactor);
  // Rotation de +90° en X car le marqueur est posé à plat au sol
  previewContainer.rotation.x = Math.PI / 2;

  const modelClone = buildingModel.clone();
  modelClone.position.copy(CONFIG.buildingOffset);
  modelClone.rotation.y = THREE.MathUtils.degToRad(CONFIG.buildingRotationDeg);
  previewContainer.add(modelClone);
  anchor.group.add(previewContainer);

  anchor.onTargetFound = () => {
    isTargetVisible = true;
    reticleGuide.style.opacity = '0.2';
    statusBanner.textContent = 'Marqueur détecté — Maintenez le téléphone stable...';
  };

  anchor.onTargetLost = () => {
    isTargetVisible = false;
    reticleGuide.style.opacity = '1';
    if (!stabilizer.isReady) {
      statusBanner.textContent = 'Marqueur perdu — Visez à nouveau l’image au sol';
    }
  };

  await mindarThree.start();
  statusBanner.textContent = 'Pointez la caméra vers l’image au sol';

  renderer.setAnimationLoop(() => {
    if (isTargetVisible) {
      stabilizer.addMatrix(anchor.group.matrixWorld);
      const pct = Math.round(stabilizer.progress * 100);
      if (!stabilizer.isReady) {
        statusBanner.textContent = `Calage géométrique en cours : ${pct}%`;
      } else {
        statusBanner.textContent = 'Calage prêt ! Verrouillez pour marcher autour.';
        btnLock.classList.remove('hidden');
      }
    }
    renderer.render(scene, camera);
  });
}

// ============================================================================
// PHASE 2 : BASCULE VERS WEBXR WORLD TRACKING (TOUR À 360° SANS MARQUEUR)
// ============================================================================
async function switchToWebXRLock() {
  const calibratedPose = stabilizer.getLevelPose();
  if (!calibratedPose) return;

  statusBanner.textContent = 'Verrouillage spatial en cours...';
  btnLock.classList.add('hidden');
  reticleGuide.classList.add('hidden');

  // 1. Arrêt propre de MindAR pour libérer la caméra Android/iOS
  mindarThree.stop();
  mindarThree.renderer.setAnimationLoop(null);
  document.querySelector('#mindar-container').innerHTML = '';

  // 2. Vérification du support WebXR immersif
  if (!navigator.xr || !(await navigator.xr.isSessionSupported('immersive-ar'))) {
    statusBanner.textContent = 'WebXR non supporté sur ce navigateur (utilisez Chrome Android).';
    btnReset.classList.remove('hidden');
    return;
  }

  // 3. Création du moteur Three.js WebXR dédié au tracking monde (SLAM)
  const xrRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  xrRenderer.setPixelRatio(window.devicePixelRatio);
  xrRenderer.setSize(window.innerWidth, window.innerHeight);
  xrRenderer.xr.enabled = true;
  document.querySelector('#mindar-container').appendChild(xrRenderer.domElement);

  const xrScene = new THREE.Scene();
  const xrCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
  xrScene.add(hemiLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(10, 20, 10);
  xrScene.add(dirLight);

  // 4. Démarrage de la session WebXR local-floor (repère lié au sol réel)
  xrSession = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['dom-overlay', 'anchors'],
    domOverlay: { root: document.getElementById('hud') }
  });

  xrRenderer.xr.setReferenceSpaceType('local-floor');
  await xrRenderer.xr.setSession(xrSession);

  // 5. Placement définitif du bâtiment à l'échelle 1:1 (1 unité = 1 mètre)
  const worldAnchorGroup = new THREE.Group();
  worldAnchorGroup.position.set(calibratedPose.position.x, 0, calibratedPose.position.z);
  worldAnchorGroup.quaternion.copy(calibratedPose.quaternion);

  const finalBuilding = buildingModel.clone();
  finalBuilding.position.copy(CONFIG.buildingOffset);
  finalBuilding.rotation.y = THREE.MathUtils.degToRad(CONFIG.buildingRotationDeg);
  worldAnchorGroup.add(finalBuilding);
  xrScene.add(worldAnchorGroup);

  statusBanner.textContent = 'Bâtiment verrouillé (échelle 1:1). Vous pouvez tourner autour !';
  btnReset.classList.remove('hidden');

  xrSession.addEventListener('end', () => {
    xrRenderer.setAnimationLoop(null);
    xrSession = null;
  });

  xrRenderer.setAnimationLoop(() => {
    xrRenderer.render(xrScene, xrCamera);
  });
}

// Gestion des boutons
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

// Lancement au chargement
startMindARPhase().catch((err) => {
  console.error(err);
  statusBanner.textContent = 'Erreur d’accès à la caméra. Vérifiez les permissions HTTPS.';
});