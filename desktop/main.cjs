// Ringers for Windows (and other desktops): a window that runs the web game
// from the files bundled in ./app, served over a private app:// scheme so
// modules, the worker and saved progress behave exactly as on the web.
const { app, BrowserWindow, Menu, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, 'app');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Ringers',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'app', 'icons', 'icon-512.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      // Keep the game running smoothly even when the window is partly covered.
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  // F11 toggles full screen, as in other Windows games (F inside the game does too).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
  // Any outside link opens in the normal web browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://')) event.preventDefault();
  });
  win.loadURL('app://ringers/index.html');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    protocol.handle('app', (request) => {
      const { pathname } = new URL(request.url);
      const file = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
      if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => app.quit());
}
