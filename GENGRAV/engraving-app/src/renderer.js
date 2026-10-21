/**
 * GENGRAV Renderer - GRBL 1.1 Compatible
 * Full LaserGRBL-style API with GRBL 1.1 features
 * With QR Code Database Integration
 */
import './index.css';

const $ = id => document.getElementById(id);
let isConnected = false;
let currentGCode = null;
let grblVersion = null;
let loadedImage = null;
let selectedQRItem = null;
let qrImageData = null;  // Canvas image data for G-code generation
let batchRunning = false;  // true while a database batch is engraving

// Default engraving settings (LaserGRBL style)
const DEFAULT_ENGRAVING_SETTINGS = {
  engravingSpeed: 300,    // mm/min (Mark Speed)
  laserMode: 'M3',        // M3 = Constant, M4 = Dynamic
  sMin: 0,                // S-MIN (0-1000) - laser OFF power
  sMax: 700,              // S-MAX (0-1000) - laser ON power
  autoSize: true,
  sizeW: 30,              // Width in mm (default for QR codes)
  sizeH: 30,              // Height in mm (default for QR codes)
  offsetX: 0,             // X offset in mm
  offsetY: 0,             // Y offset in mm

  // LaserGRBL Image Parameters
  brightness: 0,          // -100 to 100 (0 = no change)
  contrast: 0,            // -100 to 100 (0 = no change)
  whiteClip: 5,           // 0-100 (percentage of white to clip)

  // LaserGRBL Conversion Tool
  conversionTool: 'line2line',  // line2line, dithering, vectorize

  // Line-to-Line Options
  direction: 'horizontal', // horizontal, vertical, diagonal
  quality: 8,             // Lines per mm (1-20)
  linePreview: false      // Show line preview
};

// Load settings from localStorage or use defaults
function loadEngravingSettings() {
  try {
    const saved = localStorage.getItem('gengrav_engraving_settings');
    if (saved) {
      return { ...DEFAULT_ENGRAVING_SETTINGS, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.error('Error loading settings:', e);
  }
  return { ...DEFAULT_ENGRAVING_SETTINGS };
}

// Save settings to localStorage
function saveEngravingSettings(settings) {
  try {
    localStorage.setItem('gengrav_engraving_settings', JSON.stringify(settings));
    log('Settings saved!', 'log');
    return true;
  } catch (e) {
    console.error('Error saving settings:', e);
    log('Error saving settings', 'error');
    return false;
  }
}

// Current engraving settings
let engravingSettings = loadEngravingSettings();

// Update the settings summary display
function updateSettingsSummary() {
  $('summarySpeed').textContent = engravingSettings.engravingSpeed;
  $('summarySMin').textContent = engravingSettings.sMin;
  $('summarySMax').textContent = engravingSettings.sMax;
  $('summarySize').textContent = `${engravingSettings.sizeW}x${engravingSettings.sizeH}`;
  $('summaryQuality').textContent = engravingSettings.quality || 8;
}

// Populate modal form with current settings
function populateSettingsModal() {
  $('engravingSpeed').value = engravingSettings.engravingSpeed;
  $('laserMode').value = engravingSettings.laserMode;
  $('sMin').value = engravingSettings.sMin;
  $('sMax').value = engravingSettings.sMax;
  $('autoSize').checked = engravingSettings.autoSize;
  $('sizeW').value = engravingSettings.sizeW;
  $('sizeH').value = engravingSettings.sizeH;
  $('offsetX').value = engravingSettings.offsetX;
  $('offsetY').value = engravingSettings.offsetY;

  // LaserGRBL-style parameters
  $('brightness').value = engravingSettings.brightness || 0;
  $('contrast').value = engravingSettings.contrast || 0;
  $('whiteClip').value = engravingSettings.whiteClip || 5;
  $('direction').value = engravingSettings.direction || 'horizontal';
  $('quality').value = engravingSettings.quality || 8;
  $('linePreview').checked = engravingSettings.linePreview || false;

  // Set conversion tool radio
  const convTool = engravingSettings.conversionTool || 'line2line';
  const radio = document.querySelector(`input[name="conversionTool"][value="${convTool}"]`);
  if (radio) radio.checked = true;

  updatePercentages();
  updateSliderDisplays();
}

// Update slider value displays
function updateSliderDisplays() {
  $('brightnessVal').textContent = $('brightness').value;
  $('contrastVal').textContent = $('contrast').value;
  $('whiteClipVal').textContent = $('whiteClip').value + '%';
}

// Update S-MIN and S-MAX percentages
function updatePercentages() {
  const sMin = parseInt($('sMin').value) || 0;
  const sMax = parseInt($('sMax').value) || 0;
  $('sMinPercent').textContent = `${(sMin / 10).toFixed(1)}%`;
  $('sMaxPercent').textContent = `${(sMax / 10).toFixed(1)}%`;
}

// Get settings from modal form
function getSettingsFromModal() {
  const selectedTool = document.querySelector('input[name="conversionTool"]:checked');
  return {
    engravingSpeed: parseInt($('engravingSpeed').value) || 300,
    laserMode: $('laserMode').value,
    sMin: parseInt($('sMin').value) || 0,
    sMax: parseInt($('sMax').value) || 700,
    autoSize: $('autoSize').checked,
    sizeW: parseFloat($('sizeW').value) || 100,
    sizeH: parseFloat($('sizeH').value) || 100,
    offsetX: parseFloat($('offsetX').value) || 0,
    offsetY: parseFloat($('offsetY').value) || 0,
    // LaserGRBL-style parameters
    brightness: parseInt($('brightness').value) || 0,
    contrast: parseInt($('contrast').value) || 0,
    whiteClip: parseInt($('whiteClip').value) || 5,
    conversionTool: selectedTool ? selectedTool.value : 'line2line',
    direction: $('direction').value || 'horizontal',
    quality: parseFloat($('quality').value) || 8,
    linePreview: $('linePreview').checked
  };
}

// ========== QR Code Database Functions ==========

// Fetch QR codes from database
async function fetchQRCodes() {
  $('qrList').innerHTML = '<span class="qr-loading">Loading QR codes</span>';
  log('Fetching QR codes from database...');

  try {
    const result = await window.api.fetchQRCodes();
    if (result.success && result.items) {
      displayQRCodes(result.items);
      log(`Loaded ${result.items.length} items from database`);
    } else {
      $('qrList').innerHTML = `<span class="hint">Error: ${result.error || 'Failed to fetch'}</span>`;
      log(`Failed to fetch QR codes: ${result.error}`, 'error');
    }
  } catch (e) {
    $('qrList').innerHTML = `<span class="hint">Error: ${e.message}</span>`;
    log(`Error fetching QR codes: ${e.message}`, 'error');
  }
}

// Display QR codes in the list
function displayQRCodes(items) {
  const qrList = $('qrList');
  qrList.innerHTML = '';

  if (!items || items.length === 0) {
    qrList.innerHTML = '<span class="hint">No QR codes found in database</span>';
    return;
  }

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'qr-item';
    div.dataset.uid = item.uid;
    div.innerHTML = `
      <span class="qr-icon">📱</span>
      <span class="qr-uid" title="${item.uid}">${item.uid.slice(0, 10)}...</span>
      <span class="qr-type">${item.component_type || 'Item'}</span>
    `;
    div.addEventListener('click', () => selectQRItem(item, div));
    qrList.appendChild(div);
  });
}

// Select a QR item and generate real QR code
async function selectQRItem(item, element) {
  // Remove previous selection
  document.querySelectorAll('.qr-item.selected').forEach(el => el.classList.remove('selected'));
  element.classList.add('selected');
  selectedQRItem = item;

  log(`Selected: ${item.uid} (${item.component_type})`);

  // Show loading state
  const preview = $('preview');
  preview.innerHTML = '<span class="qr-loading">Generating QR code...</span>';

  try {
    // Generate actual QR code using the qrcode library via main process
    const qrResult = await window.api.generateQRCode(item.uid, 256);

    if (qrResult.success && qrResult.dataUrl) {
      // Create image from data URL
      const img = new Image();
      img.onload = () => {
        // Create canvas for preview and image data extraction
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // Store image data for G-code generation
        qrImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        loadedImage = canvas;

        // Display in preview
        preview.innerHTML = '';
        canvas.style.maxWidth = '100%';
        canvas.style.maxHeight = '300px';
        canvas.style.imageRendering = 'pixelated';
        preview.appendChild(canvas);

        log(`QR code generated: ${canvas.width}x${canvas.height}px`);
        $('generateBtn').disabled = false;
      };
      img.src = qrResult.dataUrl;
    } else {
      throw new Error(qrResult.error || 'Failed to generate QR code');
    }
  } catch (e) {
    log(`Error generating QR code: ${e.message}`, 'error');
    preview.innerHTML = `<span class="hint">Error: ${e.message}</span>`;
  }
}

/**
 * Line-to-line QR G-code. Generated in the main process by src/qr-gcode.js,
 * the exact same generator the batch engraver uses, so a single test engrave
 * and a batch run always produce identical output.
 */
async function generateQRGCode() {
  if (!selectedQRItem) {
    log('No QR code selected', 'error');
    return null;
  }
  const result = await window.api.generateQRGCode(selectedQRItem.uid, engravingSettings);
  if (!result.success) {
    log(`Failed to generate QR G-code: ${result.error}`, 'error');
    return null;
  }
  const commands = result.gcode.split('\n').filter(l => l && !l.startsWith(';')).length;
  log(`Generated ${commands} G-code commands for ${selectedQRItem.uid} (${engravingSettings.sizeW}x${engravingSettings.sizeW}mm)`);
  return result.gcode;
}

function log(msg, type = 'log') {
  const c = $('console');
  const l = document.createElement('div');
  l.className = `console-line ${type}`;
  l.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  c.appendChild(l);
  c.scrollTop = c.scrollHeight;
  // Keep only last 500 lines
  while (c.children.length > 500) c.removeChild(c.firstChild);
}

function updateConnectionUI(connected) {
  isConnected = connected;
  const s = $('connectionStatus');
  s.className = connected ? 'connection connected' : 'connection disconnected';
  s.querySelector('.text').textContent = connected ? 'Connected' : 'Disconnected';
  $('connectBtn').disabled = connected;
  $('disconnectBtn').disabled = !connected;
  $('baudSelect').disabled = connected;
  $('dtrReset').disabled = connected;
  $('softReset').disabled = connected;

  const controls = ['readSettingsBtn', 'saveSettingsBtn', 'applyDefaultsBtn', 'enableLaserBtn',
    'homeBtn', 'goHomeBtn', 'jogYPlus', 'jogYMinus', 'jogXPlus', 'jogXMinus', 'jogCenter', 'sendCmdBtn',
    'config22', 'config100', 'config101',
    'laserTestBtn', 'laserFocusBtn', 'laserOffBtn', 'testPower',
    'unlockBtn', 'resetBtn',
    // GRBL 1.1 override controls
    'feedMinus10', 'feedMinus1', 'feedPlus1', 'feedPlus10', 'feedReset',
    'spindleMinus10', 'spindleMinus1', 'spindlePlus1', 'spindlePlus10', 'spindleReset',
    'rapidFull', 'rapid50', 'rapid25'];
  controls.forEach(id => {
    const el = $(id);
    if (el) el.disabled = !connected;
  });
  updateBatchControls();
}

function updateStatus(s) {
  $('posX').textContent = s.position.x.toFixed(3);
  $('posY').textContent = s.position.y.toFixed(3);
  $('posZ').textContent = s.position.z.toFixed(3);

  // GRBL 1.1 state with substate
  let stateText = s.state;
  if (s.subState !== null && s.subState !== undefined) {
    stateText += `:${s.subState}`;
  }
  $('machineState').textContent = stateText;

  // Color-code machine state
  const stateEl = $('machineState');
  stateEl.className = '';
  if (s.state === 'Alarm') stateEl.className = 'state-alarm';
  else if (s.state === 'Run') stateEl.className = 'state-run';
  else if (s.state === 'Hold') stateEl.className = 'state-hold';
  else if (s.state === 'Idle') stateEl.className = 'state-idle';
  else if (s.state === 'Jog') stateEl.className = 'state-jog';
  else if (s.state === 'Door') stateEl.className = 'state-alarm';
  else if (s.state === 'Home') stateEl.className = 'state-run';

  // GRBL 1.1 overrides display
  if (s.overrides) {
    $('feedOvr').textContent = s.overrides.feed || 100;
    $('spindleOvr').textContent = s.overrides.spindle || 100;
    $('feedOverrideVal').textContent = `${s.overrides.feed || 100}%`;
    $('spindleOverrideVal').textContent = `${s.overrides.spindle || 100}%`;
  }
}

function updateSettings(settings) {
  // Update badges
  const laser = settings['$32'];
  const badge = $('laserBadge');
  badge.textContent = `$32: ${laser === 1 ? 'ON' : 'OFF'}`;
  badge.className = laser === 1 ? 'badge active' : 'badge';

  // Update config fields
  if (settings['$22'] !== undefined) $('config22').value = settings['$22'];
  if (settings['$100'] !== undefined) $('config100').value = settings['$100'];
  if (settings['$101'] !== undefined) $('config101').value = settings['$101'];

  log('Settings loaded', 'log');
}

// Connection
$('refreshBtn').addEventListener('click', async () => {
  const showAll = $('showAllPorts').checked;
  log(`Scanning for ${showAll ? 'ALL' : 'compatible'} ports...`);

  // Use listAllPorts if checkbox is checked, otherwise use filtered listPorts
  const ports = showAll ? await window.grbl.listAllPorts() : await window.grbl.listPorts();

  const sel = $('portSelect');
  sel.innerHTML = '<option value="">Select Port</option>';
  ports.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.path;
    const info = [p.path];
    if (p.manufacturer) info.push(p.manufacturer);
    if (p.vendorId) info.push(`VID:${p.vendorId}`);
    if (p.productId) info.push(`PID:${p.productId}`);
    opt.textContent = info.join(' - ');
    sel.appendChild(opt);
  });
  log(`Found ${ports.length} ${showAll ? 'total' : 'compatible'} ports`);
  if (ports.length === 0) {
    log('No ports found. Check USB connection.', 'error');
  } else if (ports.length > 0 && !showAll) {
    log('Tip: Check "Show All Ports" to see unrecognized USB devices', 'log');
  }
});

// Re-scan ports when "Show All Ports" checkbox changes
$('showAllPorts').addEventListener('change', () => {
  $('refreshBtn').click();
});

$('connectBtn').addEventListener('click', async () => {
  const port = $('portSelect').value;
  if (!port) return log('Select a port first', 'error');

  const baudRate = parseInt($('baudSelect').value);
  const dtrReset = $('dtrReset').checked;
  const softReset = $('softReset').checked;

  log(`Connecting to ${port} @ ${baudRate} baud...`);
  log(`Options: DTR/RTS=${dtrReset}, SoftReset=${softReset}`);

  $('connectBtn').disabled = true;
  $('connectBtn').textContent = 'Connecting...';

  const r = await window.grbl.connect(port, baudRate, {
    dtrOnConnect: dtrReset,
    rtsOnConnect: dtrReset,
    softResetOnConnect: softReset
  });

  if (r.success) {
    updateConnectionUI(true);
    log('Connected successfully!');
    if (r.state?.version) {
      grblVersion = r.state.version;
      $('versionBadge').textContent = `Ver: ${grblVersion}`;
    }
  } else {
    log(`Connection failed: ${r.error}`, 'error');
    $('connectBtn').disabled = false;
  }
  $('connectBtn').textContent = 'Connect';
});

$('disconnectBtn').addEventListener('click', async () => {
  await window.grbl.disconnect();
  updateConnectionUI(false);
  log('Disconnected');
  $('versionBadge').textContent = 'Ver: --';
});

// Settings
$('readSettingsBtn').addEventListener('click', async () => {
  log('Reading settings...');
  const r = await window.grbl.readSettings();
  if (r.success) updateSettings(r.settings);
});

$('saveSettingsBtn').addEventListener('click', async () => {
  log('Saving settings...');
  const settings = [
    ['$22', $('config22').value],
    ['$100', $('config100').value],
    ['$101', $('config101').value]
  ];
  for (const [k, v] of settings) {
    if (v) {
      const r = await window.grbl.writeSetting(k, v);
      if (r.success) log(`${k}=${v} saved`);
      else log(`${k} error: ${r.error}`, 'error');
    }
  }
  log('Settings saved!', 'log');
});

$('applyDefaultsBtn').addEventListener('click', async () => {
  if (!confirm('Apply default settings?')) return;
  log('Applying defaults...');
  await window.grbl.applyDefaults();
  await window.grbl.readSettings();
});

$('enableLaserBtn').addEventListener('click', async () => {
  log('Enabling laser mode...');
  const r = await window.grbl.enableLaserMode();
  if (r.success) { $('laserBadge').textContent = '$32: ON'; $('laserBadge').className = 'badge active'; log('Laser mode enabled'); }
});

// Machine Control
$('homeBtn').addEventListener('click', async () => { await window.grbl.home(); log('Home set'); });
$('goHomeBtn').addEventListener('click', async () => { await window.grbl.goHome(); log('Going home...'); });

const jogStep = () => parseFloat($('jogStep').value);
$('jogYPlus').addEventListener('click', () => window.grbl.jog('Y', jogStep()));
$('jogYMinus').addEventListener('click', () => window.grbl.jog('Y', -jogStep()));
$('jogXPlus').addEventListener('click', () => window.grbl.jog('X', jogStep()));
$('jogXMinus').addEventListener('click', () => window.grbl.jog('X', -jogStep()));

// Laser Test Controls
$('testPower').addEventListener('input', () => {
  $('testPowerValue').textContent = `${$('testPower').value}%`;
});

$('laserTestBtn').addEventListener('click', async () => {
  const power = parseInt($('testPower').value) * 10; // Convert % to S-value (assuming $30=1000)
  log(`Test firing laser at ${$('testPower').value}% power...`, 'warning');
  await window.grbl.laserTest(power, 200);
  log('Test fire complete');
});

$('laserFocusBtn').addEventListener('click', async () => {
  const power = Math.min(parseInt($('testPower').value) * 2, 50); // Very low power for focus
  log(`Focus mode ON at ${power / 10}% - Use laser OFF to stop`, 'warning');
  await window.grbl.laserFocus(power);
});

$('laserOffBtn').addEventListener('click', async () => {
  await window.grbl.laserOff();
  log('Laser OFF');
});

// Emergency & Reset Controls
$('unlockBtn').addEventListener('click', async () => {
  log('Unlocking GRBL...');
  const r = await window.grbl.unlock();
  if (r.success) log('Unlocked');
  else log(`Unlock failed: ${r.error}`, 'error');
});

$('resetBtn').addEventListener('click', async () => {
  log('Sending soft reset...');
  await window.grbl.softReset();
  log('Reset sent');
});

// GRBL 1.1 Override Controls
// Feed Override
$('feedMinus10').addEventListener('click', () => window.grbl.feedOverrideDecrease(false));
$('feedMinus1').addEventListener('click', () => window.grbl.feedOverrideDecrease(true));
$('feedPlus1').addEventListener('click', () => window.grbl.feedOverrideIncrease(true));
$('feedPlus10').addEventListener('click', () => window.grbl.feedOverrideIncrease(false));
$('feedReset').addEventListener('click', () => window.grbl.feedOverrideReset());

// Spindle/Laser Override
$('spindleMinus10').addEventListener('click', () => window.grbl.spindleOverrideDecrease(false));
$('spindleMinus1').addEventListener('click', () => window.grbl.spindleOverrideDecrease(true));
$('spindlePlus1').addEventListener('click', () => window.grbl.spindleOverrideIncrease(true));
$('spindlePlus10').addEventListener('click', () => window.grbl.spindleOverrideIncrease(false));
$('spindleReset').addEventListener('click', () => window.grbl.spindleOverrideReset());

// Rapid Override
$('rapidFull').addEventListener('click', () => window.grbl.rapidOverrideReset());
$('rapid50').addEventListener('click', () => window.grbl.rapidOverride50());
$('rapid25').addEventListener('click', () => window.grbl.rapidOverride25());

// Image
$('preview').addEventListener('click', () => $('fileInput').click());
$('loadImageBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = document.createElement('img');
    img.src = reader.result;
    loadedImage = img;
    $('preview').innerHTML = '';
    $('preview').appendChild(img);
    $('generateBtn').disabled = false;
    log(`Loaded: ${file.name}`);

    // Auto-calculate size if autoSize is enabled
    img.onload = () => {
      if (engravingSettings.autoSize && img.naturalWidth && img.naturalHeight) {
        const aspectRatio = img.naturalWidth / img.naturalHeight;
        // Keep width, adjust height to maintain aspect ratio
        engravingSettings.sizeH = Math.round((engravingSettings.sizeW / aspectRatio) * 10) / 10;
        updateSettingsSummary();
        log(`Auto-sized to ${engravingSettings.sizeW}x${engravingSettings.sizeH}mm`);
      }
    };
  };
  reader.readAsDataURL(file);
});

// Engraving Settings Modal
$('engravingSettingsBtn').addEventListener('click', () => {
  populateSettingsModal();
  $('settingsModal').hidden = false;
});

$('closeSettingsBtn').addEventListener('click', () => {
  $('settingsModal').hidden = true;
});

$('cancelSettingsBtn').addEventListener('click', () => {
  $('settingsModal').hidden = true;
});

$('saveEngravingSettingsBtn').addEventListener('click', () => {
  autoSaveSettings();
  $('settingsModal').hidden = true;
  log('Settings saved and closed');
});

$('resetSettingsBtn').addEventListener('click', () => {
  if (confirm('Reset to default settings?')) {
    engravingSettings = { ...DEFAULT_ENGRAVING_SETTINGS };
    populateSettingsModal();
    saveEngravingSettings(engravingSettings);
    updateSettingsSummary();
    log('Settings reset to defaults');
  }
});

// Auto-save function - saves settings immediately when changed
function autoSaveSettings() {
  engravingSettings = getSettingsFromModal();
  saveEngravingSettings(engravingSettings);
  updateSettingsSummary();
  updateSliderDisplays();
}

// Auto-save on any settings change
const settingsInputs = [
  'engravingSpeed', 'laserMode', 'sMin', 'sMax', 'autoSize', 'sizeW', 'sizeH', 'offsetX', 'offsetY',
  'brightness', 'contrast', 'whiteClip', 'direction', 'quality', 'linePreview'
];
settingsInputs.forEach(id => {
  const el = $(id);
  if (el) {
    el.addEventListener('change', autoSaveSettings);
    el.addEventListener('input', autoSaveSettings);
  }
});

// Auto-save for radio buttons (conversion tool)
document.querySelectorAll('input[name="conversionTool"]').forEach(radio => {
  radio.addEventListener('change', autoSaveSettings);
});

// Update percentages when S-MIN/S-MAX change
$('sMin').addEventListener('input', updatePercentages);
$('sMax').addEventListener('input', updatePercentages);

// Close modal on backdrop click
$('settingsModal').addEventListener('click', (e) => {
  if (e.target === $('settingsModal')) {
    $('settingsModal').hidden = true;
  }
});

// Generate G-Code with engraving settings
$('generateBtn').addEventListener('click', async () => {
  const { engravingSpeed, laserMode, sMin, sMax, sizeW, sizeH, offsetX, offsetY } = engravingSettings;

  // If a QR code is selected, use the QR-specific G-code generator
  if (selectedQRItem) {
    log('Generating G-code for QR code engraving...');
    $('generateBtn').disabled = true;
    $('generateBtn').textContent = 'Generating...';

    try {
      currentGCode = await generateQRGCode();
      if (currentGCode) {
        $('startBtn').disabled = false;
        $('previewGCodeBtn').disabled = false;
        const lineCount = currentGCode.split('\n').length;
        log(`QR G-Code generated: ${lineCount} lines, ${sizeW}x${sizeH}mm @ ${engravingSpeed}mm/min`);
        log(`Laser power: S-MIN=${sMin} (OFF/white), S-MAX=${sMax} (ON/black)`);
      } else {
        log('Failed to generate QR G-code', 'error');
      }
    } catch (e) {
      log(`Error generating G-code: ${e.message}`, 'error');
    }

    $('generateBtn').disabled = false;
    $('generateBtn').textContent = 'Generate G-code';
    return;
  }

  // Otherwise use image-based G-code generation
  if (!loadedImage) {
    log('No image or QR code loaded', 'error');
    return;
  }

  // Generate raster G-code for the image
  // This is a simplified version - a full implementation would convert the image to paths
  const lines = [];
  lines.push('; GENGRAV - Generated G-Code');
  lines.push(`; Settings: Speed=${engravingSpeed}mm/min, S-MIN=${sMin}, S-MAX=${sMax}`);
  lines.push(`; Size: ${sizeW}x${sizeH}mm, Offset: X${offsetX}, Y${offsetY}`);
  lines.push('G21 ; Units: mm');
  lines.push('G90 ; Absolute positioning');
  lines.push(`${laserMode} S0 ; Laser mode`);
  lines.push(`G0 X${offsetX} Y${offsetY} ; Move to start position`);

  // Simple raster pattern (line by line)
  const lineSpacing = 0.1;  // mm between lines (based on DPI)
  const numLines = Math.ceil(sizeH / lineSpacing);

  for (let i = 0; i < Math.min(numLines, 100); i++) {  // Limit for demo
    const y = offsetY + (i * lineSpacing);
    const isEvenLine = i % 2 === 0;
    const xStart = isEvenLine ? offsetX : offsetX + sizeW;
    const xEnd = isEvenLine ? offsetX + sizeW : offsetX;

    lines.push(`G0 X${xStart.toFixed(2)} Y${y.toFixed(2)} S${sMin}`);
    lines.push(`G1 X${xEnd.toFixed(2)} Y${y.toFixed(2)} F${engravingSpeed} S${sMax}`);
  }

  lines.push('M5 S0 ; Laser off');
  lines.push(`G0 X${offsetX} Y${offsetY} ; Return to start`);
  lines.push('M2 ; Program end');

  currentGCode = lines.join('\n');
  $('startBtn').disabled = false;
  $('previewGCodeBtn').disabled = false;
  log(`G-Code generated: ${numLines} lines, ${sizeW}x${sizeH}mm @ ${engravingSpeed}mm/min`);
});

// ========== Vision Alignment (see VISION_ALIGNMENT.md) ==========
function setVisionStatus(text, level) {
  const el = $('visionStatus');
  el.textContent = text;
  el.className = 'vision-status' + (level ? ' ' + level : '');
}

$('visionCalibrateBtn').addEventListener('click', async () => {
  $('visionCalibrateBtn').disabled = true;
  $('visionAlignBtn').disabled = true;
  $('visionApplyAlignment').checked = false;
  $('visionApplyAlignment').disabled = true;
  setVisionStatus('Calibrating (capturing bed markers)...', 'warn');
  try {
    const result = await window.vision.calibrate();
    if (result.success) {
      const err = result.report.reprojection_error_mm.max;
      setVisionStatus(`Calibrated - reprojection error ${err.toFixed(3)}mm`, err > 1.0 ? 'warn' : 'ok');
      $('visionAlignBtn').disabled = false;
      log(`Vision: camera calibrated (${err.toFixed(3)}mm max reprojection error)`);
    } else {
      setVisionStatus(`Calibration failed: ${result.error}`, 'error');
      log(`Vision: calibration failed - ${result.error}`, 'error');
    }
  } catch (e) {
    setVisionStatus(`Calibration error: ${e.message}`, 'error');
    log(`Vision: calibration error - ${e.message}`, 'error');
  } finally {
    $('visionCalibrateBtn').disabled = false;
  }
});

$('visionAlignBtn').addEventListener('click', async () => {
  $('visionAlignBtn').disabled = true;
  $('visionApplyAlignment').checked = false;
  $('visionApplyAlignment').disabled = true;
  setVisionStatus('Reading workpiece position...', 'warn');
  try {
    const result = await window.vision.align();
    if (result.success) {
      setVisionStatus(
        `dx=${result.dx_mm.toFixed(2)}mm dy=${result.dy_mm.toFixed(2)}mm `
        + `dθ=${result.theta_deg.toFixed(2)}° (confidence ${(result.confidence * 100).toFixed(0)}%)`,
        'ok');
      $('visionApplyAlignment').disabled = false;
      log(`Vision: alignment read - dx=${result.dx_mm}mm dy=${result.dy_mm}mm dtheta=${result.theta_deg}deg`);
    } else {
      setVisionStatus(`Alignment failed: ${result.error}`, 'error');
      log(`Vision: alignment failed - ${result.error}`, 'error');
    }
  } catch (e) {
    setVisionStatus(`Alignment error: ${e.message}`, 'error');
    log(`Vision: alignment error - ${e.message}`, 'error');
  } finally {
    $('visionAlignBtn').disabled = false;
  }
});

$('visionPullPhoneBtn').addEventListener('click', async () => {
  $('visionPullPhoneBtn').disabled = true;
  $('visionApplyAlignment').checked = false;
  $('visionApplyAlignment').disabled = true;
  setVisionStatus('Checking for a phone reading...', 'warn');
  try {
    const result = await window.vision.pullFromPhone();
    if (result.success) {
      const ageStr = result.age_seconds !== undefined ? ` (${Math.round(result.age_seconds)}s old)` : '';
      setVisionStatus(
        `From phone${ageStr}: dx=${result.dx_mm.toFixed(2)}mm dy=${result.dy_mm.toFixed(2)}mm `
        + `dθ=${result.theta_deg.toFixed(2)}° (confidence ${(result.confidence * 100).toFixed(0)}%)`,
        'ok');
      $('visionApplyAlignment').disabled = false;
      log(`Vision: pulled phone alignment - dx=${result.dx_mm}mm dy=${result.dy_mm}mm dtheta=${result.theta_deg}deg`
        + (result.item_uid ? ` (item ${result.item_uid})` : ''));
    } else {
      setVisionStatus(`No phone reading: ${result.error}`, 'error');
      log(`Vision: phone reading unavailable - ${result.error}`, 'error');
    }
  } catch (e) {
    setVisionStatus(`Phone reading error: ${e.message}`, 'error');
    log(`Vision: phone reading error - ${e.message}`, 'error');
  } finally {
    $('visionPullPhoneBtn').disabled = false;
  }
});

$('startBtn').addEventListener('click', async () => {
  if (!currentGCode) return;
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  $('progressBox').hidden = false;
  let result;
  if ($('visionApplyAlignment').checked) {
    log('Starting with vision alignment applied...');
    result = await window.grbl.runGCodeAligned(currentGCode);
  } else {
    log('Starting...');
    result = await window.grbl.runGCode(currentGCode);
  }
  if (result.success) {
    log(`Engraving finished (${result.lines} commands${result.seconds !== undefined ? `, ${result.seconds}s` : ''})`);
    if (selectedQRItem) {
      const r = await window.api.updateItemStatus(selectedQRItem.uid, 'engraved');
      if (r.success) log(`Marked ${selectedQRItem.uid} as engraved`);
      else log(`Could not mark ${selectedQRItem.uid} as engraved: ${r.error}`, 'warning');
    }
  } else {
    log(`Engraving FAILED: ${result.error}`, 'error');
  }
  $('stopBtn').disabled = true;
  $('startBtn').disabled = batchRunning;
});

$('stopBtn').addEventListener('click', async () => { await window.grbl.stop(); log('Stopping...'); });
$('emergencyBtn').addEventListener('click', async () => { log('!!! EMERGENCY STOP !!!', 'error'); await window.grbl.emergencyStop(); });

$('sendCmdBtn').addEventListener('click', async () => {
  const cmd = $('cmdInput').value.trim();
  if (!cmd) return;
  log(`Sending: ${cmd}`);
  const r = await window.grbl.send(cmd);
  if (!r.success) log(`Error: ${r.error}`, 'error');
  $('cmdInput').value = '';
});
$('cmdInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') $('sendCmdBtn').click(); });
$('clearConsoleBtn').addEventListener('click', () => { $('console').innerHTML = ''; });

// IPC Events
window.grbl.onStatus(updateStatus);
window.grbl.onLog(m => log(m, 'log'));
window.grbl.onTx(c => log(`>> ${c}`, 'tx'));
window.grbl.onRx(l => log(`<< ${l}`, 'rx'));
window.grbl.onProgress(p => { $('progressBox').hidden = false; $('progressFill').style.width = `${p.percent}%`; $('progressText').textContent = `${p.percent}%`; });
window.grbl.onSettings(updateSettings);
window.grbl.onError(e => log(`ERROR: ${e}`, 'error'));
window.grbl.onEstop(() => log('EMERGENCY STOP ACTIVATED', 'error'));
window.grbl.onComplete(() => { log('Complete!'); $('stopBtn').disabled = true; setTimeout(() => $('progressBox').hidden = true, 2000); });
window.grbl.onVersion(v => {
  grblVersion = v;
  $('versionBadge').textContent = `Ver: ${v || '--'}`;
  log(`GRBL Version: ${v}`);
});
window.grbl.onAlarm(a => {
  log(`⚠️ ALARM ${a.code}: ${a.message}`, 'error');
  $('machineState').textContent = 'Alarm';
  $('machineState').className = 'state-alarm';
});
window.grbl.onMessage(m => log(`[MSG] ${m}`, 'log'));

// G-Code Preview Modal
$('previewGCodeBtn').addEventListener('click', () => {
  if (!currentGCode) {
    log('No G-code generated yet', 'error');
    return;
  }

  $('gcodePreview').value = currentGCode;
  const lines = currentGCode.split('\n').length;
  $('gcodeLineCount').textContent = `${lines} lines`;

  // Estimate time based on G-code content
  const g1Moves = (currentGCode.match(/G1 /g) || []).length;
  const estimatedMinutes = Math.ceil(g1Moves * 0.1);
  $('gcodeEstimatedTime').textContent = `Est. time: ~${estimatedMinutes} min`;

  $('gcodeModal').hidden = false;
});

$('closeGCodeBtn').addEventListener('click', () => {
  $('gcodeModal').hidden = true;
});

$('closeGCodeModalBtn').addEventListener('click', () => {
  $('gcodeModal').hidden = true;
});

$('copyGCodeBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentGCode);
    log('G-code copied to clipboard!');
    $('copyGCodeBtn').textContent = '✓ Copied!';
    setTimeout(() => { $('copyGCodeBtn').textContent = '📋 Copy'; }, 2000);
  } catch (e) {
    log('Failed to copy: ' + e.message, 'error');
  }
});

$('downloadGCodeBtn').addEventListener('click', () => {
  const blob = new Blob([currentGCode], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `qr_engrave_${Date.now()}.gcode`;
  a.click();
  URL.revokeObjectURL(url);
  log('G-code downloaded!');
});

// Close modal on backdrop click
$('gcodeModal').addEventListener('click', (e) => {
  if (e.target === $('gcodeModal')) {
    $('gcodeModal').hidden = true;
  }
});

// QR Database Controls
$('refreshQRBtn').addEventListener('click', () => { fetchQRCodes(); refreshPendingCount(); });

// ========== Batch engraving (N QR codes from the database, delay between each) ==========
function updateBatchControls() {
  $('batchStartBtn').disabled = !isConnected || batchRunning;
  $('batchStartBtn').title = isConnected ? '' : 'Connect to the laser first';
  $('batchStopBtn').disabled = !batchRunning;
  ['batchCount', 'batchDelay', 'batchRetries'].forEach(id => { $(id).disabled = batchRunning; });
  $('startBtn').disabled = batchRunning || !currentGCode;
  $('generateBtn').disabled = batchRunning || !(selectedQRItem || loadedImage);
}

async function refreshPendingCount() {
  try {
    const r = await window.batch.countPending();
    $('batchPending').textContent = r.success ? `Pending: ${r.count}` : 'Pending: --';
  } catch (e) {
    $('batchPending').textContent = 'Pending: --';
  }
}

function renderBatchState(s) {
  batchRunning = !!s.running;
  updateBatchControls();

  let text = s.message || s.phase;
  let level = '';
  if (s.phase === 'engraving') {
    text = `Engraving ${s.index} of ${s.total}: ${s.currentUid}${s.attempt > 1 ? ` (attempt ${s.attempt})` : ''}`;
    level = 'warn';
  } else if (s.phase === 'waiting') {
    text = `Next QR code in ${s.delayRemaining}s (${s.index} of ${s.total} done) - swap the workpiece now`;
    level = 'warn';
  } else if (s.phase === 'recovering') {
    level = 'warn';
  } else if (s.phase === 'finished') {
    level = s.halted || s.failed > 0 ? 'error' : 'ok';
  }
  const el = $('batchStatus');
  el.textContent = text;
  el.className = 'vision-status' + (level ? ' ' + level : '');

  if (s.total > 0) {
    const done = s.results.length;
    $('batchProgressBox').hidden = false;
    $('batchProgressFill').style.width = `${Math.round((done / s.total) * 100)}%`;
    $('batchProgressText').textContent = `${done} / ${s.total} done (${s.engraved} engraved${s.failed ? `, ${s.failed} failed` : ''})`;
  }

  const results = $('batchResults');
  results.innerHTML = '';
  s.results.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = `batch-result ${r.status}`;
    const left = document.createElement('span');
    left.textContent = `${i + 1}. ${r.uid}`;
    const right = document.createElement('span');
    right.textContent = r.status === 'engraved'
      ? `engraved${r.attempts > 1 ? ` (${r.attempts} tries)` : ''}${r.dbSynced === false ? ' - DB NOT UPDATED' : ''}`
      : `${r.status}: ${r.error || ''}`;
    row.append(left, right);
    results.appendChild(row);
  });

  if (s.phase === 'finished') refreshPendingCount();
}

$('batchStartBtn').addEventListener('click', async () => {
  const count = parseInt($('batchCount').value, 10);
  const delaySeconds = parseFloat($('batchDelay').value);
  const maxRetries = parseInt($('batchRetries').value, 10);
  if (!Number.isInteger(count) || count < 1) return log('Enter how many QR codes to engrave (1 or more)', 'error');
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) return log('Enter a delay of 0 seconds or more', 'error');
  if (!Number.isInteger(maxRetries) || maxRetries < 0) return log('Retries must be 0 or more', 'error');

  const r = await window.batch.start({
    count, delaySeconds, maxRetries,
    settings: engravingSettings,
    applyAlignment: $('visionApplyAlignment').checked,
  });
  if (!r.success) {
    log(`Batch not started: ${r.error}`, 'error');
    return;
  }
  log(`Batch started: ${count} QR code(s), ${delaySeconds}s between each`);
});

$('batchStopBtn').addEventListener('click', async () => {
  log('Stopping batch...', 'warning');
  await window.batch.stop();
});

window.batch.onState(renderBatchState);
window.batch.onLog(l => log(`[Batch] ${l.message}`, l.level === 'warning' ? 'warning' : l.level === 'error' ? 'error' : 'log'));

// Database status indicator
function updateDbStatus(connected) {
  const s = $('dbStatus');
  if (connected) {
    s.className = 'connection connected';
    s.querySelector('.text').textContent = 'DB: Online';
  } else {
    s.className = 'connection disconnected';
    s.querySelector('.text').textContent = 'DB: Offline';
  }
}

// Listen for database status updates
window.api.onDbStatus(status => {
  updateDbStatus(status.connected);
  if (status.connected) {
    log('📡 Database connected (Supabase)', 'log');
  } else {
    log('⚠️ Database not connected', 'warning');
  }
});

// Initialize settings summary on load
updateSettingsSummary();
log('GENGRAV ready - GRBL 1.1 compatible with Supabase');
log(`Engraving settings loaded: Speed=${engravingSettings.engravingSpeed}mm/min, S-MAX=${engravingSettings.sMax}`);
$('refreshBtn').click();

// Check database status on load and fetch QR codes
(async function initializeDatabase() {
  try {
    const status = await window.api.getDbStatus();
    updateDbStatus(status.connected);
    if (status.connected) {
      log('📡 Database connected (Supabase)');
      fetchQRCodes();
      refreshPendingCount();
    } else {
      log('⚠️ Database not connected - retrying...', 'warning');
      // Try to test connection
      const testResult = await window.api.testConnection();
      updateDbStatus(testResult.success);
      if (testResult.success) {
        log('✅ Database connection established!');
        fetchQRCodes();
        refreshPendingCount();
      }
    }
  } catch (e) {
    log(`Database error: ${e.message}`, 'error');
  }
})();
