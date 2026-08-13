// shared/gcode-transform.js
// Purpose: apply a camera-measured alignment correction (dx/dy/rotation) to
// already-generated G-code, right before it is sent to the machine.
//
// Deliberately generator-agnostic: it operates on the G-code TEXT via
// regex, not on GCodeGenerator's internal matrix representation. That is
// what lets it sit as a single interception point in front of BOTH
// generation paths this app actually has (the shared GCodeGenerator class
// in gcode-generator.js, and the inline QR/image raster generator in
// engraving-app's renderer.js) without duplicating the transform logic in
// either one, and without caring which one produced the string.
//
// Pure, dependency-free JS (no Node-only APIs) so it is safe to run in
// either the Electron main process or a webpack-bundled renderer.

/**
 * Rotate+translate a single (x, y) point.
 * Rotation is applied around `pivot` first, then the translation is added --
 * i.e. this expresses "the workpiece is actually at (pivot + offset),
 * rotated by thetaDeg about pivot" relative to where the G-code assumed it
 * was drawn (nominally around `pivot`, typically the job's programmed
 * origin or the workpiece's nominal center).
 */
function transformPoint(x, y, { dxMm = 0, dyMm = 0, thetaDeg = 0, pivot = { x: 0, y: 0 } }) {
  const theta = (thetaDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const lx = x - pivot.x;
  const ly = y - pivot.y;
  const rx = lx * cos - ly * sin;
  const ry = lx * sin + ly * cos;
  return { x: pivot.x + rx + dxMm, y: pivot.y + ry + dyMm };
}

// Matches G0/G1/G2/G3 motion lines and captures the X/Y numeric arguments
// (in any order, either may be absent) while leaving everything else on the
// line (F, S, comments, other words) untouched.
const MOTION_LINE_RE = /^(\s*)(G0|G1|G2|G3)(\s+.*)$/i;
const X_ARG_RE = /\bX(-?\d+(?:\.\d+)?)\b/i;
const Y_ARG_RE = /\bY(-?\d+(?:\.\d+)?)\b/i;

function formatCoord(n) {
  // Match gcode-generator.js's own formatting convention (3 decimal places,
  // plain -- no unnecessary trailing zeros stripped, no locale formatting)
  // so a diff against non-aligned output only ever touches the numbers that
  // actually moved.
  return n.toFixed(3);
}

/**
 * Apply an alignment offset to every G0/G1/G2/G3 X/Y coordinate in a block
 * of G-code text. Lines with no X or no Y are left exactly as they are for
 * that axis (e.g. an X-only rapid move only gets its X transformed).
 *
 * G2/G3 (arc) I/J offsets are NOT transformed here -- see the "Known
 * limitations" note in VISION_ALIGNMENT.md. This codebase's generators only
 * emit G0/G1 today (confirmed in gcode-generator.js and renderer.js), so
 * this is a documented gap, not a silent one.
 *
 * @param {string} gcodeText
 * @param {{dxMm:number, dyMm:number, thetaDeg:number, pivot?:{x:number,y:number}}} offset
 * @returns {string} transformed G-code text
 */
function applyAlignmentOffset(gcodeText, offset) {
  if (!offset || (!offset.dxMm && !offset.dyMm && !offset.thetaDeg)) {
    return gcodeText; // no-op: nothing to apply, return input unchanged (not even re-joined)
  }
  const pivot = offset.pivot || { x: 0, y: 0 };
  const lines = gcodeText.split("\n");
  const out = lines.map((line) => {
    const m = line.match(MOTION_LINE_RE);
    if (!m) return line;
    const [, indent, word, rest] = m;
    const xMatch = rest.match(X_ARG_RE);
    const yMatch = rest.match(Y_ARG_RE);
    if (!xMatch && !yMatch) return line;

    const curX = xMatch ? parseFloat(xMatch[1]) : pivot.x;
    const curY = yMatch ? parseFloat(yMatch[1]) : pivot.y;
    const t = transformPoint(curX, curY, { ...offset, pivot });

    let newRest = rest;
    if (xMatch) newRest = newRest.replace(X_ARG_RE, `X${formatCoord(t.x)}`);
    if (yMatch) newRest = newRest.replace(Y_ARG_RE, `Y${formatCoord(t.y)}`);
    return `${indent}${word}${newRest}`;
  });
  return out.join("\n");
}

module.exports = { applyAlignmentOffset, transformPoint };
