/**
 * GRBL 1.1 Controller - Based on LaserGRBL's GrblCore.cs
 * Full laser module configuration support for GRBL 1.1+
 * 
 * GRBL 1.1 Features:
 * - Laser mode ($32=1) with dynamic power (M4)
 * - Real-time jogging ($J= command)
 * - Extended status reports with WCO, overrides
 * - Feed and spindle overrides
 * - New error and alarm codes
 */
const EventEmitter = require('events');

// Stream tuning (see runGCode)
const RX_BUFFER_SAFE = 110;        // GRBL RX buffer is 128 bytes; keep a safety margin for clones
const STREAM_QUEUE_DEPTH = 8;      // lines waiting to be written before the sender pauses
const NO_DATA_TIMEOUT_MS = 8000;   // GRBL must answer status polls (every 250ms) at least this often
const IDLE_STALL_MS = 3000;        // GRBL idle yet commands unacknowledged for this long = lost 'ok'
const JOB_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * Minimal line splitter. Accepts \r\n or \n so a board that only sends \n
 * (some clones) works too, and has no dependency on serialport parsers.
 */
class LineParser extends EventEmitter {
    constructor() { super(); this.buf = ''; }
    push(chunk) {
        this.buf += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, i).replace(/\r$/, '').trim();
            this.buf = this.buf.slice(i + 1);
            if (line) this.emit('data', line);
        }
        if (this.buf.length > 4096) this.buf = '';  // garbage without newline
    }
}

function jobError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
}

// GRBL 1.1 specific constants
const GRBL_VERSION = '1.1';
const STATUS_POLL_INTERVAL = 250;

// Supported baud rates (LaserGRBL compatible)
const BAUD_RATES = [115200, 250000, 230400, 57600, 38400, 19200, 9600];
const DEFAULT_BAUD_RATE = 115200;

const MachineState = {
    DISCONNECTED: 'Disconnected',
    CONNECTING: 'Connecting',
    IDLE: 'Idle',
    RUN: 'Run',
    HOLD: 'Hold',       // GRBL 1.1: Hold:0 (complete), Hold:1 (in-progress)
    JOG: 'Jog',         // GRBL 1.1 real-time jogging
    ALARM: 'Alarm',
    DOOR: 'Door',       // GRBL 1.1: Door:0-3 states
    CHECK: 'Check',
    HOME: 'Home',
    SLEEP: 'Sleep',
    QUEUE: 'Queue',
    COOLING: 'Cooling'
};

// GRBL 1.1 Settings (full list from setting_codes.v1.1.csv)
const GRBL_SETTINGS = {
    '$0': { name: 'Step pulse time', units: 'µs', desc: 'Sets time length per step. Minimum 3usec.', min: 3, max: 255 },
    '$1': { name: 'Step idle delay', units: 'ms', desc: 'Sets a short hold delay when stopping. Value 255 keeps motors enabled.', min: 0, max: 255 },
    '$2': { name: 'Step pulse invert', units: 'mask', desc: 'Inverts the step signal. Set axis bit to invert (00000ZYX).', min: 0, max: 7 },
    '$3': { name: 'Step direction invert', units: 'mask', desc: 'Inverts the direction signal. Set axis bit to invert (00000ZYX).', min: 0, max: 7 },
    '$4': { name: 'Invert step enable pin', units: 'bool', desc: 'Inverts the stepper driver enable pin signal.', min: 0, max: 1 },
    '$5': { name: 'Invert limit pins', units: 'bool', desc: 'Inverts all of the limit input pins.', min: 0, max: 1 },
    '$6': { name: 'Invert probe pin', units: 'bool', desc: 'Inverts the probe input pin signal.', min: 0, max: 1 },
    '$10': { name: 'Status report options', units: 'mask', desc: 'Alters data included in status reports.', min: 0, max: 255 },
    '$11': { name: 'Junction deviation', units: 'mm', desc: 'Sets how fast Grbl travels through consecutive motions.', min: 0.001, max: 10 },
    '$12': { name: 'Arc tolerance', units: 'mm', desc: 'Sets the G2 and G3 arc tracing accuracy based on radial error.', min: 0.001, max: 10 },
    '$13': { name: 'Report in inches', units: 'bool', desc: 'Enables inch units when returning position and rate values.', min: 0, max: 1 },
    '$20': { name: 'Soft limits enable', units: 'bool', desc: 'Enables soft limits checks within machine travel.', min: 0, max: 1 },
    '$21': { name: 'Hard limits enable', units: 'bool', desc: 'Enables hard limits. Immediately halts motion on switch trigger.', min: 0, max: 1 },
    '$22': { name: 'Homing cycle enable', units: 'bool', desc: 'Enables homing cycle. Requires limit switches on all axes.', min: 0, max: 1 },
    '$23': { name: 'Homing direction invert', units: 'mask', desc: 'Homing searches for switch in positive direction.', min: 0, max: 7 },
    '$24': { name: 'Homing locate feed rate', units: 'mm/min', desc: 'Feed rate to slowly engage limit switch.', min: 1, max: 10000 },
    '$25': { name: 'Homing search seek rate', units: 'mm/min', desc: 'Seek rate to quickly find the limit switch.', min: 1, max: 10000 },
    '$26': { name: 'Homing switch debounce delay', units: 'ms', desc: 'Sets delay between phases of homing cycle.', min: 0, max: 1000 },
    '$27': { name: 'Homing switch pull-off distance', units: 'mm', desc: 'Retract distance after triggering switch.', min: 0, max: 100 },
    '$30': { name: 'Maximum spindle speed', units: 'RPM', desc: 'Maximum spindle speed. Sets PWM to 100% duty cycle.', min: 0, max: 100000 },
    '$31': { name: 'Minimum spindle speed', units: 'RPM', desc: 'Minimum spindle speed. Sets PWM to 0.4% duty cycle.', min: 0, max: 100000 },
    '$32': { name: 'Laser mode enable', units: 'bool', desc: 'GRBL 1.1 Laser mode. G1/2/3 commands will not halt when S changes.', min: 0, max: 1 },
    '$100': { name: 'X-axis travel resolution', units: 'step/mm', desc: 'X-axis travel resolution in steps per millimeter.', min: 1, max: 10000 },
    '$101': { name: 'Y-axis travel resolution', units: 'step/mm', desc: 'Y-axis travel resolution in steps per millimeter.', min: 1, max: 10000 },
    '$102': { name: 'Z-axis travel resolution', units: 'step/mm', desc: 'Z-axis travel resolution in steps per millimeter.', min: 1, max: 10000 },
    '$110': { name: 'X-axis maximum rate', units: 'mm/min', desc: 'X-axis maximum rate. Used as G0 rapid rate.', min: 1, max: 100000 },
    '$111': { name: 'Y-axis maximum rate', units: 'mm/min', desc: 'Y-axis maximum rate. Used as G0 rapid rate.', min: 1, max: 100000 },
    '$112': { name: 'Z-axis maximum rate', units: 'mm/min', desc: 'Z-axis maximum rate. Used as G0 rapid rate.', min: 1, max: 100000 },
    '$120': { name: 'X-axis acceleration', units: 'mm/s²', desc: 'X-axis acceleration for motion planning.', min: 1, max: 100000 },
    '$121': { name: 'Y-axis acceleration', units: 'mm/s²', desc: 'Y-axis acceleration for motion planning.', min: 1, max: 100000 },
    '$122': { name: 'Z-axis acceleration', units: 'mm/s²', desc: 'Z-axis acceleration for motion planning.', min: 1, max: 100000 },
    '$130': { name: 'X-axis maximum travel', units: 'mm', desc: 'Maximum X-axis travel distance from homing switch.', min: 1, max: 100000 },
    '$131': { name: 'Y-axis maximum travel', units: 'mm', desc: 'Maximum Y-axis travel distance from homing switch.', min: 1, max: 100000 },
    '$132': { name: 'Z-axis maximum travel', units: 'mm', desc: 'Maximum Z-axis travel distance from homing switch.', min: 1, max: 100000 }
};

// Default laser engraver settings for GRBL 1.1
const LASER_DEFAULTS = {
    '$0': 10,     // Step pulse time (µs)
    '$1': 25,     // Step idle delay (ms) - 25 for laser, 255 keeps on
    '$2': 0,      // Step pulse invert (mask)
    '$3': 0,      // Step direction invert (mask)
    '$4': 0,      // Invert step enable pin
    '$5': 0,      // Invert limit pins
    '$6': 0,      // Invert probe pin
    '$10': 1,     // Status report options (GRBL 1.1: 1=MPos, 2=buffer)
    '$11': 0.010, // Junction deviation (mm)
    '$12': 0.002, // Arc tolerance (mm)
    '$13': 0,     // Report in inches (0=mm)
    '$20': 0,     // Soft limits enable
    '$21': 0,     // Hard limits enable
    '$22': 0,     // Homing cycle enable
    '$23': 0,     // Homing direction invert
    '$24': 25.0,  // Homing locate feed rate
    '$25': 500.0, // Homing search seek rate
    '$26': 250,   // Homing switch debounce delay
    '$27': 1.0,   // Homing switch pull-off distance
    '$30': 1000,  // Maximum spindle speed (S-value for laser PWM)
    '$31': 0,     // Minimum spindle speed
    '$32': 1,     // GRBL 1.1 Laser mode enable (CRITICAL!)
    '$100': 80,   // X-axis steps/mm
    '$101': 80,   // Y-axis steps/mm
    '$102': 80,   // Z-axis steps/mm
    '$110': 2000, // X-axis max rate (mm/min)
    '$111': 2000, // Y-axis max rate (mm/min)
    '$112': 500,  // Z-axis max rate (mm/min)
    '$120': 500,  // X-axis acceleration (mm/s²)
    '$121': 500,  // Y-axis acceleration (mm/s²)
    '$122': 500,  // Z-axis acceleration (mm/s²)
    '$130': 200,  // X-axis max travel (mm)
    '$131': 200,  // Y-axis max travel (mm)
    '$132': 50    // Z-axis max travel (mm)
};

// Connection options (LaserGRBL style)
const CONNECTION_OPTIONS = {
    dtrOnConnect: true,       // Toggle DTR on connect (hardware reset)
    rtsOnConnect: true,       // Toggle RTS on connect (hardware reset)
    softResetOnConnect: true, // Send Ctrl-X on connect
    waitForStartup: 2000,     // Wait time for GRBL startup message (ms)
    connectionTimeout: 5000   // Connection timeout (ms)
};

// GRBL 1.1 Real-time commands (no newline needed)
const REALTIME_COMMANDS = {
    STATUS_REPORT: '?',       // Request status report
    CYCLE_START: '~',         // Resume/Start cycle
    FEED_HOLD: '!',           // Pause/Feed hold
    SOFT_RESET: 0x18,         // Ctrl-X soft reset
    SAFETY_DOOR: 0x84,        // Safety door
    JOG_CANCEL: 0x85,         // Cancel jog
    // Feed overrides
    FEED_OVR_RESET: 0x90,     // Reset to 100%
    FEED_OVR_COARSE_PLUS: 0x91,  // +10%
    FEED_OVR_COARSE_MINUS: 0x92, // -10%
    FEED_OVR_FINE_PLUS: 0x93,    // +1%
    FEED_OVR_FINE_MINUS: 0x94,   // -1%
    // Rapid overrides
    RAPID_OVR_RESET: 0x95,    // Reset to 100%
    RAPID_OVR_MEDIUM: 0x96,   // 50%
    RAPID_OVR_LOW: 0x97,      // 25%
    // Spindle overrides
    SPINDLE_OVR_RESET: 0x99,     // Reset to 100%
    SPINDLE_OVR_COARSE_PLUS: 0x9A,  // +10%
    SPINDLE_OVR_COARSE_MINUS: 0x9B, // -10%
    SPINDLE_OVR_FINE_PLUS: 0x9C,    // +1%
    SPINDLE_OVR_FINE_MINUS: 0x9D,   // -1%
    SPINDLE_STOP: 0x9E,       // Toggle spindle stop
    FLOOD_COOLANT: 0xA0,      // Toggle flood coolant
    MIST_COOLANT: 0xA1        // Toggle mist coolant
};

class GRBLController extends EventEmitter {
    constructor() {
        super();
        this.port = null;
        this.parser = null;
        this.isConnected = false;
        this.portPath = null;
        this.baudRate = DEFAULT_BAUD_RATE;
        this.machineState = MachineState.DISCONNECTED;
        this.machineSubState = null;  // GRBL 1.1 substates (Hold:0, Door:1, etc.)
        this.grblVersion = null;
        this.grblVersionFull = null;
        this.position = { x: 0, y: 0, z: 0 };
        this.workPosition = { x: 0, y: 0, z: 0 };
        this.workCoordinateOffset = { x: 0, y: 0, z: 0 };  // GRBL 1.1 WCO
        this.feedRate = 0;
        this.spindleSpeed = 0;
        this.settings = {};
        this.commandQueue = [];
        this.sentCommands = [];
        this.bufferUsed = 0;
        this.pollInterval = null;
        this.isRunning = false;
        this.totalCommands = 0;
        this.completedCommands = 0;
        this.stopRequested = false;
        this.userRequestedStop = false;  // Track if stop was user-initiated
        this.emergencyStop = false;
        this.alarmActive = false;  // Track alarm state
        this.lastOkTime = Date.now();  // Track last successful response for stall detection
        this.maxPower = 1000;  // $30 value
        this.minPower = 0;     // $31 value

        // GRBL 1.1 specific state
        this.overrides = { feed: 100, rapid: 100, spindle: 100 };
        this.accessories = { spindle: false, flood: false, mist: false };
        this.plannerBuffer = { blocks: 0, bytes: 0 };
        this.lineNumber = 0;
        this.pins = {};

        // Connection options
        this.connectionOptions = { ...CONNECTION_OPTIONS };

        // Connection state tracking
        this.welcomeReceived = false;
        this.connectionStartTime = 0;
        this.failedConnections = 0;

        // Liveness tracking used by the job watchdog
        this.lastRxTime = Date.now();      // any line received from GRBL
        this.lastStatusTime = 0;
        this.statusCount = 0;              // number of status reports parsed
        this.expectingReset = false;       // true while WE are soft-resetting GRBL
    }

    async listPorts() {
        try {
            const { SerialPort } = require('serialport');
            const ports = await SerialPort.list();
            // Filter for common laser engraver USB-serial adapters
            const filtered = ports.filter(p => {
                const mfr = (p.manufacturer || '').toLowerCase();
                const path = (p.path || '').toLowerCase();
                const vid = p.vendorId || '';
                const pid = p.productId || '';

                return (
                    mfr.includes('arduino') ||
                    mfr.includes('ch340') ||
                    mfr.includes('ch341') ||
                    mfr.includes('ftdi') ||
                    mfr.includes('silicon') ||  // Silicon Labs CP210x
                    mfr.includes('prolific') || // PL2303
                    mfr.includes('wch') ||      // WCH chips
                    path.includes('usbserial') ||
                    path.includes('ttyusb') ||
                    path.includes('ttyacm') ||
                    path.includes('com') ||
                    vid === '1A86' ||  // CH340 vendor ID
                    vid === '0403' ||  // FTDI vendor ID
                    vid === '10C4' ||  // Silicon Labs vendor ID
                    vid === '2341'     // Arduino vendor ID
                );
            });

            this.log(`Found ${filtered.length} compatible ports`);
            return filtered;
        } catch (e) {
            console.error('Error listing ports:', e);
            this.emit('error', `Port listing failed: ${e.message}`);
            return [];
        }
    }

    // List ALL serial ports without filtering (useful for Arduino/USB devices not recognized by standard filters)
    async listAllPorts() {
        try {
            const { SerialPort } = require('serialport');
            const ports = await SerialPort.list();
            this.log(`Found ${ports.length} total serial ports (unfiltered)`);
            return ports;
        } catch (e) {
            console.error('Error listing all ports:', e);
            this.emit('error', `Port listing failed: ${e.message}`);
            return [];
        }
    }

    // Creates the underlying serial port. Separate so tests can supply a simulated machine.
    _createPort({ path, baudRate }) {
        const { SerialPort } = require('serialport');
        return new SerialPort({
            path,
            baudRate,
            dataBits: 8,
            parity: 'none',
            stopBits: 1,
            autoOpen: false,
            // Hardware flow control settings (LaserGRBL style)
            rtscts: false,
            xon: false,
            xoff: false,
            xany: false
        });
    }

    _emitError(e) {
        // EventEmitter throws on an unhandled 'error' event; never let that kill a job.
        if (this.listenerCount('error') > 0) this.emit('error', e);
    }

    async connect(portPath, options = {}) {
        if (this.isConnected) await this.disconnect();

        const baudRate = options.baudRate || this.baudRate;
        const dtrOnConnect = options.dtrOnConnect ?? this.connectionOptions.dtrOnConnect;
        const rtsOnConnect = options.rtsOnConnect ?? this.connectionOptions.rtsOnConnect;
        const softResetOnConnect = options.softResetOnConnect ?? this.connectionOptions.softResetOnConnect;
        const waitForStartup = options.waitForStartup ?? this.connectionOptions.waitForStartup;

        this.machineState = MachineState.CONNECTING;
        this.welcomeReceived = false;
        this.connectionStartTime = Date.now();

        return new Promise((resolve, reject) => {
            let settled = false;
            let connectionTimeout = null;
            const settle = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(connectionTimeout);
                fn(value);
            };

            try {
                this.log(`Connecting to ${portPath} @ ${baudRate} baud...`);
                this.log(`Options: DTR=${dtrOnConnect}, RTS=${rtsOnConnect}, SoftReset=${softResetOnConnect}`);

                this.port = this._createPort({ path: portPath, baudRate });
                this.parser = new LineParser();
                this.port.on('data', (chunk) => this.parser.push(chunk));
                this.portPath = portPath;
                this.baudRate = baudRate;

                // Connection timeout
                connectionTimeout = setTimeout(() => {
                    if (!this.welcomeReceived) {
                        this.log('Connection timeout - no GRBL response');
                        this.failedConnections++;
                        this.disconnect();
                        settle(reject, new Error('Connection timeout - GRBL not responding. Check baud rate and connections.'));
                    }
                }, this.connectionOptions.connectionTimeout);

                this.port.open((err) => {
                    if (err) {
                        this.machineState = MachineState.DISCONNECTED;
                        this._emitError(err);
                        settle(reject, err);
                        return;
                    }

                    this.log('Port opened successfully');

                    // Set DTR/RTS for hardware reset (like LaserGRBL)
                    if (dtrOnConnect || rtsOnConnect) {
                        this.log('Performing hardware reset (DTR/RTS toggle)...');
                        this.port.set({
                            dtr: dtrOnConnect,
                            rts: rtsOnConnect
                        }, (err) => {
                            if (err) this.log(`DTR/RTS set warning: ${err.message}`);
                        });
                    }

                    // Clear buffers
                    this.port.flush((err) => {
                        if (err) this.log(`Flush warning: ${err.message}`);
                    });

                    // Send soft reset if enabled (Ctrl-X, 0x18)
                    if (softResetOnConnect) {
                        setTimeout(() => {
                            if (this.port?.isOpen) {
                                this.log('Sending soft reset (Ctrl-X)...');
                                this.port.write(Buffer.from([0x18]));
                            }
                        }, 100);
                    }
                });

                this.parser.on('data', (line) => {
                    this.handleResponse(line);

                    // Check for GRBL welcome message
                    if (!this.welcomeReceived && line.includes('Grbl')) {
                        clearTimeout(connectionTimeout);
                        this.welcomeReceived = true;
                        this.isConnected = true;
                        this.machineState = MachineState.IDLE;
                        this.failedConnections = 0;
                        this.lastRxTime = Date.now();
                        this.emit('connected');
                        this.log(`Connected! GRBL ${this.grblVersion || 'detected'}`);

                        // Start initialization sequence
                        setTimeout(async () => {
                            try {
                                await this.readSettings();
                            } catch (e) {
                                this.log(`Settings read warning: ${e.message}`);
                            }
                            this.startStatusPolling();
                            settle(resolve, true);
                        }, waitForStartup);
                    }
                });

                this.port.on('error', (err) => {
                    this.log(`Port error: ${err.message}`);
                    console.error('SERIAL PORT ERROR:', err);
                    this.isConnected = false;
                    this.machineState = MachineState.DISCONNECTED;
                    this._rejectAllPending(jobError(`Serial port error: ${err.message}`, 'DISCONNECTED'));
                    this._emitError(err);
                    settle(reject, err);
                });

                this.port.on('close', () => {
                    this.log('Port closed');
                    this.isConnected = false;
                    this.machineState = MachineState.DISCONNECTED;
                    this.stopStatusPolling();
                    this._rejectAllPending(jobError('Port disconnected', 'DISCONNECTED'));
                    this.emit('disconnected');
                });

            } catch (e) {
                this.machineState = MachineState.DISCONNECTED;
                settle(reject, e);
            }
        });
    }

    async disconnect() {
        this.stopStatusPolling();
        this.isConnected = false;
        this.machineState = MachineState.DISCONNECTED;
        this.welcomeReceived = false;

        if (this.port?.isOpen) {
            return new Promise(resolve => {
                // Turn off laser before disconnecting
                try {
                    this.port.write('M5\n');
                } catch (e) { }

                setTimeout(() => {
                    this.port.close((err) => {
                        if (err) this.log(`Disconnect warning: ${err.message}`);
                        resolve();
                    });
                }, 100);
            });
        }
    }

    // Get available baud rates
    getBaudRates() {
        return BAUD_RATES;
    }

    // Set connection options
    setConnectionOptions(options) {
        this.connectionOptions = { ...this.connectionOptions, ...options };
    }

    // ========== Command streaming ==========
    // GRBL "character counting" protocol: lines are written while they fit in
    // GRBL's 128 byte RX buffer, and every 'ok' / 'error:N' frees the OLDEST
    // outstanding line. Nothing is ever dropped, skipped or timed out silently:
    // a line either gets 'ok' or its promise rejects and the job is aborted.

    // Strip comments / whitespace. Empty result means "nothing to send".
    _clean(cmd) {
        return String(cmd).replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim();
    }

    // Queue one line. Resolves on 'ok'. timeoutMs=0 disables the timeout (jobs).
    _submit(cmd, timeoutMs = 0) {
        return new Promise((resolve, reject) => {
            const clean = this._clean(cmd);
            if (!clean) return resolve(true);
            const len = clean.length + 1;
            if (len > RX_BUFFER_SAFE) return reject(new Error(`Line too long (${len} bytes): ${clean.slice(0, 30)}...`));

            const c = { cmd: clean, len, resolve, reject, timestamp: Date.now(), expired: false };
            if (timeoutMs > 0) {
                c.timer = setTimeout(() => {
                    c.expired = true;
                    // Not yet written: just drop it. Already written: keep it in
                    // sentCommands so its late 'ok' is still matched to the right line.
                    const qi = this.commandQueue.indexOf(c);
                    if (qi !== -1) this.commandQueue.splice(qi, 1);
                    reject(new Error(`Timeout waiting for GRBL to acknowledge: ${clean.slice(0, 40)}`));
                }, timeoutMs);
                const done = () => clearTimeout(c.timer);
                const res = c.resolve, rej = c.reject;
                c.resolve = (v) => { done(); res(v); };
                c.reject = (e) => { done(); rej(e); };
            }
            this.commandQueue.push(c);
            this._pump();
        });
    }

    _pump() {
        if (!this.port?.isOpen) return;
        while (this.commandQueue.length > 0) {
            const c = this.commandQueue[0];
            if (this.bufferUsed + c.len > RX_BUFFER_SAFE) break;
            this.commandQueue.shift();
            this.bufferUsed += c.len;
            this.sentCommands.push(c);
            this.port.write(c.cmd + '\n');
            this.emit('tx', c.cmd);
        }
    }

    _rejectAllPending(err) {
        const pending = [...this.sentCommands, ...this.commandQueue];
        this.sentCommands = [];
        this.commandQueue = [];
        this.bufferUsed = 0;
        pending.forEach(c => c.reject(err));
        return pending.length;
    }

    // Fire-and-forget line whose 'ok' must still be accounted for (e.g. '$$').
    sendRaw(cmd) {
        if (!this.isConnected) return false;
        this._submit(cmd, 0).catch(() => { });
        return true;
    }

    async send(cmd, timeoutMs = 15000) {
        if (!this.isConnected) throw new Error('Not connected');
        if (this.emergencyStop) throw new Error('Emergency stop active');
        // Interactive commands get a timeout; job lines (runGCode) never do.
        return this._submit(cmd, timeoutMs);
    }

    // Kept for API compatibility
    processQueue() { this._pump(); }

    handleResponse(line) {
        if (!line) return;
        this.lastRxTime = Date.now();
        this.emit('rx', line);

        // Status report <...>
        if (line.startsWith('<') && line.endsWith('>')) {
            this.parseStatus(line);
            return;
        }

        // OK response: always acknowledges the OLDEST outstanding line
        if (line === 'ok') {
            this.lastOkTime = Date.now();
            const cmd = this.sentCommands.shift();
            if (cmd) {
                this.bufferUsed -= cmd.len;
                if (!cmd.expired) {
                    if (this.isRunning) {
                        this.completedCommands++;
                        this.emit('progress', {
                            completed: this.completedCommands,
                            total: this.totalCommands,
                            percent: this.totalCommands > 0
                                ? Math.round((this.completedCommands / this.totalCommands) * 100) : 0
                        });
                    }
                }
                cmd.resolve(true);
            }
            this._pump();
            return;
        }

        // Error response: the line was REJECTED by GRBL. Never skipped silently:
        // the owner of the line gets a rejection (a running job aborts).
        if (line.startsWith('error:')) {
            const errorCode = line.match(/error:(\d+)/)?.[1];
            const errorMsg = this.getErrorMessage(errorCode);
            this.log(`Error: ${line} - ${errorMsg}`);
            this.lastOkTime = Date.now();

            const cmd = this.sentCommands.shift();
            if (cmd) {
                this.bufferUsed -= cmd.len;
                const e = jobError(`${line} - ${errorMsg} (line: ${cmd.cmd.slice(0, 60)})`, 'GRBL_ERROR');
                cmd.reject(e);
            }
            this._emitError(`${line} - ${errorMsg}`);
            this._pump();
            return;
        }

        // GRBL welcome message (version detection)
        if (line.includes('Grbl')) {
            this.grblVersionFull = line;
            const match = line.match(/Grbl\s+(\d+\.\d+[a-z]?)/i);
            if (match) {
                this.grblVersion = match[1];
                this.log(`GRBL Version: ${this.grblVersion}`);
            }
            this.emit('version', this.grblVersion);

            // Banner after a reset: everything GRBL had buffered is gone.
            if (/^Grbl\s/i.test(line) && this.welcomeReceived) {
                this.emit('welcome');
                if (!this.expectingReset && (this.sentCommands.length > 0 || this.isRunning)) {
                    this.log('GRBL reset unexpectedly - failing outstanding commands');
                    this._rejectAllPending(jobError('GRBL reset unexpectedly (power dip or USB glitch)', 'GRBL_RESET'));
                }
            }

            // Check for known vendors (Ortur, Longer, etc.)
            if (line.toLowerCase().includes('ortur')) {
                this.log('Detected Ortur laser');
            } else if (line.toLowerCase().includes('longer')) {
                this.log('Detected Longer laser');
            } else if (line.toLowerCase().includes('neje')) {
                this.log('Detected NEJE laser');
            }
        }

        // Settings response ($N=V)
        if (line.match(/^\$\d+=/)) {
            const m = line.match(/^\$(\d+)=(.+)$/);
            if (m) {
                const key = `$${m[1]}`;
                const value = parseFloat(m[2]);
                this.settings[key] = isNaN(value) ? m[2] : value;

                // Update max/min power from settings
                if (key === '$30') this.maxPower = value;
                if (key === '$31') this.minPower = value;
            }
        }

        // Alarm message
        if (line.startsWith('ALARM:')) {
            const alarmCode = line.match(/ALARM:(\d+)/)?.[1];
            const alarmMsg = this.getAlarmMessage(alarmCode);
            this.machineState = MachineState.ALARM;
            this.alarmActive = true;  // Set alarm flag
            this.log(`ALARM: ${line} - ${alarmMsg}`);
            this.emit('alarm', { code: alarmCode, message: alarmMsg, raw: line });

            // GRBL has halted: whatever it had buffered will never be 'ok'-ed.
            this._rejectAllPending(jobError(`${line} - ${alarmMsg}`, 'ALARM'));
        }

        // Feedback messages [MSG:...]
        if (line.startsWith('[MSG:')) {
            const msg = line.slice(5, -1);
            this.log(`Message: ${msg}`);
            this.emit('message', msg);
        }

        // Settings names [OPT:...] or [VER:...]
        if (line.startsWith('[VER:') || line.startsWith('[OPT:')) {
            this.log(`Info: ${line}`);
        }
    }

    // GRBL Error codes (from LaserGRBL)
    getErrorMessage(code) {
        const errors = {
            '1': 'G-code words consist of a letter and a value. Letter was not found.',
            '2': 'Numeric value format is not valid or missing an expected value.',
            '3': 'Grbl $ system command was not recognized or supported.',
            '4': 'Negative value received for an expected positive value.',
            '5': 'Homing cycle is not enabled via settings.',
            '6': 'Minimum step pulse time must be greater than 3usec.',
            '7': 'EEPROM read failed. Reset and restored to default values.',
            '8': 'Grbl $ command cannot be used unless Grbl is IDLE.',
            '9': 'G-code locked out during alarm or jog state.',
            '10': 'Soft limits cannot be enabled without homing also enabled.',
            '11': 'Max characters per line exceeded. Line was not processed.',
            '12': 'Grbl $ setting value exceeds the maximum step rate supported.',
            '13': 'Safety door detected as opened and door state initiated.',
            '14': 'Build info or startup line exceeds EEPROM line length limit.',
            '15': 'Jog target exceeds machine travel. Command ignored.',
            '16': 'Jog command with no = or contains prohibited g-code.',
            '17': 'Laser mode requires PWM output.',
            '20': 'Unsupported or invalid g-code command found in block.',
            '21': 'More than one g-code command from same modal group found in block.',
            '22': 'Feed rate has not yet been set or is undefined.',
            '23': 'G-code command in block requires an integer value.',
            '24': 'Two G-code commands that both require the use of the XYZ axis words were detected.',
            '25': 'A G-code word was repeated in the block.',
            '26': 'A G-code command implicitly or explicitly requires XYZ axis words in the block.',
            '27': 'N line number value is not within the valid range of 1 - 9,999,999.',
            '28': 'A G-code command was sent, but is missing some required P or L value words.',
            '29': 'Grbl supports six work coordinate systems G54-G59. G59.1, G59.2, and G59.3 are not supported.',
            '30': 'The G53 G-code command requires either a G0 seek or G1 feed motion mode.',
            '31': 'There are unused axis words in the block and G80 motion mode cancel is active.',
            '32': 'A G2 or G3 arc was commanded but there are no XYZ axis words in the selected plane.',
            '33': 'The motion command has an invalid target.',
            '34': 'Arc radius value is invalid.',
            '35': 'A G2 or G3 arc, traced by the radius definition, had a mathematical error.',
            '36': 'A G2 or G3 arc, traced by the offset definition, is missing the IJK offset word.',
            '37': 'There are unused, leftover G-code words that aren\'t used by any command in the block.',
            '38': 'The G43.1 dynamic tool length offset command cannot apply an offset to an axis other than Z.',
            '39': 'Tool number greater than max supported value.'
        };
        return errors[code] || 'Unknown error';
    }

    // GRBL Alarm codes (from LaserGRBL)
    getAlarmMessage(code) {
        const alarms = {
            '1': 'Hard limit triggered. Position lost. Re-home.',
            '2': 'G-code motion target exceeds machine travel.',
            '3': 'Reset while in motion. Position lost. Re-home.',
            '4': 'Probe fail. Probe not in expected state.',
            '5': 'Probe fail. Did not contact workpiece.',
            '6': 'Homing fail. Reset during active cycle.',
            '7': 'Homing fail. Door opened during cycle.',
            '8': 'Homing fail. Cycle failed to clear switch.',
            '9': 'Homing fail. Could not find limit switch.'
        };
        return alarms[code] || 'Unknown alarm';
    }

    parseStatus(report) {
        const content = report.slice(1, -1);

        // GRBL 0.9 (common on Arduino Uno + CNC shield) reports comma separated:
        //   <Idle,MPos:0.000,0.000,0.000,WPos:0.000,0.000,0.000>
        // GRBL 1.1 uses pipes: <Idle|MPos:0.000,0.000,0.000|FS:0,0>
        if (!content.includes('|')) {
            this.machineState = content.split(',')[0].split(':')[0];
            this.machineSubState = null;
            const triple = (tag) => {
                const m = content.match(new RegExp(`${tag}:(-?[\\d.]+),(-?[\\d.]+),(-?[\\d.]+)`));
                return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) } : null;
            };
            this.position = triple('MPos') || this.position;
            this.workPosition = triple('WPos') || this.workPosition;
            this.statusCount++;
            this.lastStatusTime = Date.now();
            this.emit('status', {
                state: this.machineState,
                subState: null,
                position: this.position,
                workPosition: this.workPosition,
                workCoordinateOffset: this.workCoordinateOffset,
                feedRate: this.feedRate,
                spindleSpeed: this.spindleSpeed,
                overrides: this.overrides,
                accessories: this.accessories,
                plannerBuffer: this.plannerBuffer,
                pins: this.pins
            });
            return;
        }

        const parts = content.split('|');

        // GRBL 1.1 status can have substates like "Hold:0", "Door:1"
        const stateParts = parts[0].split(':');
        this.machineState = stateParts[0];
        this.machineSubState = stateParts[1] || null;

        for (const part of parts.slice(1)) {
            if (part.startsWith('MPos:')) {
                const coords = part.slice(5).split(',');
                this.position = { x: parseFloat(coords[0]) || 0, y: parseFloat(coords[1]) || 0, z: parseFloat(coords[2]) || 0 };
            }
            if (part.startsWith('WPos:')) {
                const coords = part.slice(5).split(',');
                this.workPosition = { x: parseFloat(coords[0]) || 0, y: parseFloat(coords[1]) || 0, z: parseFloat(coords[2]) || 0 };
            }
            // GRBL 1.1: Work Coordinate Offset
            if (part.startsWith('WCO:')) {
                const coords = part.slice(4).split(',');
                this.workCoordinateOffset = { x: parseFloat(coords[0]) || 0, y: parseFloat(coords[1]) || 0, z: parseFloat(coords[2]) || 0 };
            }
            // GRBL 1.1: Feed and Speed
            if (part.startsWith('FS:')) {
                const vals = part.slice(3).split(',');
                this.feedRate = parseFloat(vals[0]) || 0;
                this.spindleSpeed = parseFloat(vals[1]) || 0;
            }
            // GRBL 1.1: Feed only (when spindle off)
            if (part.startsWith('F:')) {
                this.feedRate = parseFloat(part.slice(2)) || 0;
            }
            // GRBL 1.1: Overrides (feed, rapid, spindle)
            if (part.startsWith('Ov:')) {
                const vals = part.slice(3).split(',');
                this.overrides = {
                    feed: parseInt(vals[0]) || 100,
                    rapid: parseInt(vals[1]) || 100,
                    spindle: parseInt(vals[2]) || 100
                };
            }
            // GRBL 1.1: Accessory state
            if (part.startsWith('A:')) {
                const accessories = part.slice(2);
                this.accessories = {
                    spindle: accessories.includes('S'),
                    flood: accessories.includes('F'),
                    mist: accessories.includes('M')
                };
            }
            // GRBL 1.1: Buffer state (Bf:blocks,bytes)
            if (part.startsWith('Bf:')) {
                const vals = part.slice(3).split(',');
                this.plannerBuffer = {
                    blocks: parseInt(vals[0]) || 0,
                    bytes: parseInt(vals[1]) || 0
                };
            }
            // GRBL 1.1: Line number (Ln:)
            if (part.startsWith('Ln:')) {
                this.lineNumber = parseInt(part.slice(3)) || 0;
            }
            // GRBL 1.1: Pins state (Pn:)
            if (part.startsWith('Pn:')) {
                const pins = part.slice(3);
                this.pins = {
                    limitX: pins.includes('X'),
                    limitY: pins.includes('Y'),
                    limitZ: pins.includes('Z'),
                    probe: pins.includes('P'),
                    door: pins.includes('D'),
                    hold: pins.includes('H'),
                    softReset: pins.includes('R'),
                    cycleStart: pins.includes('S')
                };
            }
        }
        this.statusCount++;
        this.lastStatusTime = Date.now();
        this.emit('status', {
            state: this.machineState,
            subState: this.machineSubState,
            position: this.position,
            workPosition: this.workPosition,
            workCoordinateOffset: this.workCoordinateOffset,
            feedRate: this.feedRate,
            spindleSpeed: this.spindleSpeed,
            overrides: this.overrides,
            accessories: this.accessories,
            plannerBuffer: this.plannerBuffer,
            pins: this.pins
        });
    }


    startStatusPolling() {
        if (this.pollInterval) return;
        this.pollInterval = setInterval(() => { if (this.isConnected && this.port?.isOpen) this.port.write('?'); }, STATUS_POLL_INTERVAL);
    }

    stopStatusPolling() {
        if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
    }

    async readSettings() {
        return new Promise((resolve) => {
            this.settings = {};
            const timeout = setTimeout(() => { this.parser.off('data', onData); resolve(this.settings); }, 2000);
            const onData = (line) => {
                if (line === 'ok') { clearTimeout(timeout); this.parser.off('data', onData); this.emit('settings', this.settings); resolve(this.settings); }
            };
            this.parser.on('data', onData);
            this.sendRaw('$$');
        });
    }

    async writeSetting(key, value) {
        await this.send(`${key}=${value}`);
        this.settings[key] = value;
    }

    async applyDefaults() {
        for (const [k, v] of Object.entries(LASER_DEFAULTS)) {
            // Older GRBL (0.9) doesn't have every setting (e.g. $32): skip those, keep going.
            try { await this.writeSetting(k, v); } catch (e) { this.log(`Skipped ${k}: ${e.message}`); }
            await this.delay(50);
        }
        this.emit('settings', this.settings);
    }

    async enableLaserMode() { await this.writeSetting('$32', 1); this.log('Laser mode enabled'); }
    isLaserModeEnabled() { return this.settings['$32'] === 1; }

    // GRBL 1.1 always supports true jogging with $J= command
    supportsTrueJogging() {
        // GRBL 1.1 target - always use $J= command
        return true;
    }

    async home() { await this.send('G10 L20 P1 X0 Y0 Z0'); this.position = { x: 0, y: 0, z: 0 }; this.log('Home set'); }
    async goHome() { await this.send('G90'); await this.send('G0 X0 Y0'); }

    // GRBL 1.1 homing cycle ($H)
    async homeAll() {
        if (this.settings['$22'] !== 1) {
            this.log('Warning: Homing not enabled ($22=0). Enable with $22=1');
        }
        await this.send('$H', 180000);
        this.log('Homing cycle started');
    }

    async moveTo(x, y, feed = 1000) {
        await this.send('G90');
        await this.send(`G0 X${x.toFixed(2)} Y${y.toFixed(2)} F${feed}`);
    }

    // Jogging - supports both GRBL 0.9 (G91/G0) and GRBL 1.1 ($J=)
    async jog(axis, distance, feed = 500) {
        const dist = parseFloat(distance);
        if (isNaN(dist)) {
            this.log('Jog error: invalid distance');
            return;
        }

        // Check GRBL version - use $J= for 1.1+, G91/G0 for 0.9
        const useJogCommand = this.supportsJogCommand();

        if (useJogCommand) {
            // GRBL 1.1 jog command format: $J=G91X1.000F500 (no spaces)
            const cmd = `$J=G91${axis}${dist.toFixed(3)}F${feed}`;
            this.log(`Jog (1.1): ${cmd}`);
            await this.send(cmd);
        } else {
            // GRBL 0.9 fallback: use G91 relative mode + G0 rapid move
            this.log(`Jog (0.9): G91 ${axis}${dist.toFixed(3)}`);
            await this.send('G91');  // Relative mode
            await this.send(`G0 ${axis}${dist.toFixed(3)} F${feed}`);
            await this.send('G90');  // Back to absolute mode
        }
    }

    // Check if GRBL supports $J= jog command (1.1+)
    supportsJogCommand() {
        if (!this.grblVersion) return false;  // Assume 0.9 if unknown
        const match = this.grblVersion.match(/(\d+)\.(\d+)/);
        if (match) {
            const major = parseInt(match[1]);
            const minor = parseInt(match[2]);
            return major > 1 || (major === 1 && minor >= 1);
        }
        return false;
    }

    // GRBL 1.1 jog cancel (real-time command 0x85)
    jogCancel() {
        if (this.isConnected && this.port?.isOpen) {
            this.port.write(Buffer.from([REALTIME_COMMANDS.JOG_CANCEL]));
            this.log('Jog cancelled');
        }
    }

    async laserOn(power = 100) {
        if (this.machineState === MachineState.ALARM) {
            throw new Error('Machine in alarm state - click Unlock first');
        }
        const clampedPower = Math.max(this.minPower, Math.min(power, this.maxPower));
        // M3 = constant laser power, M4 = dynamic (varies with speed)
        await this.send(`M3 S${clampedPower}`);
    }
    async laserOff() { await this.send('M5 S0'); }

    // Laser test fire (brief pulse)
    async laserTest(power = 50, duration = 100) {
        // Check if in alarm state
        if (this.machineState === MachineState.ALARM) {
            this.log('Cannot test laser in alarm state - unlock first');
            throw new Error('Machine in alarm state - click Unlock first');
        }
        const clampedPower = Math.max(this.minPower, Math.min(power, this.maxPower));
        this.log(`Laser test: S${clampedPower} for ${duration}ms`);
        // Use M3 for constant laser mode (M4 is dynamic and may not fire without motion)
        await this.send(`M3 S${clampedPower}`);
        await this.delay(duration);
        await this.send('M5 S0');
        this.log('Laser test complete');
    }

    // Focus laser (low power continuous for focusing)
    async laserFocus(power = 10) {
        if (this.machineState === MachineState.ALARM) {
            this.log('Cannot focus laser in alarm state - unlock first');
            throw new Error('Machine in alarm state - click Unlock first');
        }
        const clampedPower = Math.max(this.minPower, Math.min(power, this.maxPower));
        this.log(`Laser focus: S${clampedPower}`);
        // Use M3 for constant laser output
        await this.send(`M3 S${clampedPower}`);
    }

    async doEmergencyStop() {
        this.emergencyStop = true;
        this.stopRequested = true;
        this._rejectAllPending(jobError('E-Stop', 'ESTOP'));
        this.stopStatusPolling();
        if (this.port?.isOpen) { this.port.write('M5\n'); this.port.write(Buffer.from([0x18])); }
        this.machineState = MachineState.ALARM;
        this.emit('estop');
        this.log('EMERGENCY STOP');
    }

    async resetEstop() {
        this.emergencyStop = false;
        this.stopRequested = false;
        this.userRequestedStop = false;
        this.alarmActive = false;  // Clear alarm flag
        if (this.port?.isOpen) { this.port.write(Buffer.from([0x18])); await this.delay(500); await this.send('$X'); }
        this.startStatusPolling();
        this.log('Reset complete');
    }

    // Ask GRBL for a fresh status report (real-time command, not buffered)
    _requestStatus() {
        if (this.port?.isOpen) this.port.write('?');
    }

    // Wait for the next status report newer than `since` (statusCount); false on timeout.
    async _waitStatus(since, timeoutMs) {
        const t0 = Date.now();
        while (this.statusCount <= since) {
            if (Date.now() - t0 > timeoutMs) return false;
            if (!this.port?.isOpen) return false;
            await this.delay(20);
        }
        return true;
    }

    /**
     * Bring the machine to a known-safe state after a failed/stopped job:
     * feed hold (so position is kept), soft reset (laser off, buffers flushed),
     * wait for GRBL's banner. Never throws.
     */
    async _abortMotion() {
        this._rejectAllPending(jobError('Job aborted', 'ABORTED'));
        if (this.emergencyStop || !this.port?.isOpen) return;

        this.expectingReset = true;
        try {
            this.port.write('!');                    // feed hold: stops motion, keeps position
            const t0 = Date.now();
            while (Date.now() - t0 < 2500) {
                const c = this.statusCount;
                this._requestStatus();
                if (!(await this._waitStatus(c, 300))) continue;
                if ([MachineState.HOLD, MachineState.IDLE, MachineState.ALARM].includes(this.machineState)) break;
            }

            const welcome = new Promise(r => this.once('welcome', r));
            this.port.write(Buffer.from([REALTIME_COMMANDS.SOFT_RESET]));  // laser off, planner flushed
            await Promise.race([welcome, this.delay(3000)]);
            this._rejectAllPending(jobError('Job aborted', 'ABORTED'));

            // Make sure the status reflects the post-reset machine
            const c = this.statusCount;
            this._requestStatus();
            await this._waitStatus(c, 1000);
            if (this.machineState === MachineState.ALARM) this.alarmActive = true;
        } catch (e) {
            this.log(`Abort sequence warning: ${e.message}`);
        } finally {
            this.expectingReset = false;
        }
    }

    /**
     * Stream a G-code program and resolve ONLY when the machine has finished
     * executing it (state Idle, nothing outstanding). Rejects on the first
     * problem (GRBL error, alarm, lost 'ok', disconnect, stop, e-stop) after
     * putting the machine in a safe state - it never skips a line and never
     * reports success for a partly engraved job.
     */
    async runGCode(gcode) {
        if (this.isRunning) throw new Error('Another job is already running');
        if (this.emergencyStop) throw new Error('E-Stop active');
        if (this.alarmActive) throw new Error('Alarm active - please unlock first ($X)');
        if (!this.isConnected) throw new Error('Not connected - please connect first');

        const lines = String(gcode).split('\n').map(l => this._clean(l)).filter(Boolean);
        if (lines.length === 0) throw new Error('G-code is empty');

        this.totalCommands = lines.length;
        this.completedCommands = 0;
        this.isRunning = true;
        this.stopRequested = false;
        this.userRequestedStop = false;
        this.lastOkTime = Date.now();
        this.lastRxTime = Date.now();
        const startedAt = Date.now();
        this.emit('start', { total: this.totalCommands });
        this.log(`Starting G-code execution: ${lines.length} commands`);

        let failure = null;
        let pending = 0;
        const fail = (e) => { if (!failure) failure = e instanceof Error ? e : new Error(String(e)); };
        const interrupted = () => {
            if (failure) return true;
            if (this.emergencyStop) fail(jobError('Emergency stop', 'ESTOP'));
            else if (this.userRequestedStop) fail(jobError('Stopped by operator', 'STOPPED'));
            else if (!this.isConnected || !this.port?.isOpen) fail(jobError('Connection lost during engraving', 'DISCONNECTED'));
            else if (this.machineState === MachineState.ALARM) fail(jobError('Machine went into ALARM', 'ALARM'));
            else if (Date.now() - startedAt > JOB_MAX_MS) fail(jobError('Job exceeded maximum run time', 'TIMEOUT'));
            return !!failure;
        };

        const watchdog = setInterval(() => {
            const now = Date.now();
            if (now - this.lastRxTime > NO_DATA_TIMEOUT_MS) {
                fail(jobError(`No data from GRBL for ${Math.round(NO_DATA_TIMEOUT_MS / 1000)}s (check cable / power)`, 'STALL'));
            } else if (this.sentCommands.length > 0 && this.machineState === MachineState.IDLE
                && now - this.lastOkTime > IDLE_STALL_MS) {
                // GRBL has nothing left to do yet we never got an 'ok' for what we sent:
                // a response was lost. We can't know whether the line ran, so abort cleanly.
                fail(jobError(`GRBL is idle but did not acknowledge "${this.sentCommands[0].cmd.slice(0, 40)}"`, 'STALL'));
            }
        }, 500);

        try {
            // 1. stream every line, in order, with back-pressure
            for (let i = 0; i < lines.length; i++) {
                if (interrupted()) break;
                while (this.commandQueue.length >= STREAM_QUEUE_DEPTH) {
                    if (interrupted()) break;
                    await this.delay(2);
                }
                if (interrupted()) break;
                pending++;
                this._submit(lines[i], 0).then(() => { pending--; }, (e) => { pending--; fail(e); });
                if (i > 0 && i % 200 === 0) this.log(`Progress: ${i}/${lines.length} commands sent`);
            }

            // 2. every line must be acknowledged
            while (!interrupted() && pending > 0) await this.delay(5);

            // 3. ... and the machine must actually have finished moving
            let idleReports = 0;
            while (!interrupted() && idleReports < 2) {
                const c = this.statusCount;
                this._requestStatus();
                if (await this._waitStatus(c, 400)) {
                    idleReports = this.machineState === MachineState.IDLE ? idleReports + 1 : 0;
                }
                await this.delay(50);
            }
        } finally {
            clearInterval(watchdog);
        }

        if (failure) {
            this.log(`G-code execution FAILED: ${failure.message}`);
            await this._abortMotion();
            this.isRunning = false;
            this.userRequestedStop = false;
            this.totalCommands = 0;
            this._emitError(failure.message);
            this.emit('job-failed', { message: failure.message, code: failure.code });
            throw failure;
        }

        this.isRunning = false;
        this.totalCommands = 0;
        const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
        this.log(`All ${lines.length} commands completed successfully in ${seconds}s`);
        this.emit('complete');
        return { lines: lines.length, seconds };
    }

    // Stop the running job right now (feed hold immediately; runGCode then resets safely).
    stop() {
        this.stopRequested = true;
        this.userRequestedStop = true;
        if (this.isRunning && this.port?.isOpen) this.port.write('!');
        this.log('Stop requested by user');
    }
    delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    log(msg) { this.emit('log', msg); console.log('[GRBL 1.1]', msg); }

    getState() {
        return {
            connected: this.isConnected,
            state: this.machineState,
            subState: this.machineSubState,
            position: this.position,
            workPosition: this.workPosition,
            workCoordinateOffset: this.workCoordinateOffset,
            settings: this.settings,
            version: this.grblVersion,
            versionFull: this.grblVersionFull,
            laserMode: this.isLaserModeEnabled(),
            maxPower: this.maxPower,
            minPower: this.minPower,
            baudRate: this.baudRate,
            portPath: this.portPath,
            overrides: this.overrides,
            accessories: this.accessories,
            plannerBuffer: this.plannerBuffer,
            pins: this.pins
        };
    }

    // ========== GRBL 1.1 Real-time Commands ==========
    // These bypass the command queue and execute immediately

    feedHold() {
        if (this.port?.isOpen) {
            this.port.write(REALTIME_COMMANDS.FEED_HOLD);
            this.log('Feed hold sent');
        }
    }

    cycleStart() {
        if (this.port?.isOpen) {
            this.port.write(REALTIME_COMMANDS.CYCLE_START);
            this.log('Cycle start sent');
        }
    }

    softReset() {
        if (this.port?.isOpen) {
            this.port.write(Buffer.from([REALTIME_COMMANDS.SOFT_RESET]));
            this.log('Soft reset (Ctrl-X) sent');
        }
    }

    safetyDoor() {
        if (this.port?.isOpen) {
            this.port.write(Buffer.from([REALTIME_COMMANDS.SAFETY_DOOR]));
            this.log('Safety door command sent');
        }
    }

    // ========== GRBL 1.1 Feed Override Commands ==========
    feedOverrideReset() {
        if (this.port?.isOpen) {
            this.port.write(Buffer.from([REALTIME_COMMANDS.FEED_OVR_RESET]));
            this.log('Feed override reset to 100%');
        }
    }

    feedOverrideIncrease(fine = false) {
        if (this.port?.isOpen) {
            const cmd = fine ? REALTIME_COMMANDS.FEED_OVR_FINE_PLUS : REALTIME_COMMANDS.FEED_OVR_COARSE_PLUS;
            this.port.write(Buffer.from([cmd]));
            this.log(`Feed override +${fine ? '1' : '10'}%`);
        }
    }

    feedOverrideDecrease(fine = false) {
        if (this.port?.isOpen) {
            const cmd = fine ? REALTIME_COMMANDS.FEED_OVR_FINE_MINUS : REALTIME_COMMANDS.FEED_OVR_COARSE_MINUS;
            this.port.write(Buffer.from([cmd]));
            this.log(`Feed override -${fine ? '1' : '10'}%`);
        }
    }

    // ========== GRBL 1.1 Rapid Override Commands ==========
    rapidOverrideReset() {
        if (this.port?.isOpen) {
            this.port.write(Buffer.from([REALTIME_COMMANDS.RAPID_OVR_RESET]));
            this.log('Rapid override reset to 100%');
        }
    }

    rapidOverride50() {
        if (this.port?.isOpen) {
            this.port.write(Buffer.from([REALTIME_COMMANDS.RAPID_OVR_MEDIUM]));
            this.log('Rapid override set to 50%');
        }
    }

    rapidOverride25() {
        if (this.port?.isOpen) {
            this.port.write(Buffer.from([REALTIME_COMMANDS.RAPID_OVR_LOW]));
            this.log('Rapid override set to 25%');
        }
    }

    // ========== GRBL 1.1 Spindle/Laser Override Commands ==========
    spindleOverrideReset() {
        if (this.port?.isOpen) {
            this.port.write(Buffer.from([REALTIME_COMMANDS.SPINDLE_OVR_RESET]));
            this.log('Spindle/Laser override reset to 100%');
        }
    }

    spindleOverrideIncrease(fine = false) {
        if (this.port?.isOpen) {
            const cmd = fine ? REALTIME_COMMANDS.SPINDLE_OVR_FINE_PLUS : REALTIME_COMMANDS.SPINDLE_OVR_COARSE_PLUS;
            this.port.write(Buffer.from([cmd]));
            this.log(`Spindle/Laser override +${fine ? '1' : '10'}%`);
        }
    }

    spindleOverrideDecrease(fine = false) {
        if (this.port?.isOpen) {
            const cmd = fine ? REALTIME_COMMANDS.SPINDLE_OVR_FINE_MINUS : REALTIME_COMMANDS.SPINDLE_OVR_COARSE_MINUS;
            this.port.write(Buffer.from([cmd]));
            this.log(`Spindle/Laser override -${fine ? '1' : '10'}%`);
        }
    }

    spindleStop() {
        if (this.port?.isOpen) {
            this.port.write(Buffer.from([REALTIME_COMMANDS.SPINDLE_STOP]));
            this.log('Spindle stop toggled');
        }
    }

    // ========== GRBL 1.1 Coolant Commands ==========
    toggleFloodCoolant() {
        if (this.port?.isOpen) {
            this.port.write(Buffer.from([REALTIME_COMMANDS.FLOOD_COOLANT]));
            this.log('Flood coolant toggled');
        }
    }

    toggleMistCoolant() {
        if (this.port?.isOpen) {
            this.port.write(Buffer.from([REALTIME_COMMANDS.MIST_COOLANT]));
            this.log('Mist coolant toggled');
        }
    }

    // Legacy override methods for compatibility
    setFeedOverride(percent) {
        if (!this.port?.isOpen) return;
        if (percent === 100) this.feedOverrideReset();
        else if (percent > 100) this.feedOverrideIncrease();
        else if (percent < 100) this.feedOverrideDecrease();
    }

    setSpindleOverride(percent) {
        if (!this.port?.isOpen) return;
        if (percent === 100) this.spindleOverrideReset();
        else if (percent > 100) this.spindleOverrideIncrease();
        else if (percent < 100) this.spindleOverrideDecrease();
    }

    // Unlock alarm state ($X)
    async unlock() {
        this.log('Unlocking alarm state...');
        this.alarmActive = false;  // Clear alarm flag
        await this.send('$X');
    }

    // Check mode - GRBL 1.1 dry run ($C)
    async toggleCheckMode() {
        await this.send('$C');
        this.log('Check mode toggled');
    }

    // Sleep mode - GRBL 1.1 ($SLP)
    async sleep() {
        await this.send('$SLP');
        this.log('Sleep mode activated');
    }

    // Get build info
    async getBuildInfo() {
        return new Promise((resolve) => {
            const buildInfo = [];
            const timeout = setTimeout(() => { this.parser.off('data', onData); resolve(buildInfo.join('\n')); }, 1000);
            const onData = (line) => {
                if (line.startsWith('[') && !line.startsWith('[MSG:')) {
                    buildInfo.push(line);
                }
                if (line === 'ok') {
                    clearTimeout(timeout);
                    this.parser.off('data', onData);
                    resolve(buildInfo.join('\n'));
                }
            };
            this.parser.on('data', onData);
            this.sendRaw('$I');
        });
    }

    // Get parser state
    async getParserState() {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => { this.parser.off('data', onData); resolve(null); }, 1000);
            const onData = (line) => {
                if (line.startsWith('[GC:')) {
                    clearTimeout(timeout);
                    this.parser.off('data', onData);
                    const state = line.slice(4, -1);
                    resolve(state);
                }
            };
            this.parser.on('data', onData);
            this.sendRaw('$G');
        });
    }

    // GRBL 1.1 startup blocks
    async getStartupBlocks() {
        return new Promise((resolve) => {
            const blocks = [];
            const timeout = setTimeout(() => { this.parser.off('data', onData); resolve(blocks); }, 1000);
            const onData = (line) => {
                if (line.startsWith('$N')) {
                    blocks.push(line);
                }
                if (line === 'ok') {
                    clearTimeout(timeout);
                    this.parser.off('data', onData);
                    resolve(blocks);
                }
            };
            this.parser.on('data', onData);
            this.sendRaw('$N');
        });
    }

    // Set startup block (0 or 1)
    async setStartupBlock(index, gcode) {
        await this.send(`$N${index}=${gcode}`);
        this.log(`Startup block ${index} set to: ${gcode}`);
    }
}

module.exports = {
    GRBLController,
    MachineState,
    GRBL_SETTINGS,
    LASER_DEFAULTS,
    BAUD_RATES,
    CONNECTION_OPTIONS,
    REALTIME_COMMANDS,
    GRBL_VERSION
};
