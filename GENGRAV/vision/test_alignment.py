#!/usr/bin/env python3
"""test_alignment.py -- end-to-end proof of the vision-alignment math.

No physical camera is needed. Instead this SYNTHESIZES bed-camera images
from a known ground-truth camera model (a chosen, deliberately non-trivial
homography: rotation + non-square scale + translation, i.e. a camera that is
not perfectly overhead/square-on, which is the realistic case), renders
ArUco markers and a rotated "workpiece" rectangle into that synthetic view
exactly where the ground-truth model says they should be, feeds the images
through the real calibrate_from_image() / compute_alignment_offset()
functions, and asserts the recovered numbers match the ground truth to
sub-mm / sub-degree tolerance.

This is the same reason plc_handshake_test.py exists for the cobot project:
a repeatable, CI-style proof that the math is right, not a one-off manual
check against a camera on a bench.

Cases
  A. Calibration accuracy   -- recovered homography reprojects the 4 bed
                               markers to within 0.05 mm of their known
                               positions.
  B. Workpiece detection    -- a workpiece at a KNOWN mm position/rotation
                               is recovered to within 0.5 mm / 0.5 deg.
  C. Zero-offset case       -- a workpiece placed exactly at the nominal
                               position/rotation the G-code assumes reports
                               ~0 correction (this is the "everything is
                               already aligned, don't nudge it" case, and is
                               its own failure mode if the math has a sign
                               error anywhere).
  D. Rejection on bad input -- missing markers / no workpiece / low
                               confidence must all fail LOUD (raise / return
                               success:false), never silently return a
                               guess that a caller could apply to real
                               G-code.
"""
import json
import math
import os
import sys
import tempfile

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vision_lib as vl

FAILS = []


def check(cond, name):
    print(("  PASS  " if cond else "  FAIL  ") + name)
    if not cond:
        FAILS.append(name)


def close(a, b, tol):
    return abs(a - b) <= tol


# ---------------------------------------------------------------------------
# Synthetic camera model: machine mm -> camera pixel.
# Deliberately not a simple axis-aligned scale: includes a small rotation and
# non-square (anisotropic) scale, i.e. the camera is mounted slightly
# skewed/tilted-in-projection relative to the bed -- the realistic case a
# hand-mounted webcam bracket actually produces, and exactly the case a
# naive "just scale by px-per-mm" approach would get wrong but a proper
# homography gets right.
# ---------------------------------------------------------------------------
IMG_W, IMG_H = 1400, 1400
_theta = math.radians(1.3)
_sx, _sy = 4.10, 3.95          # px per mm, slightly anisotropic
_ox, _oy = 60.0, 60.0          # pixel offset of machine (0,0)


def mm_to_px(x_mm, y_mm):
    xr = x_mm * math.cos(_theta) - y_mm * math.sin(_theta)
    yr = x_mm * math.sin(_theta) + y_mm * math.cos(_theta)
    return (_ox + xr * _sx, _oy + yr * _sy)


def render_marker(canvas, marker_id, center_px, size_px=90):
    dictionary = cv2.aruco.getPredefinedDictionary(vl.ARUCO_DICT)
    tile = cv2.aruco.generateImageMarker(dictionary, marker_id, size_px)
    tile_bgr = cv2.cvtColor(tile, cv2.COLOR_GRAY2BGR)
    x0 = int(center_px[0] - size_px / 2)
    y0 = int(center_px[1] - size_px / 2)
    canvas[y0:y0 + size_px, x0:x0 + size_px] = tile_bgr
    return canvas


def render_workpiece(canvas, center_mm, size_mm, theta_deg):
    """Paints a filled light rectangle (workpiece on a dark bed) at the given
    machine-mm center/rotation, using the SAME mm_to_px ground-truth camera
    model, so cv2.minAreaRect has a real, known-correct target to recover."""
    w_mm, h_mm = size_mm
    hw, hh = w_mm / 2.0, h_mm / 2.0
    local_corners_mm = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
    t = math.radians(theta_deg)
    pts_px = []
    for lx, ly in local_corners_mm:
        rx = lx * math.cos(t) - ly * math.sin(t)
        ry = lx * math.sin(t) + ly * math.cos(t)
        pts_px.append(mm_to_px(center_mm[0] + rx, center_mm[1] + ry))
    pts_px = np.array(pts_px, dtype=np.int32)
    cv2.fillConvexPoly(canvas, pts_px, (235, 235, 235))
    return canvas


def build_bed_markers_file(tmpdir):
    """Bed markers at the four bed corners (matches vision/bed_markers.json's
    shape), written to a temp file so the test does not depend on / mutate
    the real one shipped in the repo."""
    markers = {"0": [15, 15], "1": [235, 15], "2": [235, 235], "3": [15, 235]}
    path = os.path.join(tmpdir, "bed_markers.json")
    with open(path, "w") as f:
        json.dump({"dictionary": "DICT_4X4_50", "marker_size_mm": 20, "markers": markers}, f)
    return path, {int(k): tuple(v) for k, v in markers.items()}


def synth_scene(bed_markers_mm, workpiece=None):
    canvas = np.full((IMG_H, IMG_W, 3), 60, dtype=np.uint8)   # dim bed background
    for marker_id, (mx, my) in bed_markers_mm.items():
        render_marker(canvas, marker_id, mm_to_px(mx, my))
    if workpiece is not None:
        render_workpiece(canvas, workpiece["center_mm"], workpiece["size_mm"], workpiece["theta_deg"])
    return canvas


def run_tests():
    tmpdir = tempfile.mkdtemp(prefix="vision_align_test_")
    bed_markers_path, bed_markers_mm = build_bed_markers_file(tmpdir)
    calibration_path = os.path.join(tmpdir, "calibration.json")

    # ---- A. calibration accuracy -----------------------------------------
    print("\n== A. calibration accuracy ==")
    calib_img = synth_scene(bed_markers_mm)
    H, report = vl.calibrate_from_image(calib_img, bed_markers_path=bed_markers_path)
    check(len(report["markers_used"]) == 4, "all 4 bed markers detected (%s)" % report["markers_used"])
    check(report["reprojection_error_mm"]["max"] < 0.05,
          "homography reprojection error < 0.05mm (got %.4f)" % report["reprojection_error_mm"]["max"])

    # cross-check: map a point that ISN'T one of the 4 calibration markers
    # and confirm it still lands correctly -- proves this is a real
    # homography, not something that only happens to satisfy the 4 fit
    # points and is wrong everywhere else.
    probe_mm = (120.0, 80.0)
    probe_px = mm_to_px(*probe_mm)
    recovered = vl.apply_homography(H, [probe_px])[0]
    # Tolerance here is deliberately looser than case A's marker-reprojection
    # check: render_marker() places markers at INTEGER pixel coordinates
    # (np array slicing), so the synthetic image itself has up to ~0.5px of
    # quantization baked in -- at ~4 px/mm that is up to ~0.3mm, a rendering
    # artifact of this test, not a defect in compute_homography.
    check(close(recovered[0], probe_mm[0], 0.3) and close(recovered[1], probe_mm[1], 0.3),
          "off-marker probe point recovered within 0.3mm (got dx=%.3f dy=%.3f)"
          % (recovered[0] - probe_mm[0], recovered[1] - probe_mm[1]))

    vl.save_calibration(H, report, path=calibration_path)
    check(os.path.exists(calibration_path), "calibration.json written")
    H2, report2 = vl.load_calibration(calibration_path)
    check(np.allclose(H, H2), "saved calibration round-trips through load_calibration()")

    # ---- B. workpiece detection: known offset + rotation ------------------
    print("\n== B. workpiece detection accuracy ==")
    true_center = (162.0, 91.0)     # mm -- deliberately off the nominal (125,125) below
    true_theta = 7.5                # deg
    scene = synth_scene(bed_markers_mm, workpiece={
        "center_mm": true_center, "size_mm": (60, 40), "theta_deg": true_theta})

    nominal = {"x": 125.0, "y": 125.0, "theta_deg": 0.0}   # bed-center placement, 0 rotation
    result = vl.compute_alignment_offset(scene, nominal, bed_markers_path=bed_markers_path,
                                          calibration_path=calibration_path)

    expected_dx = true_center[0] - nominal["x"]
    expected_dy = true_center[1] - nominal["y"]
    check(close(result["dx_mm"], expected_dx, 0.5),
          "dx_mm within 0.5mm of ground truth (got %.3f, expected %.3f)" % (result["dx_mm"], expected_dx))
    check(close(result["dy_mm"], expected_dy, 0.5),
          "dy_mm within 0.5mm of ground truth (got %.3f, expected %.3f)" % (result["dy_mm"], expected_dy))
    # angle recovered mod 90 (normalize_angle) -- 7.5 deg is unambiguous (far from the +-45 wrap)
    check(close(result["theta_deg"], true_theta, 0.5),
          "theta_deg within 0.5deg of ground truth (got %.3f, expected %.3f)" % (result["theta_deg"], true_theta))
    check(result["confidence"] >= 0.9, "high confidence on a clean synthetic reading (%.2f)" % result["confidence"])

    # ---- C. zero-offset case (sign-error canary) ---------------------------
    print("\n== C. workpiece exactly at nominal -> ~zero correction ==")
    scene_zero = synth_scene(bed_markers_mm, workpiece={
        "center_mm": (125.0, 125.0), "size_mm": (60, 40), "theta_deg": 0.0})
    result_zero = vl.compute_alignment_offset(scene_zero, nominal, bed_markers_path=bed_markers_path,
                                               calibration_path=calibration_path)
    check(abs(result_zero["dx_mm"]) < 0.3, "dx_mm ~0 when workpiece is already at nominal (%.3f)" % result_zero["dx_mm"])
    check(abs(result_zero["dy_mm"]) < 0.3, "dy_mm ~0 when workpiece is already at nominal (%.3f)" % result_zero["dy_mm"])
    check(abs(result_zero["theta_deg"]) < 0.3, "theta_deg ~0 when workpiece is already at nominal (%.3f)" % result_zero["theta_deg"])

    # ---- D. rejection on bad input -----------------------------------------
    print("\n== D. rejects bad input instead of guessing ==")
    blank = np.full((IMG_H, IMG_W, 3), 60, dtype=np.uint8)
    try:
        vl.calibrate_from_image(blank, bed_markers_path=bed_markers_path)
        check(False, "calibration raises VisionError when no markers are visible")
    except vl.VisionError:
        check(True, "calibration raises VisionError when no markers are visible")

    # only 2 of 4 markers visible -> must refuse (homography needs 4)
    partial_markers = {0: bed_markers_mm[0], 1: bed_markers_mm[1]}
    partial_scene = synth_scene(partial_markers)
    try:
        vl.calibrate_from_image(partial_scene, bed_markers_path=bed_markers_path)
        check(False, "calibration raises VisionError with only 2/4 markers visible")
    except vl.VisionError:
        check(True, "calibration raises VisionError with only 2/4 markers visible")

    # markers present, but no workpiece on the bed -> detection must refuse
    no_workpiece_scene = synth_scene(bed_markers_mm)
    try:
        vl.compute_alignment_offset(no_workpiece_scene, nominal, bed_markers_path=bed_markers_path,
                                     calibration_path=calibration_path)
        check(False, "alignment raises VisionError when no workpiece is on the bed")
    except vl.VisionError:
        check(True, "alignment raises VisionError when no workpiece is on the bed")

    # align.py's CLI-level confidence gate: a near-45deg rotation is genuine
    # geometric ambiguity (normalize_angle wraps at +-45) -- confirm the
    # library still returns a reading (rectangle math itself is fine) but
    # flags reduced confidence, and that align.py's own MIN_CONFIDENCE gate
    # (tested via the module import, not a subprocess) would reject it.
    edge_scene = synth_scene(bed_markers_mm, workpiece={
        "center_mm": (125.0, 125.0), "size_mm": (60, 40), "theta_deg": 44.0})
    edge_nominal = {"x": 125.0, "y": 125.0, "theta_deg": 0.0}
    edge_result = vl.compute_alignment_offset(edge_scene, edge_nominal, bed_markers_path=bed_markers_path,
                                               calibration_path=calibration_path)
    import align as align_module
    check(edge_result["confidence"] < align_module.MIN_CONFIDENCE,
          "near-45deg rotation drops confidence (%.2f) below align.py's MIN_CONFIDENCE (%.2f) -- "
          "CLI would refuse to hand this to a job" % (edge_result["confidence"], align_module.MIN_CONFIDENCE))


def main():
    run_tests()
    print()
    if FAILS:
        print("VISION ALIGNMENT TEST: %d FAILURES:" % len(FAILS))
        for f in FAILS:
            print("  - " + f)
        sys.exit(1)
    print("VISION ALIGNMENT TEST OK -- calibration, detection, zero-offset and rejection cases all verified")
    sys.exit(0)


if __name__ == "__main__":
    main()
