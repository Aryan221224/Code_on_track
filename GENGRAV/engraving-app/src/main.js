/**
 * GENGRAV Main Process - GRBL 1.1 Controller
 * With Direct Supabase Database Connection
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { execFile } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');
const { GRBLController, GRBL_SETTINGS, LASER_DEFAULTS, BAUD_RATES, CONNECTION_OPTIONS, REALTIME_COMMANDS, GRBL_VERSION } = require('./grbl-controller');
const db = require('./database');
const QRCode = require('qrcode');
const { applyAlignmentOffset } = require('../../shared/gcode-transform');
const { generateQRGCode } = require('./qr-gcode');
const { BatchEngraver } = require('./batch-engraver');

if (require('electron-squirrel-startup')) app.quit();

const grbl = new GRBLController();

// QR modules (1 = black) for a string; shared by the single-QR UI and the batch engraver.
function buildQRMatrix(data) {
  const qrData = QRCode.create(data, { errorCorrectionLevel: 'M' });
  const modules = qrData.modules;
  const size = modules.size;
  const matrix = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push(modules.get(x, y) ? 1 : 0);
    matrix.push(row);
  }
  return matrix;
}

// Settings / alignment for the batch that is currently running (set by batch:start)
let batchJob = { settings: {}, applyAlignment: false };
const batch = new BatchEngraver({
  grbl,
  db,
  generateGCode: (item) => {
    // never ask for more power than the controller's $30 (max spindle/laser S value)
    const sMax = Math.min(Number(batchJob.settings.sMax) || 0, grbl.maxPower || 1000);
    let gcode = generateQRGCode({ matrix: buildQRMatrix(item.uid), uid: item.uid, settings: { ...batchJob.settings, sMax } });
    if (batchJob.applyAlignment) {
      if (!lastAlignment) throw new Error('no vision alignment available');
      gcode = applyAlignmentOffset(gcode, {
        dxMm: lastAlignment.dx_mm,
        dyMm: lastAlignment.dy_mm,
        thetaDeg: lastAlignment.theta_deg,
        pivot: { x: lastAlignment.nominal_mm.x, y: lastAlignment.nominal_mm.y },
      });
    }
    return gcode;
  },
});
let mainWindow = null;
let dbConnected = false;

// ========== Vision Alignment (see VISION_ALIGNMENT.md) ==========
// Camera-measured workpiece offset from the most recent successful
// vision:align call. Cleared on connect/disconnect and whenever a new
// calibration is run, so a stale reading from a previous workpiece can
// never silently get applied to a different one.
let lastAlignment = null;
const VISION_DIR = path.join(__dirname, '../../vision');
const PYTHON_BIN = process.env.GENGRAV_PYTHON || 'python3';

// Phone-camera alignment (see VISION_ALIGNMENT.md "Phone camera as an
// alternative capture device"). The phone app POSTs a photo to this same
// backend's /api/vision/align, which persists the reading -- this pulls
// the most recent one so it can be applied here exactly like a USB-camera
// reading from vision:align. Same backend the Flutter app is already
// configured against (see BACKEND_CONFIG.md); override with
// GENGRAV_VISION_BACKEND_URL for a local/self-hosted backend.
const VISION_BACKEND_URL = process.env.GENGRAV_VISION_BACKEND_URL
  || 'https://railchinh-mobile-backend.onrender.com';
const VISION_MACHINE_ID = process.env.GENGRAV_MACHINE_ID || 'default';

function httpGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: true, data: JSON.parse(body) });
        } catch (e) {
          resolve({ ok: false, error: 'invalid JSON from vision backend' });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'vision backend request timed out' }); });
  });
}

function runVisionScript(scriptName, extraArgs = []) {
  return new Promise((resolve) => {
    execFile(PYTHON_BIN, [path.join(VISION_DIR, scriptName), ...extraArgs],
      { cwd: VISION_DIR, timeout: 30000 },
      (error, stdout, _stderr) => {
        // Both calibrate.py and align.py always print exactly one JSON
        // object to stdout, success or failure (see their own docstrings)
        // -- so a parse failure here means the Python process itself
        // crashed before reaching its own error handling, which is
        // reported as-is rather than papered over.
        const lastLine = (stdout || '').trim().split('\n').pop() || '';
        try {
          resolve(JSON.parse(lastLine));
        } catch (e) {
          resolve({
            success: false,
            error: (error && error.message) || 'vision script produced no parseable output',
          });
        }
      });
  });
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1200, minHeight: 700,
    webPreferences: { preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY, nodeIntegration: false, contextIsolation: true },
    backgroundColor: '#0a0a0f', title: 'GENGRAV Laser Engraver (GRBL 1.1)'
  });
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // GRBL event forwarding
  grbl.on('status', (s) => mainWindow?.webContents.send('grbl:status', s));
  grbl.on('log', (m) => mainWindow?.webContents.send('grbl:log', m));
  grbl.on('tx', (c) => mainWindow?.webContents.send('grbl:tx', c));
  grbl.on('rx', (l) => mainWindow?.webContents.send('grbl:rx', l));
  grbl.on('progress', (p) => mainWindow?.webContents.send('grbl:progress', p));
  grbl.on('settings', (s) => mainWindow?.webContents.send('grbl:settings', s));
  grbl.on('error', (e) => mainWindow?.webContents.send('grbl:error', e.toString()));
  grbl.on('estop', () => mainWindow?.webContents.send('grbl:estop'));
  grbl.on('complete', () => mainWindow?.webContents.send('grbl:complete'));
  grbl.on('version', (v) => mainWindow?.webContents.send('grbl:version', v));
  grbl.on('alarm', (a) => mainWindow?.webContents.send('grbl:alarm', a));
  grbl.on('message', (m) => mainWindow?.webContents.send('grbl:message', m));
  batch.on('state', (s) => mainWindow?.webContents.send('batch:state', s));
  batch.on('log', (l) => mainWindow?.webContents.send('batch:log', l));

  // Send database connection status to renderer
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('db:status', { connected: dbConnected });
  });

  if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools();
};

// Test database connection before starting the app
async function initializeApp() {
  console.log('🚀 GENGRAV Starting...');
  console.log('📡 Testing database connection...');

  const dbResult = await db.testConnection();

  if (dbResult.success) {
    console.log('✅ Database connection successful!');
    dbConnected = true;
  } else {
    console.error('❌ Database connection failed:', dbResult.error);
    dbConnected = false;

    // Show error dialog but continue anyway
    dialog.showMessageBox({
      type: 'warning',
      title: 'Database Connection Failed',
      message: 'Could not connect to the database.',
      detail: `Error: ${dbResult.error}\n\nThe app will continue but QR code fetching may not work.`,
      buttons: ['Continue Anyway', 'Quit'],
    }).then(({ response }) => {
      if (response === 1) {
        app.quit();
      }
    });
  }

  createWindow();
}

app.whenReady().then(initializeApp);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => {
  grbl.disconnect();
  db.closePool();
  if (process.platform !== 'darwin') app.quit();
});

// ========== Core IPC Handlers ==========
ipcMain.handle('grbl:listPorts', () => grbl.listPorts());
ipcMain.handle('grbl:listAllPorts', () => grbl.listAllPorts());
ipcMain.handle('grbl:connect', (_, { port, baudRate, options }) => {
  return grbl.connect(port, { baudRate, ...options })
    .then(() => ({ success: true, state: grbl.getState() }))
    .catch(e => ({ success: false, error: e.message }));
});
ipcMain.handle('grbl:disconnect', () => { grbl.disconnect(); return { success: true }; });
ipcMain.handle('grbl:getState', () => grbl.getState());
ipcMain.handle('grbl:getBaudRates', () => BAUD_RATES);
ipcMain.handle('grbl:getConnectionOptions', () => CONNECTION_OPTIONS);
ipcMain.handle('grbl:getGrblVersion', () => GRBL_VERSION);

// ========== Settings IPC Handlers ==========
ipcMain.handle('grbl:readSettings', () => grbl.readSettings().then(s => ({ success: true, settings: s })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:writeSetting', (_, { key, value }) => grbl.writeSetting(key, value).then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:applyDefaults', () => grbl.applyDefaults().then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:enableLaserMode', () => grbl.enableLaserMode().then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:getDefaults', () => ({ settings: GRBL_SETTINGS, defaults: LASER_DEFAULTS }));

// ========== Motion IPC Handlers ==========
ipcMain.handle('grbl:home', () => grbl.home().then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:homeAll', () => grbl.homeAll().then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:goHome', () => grbl.goHome().then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:jog', (_, { axis, distance, feed }) => grbl.jog(axis, distance, feed || 500).then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:jogCancel', () => { grbl.jogCancel(); return { success: true }; });
ipcMain.handle('grbl:moveTo', (_, { x, y, feed }) => grbl.moveTo(x, y, feed || 1000).then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:send', (_, c) => grbl.send(c).then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));

// ========== Laser IPC Handlers ==========
ipcMain.handle('grbl:laserOn', (_, p) => grbl.laserOn(p).then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:laserOff', () => grbl.laserOff().then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:laserTest', (_, { power, duration }) => grbl.laserTest(power, duration).then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:laserFocus', (_, p) => grbl.laserFocus(p).then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));

// ========== Control IPC Handlers ==========
ipcMain.handle('grbl:emergencyStop', () => {
  if (batch.running) batch.stop();
  return grbl.doEmergencyStop().then(() => ({ success: true })).catch(e => ({ success: false, error: e.message }));
});
ipcMain.handle('grbl:resetEstop', () => grbl.resetEstop().then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:unlock', () => grbl.unlock().then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:runGCode', (_, g) => {
  if (batch.running) return Promise.resolve({ success: false, error: 'A batch is running - stop it first' });
  return grbl.runGCode(g).then((r) => ({ success: true, ...r })).catch(e => ({ success: false, error: e.message }));
});
ipcMain.handle('grbl:stop', () => { batch.running ? batch.stop() : grbl.stop(); return { success: true }; });

// Run G-code with the most recent vision alignment offset applied first.
// Kept as a SEPARATE channel from grbl:runGCode (rather than adding a flag
// to it) so existing callers of runGCode are entirely unaffected, and so
// this can never fire off a stale/no alignment silently -- it fails closed
// if there isn't one.
ipcMain.handle('grbl:runGCodeAligned', (_, g) => {
  if (!lastAlignment) {
    return Promise.resolve({ success: false, error: 'no vision alignment available -- run vision:align first' });
  }
  const aligned = applyAlignmentOffset(g, {
    dxMm: lastAlignment.dx_mm,
    dyMm: lastAlignment.dy_mm,
    thetaDeg: lastAlignment.theta_deg,
    pivot: { x: lastAlignment.nominal_mm.x, y: lastAlignment.nominal_mm.y },
  });
  if (batch.running) return Promise.resolve({ success: false, error: 'A batch is running - stop it first' });
  return grbl.runGCode(aligned)
    .then(() => ({ success: true, appliedOffset: lastAlignment }))
    .catch(e => ({ success: false, error: e.message }));
});

// ========== GRBL 1.1 Real-time Commands ==========
ipcMain.handle('grbl:softReset', () => { grbl.softReset(); return { success: true }; });
ipcMain.handle('grbl:feedHold', () => { grbl.feedHold(); return { success: true }; });
ipcMain.handle('grbl:cycleStart', () => { grbl.cycleStart(); return { success: true }; });
ipcMain.handle('grbl:safetyDoor', () => { grbl.safetyDoor(); return { success: true }; });

// ========== GRBL 1.1 Override Commands ==========
ipcMain.handle('grbl:feedOverrideReset', () => { grbl.feedOverrideReset(); return { success: true }; });
ipcMain.handle('grbl:feedOverrideIncrease', (_, fine) => { grbl.feedOverrideIncrease(fine); return { success: true }; });
ipcMain.handle('grbl:feedOverrideDecrease', (_, fine) => { grbl.feedOverrideDecrease(fine); return { success: true }; });
ipcMain.handle('grbl:rapidOverrideReset', () => { grbl.rapidOverrideReset(); return { success: true }; });
ipcMain.handle('grbl:rapidOverride50', () => { grbl.rapidOverride50(); return { success: true }; });
ipcMain.handle('grbl:rapidOverride25', () => { grbl.rapidOverride25(); return { success: true }; });
ipcMain.handle('grbl:spindleOverrideReset', () => { grbl.spindleOverrideReset(); return { success: true }; });
ipcMain.handle('grbl:spindleOverrideIncrease', (_, fine) => { grbl.spindleOverrideIncrease(fine); return { success: true }; });
ipcMain.handle('grbl:spindleOverrideDecrease', (_, fine) => { grbl.spindleOverrideDecrease(fine); return { success: true }; });
ipcMain.handle('grbl:spindleStop', () => { grbl.spindleStop(); return { success: true }; });

// ========== GRBL 1.1 Coolant Commands ==========
ipcMain.handle('grbl:toggleFloodCoolant', () => { grbl.toggleFloodCoolant(); return { success: true }; });
ipcMain.handle('grbl:toggleMistCoolant', () => { grbl.toggleMistCoolant(); return { success: true }; });

// ========== GRBL 1.1 Info Commands ==========
ipcMain.handle('grbl:getBuildInfo', () => grbl.getBuildInfo().then(info => ({ success: true, info })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:getParserState', () => grbl.getParserState().then(state => ({ success: true, state })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:getStartupBlocks', () => grbl.getStartupBlocks().then(blocks => ({ success: true, blocks })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:setStartupBlock', (_, { index, gcode }) => grbl.setStartupBlock(index, gcode).then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:toggleCheckMode', () => grbl.toggleCheckMode().then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));
ipcMain.handle('grbl:sleep', () => grbl.sleep().then(() => ({ success: true })).catch(e => ({ success: false, error: e.message })));

// ========== Database/API Handlers for QR Codes (Direct Supabase Connection) ==========

// Test database connection
ipcMain.handle('db:testConnection', async () => {
  return await db.testConnection();
});

// Get database connection status
ipcMain.handle('db:getStatus', () => {
  return { connected: dbConnected };
});

// Fetch all QR codes/items from database
ipcMain.handle('api:fetchQRCodes', async () => {
  if (!dbConnected) {
    // Try to reconnect
    const result = await db.testConnection();
    if (result.success) {
      dbConnected = true;
    } else {
      return { success: false, error: 'Database not connected' };
    }
  }

  return await db.fetchItems(50);
});

// Fetch items pending engraving
ipcMain.handle('api:fetchPendingEngravings', async () => {
  if (!dbConnected) {
    return { success: false, error: 'Database not connected' };
  }
  return await db.fetchPendingEngravings(50);
});

// Fetch a single item by UID
ipcMain.handle('api:fetchQRImage', async (_, uid) => {
  if (!dbConnected) {
    return { success: false, error: 'Database not connected' };
  }
  return await db.fetchItemByUid(uid);
});

// Update item status after engraving
ipcMain.handle('api:updateItemStatus', async (_, { uid, status }) => {
  if (!dbConnected) {
    return { success: false, error: 'Database not connected' };
  }
  return await db.updateItemStatus(uid, status);
});

// Record an engraving job
ipcMain.handle('api:recordEngraving', async (_, engravingData) => {
  if (!dbConnected) {
    return { success: false, error: 'Database not connected' };
  }
  return await db.recordEngraving(engravingData);
});

// Generate QR code as data URL
ipcMain.handle('api:generateQRCode', async (_, { data, size }) => {
  try {
    const qrSize = size || 256;
    const dataUrl = await QRCode.toDataURL(data, {
      width: qrSize,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      errorCorrectionLevel: 'M'
    });
    return { success: true, dataUrl };
  } catch (error) {
    console.error('QR code generation error:', error);
    return { success: false, error: error.message };
  }
});

// Generate QR code as matrix (for G-code generation)
ipcMain.handle('api:generateQRMatrix', async (_, { data }) => {
  try {
    const matrix = buildQRMatrix(data);
    return { success: true, matrix, size: matrix.length, moduleCount: matrix.length };
  } catch (error) {
    console.error('QR matrix generation error:', error);
    return { success: false, error: error.message };
  }
});

// Generate G-code for one QR code (same generator the batch engraver uses)
ipcMain.handle('api:generateQRGCode', async (_, { data, settings }) => {
  try {
    return { success: true, gcode: generateQRGCode({ matrix: buildQRMatrix(data), uid: data, settings }) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ========== Batch engraving ==========
// Fetch N pending QR codes from the database and engrave them with a delay between each.
ipcMain.handle('batch:start', async (_, { count, delaySeconds, maxRetries, settings, applyAlignment } = {}) => {
  if (batch.running) return { success: false, error: 'A batch is already running' };
  if (!dbConnected) {
    const r = await db.testConnection();
    if (!r.success) return { success: false, error: 'Database not connected' };
    dbConnected = true;
  }
  if (applyAlignment && !lastAlignment) {
    return { success: false, error: 'no vision alignment available -- run vision:align first' };
  }
  batchJob = { settings: settings || {}, applyAlignment: !!applyAlignment };
  // Runs in the background; progress arrives via batch:state events.
  batch.start({ count, delaySeconds, maxRetries }).then((r) => {
    if (r && r.success === false && r.error) mainWindow?.webContents.send('batch:log', { message: r.error, level: 'error' });
  });
  return { success: true };
});
ipcMain.handle('batch:stop', () => batch.stop());
ipcMain.handle('batch:getState', () => batch.getState());
ipcMain.handle('batch:countPending', async () => {
  if (!dbConnected) return { success: false, error: 'Database not connected' };
  return await db.countPendingEngravings();
});

// ========== Vision Alignment IPC Handlers ==========
// See VISION_ALIGNMENT.md for the hardware, calibration procedure and the
// full design rationale. Both handlers shell out to the vision/ Python CLI
// tools (OpenCV) rather than using a native Node CV binding -- see that
// doc's "Why a Python subprocess" section for why that trade was made
// deliberately, not for lack of a Node option.
ipcMain.handle('vision:calibrate', async (_, { cameraIndex } = {}) => {
  const args = cameraIndex !== undefined ? ['--camera', String(cameraIndex)] : [];
  const result = await runVisionScript('calibrate.py', args);
  if (result.success) {
    lastAlignment = null; // a new calibration invalidates any prior alignment reading
  }
  return result;
});

ipcMain.handle('vision:align', async (_, { cameraIndex, nominalX, nominalY, nominalTheta } = {}) => {
  const args = [];
  if (cameraIndex !== undefined) args.push('--camera', String(cameraIndex));
  if (nominalX !== undefined) args.push('--nominal-x', String(nominalX));
  if (nominalY !== undefined) args.push('--nominal-y', String(nominalY));
  if (nominalTheta !== undefined) args.push('--nominal-theta', String(nominalTheta));
  const result = await runVisionScript('align.py', args);
  lastAlignment = result.success ? result : null;
  return result;
});

ipcMain.handle('vision:getLastAlignment', () => ({ alignment: lastAlignment }));
ipcMain.handle('vision:clearAlignment', () => { lastAlignment = null; return { success: true }; });

// Pull the most recent alignment reading a phone submitted via the mobile
// app's Vision Alignment page. Fails closed exactly like vision:align:
// nothing is written to lastAlignment unless the backend actually has a
// fresh (see max_age_seconds), successful reading.
ipcMain.handle('vision:pullFromPhone', async (_, { maxAgeSeconds } = {}) => {
  const age = maxAgeSeconds !== undefined ? maxAgeSeconds : 300;
  const url = `${VISION_BACKEND_URL}/api/vision/latest-alignment?machine_id=${encodeURIComponent(VISION_MACHINE_ID)}&max_age_seconds=${age}`;
  const res = await httpGetJson(url);
  if (!res.ok) {
    return { success: false, error: `could not reach vision backend: ${res.error}` };
  }
  const body = res.data;
  if (!body.available) {
    return { success: false, error: body.reason === 'stale'
      ? `latest phone reading is stale (${Math.round(body.age_seconds)}s old, limit ${age}s)`
      : 'no phone alignment reading available -- use Vision Alignment on the phone app first' };
  }
  const result = {
    success: true,
    dx_mm: body.dx_mm,
    dy_mm: body.dy_mm,
    theta_deg: body.theta_deg,
    confidence: body.confidence,
    nominal_mm: body.nominal_mm,
    source: 'phone',
    item_uid: body.item_uid,
    age_seconds: body.age_seconds,
  };
  lastAlignment = result;
  return result;
});

console.log('GENGRAV loaded - GRBL 1.1 Controller with Supabase Database');
