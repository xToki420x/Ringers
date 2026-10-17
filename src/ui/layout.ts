/**
 * Screen-shape awareness. Phones get the portrait layout the game was built
 * around; PCs, laptops and landscape tablets get a wide layout (menus beside
 * the 3D scene) with the interface scaled up to suit a large display.
 */

export const layout = {
  /** Landscape screen big enough for side-by-side menus. */
  wide: false,
  /** Interface zoom (1 on phones). */
  scale: 1,
  /** Touch screen rather than mouse. */
  coarse: true,
};

export function updateLayout() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  layout.coarse = window.matchMedia?.('(pointer: coarse)').matches ?? true;
  layout.wide = W >= 760 && W > H * 1.15;
  const s = Math.min(H / 860, W / (layout.wide ? 1100 : 430));
  layout.scale = Math.round(Math.max(1, Math.min(1.7, s)) * 100) / 100;
  const root = document.documentElement;
  root.classList.toggle('wide', layout.wide);
  root.classList.toggle('mouse', !layout.coarse);
  root.style.setProperty('--ui-scale', String(layout.scale));
}

/** "Tap" on touch screens, "Click" with a mouse. */
export const tapWord = () => (layout.coarse ? 'Tap' : 'Click');

export function toggleFullscreen() {
  const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  if (document.fullscreenElement || d.webkitFullscreenElement) {
    (document.exitFullscreen?.() ?? d.webkitExitFullscreen?.())?.catch?.(() => undefined);
  } else {
    (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.())?.catch?.(() => undefined);
  }
}

export const canFullscreen = () => !!(document.fullscreenEnabled || (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled);
