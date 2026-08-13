#!/usr/bin/env python3
"""vision_lib.py -- core computer-vision library for GENGRAV workpiece alignment.

Two-stage design, chosen deliberately over per-workpiece markers:

  1. CALIBRATION (occasional, not per-job): four ArUco markers glued at KNOWN
     machine (mm) coordinates on the bed itself define a homography H that
     maps camera pixel coordinates -> machine mm coordinates. This absorbs
     lens distortion, camera tilt and mounting offset in one step, without a
     full intrinsic camera calibration (chessboard) -- the bed is planar, so
     a 2D homography from >=4 point correspondences is the exact, correct
     model (not an approximation).

  2. ALIGNMENT (every job): with H already known, the workpiece itself is
     located by plain contour detection (no marker needed on every blank) --
     grayscale -> Otsu threshold -> largest suitable contour -> minAreaRect.
     Its center and rotation, mapped through H into mm, are compared to the
     NOMINAL placement the G-code was authored for, giving an
     {dx_mm, dy_mm, theta_deg} correction.

The two stages are independent and independently testable (see
test_alignment.py), which is what makes this safe to reason about: a bad
alignment reading cannot silently come from a stale/bad calibration without
the calibration step itself having been re-verified.
"""
import json
import math
import os

import cv2
import numpy as np

ARUCO_DICT = cv2.aruco.DICT_4X4_50

DEFAULT_CALIBRATION_PATH = os.path.join(os.path.dirname(__file__), "calibration.json")
DEFAULT_BED_MARKERS_PATH = os.path.join(os.path.dirname(__file__), "bed_markers.json")


class VisionError(Exception):
    pass


# --------------------------------------------------------------------------
# Stage 1: calibration (camera pixels -> machine mm)
# --------------------------------------------------------------------------
def detect_aruco_markers(image):
    """Returns {marker_id: (cx, cy)} pixel centers for every detected marker."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    dictionary = cv2.aruco.getPredefinedDictionary(ARUCO_DICT)
    params = cv2.aruco.DetectorParameters()
    detector = cv2.aruco.ArucoDetector(dictionary, params)
    corners, ids, _ = detector.detectMarkers(gray)
    out = {}
    if ids is None:
        return out
    for i, marker_id in enumerate(ids.flatten()):
        c = corners[i][0]                       # 4x2 corner points
        cx, cy = float(c[:, 0].mean()), float(c[:, 1].mean())
        out[int(marker_id)] = (cx, cy)
    return out


def load_bed_markers(path=DEFAULT_BED_MARKERS_PATH):
    """Known machine-mm position of each fixed bed marker: {id: [x_mm, y_mm]}."""
    with open(path) as f:
        data = json.load(f)
    return {int(k): tuple(v) for k, v in data["markers"].items()}


def compute_homography(pixel_points, machine_points):
    """4+ point correspondences -> 3x3 homography (camera px -> machine mm).

    Uses cv2.findHomography (DLT + RANSAC) rather than a hand-rolled solve so
    that >4 markers over-determine and average out detection noise instead of
    just satisfying 4 points exactly.
    """
    if len(pixel_points) < 4:
        raise VisionError(
            "need >=4 marker correspondences for a homography, found %d" % len(pixel_points))
    src = np.array(pixel_points, dtype=np.float64)
    dst = np.array(machine_points, dtype=np.float64)
    H, mask = cv2.findHomography(src, dst, method=0)   # exact DLT; RANSAC needs >=4 with outliers
    if H is None:
        raise VisionError("homography solve failed (degenerate marker layout?)")
    return H


def calibrate_from_image(image, bed_markers_path=DEFAULT_BED_MARKERS_PATH):
    """Full calibration pass: detect markers in `image`, match against the
    known bed layout, solve the homography. Returns (H, report_dict)."""
    bed_markers = load_bed_markers(bed_markers_path)
    detected = detect_aruco_markers(image)

    matched_ids = sorted(set(bed_markers) & set(detected))
    if len(matched_ids) < 4:
        raise VisionError(
            "only found %d/%d expected bed markers (ids seen: %s) -- check lighting, "
            "focus, and that all 4 calibration markers are unobstructed"
            % (len(matched_ids), len(bed_markers), sorted(detected)))

    pixel_pts = [detected[i] for i in matched_ids]
    machine_pts = [bed_markers[i] for i in matched_ids]
    H = compute_homography(pixel_pts, machine_pts)

    # Self-check: re-project each marker through H and measure residual error
    # in mm. This is the single most important sanity number in the whole
    # pipeline -- it is the only way to know if the calibration is actually
    # good before trusting any alignment reading built on top of it.
    residuals = []
    for px, mm in zip(pixel_pts, machine_pts):
        proj = apply_homography(H, [px])[0]
        residuals.append(math.hypot(proj[0] - mm[0], proj[1] - mm[1]))

    return H, {
        "markers_used": matched_ids,
        "markers_expected": sorted(bed_markers),
        "reprojection_error_mm": {"max": max(residuals), "mean": sum(residuals) / len(residuals)},
    }


def apply_homography(H, pixel_points):
    """Map a list of (px, py) camera points to (x_mm, y_mm) machine points."""
    pts = np.array([[p] for p in pixel_points], dtype=np.float64)
    mapped = cv2.perspectiveTransform(pts, H)
    return [(float(m[0][0]), float(m[0][1])) for m in mapped]


def save_calibration(H, report, path=DEFAULT_CALIBRATION_PATH):
    payload = {"homography": H.tolist(), "report": report}
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
    return path


def load_calibration(path=DEFAULT_CALIBRATION_PATH):
    if not os.path.exists(path):
        raise VisionError(
            "no calibration found at %s -- run calibrate.py first (camera alignment "
            "requires calibration before it can be used)" % path)
    with open(path) as f:
        data = json.load(f)
    return np.array(data["homography"], dtype=np.float64), data.get("report", {})


# --------------------------------------------------------------------------
# Stage 2: workpiece detection (contour -> position + rotation)
# --------------------------------------------------------------------------
def detect_workpiece_rect(image, min_area_px=800, exclude_px=None, exclude_radius_px=0.0):
    """Locate the workpiece as the largest sane contour in the bed image
    that is NOT one of the (known, excluded) calibration-marker blobs.

    exclude_px: pixel centers of the bed's fixed ArUco markers -- without
    this, a marker (a high-contrast square easily bigger than min_area_px)
    is itself a very plausible-looking "largest contour" and will be
    misdetected as the workpiece on an otherwise-empty bed. Contours are
    walked largest-first and the first one both big enough AND outside every
    exclusion zone wins.

    Returns (center_px, size_px, angle_deg, box_points_px) using
    cv2.minAreaRect, or raises VisionError if nothing plausible is found.
    angle_deg here is in the CAMERA's pixel frame -- see
    compute_alignment_offset, which re-derives the machine-frame rotation
    from the homography-mapped corners rather than trusting this value
    directly, because the camera is not generally axis-aligned with the
    machine.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    # Otsu threshold: robust to the two lighting regimes this bed sees
    # (bright even work light vs. dimmer ambient) without hand-tuning a
    # fixed threshold per install.
    _, thresh = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        raise VisionError("no contours found -- check camera focus/exposure and that a "
                           "workpiece is actually on the bed")

    exclude_px = exclude_px or []
    checked = 0
    for c in sorted(contours, key=cv2.contourArea, reverse=True):
        area = cv2.contourArea(c)
        if area < min_area_px:
            break  # sorted descending -- nothing smaller can pass either
        checked += 1
        m = cv2.moments(c)
        if m["m00"] == 0:
            continue
        ccx, ccy = m["m10"] / m["m00"], m["m01"] / m["m00"]
        if any(math.hypot(ccx - ex, ccy - ey) < exclude_radius_px for ex, ey in exclude_px):
            continue   # this is a calibration marker, not the workpiece
        rect = cv2.minAreaRect(c)                  # ((cx,cy), (w,h), angle)
        (cx, cy), (w, h), angle = rect
        box = cv2.boxPoints(rect)
        return (cx, cy), (w, h), float(angle), box

    raise VisionError(
        "no workpiece-sized contour found outside the calibration-marker regions "
        "(%d candidate contour(s) >= %d px^2 checked, all excluded or none big enough) "
        "-- check that a workpiece is actually on the bed" % (checked, min_area_px))


def rect_angle_from_corners_mm(corners_mm):
    """Rotation (deg, normalized to (-45, 45]) of a rectangle from its 4
    corners ALREADY MAPPED into machine-mm space (order as cv2.boxPoints
    returns: sequential around the rectangle).

    Deliberately computed in mm-space, not pixel-space: cv2.minAreaRect's
    angle describes the rectangle as the CAMERA sees it, which is only the
    same as the machine-frame rotation if the camera happens to be mounted
    perfectly axis-aligned with the machine gantry. A hand-mounted webcam
    essentially never is, and the homography already encodes exactly that
    camera-to-machine rotation -- so re-deriving the angle from the
    homography-mapped corners is what makes this correct for a tilted
    camera instead of only for a perfectly square one.
    """
    pts = np.array(corners_mm, dtype=np.float64)
    lengths, angles = [], []
    for i in range(4):
        edge = pts[(i + 1) % 4] - pts[i]
        lengths.append(float(np.hypot(*edge)))
        angles.append(math.degrees(math.atan2(edge[1], edge[0])))
    # opposite edges (0&2, 1&3) are parallel on a real rectangle; use the
    # longer pair as the reference axis, same reasoning as the old
    # pixel-space normalize_angle but now on the true machine geometry.
    angle = angles[0] if (lengths[0] + lengths[2]) >= (lengths[1] + lengths[3]) else angles[1]
    while angle > 45.0:
        angle -= 90.0
    while angle <= -45.0:
        angle += 90.0
    return angle


def compute_alignment_offset(image, nominal_mm, bed_markers_path=DEFAULT_BED_MARKERS_PATH,
                              calibration_path=DEFAULT_CALIBRATION_PATH):
    """Full alignment pass against an already-saved calibration.

    nominal_mm: {"x": .., "y": .., "theta_deg": ..} -- the placement the
    G-code was authored assuming (usually theta=0, x/y = bed center or the
    machine's programmed job origin).

    Returns a dict with dx_mm, dy_mm, theta_deg (all: actual - nominal, i.e.
    the correction to ADD to the G-code), plus the raw detected pose and a
    confidence figure so a caller can refuse to trust a marginal reading.
    """
    H, calib_report = load_calibration(calibration_path)
    bed_markers = load_bed_markers(bed_markers_path)
    return compute_alignment_offset_from_homography(image, nominal_mm, H, calib_report, bed_markers)


def compute_alignment_offset_from_homography(image, nominal_mm, H, calib_report, bed_markers):
    """Core alignment computation given an ALREADY-LOADED homography,
    calibration report and bed-marker layout, rather than file paths.

    Factored out of compute_alignment_offset() specifically so a caller that
    stores calibration somewhere other than a local calibration.json file
    (e.g. the phone-facing backend, which persists it in Postgres so a
    calibration done from one phone photo can be reused by later phone or
    desktop alignment reads -- see mobile_backend/main.py) can reuse this
    exact detection/math path instead of a parallel reimplementation that
    could silently drift from it. compute_alignment_offset() above is now
    just this function plus the two file loads.
    """
    H_inv = np.linalg.inv(H)

    # Exclude the known bed-marker regions from workpiece contour search --
    # otherwise a marker itself (a big, high-contrast blob) can be
    # misdetected as the workpiece. Radius estimated from marker spacing so
    # it scales with this bed's actual px-per-mm rather than a hardcoded
    # pixel count.
    marker_mm_pts = list(bed_markers.values())
    marker_px_pts = apply_homography(H_inv, marker_mm_pts)
    ref = math.hypot(marker_mm_pts[1][0] - marker_mm_pts[0][0], marker_mm_pts[1][1] - marker_mm_pts[0][1])
    ref_px = math.hypot(marker_px_pts[1][0] - marker_px_pts[0][0], marker_px_pts[1][1] - marker_px_pts[0][1])
    px_per_mm = ref_px / max(1e-6, ref)
    exclude_radius_px = px_per_mm * 20.0   # generous: ~20mm footprint around each marker

    (cx_px, cy_px), (w_px, h_px), angle_raw, box_px = detect_workpiece_rect(
        image, exclude_px=marker_px_pts, exclude_radius_px=exclude_radius_px)

    center_mm = apply_homography(H, [(cx_px, cy_px)])[0]
    box_mm = apply_homography(H, [tuple(p) for p in box_px])

    # Rotation is derived from the homography-MAPPED corners (machine-mm
    # space), not the raw pixel-space angle -- see rect_angle_from_corners_mm
    # for why: a tilted camera makes those two different.
    angle_deg = rect_angle_from_corners_mm(box_mm)

    dx_mm = center_mm[0] - nominal_mm["x"]
    dy_mm = center_mm[1] - nominal_mm["y"]
    dtheta_deg = angle_deg - nominal_mm.get("theta_deg", 0.0)

    # Confidence: penalize a poor calibration reprojection, and -- more
    # importantly -- penalize the DETECTED orientation being close to the
    # +-45 deg wrap boundary of rect_angle_from_corners_mm. Near that
    # boundary, "44 deg" and "-46 deg" describe the same physical rectangle
    # equally well, so the reading is genuinely ambiguous regardless of how
    # clean the image is; this is checked on angle_deg (the raw detected
    # orientation), not dtheta_deg, because the ambiguity is a property of
    # the detection itself, not of how far it is from the nominal.
    calib_mm_err = calib_report.get("reprojection_error_mm", {}).get("max", 0.0)
    angle_margin_deg = 45.0 - abs(angle_deg)
    confidence = 1.0
    if calib_mm_err > 1.0:
        confidence -= 0.3
    if angle_margin_deg < 5.0:
        confidence -= 0.6
    elif angle_margin_deg < 10.0:
        confidence -= 0.3
    confidence = max(0.0, min(1.0, confidence))

    return {
        "dx_mm": round(dx_mm, 3),
        "dy_mm": round(dy_mm, 3),
        "theta_deg": round(dtheta_deg, 3),
        "detected": {
            "center_mm": [round(center_mm[0], 3), round(center_mm[1], 3)],
            "angle_deg": round(angle_deg, 3),
            "size_px": [round(w_px, 1), round(h_px, 1)],
        },
        "calibration_reprojection_error_mm": calib_mm_err,
        "confidence": round(confidence, 2),
    }
