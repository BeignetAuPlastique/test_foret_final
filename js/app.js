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
  physicalMarkerWidthMeters: 0.20,
  forceTestSizeMeters: 0.30,
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
// CHARGEMENT SÉCURISÉ DU MODÈLE 3D (AVEC OBJET DE SECOURS SI 404)
// ============================================================================
function createFallbackMesh() {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.3 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.1;
  group.add(mesh);
  return group;
}

async function loadBuildingModel() {
  const loader = new GLTFLoader();
  return new Promise((resolve) => {
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
      (err) => {
        console.warn('Modèle .glb introuvable, utilisation du cube de secours :', err);
        statusBanner.textContent = 'Modèle .glb non trouvé (mode cube de secours actif)';
        resolve(createFallbackMesh());
      }
    );
  });
}

// ============================================================================
// LIBÉRATION MATÉRIELLE COMPLÈTE DE LA CAMÉRA
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
// PHASE 1 : DÉMARRAGE CAMÉRA PRIORITAIRE + CALAGE MINDAR
// ============================================================================
async function startMindARPhase() {
  try {
    document.body.classList.remove('xr-active');
    statusBanner.textContent = 'Demande d’accès à la caméra...';
    reticleGuide.classList.remove('hidden');
    btnLock.classList.add('hidden');
    btnReset.classList.add('hidden');
    solver.reset();

    // 1. Test explicite des permissions caméra avant MindAR pour diagnostiquer tout blocage OS
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia indisponible (vérifiez que l’URL commence bien par https://)');
    }
    const testStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
    testStream.getTracks().forEach((t) => t.stop());

    // 2. Initialisation de MindAR
    statusBanner.textContent = 'Démarrage du moteur de détection...';
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
    anchor.group.add(previewGroup);

    // 3. Démarrage immédiat de la caméra MindAR
    await mindarThree.start();
    statusBanner.textContent = 'Caméra active — Chargement du modèle 3D...';

    // 4. Chargement asynchrone du modèle 3D sans bloquer la caméra
    if (!buildingModel) {
      buildingModel = await loadBuildingModel();
    }
    const modelClone = buildingModel.clone();
    modelClone.position.copy(CONFIG.buildingOffset);
    modelClone.rotation.y = THREE.MathUtils.degToRad(CONFIG.buildingRotationDeg);
    previewGroup.add(modelClone);

    statusBanner.textContent = 'Pointez la caméra vers l’image au sol';

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

    renderer.setAnimationLoop(() => {
      if (isTargetVisible) {
        anchor.group.updateMatrixWorld(true);
        solver.addSample(anchor.group.matrixWorld);
        const pct = Math.round(solver.progress * 100);

        if (!solver.isReady) {
          statusBanner.textContent = `Stabilisation du repère : ${pct}%`;
          btnLock.classList.add('hidden');
        } else {
          statusBanner.textContent = 'Repère verrouillable ! Gardez l’image visible et cliquez.';
          btnLock.classList.remove('hidden');
        }
      }
      renderer.render(scene, camera);
    });
  } catch (err) {
    console.error('Erreur démarrage caméra/MindAR :', err);
    statusBanner.textContent = `Erreur : ${err.name || ''} - ${err.message}`;
  }
}

// ============================================================================
// PHASE 2 : TRANSFERT EXACT DE LA POSE CAMÉRA VERS L'ESPACE MONDE WEBXR
// ============================================================================
async function switchToWebXRLock() {
  const relativePose = solver.getSmoothedCameraRelativePose();
  if (!relativePose) return;

  statusBanner.textContent = 'Verrouillage dans l’espace 3D...';
  btnLock.classList.add('hidden');
  reticleGuide.classList.add('hidden');

  hardKillMindAR();
  await new Promise((r) => setTimeout(r, 250));

  if (!navigator.xr || !(await navigator.xr.isSessionSupported('immersive-ar'))) {
    statusBanner.textContent = 'WebXR non supporté sur ce navigateur.';
    btnReset.classList.remove('hidden');
    return;
  }

  try {
    xrRenderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
    xrRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    xrRenderer.setSize(window.innerWidth, window.innerHeight);
    xrRenderer.setClearColor(0x000000, 0);
    xrRenderer.xr.enabled = true;
    document.querySelector('#mindar-container').appendChild(xrRenderer.domElement);

    const xrScene = new THREE.Scene();
    const xrCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.6);
    xrScene.add(hemiLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 10, 5);
    xrScene.add(dirLight);

    xrSession = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: document.getElementById('hud') }
    });

    document.body.classList.add('xr-active');
    xrRenderer.xr.setReferenceSpaceType('local');
    await xrRenderer.xr.setSession(xrSession);

    const worldAnchorGroup = new THREE.Group();
    worldAnchorGroup.visible = false;

    const basePlate = new THREE.Mesh(
      new THREE.RingGeometry(0.11, 0.14, 32),
      new THREE.MeshBasicMaterial({ color: 0x10b981, side: THREE.DoubleSide })
    );
    basePlate.rotation.x = -Math.PI / 2;
    worldAnchorGroup.add(basePlate);

    const finalModel = (buildingModel || createFallbackMesh()).clone();
    finalModel.position.copy(CONFIG.buildingOffset);
    finalModel.rotation.y = THREE.MathUtils.degToRad(CONFIG.buildingRotationDeg);
    worldAnchorGroup.add(finalModel);
    xrScene.add(worldAnchorGroup);

    let isAnchoredInWorld = false;
    let frameCount = 0;

    xrSession.addEventListener('end', () => {
      document.body.classList.remove('xr-active');
      if (xrRenderer) {
        xrRenderer.setAnimationLoop(null);
        xrRenderer.dispose();
      }
      xrSession = null;
    });

    xrRenderer.setAnimationLoop((timestamp, frame) => {
      if (frame && !isAnchoredInWorld) {
        frameCount++;
        const refSpace = xrRenderer.xr.getReferenceSpace();
        const viewerPose = frame.getViewerPose(refSpace);

        if (viewerPose && frameCount >= 3) {
          const camMatrix = new THREE.Matrix4().fromArray(viewerPose.transform.matrix);
          const camPos = new THREE.Vector3();
          const camQuat = new THREE.Quaternion();
          const camScale = new THREE.Vector3();
          camMatrix.decompose(camPos, camQuat, camScale);

          const worldMarkerPos = relativePose.positionInCameraSpace
            .clone()
            .applyMatrix4(camMatrix);

          worldAnchorGroup.position.copy(worldMarkerPos);

          const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camQuat);
          camForward.y = 0;
          if (camForward.lengthSq() > 0.0001) {
            camForward.normalize();
          } else {
            camForward.set(0, 1, 0).applyQuaternion(camQuat);
            camForward.y = 0;
            camForward.normalize();
          }

          const camYaw = Math.atan2(-camForward.x, -camForward.z);
          const worldYaw = camYaw + relativePose.yawInCameraSpace;

          worldAnchorGroup.quaternion.setFromEuler(new THREE.Euler(0, worldYaw, 0, 'YXZ'));
          worldAnchorGroup.visible = true;
          isAnchoredInWorld = true;

          statusBanner.textContent = 'Ancré sur le marqueur ! Tournez autour à 360°.';
          btnReset.classList.remove('hidden');
        }
      }

      xrRenderer.render(xrScene, xrCamera);
    });
  } catch (err) {
    document.body.classList.remove('xr-active');
    console.error('Échec WebXR :', err);
    statusBanner.textContent = `Erreur WebXR : ${err.name} - ${err.message}`;
    btnReset.classList.remove('hidden');
  }
}

// ============================================================================
// BOUTONS ET INITIALISATION
// ============================================================================
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

startMindARPhase();