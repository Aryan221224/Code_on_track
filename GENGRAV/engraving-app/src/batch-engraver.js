/**
 * Batch engraver: fetch N pending QR codes from the database and engrave them
 * one after another with an operator-chosen delay between each.
 *
 * Design rules (this is what makes it "seamless"):
 *  - The list is fetched ONCE up front, so progress never depends on the DB
 *    changing underneath us.
 *  - A QR is only marked 'engraved' after the machine reports it FINISHED
 *    (grbl.runGCode resolves only when every line is acked and the machine is Idle).
 *  - Hardware hiccups (lost 'ok', GRBL error, USB drop) are retried on the same
 *    QR after the machine is brought back to a safe state; operator stop,
 *    e-stop, alarms and unrecoverable faults halt the batch instead of
 *    burning the remaining parts.
 *  - A QR that can't even be generated (bad data) is skipped and reported.
 *  - DB write failures never lose engraved work: they are retried and, if
 *    still failing, flagged so the operator knows which UIDs to sync.
 */
const EventEmitter = require('events');

const HALT_CODES = new Set(['STOPPED', 'ESTOP', 'ALARM']);

class BatchEngraver extends EventEmitter {
    /**
     * @param {object} deps
     * @param {object}   deps.grbl          GRBLController
     * @param {object}   deps.db            database module
     * @param {function} deps.generateGCode (item) => G-code string (may throw)
     * @param {function} [deps.sleep]       (ms) => Promise  (injectable for tests)
     */
    constructor({ grbl, db, generateGCode, sleep }) {
        super();
        this.grbl = grbl;
        this.db = db;
        this.generateGCode = generateGCode;
        this.sleep = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
        this.running = false;
        this.stopRequested = false;
        this._wake = null;
        this.state = this._freshState();
    }

    _freshState() {
        return {
            running: false,
            phase: 'idle',          // idle | fetching | engraving | waiting | recovering | finished
            message: '',
            requested: 0,
            total: 0,
            index: 0,               // 1-based index of the QR being processed
            currentUid: null,
            attempt: 0,
            delaySeconds: 0,
            delayRemaining: 0,
            results: [],            // { uid, status: 'engraved'|'failed'|'skipped', attempts, error, dbSynced }
            engraved: 0,
            failed: 0,
            halted: false,
            haltReason: null,
        };
    }

    getState() { return JSON.parse(JSON.stringify(this.state)); }

    _update(patch) {
        Object.assign(this.state, patch);
        this.emit('state', this.getState());
    }

    _log(msg, level = 'log') {
        this.emit('log', { message: msg, level });
    }

    /**
     * @param {object} opts
     * @param {number} opts.count          how many QR codes to engrave
     * @param {number} opts.delaySeconds   pause between consecutive QR codes
     * @param {number} [opts.maxRetries=2] retries per QR on a machine fault
     * @param {boolean}[opts.markEngraved=true]
     */
    async start(opts = {}) {
        if (this.running) return { success: false, error: 'A batch is already running' };

        const count = Number.parseInt(opts.count, 10);
        const delaySeconds = Number(opts.delaySeconds);
        const maxRetries = opts.maxRetries === undefined ? 2 : Number.parseInt(opts.maxRetries, 10);
        const markEngraved = opts.markEngraved !== false;

        if (!Number.isInteger(count) || count < 1 || count > 10000) {
            return { success: false, error: 'Number of QR codes must be a whole number between 1 and 10000' };
        }
        if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > 86400) {
            return { success: false, error: 'Delay must be between 0 and 86400 seconds' };
        }
        if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
            return { success: false, error: 'Retries must be between 0 and 10' };
        }
        if (!this.grbl.isConnected) return { success: false, error: 'Machine not connected - connect to the laser first' };
        if (this.grbl.isRunning) return { success: false, error: 'The machine is busy with another job' };

        this.running = true;
        this.stopRequested = false;
        this.state = this._freshState();
        this._update({ running: true, phase: 'fetching', requested: count, delaySeconds, message: 'Fetching QR codes from database...' });

        try {
            const fetched = await this.db.fetchPendingEngravings(count);
            if (!fetched.success) {
                this._finish(`Could not fetch QR codes: ${fetched.error}`);
                return { success: false, error: fetched.error };
            }

            // exact count, no duplicates
            const seen = new Set();
            const items = [];
            for (const it of fetched.items) {
                if (it && it.uid && !seen.has(it.uid)) { seen.add(it.uid); items.push(it); }
                if (items.length >= count) break;
            }
            if (items.length === 0) {
                this._finish('No QR codes are pending engraving in the database');
                return { success: true, engraved: 0, total: 0 };
            }
            if (items.length < count) {
                this._log(`Only ${items.length} of ${count} requested QR codes are pending - engraving those`, 'warning');
            }

            this._update({ total: items.length });
            this._log(`Batch started: ${items.length} QR code(s), ${delaySeconds}s delay between each`);

            await this._runItems(items, { delaySeconds, maxRetries, markEngraved });
            return this._summary();
        } catch (e) {
            this._log(`Batch crashed: ${e.message}`, 'error');
            this._update({ halted: true, haltReason: e.message });
            this._finish(`Batch stopped: ${e.message}`);
            return { success: false, error: e.message, ...this._summary() };
        } finally {
            this.running = false;
            this._update({ running: false });
        }
    }

    stop() {
        if (!this.running) return { success: true };
        this.stopRequested = true;
        this._log('Batch stop requested', 'warning');
        if (this.grbl.isRunning) this.grbl.stop();
        if (this._wake) this._wake();
        return { success: true };
    }

    async _runItems(items, { delaySeconds, maxRetries, markEngraved }) {
        for (let i = 0; i < items.length; i++) {
            if (this.stopRequested) { this._halt('Stopped by operator'); break; }

            const item = items[i];
            this._update({ phase: 'engraving', index: i + 1, currentUid: item.uid, attempt: 0, delayRemaining: 0,
                message: `Engraving ${i + 1} of ${items.length}` });
            this._log(`[${i + 1}/${items.length}] Engraving ${item.uid}`);

            const result = await this._engraveItem(item, maxRetries);

            if (result.status === 'engraved') {
                result.dbSynced = markEngraved ? await this._syncDb(item.uid, result) : true;
            }
            this.state.results.push(result);
            this._update({
                engraved: this.state.results.filter(r => r.status === 'engraved').length,
                failed: this.state.results.filter(r => r.status !== 'engraved').length,
            });

            if (result.halt) { this._halt(result.error); break; }

            const isLast = i === items.length - 1;
            if (!isLast && result.status === 'engraved' && delaySeconds > 0) {
                const ok = await this._countdown(delaySeconds);
                if (!ok) { this._halt('Stopped by operator'); break; }
            }
        }

        // One last attempt at any DB updates that failed mid-batch
        for (const r of this.state.results) {
            if (r.status === 'engraved' && r.dbSynced === false && markEngraved) {
                r.dbSynced = await this._syncDb(r.uid, r, 1);
            }
        }

        const unsynced = this.state.results.filter(r => r.status === 'engraved' && !r.dbSynced).map(r => r.uid);
        if (unsynced.length) {
            this._log(`WARNING: engraved but not marked in the database: ${unsynced.join(', ')}`, 'error');
        }

        const { engraved, failed, halted, haltReason } = this.state;
        this._finish(halted
            ? `Batch halted after ${engraved} engraved: ${haltReason}`
            : `Batch complete: ${engraved} engraved, ${failed} failed`);
    }

    async _engraveItem(item, maxRetries) {
        const result = { uid: item.uid, status: 'failed', attempts: 0, error: null, dbSynced: null, halt: false };

        let gcode;
        try {
            gcode = this.generateGCode(item);
            if (!gcode) throw new Error('empty G-code');
        } catch (e) {
            result.status = 'skipped';
            result.error = `Could not generate QR code: ${e.message}`;
            this._log(`[${item.uid}] ${result.error} - skipping`, 'error');
            return result;
        }

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (this.stopRequested) { result.error = 'Stopped by operator'; result.halt = true; return result; }

            result.attempts = attempt + 1;
            this._update({ phase: 'engraving', attempt: attempt + 1 });
            try {
                await this.grbl.runGCode(gcode);
                result.status = 'engraved';
                result.error = null;
                this._log(`[${item.uid}] Engraved${attempt ? ` (after ${attempt} retr${attempt === 1 ? 'y' : 'ies'})` : ''}`);
                return result;
            } catch (e) {
                result.error = e.message;
                this._log(`[${item.uid}] Attempt ${attempt + 1} failed: ${e.message}`, 'error');

                if (this.stopRequested || HALT_CODES.has(e.code)) { result.halt = true; return result; }
                if (attempt === maxRetries) break;

                this._update({ phase: 'recovering', message: `Recovering machine before retry ${attempt + 1} of ${maxRetries}...` });
                const recovered = await this._recover();
                if (!recovered.ok) {
                    result.error = `${e.message}; recovery failed: ${recovered.reason}`;
                    result.halt = true;
                    return result;
                }
            }
        }

        // retries exhausted on a machine fault: stop rather than waste more parts
        result.halt = true;
        result.error = `${result.error} (gave up after ${result.attempts} attempts)`;
        return result;
    }

    // Bring the machine back to an idle, unlocked, connected state.
    async _recover() {
        const g = this.grbl;
        try {
            if (!g.isConnected && g.portPath) {
                for (let i = 0; i < 2 && !g.isConnected; i++) {
                    this._log(`Reconnecting to ${g.portPath}...`, 'warning');
                    try { await g.connect(g.portPath, { baudRate: g.baudRate }); } catch (e) { await this.sleep(1000); }
                }
            }
            if (!g.isConnected) return { ok: false, reason: 'machine disconnected' };
            await this.sleep(300);
            if (g.machineState === 'Alarm' || g.alarmActive) {
                return { ok: false, reason: 'machine is in ALARM - position may be lost; re-home / re-zero before continuing' };
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, reason: e.message };
        }
    }

    async _syncDb(uid, result, tries = 3) {
        for (let t = 0; t < tries; t++) {
            const r = await this.db.updateItemStatus(uid, 'engraved');
            if (r.success) {
                // history row is best-effort: the physical work and item status are what matter
                const rec = await this.db.recordEngraving({ item_uid: uid, status: 'completed', settings: result.settings || {} });
                if (!rec.success) this._log(`[${uid}] engraving history not recorded: ${rec.error}`, 'warning');
                return true;
            }
            this._log(`[${uid}] DB update failed (${r.error})${t < tries - 1 ? ' - retrying' : ''}`, 'warning');
            if (t < tries - 1) await this.sleep(1000 * (t + 1));
        }
        return false;
    }

    // Abortable delay with per-second countdown. Returns false if stopped.
    async _countdown(seconds) {
        const end = Date.now() + seconds * 1000;
        this._update({ phase: 'waiting', delayRemaining: seconds, message: `Waiting ${seconds}s before next QR code` });
        while (!this.stopRequested) {
            const remaining = end - Date.now();
            if (remaining <= 0) break;
            this._update({ delayRemaining: Math.ceil(remaining / 1000) });
            await new Promise(resolve => {
                const t = setTimeout(resolve, Math.min(remaining, 250));
                this._wake = () => { clearTimeout(t); resolve(); };
            });
            this._wake = null;
        }
        this._update({ delayRemaining: 0 });
        return !this.stopRequested;
    }

    _halt(reason) {
        this._update({ halted: true, haltReason: reason });
        this._log(`Batch halted: ${reason}`, 'error');
    }

    _finish(message) {
        this._update({ phase: 'finished', message, running: false });
        this._log(message);
        this.emit('finished', this.getState());
    }

    _summary() {
        const s = this.state;
        return {
            success: !s.halted && s.failed === 0,
            total: s.total,
            engraved: s.engraved,
            failed: s.failed,
            halted: s.halted,
            haltReason: s.haltReason,
            results: s.results,
        };
    }
}

module.exports = { BatchEngraver };
