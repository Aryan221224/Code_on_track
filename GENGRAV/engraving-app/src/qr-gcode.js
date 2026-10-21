/**
 * QR code -> G-code (line-to-line raster).
 *
 * Pure function (no DOM / Electron / serial access) so the exact same code
 * is used by the single-QR UI and the batch engraver, and can be unit tested.
 */

const MAX_QUALITY_LINES_PER_MM = 20;

function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {object} opts
 * @param {number[][]} opts.matrix   QR modules, 1 = black (burn), 0 = white
 * @param {string}     [opts.uid]    only used for the header comment
 * @param {object}     opts.settings engraving settings (speed, sMax, sizeW, offsetX, ...)
 * @returns {string} G-code
 */
function generateQRGCode({ matrix, uid = '', settings = {} }) {
    if (!Array.isArray(matrix) || matrix.length === 0) {
        throw new Error('QR matrix is empty');
    }
    const n = matrix.length;
    if (!matrix.every(row => Array.isArray(row) && row.length === n)) {
        throw new Error('QR matrix must be square');
    }

    const speed = Math.max(1, Math.round(num(settings.engravingSpeed, 300)));
    const laserMode = settings.laserMode === 'M4' ? 'M4' : 'M3';
    const sMax = Math.max(0, Math.round(num(settings.sMax, 700)));
    const offsetX = num(settings.offsetX, 0);
    const offsetY = num(settings.offsetY, 0);
    // A QR code must be square or it will not scan: height always follows width.
    const side = num(settings.sizeW, 30);
    if (!(side > 0)) throw new Error('QR size must be greater than 0 mm');
    const quality = Math.min(MAX_QUALITY_LINES_PER_MM, Math.max(1, num(settings.quality, 8)));
    const horizontal = (settings.direction || 'horizontal') === 'horizontal';

    const moduleSize = side / n;
    const spacing = 1 / quality;
    const totalLines = Math.max(1, Math.round(side / spacing));
    const f3 = v => v.toFixed(3);

    const out = [];
    out.push('; GENGRAV QR Code Engraving (line-to-line)');
    if (uid) out.push(`; UID: ${String(uid).replace(/[\r\n]/g, ' ')}`);
    out.push(`; Speed=${speed}mm/min S-MAX=${sMax} Size=${side}x${side}mm Offset=(${offsetX},${offsetY})`);
    out.push(`; Modules: ${n}x${n} Module size: ${moduleSize.toFixed(3)}mm Lines: ${totalLines}`);
    out.push('G21');
    out.push('G90');
    out.push(`G0 X${f3(offsetX)} Y${f3(offsetY)} F${speed}`);
    out.push(`${laserMode} S0`);

    for (let i = 0; i < totalLines; i++) {
        // Position of this scan line across the code, and the module row/col it falls in.
        const across = Math.min((i + 0.5) * (side / totalLines), side - 1e-6);
        const idx = Math.min(Math.floor(across / moduleSize), n - 1);
        const forward = i % 2 === 0;
        const fixed = (horizontal ? offsetY : offsetX) + across;
        const base = horizontal ? offsetX : offsetY;

        // Run-length encode the modules along the scan direction.
        const runs = [];
        for (let k = 0; k < n; k++) {
            const m = forward ? k : n - 1 - k;
            const black = (horizontal ? matrix[idx][m] : matrix[m][idx]) === 1;
            const last = runs[runs.length - 1];
            if (last && last.black === black) last.end = k + 1;
            else runs.push({ black, start: k, end: k + 1 });
        }

        const pos = k => forward ? base + k * moduleSize : base + side - k * moduleSize;
        const xy = p => horizontal ? `X${f3(p)} Y${f3(fixed)}` : `X${f3(fixed)} Y${f3(p)}`;

        for (const run of runs) {
            if (!run.black) continue;
            out.push(`G0 ${xy(pos(run.start))} S0`);
            out.push(`G1 ${xy(pos(run.end))} F${speed} S${sMax}`);
        }
    }

    out.push('M5 S0');
    out.push(`G0 X${f3(offsetX)} Y${f3(offsetY)} S0`);
    out.push('M2');
    return out.join('\n');
}

module.exports = { generateQRGCode };
