// test-gcode-transform.js -- standalone proof for shared/gcode-transform.js
// Run: node test-gcode-transform.js
// Matches the plain console.log/assert style already used by
// test-db-connection.js / test-gengrav-db.js in this repo (no test
// framework dependency).
const { applyAlignmentOffset, transformPoint } = require('./shared/gcode-transform');

let fails = 0;
function check(cond, name) {
  console.log((cond ? '✓ PASS  ' : '✗ FAIL  ') + name);
  if (!cond) fails++;
}
function close(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log('Test 1: pure translation, no rotation\n');
{
  const gcode = [
    'G0 X0.000 Y0.000 F3000',
    'M4 S600',
    'G1 X50.000 Y0.000 F800',
    'M5',
  ].join('\n');
  const out = applyAlignmentOffset(gcode, { dxMm: 5, dyMm: -2.5, thetaDeg: 0 });
  const lines = out.split('\n');
  check(lines[0] === 'G0 X5.000 Y-2.500 F3000', 'G0 X/Y both shifted, F untouched (' + lines[0] + ')');
  check(lines[1] === 'M4 S600', 'non-motion line untouched (' + lines[1] + ')');
  check(lines[2] === 'G1 X55.000 Y-2.500 F800', 'G1 X/Y shifted, F untouched (' + lines[2] + ')');
  check(lines[3] === 'M5', 'M5 untouched');
}

console.log('\nTest 2: rotation about a pivot (quarter turn, exact)\n');
{
  // point (10, 0) rotated 90deg about origin -> (0, 10)
  const p = transformPoint(10, 0, { dxMm: 0, dyMm: 0, thetaDeg: 90, pivot: { x: 0, y: 0 } });
  check(close(p.x, 0, 1e-9) && close(p.y, 10, 1e-9), 'transformPoint: 90deg about origin exact (' + JSON.stringify(p) + ')');

  // same rotation about a non-origin pivot: (110, 100) rotated 90deg about (100,100) -> (100, 110)
  const p2 = transformPoint(110, 100, { dxMm: 0, dyMm: 0, thetaDeg: 90, pivot: { x: 100, y: 100 } });
  check(close(p2.x, 100, 1e-9) && close(p2.y, 110, 1e-9), 'transformPoint: 90deg about (100,100) exact (' + JSON.stringify(p2) + ')');
}

console.log('\nTest 3: X-only and Y-only lines only transform the axis present\n');
{
  const gcode = 'G0 X10.000 F1000\nG0 Y20.000 F1000';
  const out = applyAlignmentOffset(gcode, { dxMm: 1, dyMm: 2, thetaDeg: 0 });
  const lines = out.split('\n');
  check(lines[0] === 'G0 X11.000 F1000', 'X-only line: only X shifted (' + lines[0] + ')');
  check(lines[1] === 'G0 Y22.000 F1000', 'Y-only line: only Y shifted (' + lines[1] + ')');
}

console.log('\nTest 4: zero offset is a true no-op (untouched, not just numerically equal)\n');
{
  const gcode = 'G1 X12.345 Y67.891 F800';
  const out = applyAlignmentOffset(gcode, { dxMm: 0, dyMm: 0, thetaDeg: 0 });
  check(out === gcode, 'zero offset returns input unchanged verbatim');
  const out2 = applyAlignmentOffset(gcode, null);
  check(out2 === gcode, 'null offset returns input unchanged verbatim');
}

console.log('\nTest 5: comments and non-motion G-codes pass through untouched\n');
{
  const gcode = [
    '; GENGRAV QR Code Laser Engraving',
    'G21 ; Units: millimeters',
    'G90 ; Absolute positioning',
    'G0 X0.000 Y0.000 F3000 ; Home position',
  ].join('\n');
  const out = applyAlignmentOffset(gcode, { dxMm: 3, dyMm: 4, thetaDeg: 0 });
  const lines = out.split('\n');
  check(lines[0] === '; GENGRAV QR Code Laser Engraving', 'header comment untouched');
  check(lines[1] === 'G21 ; Units: millimeters', 'G21 untouched (not a motion word)');
  check(lines[2] === 'G90 ; Absolute positioning', 'G90 untouched (not a motion word)');
  check(lines[3] === 'G0 X3.000 Y4.000 F3000 ; Home position', 'G0 shifted, trailing comment preserved (' + lines[3] + ')');
}

console.log('\nTest 6: full raster-style block (realistic gcode-generator.js output shape) rotates as a rigid body\n');
{
  // A 2x2mm square traced at (0,0)-(2,0)-(2,2)-(0,2), rotated 180deg about its own center (1,1).
  // A rigid 180deg rotation about the shape's own center must map it back onto itself exactly.
  const gcode = [
    'G0 X0.000 Y0.000 F3000',
    'M4 S600',
    'G1 X2.000 Y0.000 F800',
    'G1 X2.000 Y2.000 F800',
    'G1 X0.000 Y2.000 F800',
    'G1 X0.000 Y0.000 F800',
    'M5',
  ].join('\n');
  const out = applyAlignmentOffset(gcode, { dxMm: 0, dyMm: 0, thetaDeg: 180, pivot: { x: 1, y: 1 } });
  const outLines = out.split('\n');
  const expectPoints = [[2, 2], [0, 2], [0, 0], [2, 0], [2, 2]];
  let ok = true;
  const motionLines = outLines.filter((l) => /^G[01]\s/.test(l));
  motionLines.forEach((l, i) => {
    const mx = parseFloat(l.match(/X(-?\d+\.\d+)/)[1]);
    const my = parseFloat(l.match(/Y(-?\d+\.\d+)/)[1]);
    if (!close(mx, expectPoints[i][0], 1e-6) || !close(my, expectPoints[i][1], 1e-6)) ok = false;
  });
  check(ok, '180deg rotation about shape center maps square back onto itself exactly');
}

console.log();
if (fails > 0) {
  console.log(`GCODE TRANSFORM TEST: ${fails} FAILURE(S)`);
  process.exit(1);
}
console.log('GCODE TRANSFORM TEST OK -- translation, rotation, axis-selectivity, no-op and pass-through all verified');
process.exit(0);
