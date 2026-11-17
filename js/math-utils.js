import * as THREE from 'three';

/**
 * Accumule N mesures de matrice pour calculer une pose moyenne stable
 * et projette l'orientation sur le plan horizontal (gravité).
 */
export class PoseStabilizer {
  constructor(sampleTarget = 25) {
    this.sampleTarget = sampleTarget;
    this.positions = [];
    this.quaternions = [];
  }

  reset() {
    this.positions = [];
    this.quaternions = [];
  }

  get progress() {
    return Math.min(1, this.positions.length / this.sampleTarget);
  }

  get isReady() {
    return this.positions.length >= this.sampleTarget;
  }

  addMatrix(matrixWorld) {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrixWorld.decompose(pos, quat, scale);

    this.positions.push(pos);
    this.quaternions.push(quat);
  }

  /**
   * Retourne la position moyenne et un quaternion strictement horizontal (Yaw uniquement).
   * Indispensable pour un bâtiment de 5m x 5m afin d'éviter toute inclinaison due au sol irrégulier.
   */
  getLevelPose() {
    if (this.positions.length === 0) return null;

    // 1. Moyenne arithmétique de la position
    const avgPos = new THREE.Vector3();
    for (const p of this.positions) {
      avgPos.add(p);
    }
    avgPos.divideScalar(this.positions.length);

    // 2. Moyenne sphérique (SLERP cumulatif) des quaternions
    const avgQuat = this.quaternions[0].clone();
    for (let i = 1; i < this.quaternions.length; i++) {
      avgQuat.slerp(this.quaternions[i], 1 / (i + 1));
    }

    // 3. Extraction de l'angle autour de l'axe vertical Y (azimut) uniquement
    // Dans MindAR, l'axe Z local du marqueur pointe vers le haut quand l'image est au sol.
    const euler = new THREE.Euler().setFromQuaternion(avgQuat, 'YXZ');
    const levelQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, euler.y, 0, 'YXZ'));

    return { position: avgPos, quaternion: levelQuat };
  }
}