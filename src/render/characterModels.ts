import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import codyUrl from '../assets/characters/cody.glb?url';
import sarahUrl from '../assets/characters/sarah.glb?url';

/**
 * The pitchers' bodies: skinned models built from MakeHuman's CC0 assets by
 * tools/characters/build.py — one male (Cody), one female (Sarah). Each has
 * the game's 17-bone rig with translation-only joints, and garment materials
 * named shirt, pants and shoes whose colour sets the look.
 */

export type Build = 'male' | 'female';

const URLS: Record<Build, string> = { male: codyUrl, female: sarahUrl };

export async function loadCharacterModels(): Promise<Record<Build, THREE.Group>> {
  const loader = new GLTFLoader();
  const [male, female] = await Promise.all([loader.loadAsync(URLS.male), loader.loadAsync(URLS.female)]);
  return { male: male.scene, female: female.scene };
}
