/**
 * Simulated GRBL 1.1 machine behind a serialport-shaped object.
 *
 * Models the things that matter for reliability:
 *  - 128 byte RX buffer (bytes are "in the buffer" from write until the line's ok);
 *    overflowing it corrupts data exactly like real hardware, and is recorded.
 *  - 15 block planner: when it is full, 'ok' is DELAYED until a block finishes
 *    executing (this is what made the old fixed 5 s timeout drop lines).
 *  - real-time commands ? ! ~ 0x18, Hold / Idle / Run / Alarm states.
 *  - a "burn" raster: every G1 with the laser on marks the workpiece, so tests
 *    can decode the engraved QR code.
 *  - fault injection: dropped ok, error:N, spontaneous reboot, random chunking.
 */
const EventEmitter = require('events');

const RX_SIZE = 128;
const PLANNER_SIZE = 15;
const BANNER_11 = "Grbl 1.1h ['$' for help]";
const BANNER_09 = "Grbl 0.9j ['$' for help]";

class FakeGrbl extends EventEmitter {
    /**
     * @param {object} o
     * @param {number} [o.timeScale=1000]  machine runs this many times faster than real time
     * @param {number} [o.dropOkOnLine]    1-based index (counted across the machine's life) of a line whose ok is lost
     * @param {number} [o.errorOnLine]     1-based index of a line answered with error:20
     * @param {number} [o.rebootOnLine]    1-based index of a line that makes the board reboot
     * @param {boolean}[o.chunky=false]    deliver responses in random tiny chunks, with \n only
     * @param {number} [o.bootMs=20]       delay before the welcome banner
     * @param {number} [o.dropOkCount=1]   how many consecutive attempts of the fault above to apply (per fault)
     */
    constructor(o = {}) {
        super();
        this.o = { timeScale: 1000, chunky: false, bootMs: 20, legacy: false, ...o };
        this.banner = this.o.legacy ? BANNER_09 : BANNER_11;
        this.isOpen = false;
        this.reset(true);
        this.lineNo = 0;
        this.rxHighWater = 0;
        this.overflows = 0;
        this.log = [];          // every line GRBL accepted (for assertions)
        this.burn = new Map();  // "ix,iy" -> true  (0.05 mm cells)
        this.maxLaserWhileIdle = 0;
        this.faultsUsed = new Set();
    }

    // ---------- serialport API ----------
    open(cb) { this.isOpen = true; setImmediate(() => cb && cb(null)); setTimeout(() => this._boot(), this.o.bootMs); }
    set(_o, cb) { cb && cb(null); }
    flush(cb) { cb && cb(null); }
    close(cb) { this.isOpen = false; clearTimeout(this._execTimer); setImmediate(() => { cb && cb(null); this.emit('close'); }); }

    write(data) {
        if (!this.isOpen) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
        for (const b of buf) this._byte(b);
    }

    // ---------- machine internals ----------
    reset(initial = false) {
        clearTimeout(this._execTimer);
        this._execTimer = null;
        this.rx = '';
        this.rxBytes = 0;
        this.blocks = [];
        this.executing = null;
        this.blockedQueue = [];
        this.held = false;
        this.state = initial ? 'Idle' : (this.moving ? 'Alarm' : 'Idle');
        this.moving = false;
        this.laserOn = false;
        this.power = 0;
        this.feed = 0;
        this.pos = this.pos || { x: 0, y: 0, z: 0 };
        this.modalDistanceAbs = true;
    }

    _boot() {
        if (!this.isOpen) return;
        this._out(`\r\n${this.banner}\r\n`);
    }

    _out(text) {
        if (!this.isOpen) return;
        if (!this.o.chunky) { setImmediate(() => this.emit('data', Buffer.from(text, 'latin1'))); return; }
        // one ordered byte stream, delivered in random tiny chunks, LF-only line endings
        this._outBuf = (this._outBuf || '') + text.replace(/\r\n/g, '\n');
        if (this._draining) return;
        this._draining = true;
        const drain = () => {
            if (!this._outBuf) { this._draining = false; return; }
            const n = 1 + Math.floor(Math.random() * 5);
            const piece = this._outBuf.slice(0, n);
            this._outBuf = this._outBuf.slice(n);
            if (this.isOpen) this.emit('data', Buffer.from(piece, 'latin1'));
            setImmediate(drain);
        };
        setImmediate(drain);
    }

    _byte(b) {
        // real-time commands are intercepted and never enter the line buffer / RX count
        if (b === 0x3f) return this._status();                                 // ?
        if (b === 0x21) { this.held = true; this._holdMotion(); return; }      // !
        if (b === 0x7e) { this.held = false; this._kick(); return; }           // ~
        if (b === 0x18) return this._softReset();                              // Ctrl-X

        this.rxBytes++;
        this.rxHighWater = Math.max(this.rxHighWater, this.rxBytes);
        if (this.rxBytes > RX_SIZE) {
            // real GRBL silently overwrites / drops here -> corrupted G-code
            this.overflows++;
            this.rxBytes = RX_SIZE;
            return;
        }
        if (b === 0x0a) {
            const line = this.rx.trim();
            const bytes = this.rx.length + 1;
            this.rx = '';
            this._line(line, bytes);
        } else if (b !== 0x0d) {
            this.rx += String.fromCharCode(b);
        }
    }

    _softReset() {
        const wasMoving = this.moving && !this.held;
        this.moving = wasMoving;
        this.reset(false);
        this.pendingOkLines = 0;
        this._out(`\r\n${this.banner}\r\n`);
    }

    _holdMotion() {
        if (this.executing) {
            clearTimeout(this._execTimer);
            this._execTimer = null;
            this.moving = false;
            // remainder of the move is retained; position stays (good enough for tests)
        }
    }

    _status() {
        let state = this.state;
        if (state !== 'Alarm') {
            if (this.held) state = 'Hold:0';
            else if (this.blocks.length > 0 || this.executing || this.blockedQueue.length > 0) state = 'Run';
            else state = 'Idle';
        }
        if (this.o.legacy) {
            // GRBL 0.9 format (Arduino Uno + CNC shield): comma separated, no Bf/FS fields
            const p = this.pos;
            const st = state.split(':')[0];
            this._out(`<${st},MPos:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)},WPos:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}>\r\n`);
            return;
        }
        const bf = `Bf:${PLANNER_SIZE - this.blocks.length},${RX_SIZE - this.rxBytes}`;
        this._out(`<${state}|MPos:${this.pos.x.toFixed(3)},${this.pos.y.toFixed(3)},${this.pos.z.toFixed(3)}|${bf}|FS:${this.feed},${this.power}>\r\n`);
    }

    _ok(bytes) { this.rxBytes = Math.max(0, this.rxBytes - bytes); this.lineNo; this._reply('ok\r\n'); }

    _reply(text) {
        this.replies = (this.replies || 0) + 1;
        this._out(text);
    }

    _line(line, bytes) {
        this.lineNo++;
        const n = this.lineNo;

        if (this.o.rebootOnLine === n && !this.faultsUsed.has('reboot')) {
            this.faultsUsed.add('reboot');
            this.pos = { ...this.pos };
            this.blocks = [];
            this.reset(false);
            this._out(`\r\n${this.banner}\r\n`);
            return;
        }

        if (this.state === 'Alarm' && !line.startsWith('$X') && line !== '' && !line.startsWith('$')) {
            this.rxBytes = Math.max(0, this.rxBytes - bytes);
            return this._reply('error:9\r\n');
        }

        if (line === '') { this.rxBytes = Math.max(0, this.rxBytes - bytes); return this._reply('ok\r\n'); }

        if (line.startsWith('$')) {
            this.rxBytes = Math.max(0, this.rxBytes - bytes);
            if (line === '$$') {
                this._out('$30=1000\r\n$31=0\r\n$32=1\r\n$22=0\r\n$100=80.000\r\n$101=80.000\r\n');
                return this._reply('ok\r\n');
            }
            if (line === '$X') { this.state = 'Idle'; return this._reply('ok\r\n'); }
            return this._reply('ok\r\n');
        }

        if (this.o.errorOnLine === n && !this.faultsUsed.has('error')) {
            this.faultsUsed.add('error');
            this.rxBytes = Math.max(0, this.rxBytes - bytes);
            return this._reply('error:20\r\n');
        }

        const block = this._parse(line);
        if (!block) {
            this.rxBytes = Math.max(0, this.rxBytes - bytes);
            return this._reply('error:20\r\n');
        }
        block.bytes = bytes;
        block.dropOk = this.o.dropOkOnLine === n && !this.faultsUsed.has('dropok');
        if (block.dropOk) this.faultsUsed.add('dropok');
        this.log.push(line);
        this._enqueue(block);
    }

    _parse(line) {
        const w = line.toUpperCase().match(/[A-Z][-+]?\d*\.?\d*/g) || [];
        const words = {};
        for (const t of w) words[t[0]] = t.slice(1) === '' ? '' : parseFloat(t.slice(1));
        const g = w.filter(t => t[0] === 'G').map(t => parseFloat(t.slice(1)));
        const m = w.filter(t => t[0] === 'M').map(t => parseFloat(t.slice(1)));
        const known = new Set([0, 1, 10, 21, 90]);
        for (const x of g) if (!known.has(x)) return null;
        for (const x of m) if (![2, 3, 4, 5].includes(x)) return null;
        if (w.some(t => !'GMXYZFSPL'.includes(t[0]))) return null;
        const b = { line, words, g, m, kind: 'modal' };
        if (g.includes(0) || g.includes(1)) {
            b.kind = 'move';
            b.rapid = g.includes(0);
        }
        return b;
    }

    _enqueue(block) {
        if (this.blocks.length < PLANNER_SIZE && this.blockedQueue.length === 0) {
            this.blocks.push(block);
            this._release(block);
            this._kick();
        } else {
            // planner full: GRBL stops reading the serial buffer, lines wait in order,
            // no 'ok' until a slot frees
            this.blockedQueue.push(block);
        }
    }

    _release(block) {
        this.rxBytes = Math.max(0, this.rxBytes - block.bytes);
        if (block.dropOk) return;             // fault: the ok is lost on the wire
        this._reply('ok\r\n');
    }

    _kick() {
        if (this.held || this.executing || this.state === 'Alarm') return;
        const block = this.blocks[0];
        if (!block) return;
        this.executing = block;
        const dur = this._apply(block);
        this.moving = dur > 0;
        this._execTimer = setTimeout(() => this._done(block), Math.max(0, dur / this.o.timeScale));
    }

    _apply(block) {
        const { words, m } = block;
        if (words.F !== undefined) this.feed = words.F;
        if (words.S !== undefined) this.power = words.S;
        if (m.includes(3) || m.includes(4)) this.laserOn = true;
        if (m.includes(5)) { this.laserOn = false; this.power = 0; }
        if (m.includes(2)) { this.laserOn = false; this.power = 0; }
        if (block.kind !== 'move') return 0;

        const from = { ...this.pos };
        const to = {
            x: words.X !== undefined ? words.X : from.x,
            y: words.Y !== undefined ? words.Y : from.y,
            z: from.z,
        };
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const burning = !block.rapid && this.laserOn && this.power > 0;
        if (burning) this._burn(from, to);
        this.pos = to;
        const feed = block.rapid ? 2000 : (this.feed || 1);
        return (dist / (feed / 60)) * 1000; // ms of machine time
    }

    _burn(a, b) {
        const step = 0.02;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const n = Math.max(1, Math.ceil(dist / step));
        for (let i = 0; i <= n; i++) {
            const x = a.x + (b.x - a.x) * (i / n);
            const y = a.y + (b.y - a.y) * (i / n);
            this.burn.set(`${Math.round(x / 0.05)},${Math.round(y / 0.05)}`, true);
        }
    }

    _done(block) {
        this._execTimer = null;
        this.executing = null;
        this.moving = false;
        const i = this.blocks.indexOf(block);
        if (i !== -1) this.blocks.splice(i, 1);
        while (this.blockedQueue.length > 0 && this.blocks.length < PLANNER_SIZE) {
            const nb = this.blockedQueue.shift();
            this.blocks.push(nb);
            this._release(nb);
        }
        this._kick();
    }

    // ---------- test helpers ----------
    get laserIsOff() { return !this.laserOn && this.power === 0; }

    /** Render the burned workpiece as module booleans for a QR placed at (ox,oy) with side mm. */
    sampleModules(n, side, ox = 0, oy = 0) {
        const mod = side / n;
        const rows = [];
        for (let r = 0; r < n; r++) {
            const row = [];
            for (let c = 0; c < n; c++) {
                // a module is "black" if its centre cell (or a neighbour: beam width) is burned
                const cx = ox + (c + 0.5) * mod;
                const cy = oy + (r + 0.5) * mod;
                // scan lines are 1/quality mm apart, so look across a beam-width window
                let hit = 0;
                const ix = Math.round(cx / 0.05), iy = Math.round(cy / 0.05);
                for (let dx = -3; dx <= 3 && !hit; dx++) for (let dy = -3; dy <= 3 && !hit; dy++) {
                    if (this.burn.has(`${ix + dx},${iy + dy}`)) hit = 1;
                }
                row.push(hit);
            }
            rows.push(row);
        }
        return rows;
    }

    clearBurn() { this.burn = new Map(); }

    /** Black-on-white bitmap of the burn (for decoding with a real QR decoder). */
    bitmap(side, ox = 0, oy = 0, pxPerMm = 16, quiet = 4) {
        const size = Math.ceil((side + quiet * 2) * pxPerMm);
        const data = new Uint8ClampedArray(size * size * 4).fill(255);
        const set = (px, py) => {
            if (px < 0 || py < 0 || px >= size || py >= size) return;
            const i = (py * size + px) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
        };
        for (const key of this.burn.keys()) {
            const [ix, iy] = key.split(',').map(Number);
            const x = ix * 0.05 - ox + quiet;
            const y = iy * 0.05 - oy + quiet;
            const px = Math.round(x * pxPerMm), py = Math.round(y * pxPerMm);
            // ~0.15 mm beam kerf
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) set(px + dx, py + dy);
        }
        return { data, width: size, height: size };
    }
}

module.exports = { FakeGrbl };
