/**
 * Preload - exposes GRBL 1.1 API to renderer
 * Full LaserGRBL-compatible API with GRBL 1.1 features
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grbl', {
    // ========== Connection ==========
    listPorts: () => ipcRenderer.invoke('grbl:listPorts'),
    listAllPorts: () => ipcRenderer.invoke('grbl:listAllPorts'),
    connect: (port, baudRate, options) => ipcRenderer.invoke('grbl:connect', { port, baudRate, options }),
    disconnect: () => ipcRenderer.invoke('grbl:disconnect'),
    getState: () => ipcRenderer.invoke('grbl:getState'),
    getBaudRates: () => ipcRenderer.invoke('grbl:getBaudRates'),
    getConnectionOptions: () => ipcRenderer.invoke('grbl:getConnectionOptions'),
    getGrblVersion: () => ipcRenderer.invoke('grbl:getGrblVersion'),

    // ========== Settings ==========
    readSettings: () => ipcRenderer.invoke('grbl:readSettings'),
    writeSetting: (k, v) => ipcRenderer.invoke('grbl:writeSetting', { key: k, value: v }),
    applyDefaults: () => ipcRenderer.invoke('grbl:applyDefaults'),
    enableLaserMode: () => ipcRenderer.invoke('grbl:enableLaserMode'),
    getDefaults: () => ipcRenderer.invoke('grbl:getDefaults'),

    // ========== Motion ==========
    home: () => ipcRenderer.invoke('grbl:home'),
    homeAll: () => ipcRenderer.invoke('grbl:homeAll'),
    goHome: () => ipcRenderer.invoke('grbl:goHome'),
    jog: (a, d, f) => ipcRenderer.invoke('grbl:jog', { axis: a, distance: d, feed: f }),
    jogCancel: () => ipcRenderer.invoke('grbl:jogCancel'),
    moveTo: (x, y, f) => ipcRenderer.invoke('grbl:moveTo', { x, y, feed: f }),

    // ========== Commands ==========
    send: (c) => ipcRenderer.invoke('grbl:send', c),
    runGCode: (g) => ipcRenderer.invoke('grbl:runGCode', g),
    runGCodeAligned: (g) => ipcRenderer.invoke('grbl:runGCodeAligned', g),
    stop: () => ipcRenderer.invoke('grbl:stop'),

    // ========== Laser Control ==========
    laserOn: (p) => ipcRenderer.invoke('grbl:laserOn', p),
    laserOff: () => ipcRenderer.invoke('grbl:laserOff'),
    laserTest: (power, duration) => ipcRenderer.invoke('grbl:laserTest', { power, duration }),
    laserFocus: (p) => ipcRenderer.invoke('grbl:laserFocus', p),

    // ========== Safety & Control ==========
    emergencyStop: () => ipcRenderer.invoke('grbl:emergencyStop'),
    resetEstop: () => ipcRenderer.invoke('grbl:resetEstop'),
    unlock: () => ipcRenderer.invoke('grbl:unlock'),

    // ========== GRBL 1.1 Real-time Commands ==========
    softReset: () => ipcRenderer.invoke('grbl:softReset'),
    feedHold: () => ipcRenderer.invoke('grbl:feedHold'),
    cycleStart: () => ipcRenderer.invoke('grbl:cycleStart'),
    safetyDoor: () => ipcRenderer.invoke('grbl:safetyDoor'),

    // ========== GRBL 1.1 Feed Overrides ==========
    feedOverrideReset: () => ipcRenderer.invoke('grbl:feedOverrideReset'),
    feedOverrideIncrease: (fine) => ipcRenderer.invoke('grbl:feedOverrideIncrease', fine),
    feedOverrideDecrease: (fine) => ipcRenderer.invoke('grbl:feedOverrideDecrease', fine),

    // ========== GRBL 1.1 Rapid Overrides ==========
    rapidOverrideReset: () => ipcRenderer.invoke('grbl:rapidOverrideReset'),
    rapidOverride50: () => ipcRenderer.invoke('grbl:rapidOverride50'),
    rapidOverride25: () => ipcRenderer.invoke('grbl:rapidOverride25'),

    // ========== GRBL 1.1 Spindle/Laser Overrides ==========
    spindleOverrideReset: () => ipcRenderer.invoke('grbl:spindleOverrideReset'),
    spindleOverrideIncrease: (fine) => ipcRenderer.invoke('grbl:spindleOverrideIncrease', fine),
    spindleOverrideDecrease: (fine) => ipcRenderer.invoke('grbl:spindleOverrideDecrease', fine),
    spindleStop: () => ipcRenderer.invoke('grbl:spindleStop'),

    // ========== GRBL 1.1 Coolant ==========
    toggleFloodCoolant: () => ipcRenderer.invoke('grbl:toggleFloodCoolant'),
    toggleMistCoolant: () => ipcRenderer.invoke('grbl:toggleMistCoolant'),

    // ========== GRBL 1.1 Info Commands ==========
    getBuildInfo: () => ipcRenderer.invoke('grbl:getBuildInfo'),
    getParserState: () => ipcRenderer.invoke('grbl:getParserState'),
    getStartupBlocks: () => ipcRenderer.invoke('grbl:getStartupBlocks'),
    setStartupBlock: (index, gcode) => ipcRenderer.invoke('grbl:setStartupBlock', { index, gcode }),
    toggleCheckMode: () => ipcRenderer.invoke('grbl:toggleCheckMode'),
    sleep: () => ipcRenderer.invoke('grbl:sleep'),

    // ========== Event Listeners ==========
    onStatus: (cb) => ipcRenderer.on('grbl:status', (_, d) => cb(d)),
    onLog: (cb) => ipcRenderer.on('grbl:log', (_, m) => cb(m)),
    onTx: (cb) => ipcRenderer.on('grbl:tx', (_, c) => cb(c)),
    onRx: (cb) => ipcRenderer.on('grbl:rx', (_, l) => cb(l)),
    onProgress: (cb) => ipcRenderer.on('grbl:progress', (_, p) => cb(p)),
    onSettings: (cb) => ipcRenderer.on('grbl:settings', (_, s) => cb(s)),
    onError: (cb) => ipcRenderer.on('grbl:error', (_, e) => cb(e)),
    onEstop: (cb) => ipcRenderer.on('grbl:estop', () => cb()),
    onComplete: (cb) => ipcRenderer.on('grbl:complete', () => cb()),
    onVersion: (cb) => ipcRenderer.on('grbl:version', (_, v) => cb(v)),
    onAlarm: (cb) => ipcRenderer.on('grbl:alarm', (_, a) => cb(a)),
    onMessage: (cb) => ipcRenderer.on('grbl:message', (_, m) => cb(m))
});

// Expose API/Database functions for QR code fetching (Direct Supabase Connection)
contextBridge.exposeInMainWorld('api', {
    // Database connection
    testConnection: () => ipcRenderer.invoke('db:testConnection'),
    getDbStatus: () => ipcRenderer.invoke('db:getStatus'),
    onDbStatus: (cb) => ipcRenderer.on('db:status', (_, s) => cb(s)),

    // QR codes / Items
    fetchQRCodes: () => ipcRenderer.invoke('api:fetchQRCodes'),
    fetchPendingEngravings: () => ipcRenderer.invoke('api:fetchPendingEngravings'),
    fetchQRImage: (uid) => ipcRenderer.invoke('api:fetchQRImage', uid),

    // QR Code generation
    generateQRCode: (data, size) => ipcRenderer.invoke('api:generateQRCode', { data, size }),
    generateQRMatrix: (data) => ipcRenderer.invoke('api:generateQRMatrix', { data }),
    generateQRGCode: (data, settings) => ipcRenderer.invoke('api:generateQRGCode', { data, settings }),

    // Engraving operations
    updateItemStatus: (uid, status) => ipcRenderer.invoke('api:updateItemStatus', { uid, status }),
    recordEngraving: (data) => ipcRenderer.invoke('api:recordEngraving', data)
});

// Batch engraving: fetch N pending QR codes and engrave them with a delay between each.
contextBridge.exposeInMainWorld('batch', {
    start: (opts) => ipcRenderer.invoke('batch:start', opts),
    stop: () => ipcRenderer.invoke('batch:stop'),
    getState: () => ipcRenderer.invoke('batch:getState'),
    countPending: () => ipcRenderer.invoke('batch:countPending'),
    onState: (cb) => ipcRenderer.on('batch:state', (_, s) => cb(s)),
    onLog: (cb) => ipcRenderer.on('batch:log', (_, l) => cb(l))
});

// Vision Alignment (see VISION_ALIGNMENT.md) -- camera-based workpiece
// position/rotation detection, applied to G-code via grbl.runGCodeAligned.
contextBridge.exposeInMainWorld('vision', {
    calibrate: (cameraIndex) => ipcRenderer.invoke('vision:calibrate', { cameraIndex }),
    align: (opts) => ipcRenderer.invoke('vision:align', opts || {}),
    getLastAlignment: () => ipcRenderer.invoke('vision:getLastAlignment'),
    clearAlignment: () => ipcRenderer.invoke('vision:clearAlignment'),
    pullFromPhone: (maxAgeSeconds) => ipcRenderer.invoke('vision:pullFromPhone', { maxAgeSeconds })
});
