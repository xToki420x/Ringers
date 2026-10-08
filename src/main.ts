import '@fontsource/oswald/latin-500.css';
import '@fontsource/oswald/latin-600.css';
import '@fontsource/oswald/latin-700.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import './ui/styles.css';
import { App } from './game/app';

async function boot() {
  // Make sure the display fonts are ready before canvas textures draw text.
  try {
    await Promise.race([
      Promise.all(['500 16px Oswald', '700 16px Oswald'].map((f) => document.fonts.load(f))),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch {
    /* fonts are a nicety */
  }
  const app = new App();
  (window as unknown as { ringers: App }).ringers = app;
  await app.start();
}

boot().catch((err) => {
  console.error(err);
  const msg = document.querySelector('#loading .msg');
  if (msg) msg.textContent = 'This device could not start the 3D renderer.';
});

// Offline caching for the web version only; the native apps bundle their files.
const isNative = !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNative) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
