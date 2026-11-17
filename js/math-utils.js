import * as THREE from 'three';

/**
 * Calcule et lisse la position 3D (en mètres) et l'orientation horizontale (azimut)
 * d'un marqueur posé à plat au sol, exprimés dans le repère de la caméra.
 */
export class MarkerCameraSolver {
  constructor(markerWidthMeters, windowSize = 15) {
    this.markerWidthMeters = markerWidthMeters;
    this.windowSize = windowSize;
    this.samples = [];
  }

  reset() {
    this.samples = [];
  }

  get progress() {
    return Math.min(1, this.samples.length / this.windowSize);
  }

  get isReady() {
    return this.samples.length >= this.windowSize;
  }

  /**
   * Ajoute une mesure issue de la matrice monde de l'ancre MindAR.
   * Dans MindAR, la caméra est fixe à l'origine (0,0,0) et regarde vers -Z.
   * 1 unité MindAR = largeur physique du marqueur.
   */
  addSample(anchorMatrixWorld) {
    // 1. Position du centre du marqueur par rapport à la caméra, convertie en mètres
    const posMarkerUnits = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    anchorMatrixWorld.decompose(posMarkerUnits, quat, scale);

    const posMeters = posMarkerUnits.multiplyScalar(this.markerWidthMeters);

    // 2. Direction du "haut" de l'image imprimée (axe Y local du marqueur) dans le repère caméra
    const imageUpAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);

    // Projection sur le plan horizontal (X, Z) de la caméra pour obtenir l'azimut au sol
    // Angle par rapport à l'axe -Z (devant la caméra)
    const yawRad = Math.atan2(-imageUpAxis.x, -imageUpAxis.z);

    this.samples.push({ pos: posMeters, yaw: yawRad });
    if (this.samples.length > this.windowSize) {
      this.samples.shift(); // Fenêtre glissante sur les 15 dernières frames
    }
  }

  /**
   * Retourne la pose moyenne lissée par rapport à la caméra à l'instant T.
   */
  getSmoothedCameraRelativePose() {
    if (this.samples.length === 0) return null;

    const avgPos = new THREE.Vector3();
    let sinSum = 0;
    let cosSum = 0;

    for (const s of this.samples) {
      avgPos.add(s.pos);
      sinSum += Math.sin(s.yaw);
      cosSum += Math.cos(s.yaw);
    }

    avgPos.divideScalar(this.samples.length);
    // Moyenne circulaire des angles pour éviter le saut -PI / +PI
    const avgYaw = Math.atan2(sinSum / this.samples.length, cosSum / this.samples.length);

    return {
      positionInCameraSpace: avgPos, // Vecteur (X, Y, Z) en mètres depuis l'objectif
      yawInCameraSpace: avgYaw         // Rotation horizontale (rad) par rapport à la visée
    };
  }
}