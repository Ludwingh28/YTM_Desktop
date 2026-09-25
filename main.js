const { app, BrowserWindow, session, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fetch = require('cross-fetch');
const windowStateKeeper = require('electron-window-state');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

const YTM_URL = 'https://music.youtube.com';

// Extra ad/tracking hosts that YouTube uses for ad delivery and telemetry.
// The adblocker engine below (EasyList + EasyPrivacy) catches almost everything,
// but these are blocked unconditionally as a fast, cheap first line of defense.
const BLOCKED_HOST_PATTERNS = [
  /(^|\.)doubleclick\.net$/,
  /(^|\.)googlesyndication\.com$/,
  /(^|\.)googleadservices\.com$/,
  /(^|\.)google-analytics\.com$/,
  /(^|\.)adservice\.google\.com$/,
  /(^|\.)pagead2\.googlesyndication\.com$/,
];

let mainWindow = null;
let tray = null;

// Google refuses to show the sign-in page inside browsers it can identify as
// "embedded" (Electron, CEF, etc.) — it checks the User-Agent string for the
// "Electron/" token and the app's own name/version, and responds with
// "This browser or app may not be secure" instead of the login form.
// Stripping those tokens leaves a vanilla Chrome UA that Google accepts.
function getSpoofedUserAgent() {
  return app.userAgentFallback
    .replace(/\s*Electron\/\S+/, '')
    .replace(new RegExp(`\\s*${app.getName()}/${app.getVersion()}`), '');
}

function isBlockedUrl(urlString) {
  try {
    const { hostname, pathname } = new URL(urlString);
    if (BLOCKED_HOST_PATTERNS.some((re) => re.test(hostname))) return true;
    if (/\/pagead\//.test(pathname)) return true;
    if (/\/ptracking/.test(pathname)) return true;
    if (/get_midroll_info/.test(pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

async function setupAdblocker(ses) {
  const cacheDir = app.getPath('userData');
  const cachePath = path.join(cacheDir, 'adblocker-engine.bin');

  const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
    path: cachePath,
    read: fs.promises.readFile,
    write: fs.promises.writeFile,
  });

  blocker.enableBlockingInSession(ses);
}

function setupManualRequestBlocking(ses) {
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: isBlockedUrl(details.url) });
  });
}

function injectAdSkipping(win) {
  const script = `
    (function () {
      if (window.__ytmAdSkipperInstalled) return;
      window.__ytmAdSkipperInstalled = true;

      const AD_HIDE_SELECTORS = [
        '.ytp-ad-overlay-container',
        '.ytp-ad-text-overlay',
        '.ytp-ad-image-overlay',
        'ytmusic-mealbar-promo-renderer',
        'ytmusic-statement-banner-renderer',
        '.ytp-ad-player-overlay',
      ];

      function tick() {
        const skipButton = document.querySelector(
          '.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern'
        );
        if (skipButton) {
          skipButton.click();
        }

        const video = document.querySelector('video');
        const adShowing = document.querySelector('.ad-showing, .ad-interrupting');
        if (video) {
          if (adShowing) {
            // Unskippable audio/video ads: mute and fast-forward past them instead.
            video.muted = true;
            video.playbackRate = 16;
            if (isFinite(video.duration)) {
              video.currentTime = video.duration;
            }
          } else if (video.muted || video.playbackRate !== 1) {
            video.muted = false;
            video.playbackRate = 1;
          }
        }

        for (const selector of AD_HIDE_SELECTORS) {
          document.querySelectorAll(selector).forEach((el) => el.remove());
        }
      }

      setInterval(tick, 300);
    })();
  `;

  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(script).catch(() => {});
  });
}

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

function createTray(win) {
  const trayIcon = nativeImage.createFromPath(ICON_PATH).resize({ width: 32, height: 32 });
  tray = new Tray(trayIcon);
  tray.setToolTip('YTM Desktop');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Mostrar',
      click: () => {
        win.show();
      },
    },
    {
      label: 'Reproducir / Pausar',
      click: () => {
        win.webContents.executeJavaScript(
          "document.querySelector('.play-pause-button')?.click();"
        );
      },
    },
    {
      label: 'Siguiente',
      click: () => {
        win.webContents.executeJavaScript(
          "document.querySelector('.next-button')?.click();"
        );
      },
    },
    {
      label: 'Anterior',
      click: () => {
        win.webContents.executeJavaScript(
          "document.querySelector('.previous-button')?.click();"
        );
      },
    },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    win.isVisible() ? win.hide() : win.show();
  });
}

function createMenu(win) {
  const template = [
    {
      label: 'Archivo',
      submenu: [{ role: 'quit', label: 'Salir' }],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload', label: 'Recargar' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom normal' },
        { role: 'zoomIn', label: 'Acercar' },
        { role: 'zoomOut', label: 'Alejar' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const mainWindowState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 820,
  });

  const spoofedUserAgent = getSpoofedUserAgent();
  session.defaultSession.setUserAgent(spoofedUserAgent);

  mainWindow = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#030303',
    autoHideMenuBar: true,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindowState.manage(mainWindow);
  mainWindow.webContents.setUserAgent(spoofedUserAgent);

  // The adblocker engine attaches several listeners per navigation event;
  // harmless, but raise the cap so Electron doesn't warn about it.
  mainWindow.webContents.setMaxListeners(30);

  createMenu(mainWindow);
  createTray(mainWindow);
  injectAdSkipping(mainWindow);

  // Open external links (ads, "sign in" popups, etc.) in the system browser
  // instead of a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(YTM_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  await mainWindow.loadURL(YTM_URL);
}

app.whenReady().then(async () => {
  const ses = session.defaultSession;

  setupManualRequestBlocking(ses);
  try {
    await setupAdblocker(ses);
  } catch (err) {
    console.error('No se pudo inicializar el bloqueador de anuncios:', err);
  }

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });
});

app.on('before-quit', () => {
  app.isQuiting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
