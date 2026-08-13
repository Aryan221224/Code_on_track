# Vision Alignment — camera-based workpiece placement correction

Adds a camera to the laser bed so the machine can see where a workpiece
actually is, instead of assuming it was placed exactly where the operator
was told to put it. Closes the gap where a blank set down 2mm off and 3
degrees rotated silently engraves 2mm off and 3 degrees rotated.

## 1. Hardware choice

**A UVC USB webcam with a manual-focus (or fixed-focus) lens, mounted
overhead on a rigid bracket above the bed.** Concretely, something in the
**ELP AR0234 / ELP-USBFHD** family (~$30-50) — 1080p+, CS-mount lens so
focus can be locked once at install time, and standard UVC so it needs no
proprietary driver on Windows, Linux, or macOS. Any UVC webcam works; the
one property that actually matters is **manual/lockable focus**, not
resolution or brand.

Why this, over the alternatives:

- **Not an ESP32-CAM or other embedded camera board.** All the actual image
  processing has to happen somewhere with real compute, and that's already
  the same PC running this Electron app — adding a second embedded
  platform with its own firmware and Wi-Fi link would add a whole new
  failure surface for zero benefit, since the frames end up back on the PC
  either way.
- **Not a Raspberry Pi + camera module.** Same reasoning: it would just be
  a second computer relaying frames to the one that's already here.
- **Not an autofocus webcam left on autofocus.** Autofocus hunts —
  especially over a mostly-flat, mostly-uniform bed with poor contrast to
  focus on — and can silently refocus mid-job. Machine-vision setups
  consistently recommend manual/locked focus for exactly this reason; a
  camera that refocuses between calibration and alignment invalidates the
  homography computed in calibration (see below).
- **USB over wireless.** No latency, no dropped-frame surprises, one less
  thing to debug.

Mount it as high and as centered over the bed as the enclosure allows, aim
straight down, and tape or glue the focus ring once you have it sharp at
bed height — do not touch it again after calibrating.

## 2. How it works

Two independent stages, run in this order:

### Stage 1 — Calibration (occasional, not per job)

Four ArUco markers (from the standard `DICT_4X4_50` dictionary — printable,
free, no special hardware) are fixed at **known machine-mm positions** on
the bed itself, e.g. glued 15mm in from each corner. `vision/calibrate.py`
captures a frame, detects all four, and solves a **homography** — a 3×3
matrix mapping camera-pixel coordinates to machine-mm coordinates. This is
the mathematically correct model for a camera looking at a flat plane (the
bed), and it absorbs lens distortion, camera tilt, and mounting offset all
in one step, without needing a separate chessboard intrinsic-calibration
pass.

Re-run this whenever the camera is unmounted, remounted, refocused, or
bumped. It self-checks and reports its own reprojection error in mm — see
`vision/vision_lib.py`'s `calibrate_from_image()`.

Edit `vision/bed_markers.json` to match where you actually stick the four
markers on your bed (the shipped values assume a 250×250mm bed with markers
15mm in from each corner, per `MACHINE_CALIBRATION_GUIDE.md` — adjust for
your machine).

### Stage 2 — Alignment (every job)

With calibration already done, `vision/align.py` captures a frame of the
bed **with the workpiece on it**, finds the workpiece by plain contour
detection (no marker needed on every blank — only the 4 fixed bed markers
from stage 1 are permanent), and maps its center and rotation through the
homography into machine-mm space. That's compared against the **nominal**
placement the G-code was authored assuming, producing a
`{dx_mm, dy_mm, theta_deg}` correction.

The correction is then applied to the G-code text itself —
`shared/gcode-transform.js` rewrites every `G0`/`G1` line's `X`/`Y`
coordinates by that rotation+translation — right before it's sent to GRBL.

### Why the rotation math looks the way it does

A webcam mounted by hand on a laser cutter enclosure is essentially never
perfectly axis-aligned with the machine's X/Y gantry. `vision_lib.py`
deliberately computes the workpiece's rotation from its **homography-mapped
corners in machine-mm space**, not from OpenCV's raw pixel-space
`minAreaRect` angle — the two are only the same number if the camera
happens to be mounted perfectly square, which `test_alignment.py`'s
synthetic camera model (a small deliberate tilt) is specifically there to
catch if that assumption is ever reintroduced by mistake.

## 3. Known limitations

- **Contour detection assumes reasonable contrast** between the workpiece
  and the bed surface. A workpiece the same shade as the bed under flat
  lighting will not be found reliably — this is a real, current limitation,
  not a hypothetical one.
- **G2/G3 arc moves are not transformed.** `gcode-transform.js` only
  rewrites `G0`/`G1` X/Y coordinates; an arc's `I`/`J` center-offset
  arguments are left untouched. This repo's generators (`gcode-generator.js`
  and the inline generator in `renderer.js`) only emit `G0`/`G1` today, so
  this is a documented gap for future arc support, not a silent one.
- **Rotation near ±45° is genuinely ambiguous**, not just hard — a square
  workpiece rotated 44° looks identical to one rotated -46°. The library
  detects this itself and drops its own confidence score below the
  threshold `align.py` requires to hand a reading to a job (see
  `MIN_CONFIDENCE` in `vision/align.py`), rather than guessing.
- **This is alignment, not verification.** It corrects for placement error;
  it does not check that the correct workpiece, material, or size is on the
  bed.

## 4. Why a Python subprocess, not a native Node module

`main.js` shells out to `vision/calibrate.py` / `vision/align.py` via
`child_process.execFile` rather than using a native OpenCV binding for
Node (e.g. `opencv4nodejs`) in-process. That binding is native-compiled,
version-fragile against Electron/Node ABI changes, and notoriously painful
to install and keep working across platforms — a real cost for a feature
this narrow in scope. `opencv-python` is a stable, actively maintained,
pip-installable package with none of that fragility, and the JSON-over-
stdout contract between the two processes (see the docstrings in
`calibrate.py` / `align.py`) is a small, easy-to-test interface either side
can be independently verified against.

## 5. Setup

```bash
# Python side (one-time)
pip install -r vision/requirements.txt

# Print 4 ArUco markers (DICT_4X4_50, ids 0-3) and stick them at the
# positions listed in vision/bed_markers.json -- adjust that file first if
# your bed size or marker placement differs from the default.

# Calibrate (after mounting/focusing the camera, before first use, and
# again any time the camera moves)
python3 vision/calibrate.py

# Test a single alignment reading from the command line
python3 vision/align.py
```

From the app: **Calibrate Camera** once per camera mount, then
**Align Workpiece** before each job, then check **Apply alignment to next
job** before clicking **Start Engraving**.

## 6. Phone camera as an alternative capture device

The fixed USB webcam (§1) is the primary path, but the same `vision_lib.py`
core also runs behind a phone-facing HTTP API in `mobile_backend/` (the
existing FastAPI backend for the `SIH_app/flutter_sih_app` inspection app,
already deployed on Render — see `BACKEND_CONFIG.md`), so a phone can be
used instead when there's no USB camera mounted, or as a second/mobile
option for spot-checking placement.

**Why this is possible with no new CV logic**: `vision_lib.py`'s functions
operate on a plain image array, regardless of what produced it. The only
difference between the desktop path and the phone path is capture device
and transport — `cv2.VideoCapture` + a local file for calibration state, vs.
a phone photo posted as base64 + calibration stored in Postgres (Render has
no persistent local disk, unlike the desktop). Both call the same
`calibrate_from_image()` / `compute_alignment_offset_from_homography()`.

**Why a phone can't just run the whole feature itself**: it has no serial
port to drive GRBL. So the flow is deliberately a read-and-relay:

```
 Phone (SIH_app)                Backend (mobile_backend, Render)         Desktop (engraving-app)
 ─────────────────              ─────────────────────────────            ───────────────────────
 Vision Alignment page   ──►    POST /api/vision/calibrate         (once per camera position)
   "Calibrate Camera"           → vision_lib.calibrate_from_image()
                                 → homography saved in Postgres
                                 (vision_calibrations table)

 Vision Alignment page   ──►    POST /api/vision/align              (per job)
   "Align Workpiece"            → loads saved homography
                                 → vision_lib.compute_alignment_offset_
                                   from_homography()
                                 → reading saved in Postgres
                                 (vision_alignments table)
                                                                ◄──  GET /api/vision/latest-alignment
                                                                     "Use Phone Reading" button
                                                                     → becomes lastAlignment, same
                                                                       shape as a USB-camera read
                                                                     → grbl:runGCodeAligned applies it
```

New backend endpoints (`mobile_backend/main.py`):

| Endpoint | Purpose |
|---|---|
| `POST /api/vision/calibrate` | `{image_base64, machine_id}` → same report shape as `calibrate.py`, persisted per `machine_id` |
| `POST /api/vision/align` | `{image_base64, machine_id, item_uid?, nominal_x?, nominal_y?, nominal_theta?}` → same result shape as `align.py`; always records the attempt, only reports `success:true` above the confidence floor |
| `GET /api/vision/latest-alignment` | `?machine_id=&max_age_seconds=` → what the desktop app polls; `max_age_seconds` (default 300) stops a stale reading from an earlier workpiece being picked up by accident |

`machine_id` defaults to `"default"` everywhere (phone, backend, desktop's
`GENGRAV_MACHINE_ID` env var) — set it explicitly on all three if more than
one machine ever shares this backend, since calibration and readings are
partitioned by it.

New Flutter pieces (`SIH_app/flutter_sih_app`): `lib/services/
vision_alignment_service.dart` (mirrors the existing
`defect_classification_service.dart` pattern) and `lib/pages/
vision_alignment_page.dart`, reachable from a "Vision Alignment" button on
the home screen. Uses `image_picker` (already a dependency) at 1920px/90%
quality — higher than this app's other camera captures, because marker/edge
sub-pixel accuracy costs real precision at lower resolution in a way that
doesn't matter for the app's existing defect-classification photos.

**Trade-off to know**: the phone path has meaningfully worse geometric
consistency than the fixed webcam — a hand-held phone's angle/height varies
shot to shot in a way a bolted-down bracket's does not, so its calibration
should be treated as approximate and re-done more often. Use the USB webcam
for production runs; treat the phone as a convenient fallback or for
spot-checks, not a full replacement.

**Deployment note**: `opencv-contrib-python-headless` was added to
`mobile_backend/requirements.txt`. It's a real dependency to build on
Render (larger wheel than this backend's existing deps) — worth confirming
the deploy succeeds within your plan's build-time/size limits before
relying on this in production.

## 7. Verification

```bash
python3 vision/test_alignment.py     # calibration + detection math, synthetic images, no camera needed
node test-gcode-transform.js         # G-code coordinate transform, no camera/machine needed
```

Both are self-contained and run in CI or on a laptop with no camera or GRBL
hardware attached — they synthesize known ground-truth scenes/G-code and
assert the recovered numbers match, the same reasoning
`plc_handshake_test.py` uses in the `erobo10_motion` cobot project: a
repeatable, automated proof beats a one-off manual check on a bench.

Two real defects were found and fixed by writing `test_alignment.py`,
both in `vision_lib.py`: the rotation angle was being read directly from
the camera's pixel frame instead of the machine frame (wrong whenever the
camera isn't perfectly axis-aligned with the gantry — see §2 above), and
workpiece detection could mistake a calibration marker itself for the
workpiece when the bed was otherwise empty.
