const { app, BrowserWindow, session, Menu, Tray, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fetch = require('cross-fetch');
const windowStateKeeper = require('electron-window-state');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { autoUpdater } = require('electron-updater');

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

function checkForUpdates({ manual }) {
  if (!app.isPackaged) {
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: 'Las actualizaciones solo se revisan en la app instalada, no en modo desarrollo.',
      });
    }
    return;
  }

  if (manual) {
    autoUpdater.once('update-not-available', () => {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: 'Ya tienes la última versión instalada.',
      });
    });
  }

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Error buscando actualizaciones:', err);
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        message: 'No se pudo buscar actualizaciones.',
        detail: String(err),
      });
    }
  });
}

function setupAutoUpdates() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'Actualización lista',
        message: `Se descargó la versión ${info.version}.`,
        detail: 'Se instalará al cerrar la app, o puedes reiniciar ahora para aplicarla ya.',
        buttons: ['Reiniciar ahora', 'Más tarde'],
        defaultId: 0,
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on('error', (err) => {
    console.error('Error en el auto-actualizador:', err);
  });

  checkForUpdates({ manual: false });
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  setInterval(() => checkForUpdates({ manual: false }), FOUR_HOURS);
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
  // A tight setInterval polling loop is the main CPU hog in apps like this
  // (it runs forever, even when nothing is happening). A MutationObserver
  // only wakes up when the DOM actually changes, which is what happens when
  // an ad starts/stops, so steady-state CPU during normal playback stays
  // near zero. The slow interval below is just a safety net in case an ad
  // slips in without triggering a mutation we're watching.
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

      function sweep() {
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

      const observer = new MutationObserver(() => sweep());

      // Scope the observer to the player element rather than the whole
      // document: YTM's feed/queue lists churn DOM nodes constantly while
      // scrolling, which would otherwise fire this on nearly every frame.
      function attachToPlayer() {
        const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
        if (!player) return false;
        observer.observe(player, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class'],
        });
        return true;
      }

      let attempts = 0;
      const attachTimer = setInterval(() => {
        attempts += 1;
        if (attachToPlayer() || attempts > 20) {
          clearInterval(attachTimer);
        }
      }, 500);

      // Safety net: covers the rare case an ad appears without a matching mutation.
      setInterval(sweep, 2000);
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
        { role: 'forceReload', label: 'Forzar recargar' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom normal' },
        { role: 'zoomIn', label: 'Acercar' },
        { role: 'zoomOut', label: 'Alejar' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        {
          label: 'Buscar actualizaciones',
          click: () => checkForUpdates({ manual: true }),
        },
        {
          label: 'Versión actual: ' + app.getVersion(),
          enabled: false,
        },
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
      spellcheck: false, // no text input in this app; skips loading dictionaries
      backgroundThrottling: true, // throttle rendering work while hidden in the tray
    },
  });

  mainWindowState.manage(mainWindow);
  mainWindow.webContents.setUserAgent(spoofedUserAgent);

  // The adblocker engine attaches several listeners per navigation event;
  // harmless, but raise the cap so Electron doesn't warn about it.
  mainWindow.webContents.setMaxListeners(30);

  // This is a static player UI, not a game or animation-heavy app — capping
  // the compositor at 30fps noticeably cuts GPU/CPU usage with no visible cost.
  mainWindow.webContents.setFrameRate(30);

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

// Prevent a second launch (e.g. double-clicking the desktop shortcut while
// it's already running) from spinning up a whole extra Electron process
// tree — instead, just focus the window that's already open.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    const ses = session.defaultSession;

    setupManualRequestBlocking(ses);
    try {
      await setupAdblocker(ses);
    } catch (err) {
      console.error('No se pudo inicializar el bloqueador de anuncios:', err);
    }

    await createWindow();
    setupAutoUpdates();

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
}
