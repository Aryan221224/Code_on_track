/**
 * End-to-end reliability tests: real GRBLController + real BatchEngraver +
 * real G-code generator against a simulated GRBL machine (test/fake-grbl.js).
 *
 * Run:  npm test      (node --test)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const QRCode = require('qrcode');

const { GRBLController } = require('../src/grbl-controller');
const { BatchEngraver } = require('../src/batch-engraver');
const { generateQRGCode } = require('../src/qr-gcode');
const { FakeGrbl } = require('./fake-grbl');

let jsQR = null;
try { jsQR = require('jsqr'); } catch (e) { /* optional: raster comparison still runs */ }

const SETTINGS = { engravingSpeed: 300, laserMode: 'M3', sMax: 700, sizeW: 20, sizeH: 20, offsetX: 0, offsetY: 0, quality: 8, direction: 'horizontal' };

function matrixOf(data) {
    const q = QRCode.create(data, { errorCorrectionLevel: 'M' });
    const n = q.modules.size;
    return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => (q.modules.get(x, y) ? 1 : 0)));
}

const opened = [];
test.afterEach(async () => {
    // always release polling timers, even when an assertion failed mid-test
    while (opened.length) { try { await opened.pop().disconnect(); } catch (e) { /* ignore */ } }
});

async function makeMachine(machineOpts = {}) {
    const machine = new FakeGrbl(machineOpts);
    const grbl = new GRBLController();
    opened.push(grbl);
    grbl._createPort = () => machine;
    grbl.log = () => { };                           // quiet
    grbl.on('error', () => { });                    // main.js always has an error listener
    await grbl.connect('FAKE', { waitForStartup: 30, dtrOnConnect: false, rtsOnConnect: false, softResetOnConnect: false });
    return { grbl, machine };
}

function assertEngraved(machine, uid, label = uid, side = SETTINGS.sizeW) {
    const expected = matrixOf(uid);
    const got = machine.sampleModules(expected.length, side);
    let wrong = 0;
    for (let r = 0; r < expected.length; r++) for (let c = 0; c < expected.length; c++) if (expected[r][c] !== got[r][c]) wrong++;
    assert.equal(wrong, 0, `${label}: ${wrong} module(s) differ from the QR matrix`);

    if (jsQR) {
        const bmp = machine.bitmap(side, 0, 0);
        const decoded = jsQR(bmp.data, bmp.width, bmp.height);
        assert.ok(decoded, `${label}: a real QR decoder could not read the engraving`);
        assert.equal(decoded.data, uid, `${label}: decoded to wrong text`);
    }
}

function fakeDb(uids, { failUpdates = 0 } = {}) {
    const items = uids.map((uid, i) => ({ uid, current_status: 'manufactured', created_at: i }));
    const calls = { updates: [], records: [] };
    let failsLeft = failUpdates;
    return {
        items, calls,
        async fetchPendingEngravings(limit) {
            return { success: true, items: items.filter(i => i.current_status === 'manufactured').slice(0, limit) };
        },
        async updateItemStatus(uid, status) {
            if (failsLeft > 0) { failsLeft--; return { success: false, error: 'db down' }; }
            const it = items.find(i => i.uid === uid);
            it.current_status = status; calls.updates.push(uid);
            return { success: true };
        },
        async recordEngraving(r) { calls.records.push(r.item_uid); return { success: true }; },
    };
}

const UID = (n) => `LINER-LOT1234-17654${String(n).padStart(5, '0')}-ABCD${n}`;

// ---------------------------------------------------------------- generator
test('G-code generator: square, scannable, burns exactly the black modules', async () => {
    const matrix = matrixOf(UID(1));
    const g = generateQRGCode({ matrix, uid: UID(1), settings: { ...SETTINGS, sizeW: 30, sizeH: 55 } });  // sizeH must be ignored
    const { machine, grbl } = await makeMachine();
    await grbl.runGCode(g);
    assertEngraved(machine, UID(1), UID(1), 30);
    assert.ok(Math.max(...g.split('\n').map(l => l.length)) < 70, 'a G-code line is longer than GRBL 0.9 on an Uno allows');
    await grbl.disconnect();
});

// ------------------------------------------------------------ single job
test('job resolves only after the machine finished, with the laser off', async () => {
    const { grbl, machine } = await makeMachine({ timeScale: 200 });
    await grbl.runGCode(generateQRGCode({ matrix: matrixOf(UID(2)), uid: UID(2), settings: SETTINGS }));
    assert.equal(machine.state === 'Idle' && machine.blocks.length === 0 && !machine.executing, true, 'resolved while machine still busy');
    assert.equal(machine.laserIsOff, true, 'laser left on');
    assert.equal(machine.overflows, 0, 'controller overflowed the 128 byte RX buffer');
    assertEngraved(machine, UID(2));
    await grbl.disconnect();
});

test('survives a full planner (long moves, delayed oks) - old 5s sync timeout dropped lines here', async () => {
    // 60 slow blocks x 0.4s: planner (15) fills, oks arrive seconds late
    const lines = ['G21', 'G90', 'M3 S0'];
    for (let i = 0; i < 60; i++) lines.push(`G1 X${(i % 2 ? 0 : 2)} Y0 F300 S500`);
    lines.push('M5 S0', 'M2');
    const { grbl, machine } = await makeMachine({ timeScale: 25 });   // 0.4s/25... realistic ok delays relative to timeouts
    const t0 = Date.now();
    await grbl.runGCode(lines.join('\n'));
    assert.equal(machine.log.length, lines.length, 'every line must reach the machine exactly once');
    assert.ok(Date.now() - t0 > 100);
    assert.equal(machine.overflows, 0);
    await grbl.disconnect();
});

test('chunked / LF-only serial responses are parsed correctly', async () => {
    const { grbl, machine } = await makeMachine({ chunky: true });
    await grbl.runGCode(generateQRGCode({ matrix: matrixOf(UID(3)), uid: UID(3), settings: SETTINGS }));
    assertEngraved(machine, UID(3));
    await grbl.disconnect();
});

// ------------------------------------------------------------- faults
test('lost "ok" fails the job loudly (never silent success) and leaves machine safe', async () => {
    const { grbl, machine } = await makeMachine({ dropOkOnLine: 400 });
    const g = generateQRGCode({ matrix: matrixOf(UID(4)), uid: UID(4), settings: SETTINGS });
    await assert.rejects(grbl.runGCode(g), (e) => e.code === 'STALL');
    assert.equal(machine.laserIsOff, true);
    assert.equal(grbl.isRunning, false);
    assert.equal(grbl.commandQueue.length + grbl.sentCommands.length, 0);
    await grbl.disconnect();
});

test('GRBL error:N aborts the job instead of skipping the line', async () => {
    const { grbl, machine } = await makeMachine({ errorOnLine: 300 });
    const g = generateQRGCode({ matrix: matrixOf(UID(5)), uid: UID(5), settings: SETTINGS });
    await assert.rejects(grbl.runGCode(g), (e) => e.code === 'GRBL_ERROR');
    assert.equal(machine.laserIsOff, true);
    // nothing after the failing line may have been executed (it would be a corrupted QR)
    assert.ok(machine.log.length <= 300 + 20);
    await grbl.disconnect();
});

test('board reboot mid-job is detected', async () => {
    const { grbl, machine } = await makeMachine({ rebootOnLine: 250 });
    const g = generateQRGCode({ matrix: matrixOf(UID(6)), uid: UID(6), settings: SETTINGS });
    await assert.rejects(grbl.runGCode(g), (e) => e.code === 'GRBL_RESET');
    assert.equal(machine.laserIsOff, true);
    await grbl.disconnect();
});

test('operator stop halts the laser immediately and the controller is reusable', async () => {
    const { grbl, machine } = await makeMachine({ timeScale: 20 });
    const g = generateQRGCode({ matrix: matrixOf(UID(7)), uid: UID(7), settings: SETTINGS });
    const run = grbl.runGCode(g);
    setTimeout(() => grbl.stop(), 150);
    await assert.rejects(run, (e) => e.code === 'STOPPED');
    assert.equal(machine.laserIsOff, true);
    assert.equal(machine.held && machine.state === 'Alarm', false);
    // can engrave again right away (machine sped up so the full QR finishes quickly)
    machine.o.timeScale = 2000;
    machine.clearBurn();
    await grbl.runGCode(generateQRGCode({ matrix: matrixOf(UID(7)), uid: UID(7), settings: SETTINGS }));
    assertEngraved(machine, UID(7), 'after stop');
    await grbl.disconnect();
});

// ------------------------------------------------------------------ batch
function makeBatch(grbl, db) {
    return new BatchEngraver({
        grbl, db,
        generateGCode: (item) => generateQRGCode({ matrix: matrixOf(item.uid), uid: item.uid, settings: SETTINGS }),
    });
}

test('batch: engraves exactly N pending QR codes, in order, honouring the delay', async () => {
    const { grbl, machine } = await makeMachine({ timeScale: 2000 });
    const uids = [1, 2, 3, 4, 5, 6].map(UID);
    const db = fakeDb(uids);
    const batch = makeBatch(grbl, db);

    // snapshot what is on the workpiece when each QR finishes
    const snapshots = [];
    const startTimes = [];
    grbl.on('start', () => { machine.clearBurn(); startTimes.push(Date.now()); });
    grbl.on('complete', () => snapshots.push(machine.sampleModules(matrixOf(uids[0]).length, SETTINGS.sizeW)));

    const r = await batch.start({ count: 4, delaySeconds: 0.6 });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.engraved, 4);
    assert.deepEqual(db.calls.updates, uids.slice(0, 4));
    assert.deepEqual(db.items.map(i => i.current_status), ['engraved', 'engraved', 'engraved', 'engraved', 'manufactured', 'manufactured']);
    assert.equal(snapshots.length, 4);
    snapshots.forEach((s, i) => assert.deepEqual(s, matrixOf(uids[i]), `QR #${i + 1} wrong on the workpiece`));
    for (let i = 1; i < startTimes.length; i++) {
        assert.ok(startTimes[i] - startTimes[i - 1] >= 600, `delay between QR ${i} and ${i + 1} was only ${startTimes[i] - startTimes[i - 1]}ms`);
    }
    assert.equal(machine.laserIsOff, true);
    await grbl.disconnect();
});

test('batch: asking for more than exist engraves what is available', async () => {
    const { grbl } = await makeMachine({ timeScale: 2000 });
    const db = fakeDb([UID(1), UID(2)]);
    const r = await makeBatch(grbl, db).start({ count: 10, delaySeconds: 0 });
    assert.equal(r.engraved, 2);
    assert.equal(r.total, 2);
    await grbl.disconnect();
});

test('batch: a transient machine fault is retried and the QR still comes out perfect', async () => {
    const uids = [1, 2, 3].map(UID);
    // machine line numbers count the '$$' sent on connect, then each QR's G-code lines;
    // aim the lost ok 50 lines into QR #2
    const perQR = generateQRGCode({ matrix: matrixOf(uids[0]), uid: uids[0], settings: SETTINGS })
        .split('\n').filter(l => l.trim() && !l.startsWith(';')).length;
    const { grbl, machine } = await makeMachine({ timeScale: 2000, dropOkOnLine: 1 + perQR + 50 });
    const db = fakeDb(uids);
    const batch = makeBatch(grbl, db);
    const finals = [];
    grbl.on('start', () => { if (finals.length < 3 && grbl.completedCommands === 0) machine.clearBurn(); });
    grbl.on('complete', () => finals.push(machine.sampleModules(matrixOf(uids[0]).length, SETTINGS.sizeW)));

    const r = await batch.start({ count: 3, delaySeconds: 0 });
    assert.equal(r.engraved, 3, JSON.stringify(r.results));
    assert.equal(r.results.find(x => x.uid === uids[1]).attempts, 2, 'QR #2 should have needed a retry');
    finals.forEach((s, i) => assert.deepEqual(s, matrixOf(uids[i]), `QR #${i + 1} wrong after retry`));
    await grbl.disconnect();
});

test('batch: a persistent fault halts the batch instead of wasting the remaining parts', async () => {
    const { grbl, machine } = await makeMachine({ timeScale: 2000 });
    const uids = [1, 2, 3].map(UID);
    const db = fakeDb(uids);
    const batch = makeBatch(grbl, db);
    // every attempt of the 2nd QR hits a GRBL error
    let startCount = 0;
    const origRun = grbl.runGCode.bind(grbl);
    grbl.runGCode = (g) => (++startCount >= 2 ? Promise.reject(Object.assign(new Error('error:20 simulated'), { code: 'GRBL_ERROR' })) : origRun(g));
    const r = await batch.start({ count: 3, delaySeconds: 0, maxRetries: 1 });
    assert.equal(r.halted, true);
    assert.equal(r.engraved, 1);
    assert.equal(db.items[2].current_status, 'manufactured', 'QR #3 must not be touched');
    assert.equal(db.items[1].current_status, 'manufactured', 'failed QR must not be marked engraved');
    await grbl.disconnect();
});

test('batch: un-generatable QR is skipped, batch continues', async () => {
    const { grbl } = await makeMachine({ timeScale: 2000 });
    const tooLong = 'X'.repeat(4000);                  // exceeds max QR capacity
    const db = fakeDb([UID(1), tooLong, UID(3)]);
    const batch = makeBatch(grbl, db);
    const r = await batch.start({ count: 3, delaySeconds: 0 });
    assert.equal(r.engraved, 2);
    assert.equal(r.results[1].status, 'skipped');
    assert.equal(r.halted, false);
    await grbl.disconnect();
});

test('batch: stop during the delay countdown ends the batch promptly', async () => {
    const { grbl } = await makeMachine({ timeScale: 2000 });
    const db = fakeDb([1, 2, 3].map(UID));
    const batch = makeBatch(grbl, db);
    const p = batch.start({ count: 3, delaySeconds: 30 });
    await new Promise(r => batch.on('state', s => s.phase === 'waiting' && r()));
    const t0 = Date.now();
    batch.stop();
    const r = await p;
    assert.ok(Date.now() - t0 < 1500, 'stop did not interrupt the delay');
    assert.equal(r.engraved, 1);
    assert.equal(r.halted, true);
    await grbl.disconnect();
});

test('batch: stop mid-engraving stops the laser and never marks the QR engraved', async () => {
    const { grbl, machine } = await makeMachine({ timeScale: 20 });
    const db = fakeDb([1, 2].map(UID));
    const batch = makeBatch(grbl, db);
    const p = batch.start({ count: 2, delaySeconds: 0 });
    await new Promise(r => grbl.once('start', r));
    setTimeout(() => batch.stop(), 100);
    const r = await p;
    assert.equal(r.engraved, 0);
    assert.equal(db.items[0].current_status, 'manufactured');
    assert.equal(machine.laserIsOff, true);
    await grbl.disconnect();
});

test('batch: DB hiccup does not lose engraved work and is retried', async () => {
    const { grbl } = await makeMachine({ timeScale: 2000 });
    const db = fakeDb([1, 2].map(UID), { failUpdates: 2 });
    const batch = new BatchEngraver({
        grbl, db, sleep: () => Promise.resolve(),
        generateGCode: (item) => generateQRGCode({ matrix: matrixOf(item.uid), uid: item.uid, settings: SETTINGS }),
    });
    const r = await batch.start({ count: 2, delaySeconds: 0 });
    assert.equal(r.engraved, 2);
    assert.deepEqual(db.items.map(i => i.current_status), ['engraved', 'engraved']);
    await grbl.disconnect();
});

test('batch: input validation', async () => {
    const { grbl } = await makeMachine();
    const batch = makeBatch(grbl, fakeDb([UID(1)]));
    assert.equal((await batch.start({ count: 0, delaySeconds: 1 })).success, false);
    assert.equal((await batch.start({ count: 'abc', delaySeconds: 1 })).success, false);
    assert.equal((await batch.start({ count: 1, delaySeconds: -5 })).success, false);
    assert.equal((await batch.start({ count: 1, delaySeconds: 'x' })).success, false);
    await grbl.disconnect();
    assert.equal((await batch.start({ count: 1, delaySeconds: 0 })).success, false);   // not connected
});

// ------------------------------------------- Arduino Uno + CNC shield (GRBL 0.9)
test('GRBL 0.9 (Uno + CNC shield): comma status format, full job, completion detection', async () => {
    const { grbl, machine } = await makeMachine({ legacy: true, timeScale: 300 });
    assert.equal(grbl.grblVersion, '0.9j');
    await grbl.runGCode(generateQRGCode({ matrix: matrixOf(UID(8)), uid: UID(8), settings: SETTINGS }));
    assert.equal(machine.state === 'Idle' && !machine.executing && machine.blocks.length === 0, true);
    assert.equal(machine.laserIsOff, true);
    assert.equal(machine.overflows, 0);
    assertEngraved(machine, UID(8));
    await grbl.disconnect();
});

test('GRBL 0.9: lost ok / stop handled the same way', async () => {
    const a = await makeMachine({ legacy: true, dropOkOnLine: 300 });
    await assert.rejects(a.grbl.runGCode(generateQRGCode({ matrix: matrixOf(UID(9)), uid: UID(9), settings: SETTINGS })), (e) => e.code === 'STALL');
    assert.equal(a.machine.laserIsOff, true);
    await a.grbl.disconnect();

    const b = await makeMachine({ legacy: true, timeScale: 20 });
    const run = b.grbl.runGCode(generateQRGCode({ matrix: matrixOf(UID(9)), uid: UID(9), settings: SETTINGS }));
    setTimeout(() => b.grbl.stop(), 150);
    await assert.rejects(run, (e) => e.code === 'STOPPED');
    assert.equal(b.machine.laserIsOff, true);
    await b.grbl.disconnect();
});
