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

// QR Matrix data for precise G-code generation
let qrMatrix = null;
let qrModuleCount = 0;

/**
 * LaserGRBL-style Line-to-Line G-code Generation
 * This properly scans the QR code pixel by pixel and generates
 * G-code with correct laser ON/OFF segments
 */
async function generateQRGCode() {
  const { engravingSpeed, laserMode, sMin, sMax, sizeW, sizeH, offsetX, offsetY, quality, direction } = engravingSettings;

  if (!selectedQRItem) {
    log('No QR code selected', 'error');
    return null;
  }

  // Get QR matrix for precise engraving
  try {
    const matrixResult = await window.api.generateQRMatrix(selectedQRItem.uid);
    if (matrixResult.success) {
      qrMatrix = matrixResult.matrix;
      qrModuleCount = matrixResult.size;
      log(`QR matrix: ${qrModuleCount}x${qrModuleCount} modules`);
    } else {
      log('Failed to get QR matrix', 'error');
      return null;
    }
  } catch (e) {
    log('Error getting QR matrix: ' + e.message, 'error');
    return null;
  }

  if (!qrMatrix || qrMatrix.length === 0) {
    log('No QR matrix data available', 'error');
    return null;
  }

  // Calculate dimensions
  const moduleSize = sizeW / qrModuleCount;  // Size of each QR module in mm

  // Use quality setting for lines per mm (higher = better quality, slower)
  const linesPerMm = quality || 8;  // Default 8 lines/mm if not set
  const lineSpacing = 1 / linesPerMm;
  const totalLines = Math.ceil(sizeH / lineSpacing);

  // Determine scan direction (horizontal or vertical)
  const isHorizontal = (direction || 'horizontal') === 'horizontal';

  const lines = [];
  lines.push('; GENGRAV QR Code Engraving (LaserGRBL-style Line2Line)');
  lines.push(`; UID: ${selectedQRItem.uid}`);
  lines.push(`; Settings: Speed=${engravingSpeed}mm/min, S-MIN=${sMin}, S-MAX=${sMax}`);
  lines.push(`; Size: ${sizeW}x${sizeH}mm at offset (${offsetX}, ${offsetY})`);
  lines.push(`; QR Modules: ${qrModuleCount}x${qrModuleCount}`);
  lines.push(`; Module size: ${moduleSize.toFixed(3)}mm`);
  lines.push(`; Quality: ${linesPerMm} lines/mm (${lineSpacing.toFixed(3)}mm spacing)`);
  lines.push(`; Direction: ${isHorizontal ? 'Horizontal' : 'Vertical'}`);
  lines.push(`; Total lines: ${totalLines}`);
  lines.push('');
  lines.push('G21 ; Units: mm');
  lines.push('G90 ; Absolute positioning');

  // Move to start position with laser OFF
  lines.push(`G0 X${offsetX.toFixed(3)} Y${offsetY.toFixed(3)} F${engravingSpeed}`);

  // Enable laser mode (M3 for constant power - critical for PWM control)
  lines.push(`${laserMode} S0 ; Laser ON at zero power`);
  lines.push('');

  let lineCount = 0;

  if (isHorizontal) {
    // Horizontal scanning (Y increases, X sweeps)
    for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
      const y = offsetY + (lineIdx * lineSpacing);

      // Determine which QR module row this line falls into
      const moduleRow = Math.min(Math.floor((lineIdx * lineSpacing) / moduleSize), qrModuleCount - 1);
      const rowData = qrMatrix[moduleRow];

      // Alternate scan direction (bidirectional)
      const leftToRight = (lineIdx % 2 === 0);

      // Build segments for this line
      const segments = [];
      let currentSegmentStart = 0;
      let currentIsBlack = rowData[leftToRight ? 0 : qrModuleCount - 1] === 1;

      // Scan through each module boundary
      for (let moduleCol = 0; moduleCol <= qrModuleCount; moduleCol++) {
        // Check if this module is black
        let isBlack;
        if (moduleCol >= qrModuleCount) {
          isBlack = false; // End of line
        } else {
          const checkCol = leftToRight ? moduleCol : (qrModuleCount - 1 - moduleCol);
          isBlack = rowData[checkCol] === 1;
        }

        // If color changes or end of line, save the segment
        if (isBlack !== currentIsBlack || moduleCol === qrModuleCount) {
          segments.push({
            startModule: currentSegmentStart,
            endModule: moduleCol,
            isBlack: currentIsBlack
          });
          currentSegmentStart = moduleCol;
          currentIsBlack = isBlack;
        }
      }

      // Generate G-code for this line
      let currentX = leftToRight ? offsetX : (offsetX + sizeW);
      let laserIsOn = false;

      for (const seg of segments) {
        const segStartX = offsetX + (leftToRight ? seg.startModule * moduleSize : sizeW - seg.startModule * moduleSize);
        const segEndX = offsetX + (leftToRight ? seg.endModule * moduleSize : sizeW - seg.endModule * moduleSize);

        if (seg.isBlack) {
          // Rapid move to start of segment if needed
          if (Math.abs(currentX - segStartX) > 0.001) {
            lines.push(`G0 X${segStartX.toFixed(3)} Y${y.toFixed(3)} S0`);
            currentX = segStartX;
          }

          // Engrave the segment with laser ON
          lines.push(`G1 X${segEndX.toFixed(3)} Y${y.toFixed(3)} F${engravingSpeed} S${sMax}`);
          currentX = segEndX;
          laserIsOn = true;
        } else {
          // White segment - rapid move
          if (laserIsOn || Math.abs(currentX - segEndX) > 0.001) {
            lines.push(`G0 X${segEndX.toFixed(3)} Y${y.toFixed(3)} S0`);
            currentX = segEndX;
            laserIsOn = false;
          }
        }
      }

      lineCount++;
    }
  } else {
    // Vertical scanning (X increases, Y sweeps)
    for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
      const x = offsetX + (lineIdx * lineSpacing);

      // Determine which QR module column this line falls into
      const moduleCol = Math.min(Math.floor((lineIdx * lineSpacing) / moduleSize), qrModuleCount - 1);

      // Alternate scan direction (bidirectional)
      const topToBottom = (lineIdx % 2 === 0);

      // Build segments for this column
      const segments = [];
      let currentSegmentStart = 0;
      let currentIsBlack = qrMatrix[topToBottom ? 0 : qrModuleCount - 1][moduleCol] === 1;

      for (let moduleRow = 0; moduleRow <= qrModuleCount; moduleRow++) {
        let isBlack;
        if (moduleRow >= qrModuleCount) {
          isBlack = false;
        } else {
          const checkRow = topToBottom ? moduleRow : (qrModuleCount - 1 - moduleRow);
          isBlack = qrMatrix[checkRow][moduleCol] === 1;
        }

        if (isBlack !== currentIsBlack || moduleRow === qrModuleCount) {
          segments.push({
            startModule: currentSegmentStart,
            endModule: moduleRow,
            isBlack: currentIsBlack
          });
          currentSegmentStart = moduleRow;
          currentIsBlack = isBlack;
        }
      }

      // Generate G-code for this column
      let currentY = topToBottom ? offsetY : (offsetY + sizeH);
      let laserIsOn = false;

      for (const seg of segments) {
        const segStartY = offsetY + (topToBottom ? seg.startModule * moduleSize : sizeH - seg.startModule * moduleSize);
        const segEndY = offsetY + (topToBottom ? seg.endModule * moduleSize : sizeH - seg.endModule * moduleSize);

        if (seg.isBlack) {
          if (Math.abs(currentY - segStartY) > 0.001) {
            lines.push(`G0 X${x.toFixed(3)} Y${segStartY.toFixed(3)} S0`);
            currentY = segStartY;
          }

          lines.push(`G1 X${x.toFixed(3)} Y${segEndY.toFixed(3)} F${engravingSpeed} S${sMax}`);
          currentY = segEndY;
          laserIsOn = true;
        } else {
          if (laserIsOn || Math.abs(currentY - segEndY) > 0.001) {
            lines.push(`G0 X${x.toFixed(3)} Y${segEndY.toFixed(3)} S0`);
            currentY = segEndY;
            laserIsOn = false;
          }
        }
      }

      lineCount++;
    }
  }

  // Finish up
  lines.push('');
  lines.push('M5 S0 ; Laser off');
  lines.push(`G0 X${offsetX.toFixed(3)} Y${offsetY.toFixed(3)} ; Return to start`);
  lines.push('M2 ; Program end');

  log(`Generated ${lineCount} scan lines, ${lines.length} G-code commands (${isHorizontal ? 'horizontal' : 'vertical'})`);

  return lines.join('\n');
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

$('saveSettingsBtn').addEventListener('click', () => {
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
  $('stopBtn').disabled = false;
  $('progressBox').hidden = false;
  if ($('visionApplyAlignment').checked) {
    log('Starting with vision alignment applied...');
    const result = await window.grbl.runGCodeAligned(currentGCode);
    if (!result.success) {
      log(`Aligned run failed: ${result.error}`, 'error');
    }
  } else {
    log('Starting...');
    await window.grbl.runGCode(currentGCode);
  }
  $('stopBtn').disabled = true;
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
$('refreshQRBtn').addEventListener('click', fetchQRCodes);

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
    } else {
      log('⚠️ Database not connected - retrying...', 'warning');
      // Try to test connection
      const testResult = await window.api.testConnection();
      updateDbStatus(testResult.success);
      if (testResult.success) {
        log('✅ Database connection established!');
        fetchQRCodes();
      }
    }
  } catch (e) {
    log(`Database error: ${e.message}`, 'error');
  }
})();
