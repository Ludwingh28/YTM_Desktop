const { app, BrowserWindow, session, Menu, Tray, nativeImage, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fetch = require('cross-fetch');
const windowStateKeeper = require('electron-window-state');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { autoUpdater } = require('electron-updater');

const YTM_URL = 'https://music.youtube.com';

let mainWindow = null;
let tray = null;

// --- Persisted preferences (just close-behavior for now) ---------------
let settingsCache = null;

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  if (settingsCache) return settingsCache;
  try {
    settingsCache = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
  } catch {
    settingsCache = {};
  }
  return settingsCache;
}

function saveSettings(patch) {
  settingsCache = { ...loadSettings(), ...patch };
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settingsCache, null, 2));
}

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

// The legacy User-Agent string above isn't the only thing browsers send:
// Chromium also sends "Client Hints" headers (Sec-CH-UA and friends) that
// separately identify the browser. Electron's own Chromium build reports
// itself as plain "Chromium" there — it never claims "Google Chrome" — so
// without this, a request claims to be Chrome in one header and admits it
// isn't in another. That mismatch is exactly the kind of signal a risk/fraud
// system (like the one behind Google's sign-in page) can use to flag a
// session, regardless of how clean the User-Agent string looks.
function setupClientHintsSpoofing(ses) {
  const majorVersion = process.versions.chrome.split('.')[0];
  const clientHints = {
    'sec-ch-ua': `"Chromium";v="${majorVersion}", "Not?A_Brand";v="24", "Google Chrome";v="${majorVersion}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders, ...clientHints };
    callback({ requestHeaders });
  });
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

// --- Manual session import (paste cookies exported from a real browser) ---
// Google's sign-in form actively refuses embedded browsers (see
// getSpoofedUserAgent/injectUserAgentDataOverride above for how far that
// arms race goes). The reliable way around it: let the user log in for real
// in their everyday browser, export the resulting session cookies with an
// extension like Cookie-Editor, and hand them to us directly — we never
// touch Google's login form this way, we just reuse an already-trusted
// session. Only cookies scoped to google.com/youtube.com are accepted.

function isAllowedCookieDomain(domain) {
  const bare = String(domain || '').replace(/^\./, '').toLowerCase();
  return bare === 'google.com' || bare.endsWith('.google.com') || bare === 'youtube.com' || bare.endsWith('.youtube.com');
}

function mapSameSite(value) {
  const allowed = ['unspecified', 'no_restriction', 'lax', 'strict'];
  return allowed.includes(value) ? value : 'unspecified';
}

async function importCookiesFromJson(rawJson) {
  let cookies;
  try {
    cookies = JSON.parse(rawJson);
  } catch {
    return { ok: false, error: 'Eso no parece ser JSON válido. Revisa que copiaste el export completo.' };
  }
  if (!Array.isArray(cookies)) {
    return { ok: false, error: 'El JSON debe ser una lista de cookies (como la exporta Cookie-Editor).' };
  }

  const ses = session.defaultSession;
  let count = 0;
  for (const cookie of cookies) {
    if (!cookie || !cookie.name || !cookie.domain) continue;
    if (!isAllowedCookieDomain(cookie.domain)) continue;

    const domain = cookie.domain;
    const bareDomain = domain.replace(/^\./, '');
    try {
      await ses.cookies.set({
        url: `https://${bareDomain}${cookie.path || '/'}`,
        domain,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || '/',
        secure: cookie.secure !== false,
        httpOnly: !!cookie.httpOnly,
        expirationDate: cookie.session ? undefined : cookie.expirationDate,
        sameSite: mapSameSite(cookie.sameSite),
      });
      count += 1;
    } catch (err) {
      console.error('No se pudo importar la cookie', cookie.name, err);
    }
  }

  if (count === 0) {
    return { ok: false, error: 'No se importó ninguna cookie de google.com/youtube.com. ¿Copiaste el export completo?' };
  }
  return { ok: true, count };
}

let cookieImportWindow = null;

function openCookieImportWindow() {
  if (cookieImportWindow) {
    cookieImportWindow.focus();
    return;
  }

  cookieImportWindow = new BrowserWindow({
    width: 560,
    height: 560,
    parent: mainWindow,
    modal: true,
    autoHideMenuBar: true,
    backgroundColor: '#030303',
    title: 'Importar sesión',
    webPreferences: {
      preload: path.join(__dirname, 'import-session-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  cookieImportWindow.setMenu(null);
  cookieImportWindow.loadFile(path.join(__dirname, 'import-session.html'));

  cookieImportWindow.on('closed', () => {
    cookieImportWindow = null;
  });
}

function setupCookieImport() {
  ipcMain.handle('ytm:import-cookies', async (_event, rawJson) => importCookiesFromJson(rawJson));

  ipcMain.on('ytm:import-cookies-done', () => {
    if (cookieImportWindow) cookieImportWindow.close();
    if (mainWindow) mainWindow.loadURL(YTM_URL);
  });
}

const REPO_URL = 'https://github.com/Ludwingh28/YTM_Desktop';

// electron-updater carries whatever we write in the GitHub Release's
// description as `info.releaseNotes` — this just turns that into plain text
// for a native dialog (no HTML/Markdown rendering there), trimmed to a
// reasonable length. Keep release descriptions as plain "- bullet" lines
// when publishing so they read well here.
function formatReleaseNotes(releaseNotes) {
  let text = '';
  if (typeof releaseNotes === 'string') {
    text = releaseNotes;
  } else if (Array.isArray(releaseNotes)) {
    text = releaseNotes.map((n) => n.note || '').join('\n');
  }
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .trim();
  if (text.length > 600) text = text.slice(0, 600) + '...';
  return text;
}

function setupAutoUpdates() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    const notes = formatReleaseNotes(info.releaseNotes);
    const detailParts = [];
    if (notes) detailParts.push('Qué cambió:\n' + notes);
    detailParts.push('Se instalará al cerrar la app, o puedes reiniciar ahora para aplicarla ya.');
    detailParts.push('¿Dudas? Revisa el repositorio: ' + REPO_URL);

    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'Actualización lista',
        message: `Se descargó la versión ${info.version}.`,
        detail: detailParts.join('\n\n'),
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
  // Ads-only, not "AdsAndTracking": the broader tracking/privacy list (EasyPrivacy)
  // also blocks generic Google telemetry endpoints like play.google.com/log —
  // which Google's own sign-in flow uses to report client signals. Blocking that
  // made Google's fraud detection treat the session as suspicious and reject
  // login. Ads-only avoids that while still blocking the actual ad requests.
  const cachePath = path.join(cacheDir, 'adblocker-engine-ads-only.bin');

  const blocker = await ElectronBlocker.fromPrebuiltAdsOnly(fetch, {
    path: cachePath,
    read: fs.promises.readFile,
    write: fs.promises.writeFile,
  });

  blocker.enableBlockingInSession(ses);
}

// setupClientHintsSpoofing (above) fixes the Sec-CH-UA *headers*, but the
// navigator.userAgentData JS object is derived by Chromium internally from
// its own build branding, not from those headers — a page's own JS reading
// it directly would still see "Chromium" with no "Google Chrome" brand,
// which is exactly the kind of client/header mismatch a risk-scoring script
// (like the one behind Google's sign-in page) could use as a signal. This
// overrides it to stay consistent, on every navigation in this window
// (including the later navigation to accounts.google.com), running as early
// as dom-ready so it's in place well before a human finishes typing an email.
function injectUserAgentDataOverride(win) {
  const chromeVersion = process.versions.chrome;
  const majorVersion = chromeVersion.split('.')[0];
  const script = `
    (function () {
      try {
        const brands = [
          { brand: 'Not?A_Brand', version: '24' },
          { brand: 'Chromium', version: '${majorVersion}' },
          { brand: 'Google Chrome', version: '${majorVersion}' },
        ];
        const fullVersionList = [
          { brand: 'Not?A_Brand', version: '24.0.0.0' },
          { brand: 'Chromium', version: '${chromeVersion}' },
          { brand: 'Google Chrome', version: '${chromeVersion}' },
        ];
        const fakeUAData = {
          brands,
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: function (hints) {
            const values = {
              brands,
              mobile: false,
              platform: 'Windows',
              platformVersion: '10.0.0',
              architecture: 'x86',
              bitness: '64',
              fullVersionList,
              uaFullVersion: '${chromeVersion}',
            };
            const requested = hints && hints.length ? hints : Object.keys(values);
            const result = {};
            requested.forEach(function (h) { if (h in values) result[h] = values[h]; });
            return Promise.resolve(result);
          },
          toJSON: function () { return { brands, mobile: false, platform: 'Windows' }; },
        };
        Object.defineProperty(Navigator.prototype, 'userAgentData', {
          get: function () { return fakeUAData; },
          configurable: true,
        });
      } catch (e) {
        console.error('No se pudo sobreescribir navigator.userAgentData', e);
      }
    })();
  `;

  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(script).catch(() => {});
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

      // Report play/pause state to the main process so the Windows taskbar
      // thumbnail buttons can show the right icon. Reuses the same
      // find-the-video-element polling as the observer above instead of
      // adding a second one.
      let videoListenerAttached = false;
      const videoWatchTimer = setInterval(() => {
        if (videoListenerAttached) {
          clearInterval(videoWatchTimer);
          return;
        }
        const video = document.querySelector('video');
        if (!video || !window.ytmDesktop) return;
        videoListenerAttached = true;
        clearInterval(videoWatchTimer);
        video.addEventListener('play', () => window.ytmDesktop.notifyPlaybackState(true));
        video.addEventListener('pause', () => window.ytmDesktop.notifyPlaybackState(false));
        window.ytmDesktop.notifyPlaybackState(!video.paused);
      }, 500);
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

const MEDIA_ICONS_DIR = path.join(__dirname, 'assets', 'media');
const MEDIA_ICONS = {
  previous: nativeImage.createFromPath(path.join(MEDIA_ICONS_DIR, 'previous.png')),
  play: nativeImage.createFromPath(path.join(MEDIA_ICONS_DIR, 'play.png')),
  pause: nativeImage.createFromPath(path.join(MEDIA_ICONS_DIR, 'pause.png')),
  next: nativeImage.createFromPath(path.join(MEDIA_ICONS_DIR, 'next.png')),
};

function buildThumbarButtons(win, isPlaying) {
  return [
    {
      tooltip: 'Anterior',
      icon: MEDIA_ICONS.previous,
      click: () => win.webContents.executeJavaScript("document.querySelector('.previous-button')?.click();"),
    },
    {
      tooltip: isPlaying ? 'Pausar' : 'Reproducir',
      icon: isPlaying ? MEDIA_ICONS.pause : MEDIA_ICONS.play,
      click: () => win.webContents.executeJavaScript("document.querySelector('.play-pause-button')?.click();"),
    },
    {
      tooltip: 'Siguiente',
      icon: MEDIA_ICONS.next,
      click: () => win.webContents.executeJavaScript("document.querySelector('.next-button')?.click();"),
    },
  ];
}

function setupThumbarControls(win) {
  if (process.platform !== 'win32') return;

  win.setThumbarButtons(buildThumbarButtons(win, false));

  ipcMain.on('playback-state-changed', (event, isPlaying) => {
    if (event.sender !== win.webContents) return;
    win.setThumbarButtons(buildThumbarButtons(win, isPlaying));
  });
}

function createMenu(win) {
  const template = [
    {
      label: 'Archivo',
      submenu: [
        {
          label: 'Importar sesión desde el navegador...',
          click: () => openCookieImportWindow(),
        },
        { type: 'separator' },
        {
          label: 'Preguntar de nuevo al cerrar la ventana',
          click: () => {
            saveSettings({ closeBehavior: undefined });
            dialog.showMessageBox(win, {
              type: 'info',
              message: 'Listo. La próxima vez que cierres la ventana te preguntaré de nuevo qué hacer.',
            });
          },
        },
        { type: 'separator' },
        { role: 'quit', label: 'Salir' },
      ],
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
    autoHideMenuBar: false,
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
  setupThumbarControls(mainWindow);
  injectUserAgentDataOverride(mainWindow);
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
    if (app.isQuiting) return;
    event.preventDefault();

    const { closeBehavior } = loadSettings();
    if (closeBehavior === 'tray') {
      mainWindow.hide();
      return;
    }
    if (closeBehavior === 'quit') {
      app.isQuiting = true;
      app.quit();
      return;
    }

    dialog
      .showMessageBox(mainWindow, {
        type: 'question',
        title: 'Cerrar YTM Desktop',
        message: '¿Qué quieres hacer al cerrar la ventana?',
        detail:
          'Puedes seguir escuchando música en segundo plano (la app queda en la bandeja del sistema), o salir por completo.',
        buttons: ['Reproducir en segundo plano', 'Salir de la app'],
        defaultId: 0,
        cancelId: 0,
        checkboxLabel: 'Recordar mi elección y no volver a preguntar',
        checkboxChecked: false,
      })
      .then(({ response, checkboxChecked }) => {
        const choice = response === 0 ? 'tray' : 'quit';
        if (checkboxChecked) {
          saveSettings({ closeBehavior: choice });
        }
        if (choice === 'tray') {
          mainWindow.hide();
        } else {
          app.isQuiting = true;
          app.quit();
        }
      });
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

    try {
      await setupAdblocker(ses);
    } catch (err) {
      console.error('No se pudo inicializar el bloqueador de anuncios:', err);
    }
    setupClientHintsSpoofing(ses);
    setupCookieImport();

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
