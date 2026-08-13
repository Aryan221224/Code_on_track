#!/usr/bin/env python3
"""test_vision_endpoints.py -- proof that the phone-camera vision endpoints
work end-to-end, WITHOUT ever touching the real production Supabase
database.

Safety: main.py reads DATABASE_URL via os.getenv() with a hardcoded
Postgres fallback -- so DATABASE_URL is forced to an in-memory SQLite DB
in this process's environment BEFORE main.py is imported. main.py's own
`Base.metadata.create_all(bind=engine, ...)` then creates all tables
(users/items/inspections/vision_calibrations/vision_alignments) in that
throwaway SQLite DB instead. If this override were ever missing, every
query in this test would go to a completely different database engine
object anyway (FastAPI's TestClient talks to the imported `app`, which is
permanently bound to whatever `engine`/`SessionLocal` main.py built at
import time) -- there is no code path in this test that can reach the real
database.

Reuses the same synthetic-scene generation as vision/test_alignment.py
(camera-tilt ground truth model + rendered ArUco markers + a rotated
"workpiece" rectangle), re-derived here rather than imported, since
mobile_backend/ and GENGRAV/vision/ are not set up as a shared package.
"""
import base64
import io
import json
import math
import os
import sys
import tempfile

# A file-backed SQLite DB, not ":memory:" -- SQLAlchemy's connection pool
# opens a fresh connection per checkout, and a ":memory:" SQLite database is
# private to the single connection that created it, so main.py's own
# create_all() (run at import time) would create tables on a connection
# that is discarded before any test request's own connection can see them.
# A temp file behaves like a real DB across connections without touching
# anything real, and is removed at the end of this run.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = "sqlite:///" + _tmp_db.name

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vision_lib as vl  # noqa: E402  (needs to be importable before main.py imports it)

from fastapi.testclient import TestClient  # noqa: E402
import main as backend  # noqa: E402  -- imports with DATABASE_URL already overridden above

FAILS = []


def check(cond, name):
    print(("  PASS  " if cond else "  FAIL  ") + name)
    if not cond:
        FAILS.append(name)


# ---- synthetic scene generation (same ground-truth model as vision/test_alignment.py) ----
IMG_W, IMG_H = 1400, 1400
_theta = math.radians(1.3)
_sx, _sy = 4.10, 3.95
_ox, _oy = 60.0, 60.0


def mm_to_px(x_mm, y_mm):
    xr = x_mm * math.cos(_theta) - y_mm * math.sin(_theta)
    yr = x_mm * math.sin(_theta) + y_mm * math.cos(_theta)
    return (_ox + xr * _sx, _oy + yr * _sy)


def render_marker(canvas, marker_id, center_px, size_px=90):
    dictionary = cv2.aruco.getPredefinedDictionary(vl.ARUCO_DICT)
    tile = cv2.aruco.generateImageMarker(dictionary, marker_id, size_px)
    tile_bgr = cv2.cvtColor(tile, cv2.COLOR_GRAY2BGR)
    x0, y0 = int(center_px[0] - size_px / 2), int(center_px[1] - size_px / 2)
    canvas[y0:y0 + size_px, x0:x0 + size_px] = tile_bgr


def render_workpiece(canvas, center_mm, size_mm, theta_deg):
    w_mm, h_mm = size_mm
    hw, hh = w_mm / 2.0, h_mm / 2.0
    t = math.radians(theta_deg)
    pts_px = []
    for lx, ly in [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]:
        rx = lx * math.cos(t) - ly * math.sin(t)
        ry = lx * math.sin(t) + ly * math.cos(t)
        pts_px.append(mm_to_px(center_mm[0] + rx, center_mm[1] + ry))
    cv2.fillConvexPoly(canvas, np.array(pts_px, dtype=np.int32), (235, 235, 235))


BED_MARKERS_MM = {0: (15, 15), 1: (235, 15), 2: (235, 235), 3: (15, 235)}


def synth_scene_b64(workpiece=None):
    canvas = np.full((IMG_H, IMG_W, 3), 60, dtype=np.uint8)
    for marker_id, (mx, my) in BED_MARKERS_MM.items():
        render_marker(canvas, marker_id, mm_to_px(mx, my))
    if workpiece is not None:
        render_workpiece(canvas, workpiece["center_mm"], workpiece["size_mm"], workpiece["theta_deg"])
    # BGR (OpenCV) -> RGB (PIL) -> PNG -> base64, matching exactly what the
    # Flutter app sends: a photo file read as bytes and base64-encoded.
    rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def main():
    client = TestClient(backend.app)
    check(backend.VISION_AVAILABLE, "vision_lib imported successfully into the backend process")

    print("\n== A. calibrate endpoint ==")
    calib_img_b64 = synth_scene_b64()
    r = client.post("/api/vision/calibrate", json={"image_base64": calib_img_b64, "machine_id": "test-machine"})
    check(r.status_code == 200, "POST /api/vision/calibrate returns 200 (got %d)" % r.status_code)
    body = r.json()
    check(body["success"], "calibration reports success (%s)" % body.get("error"))
    check(body["reprojection_error_mm"]["max"] < 0.05,
          "reprojection error < 0.05mm (got %.4f)" % body["reprojection_error_mm"]["max"])

    print("\n== B. align endpoint before any calibration for a DIFFERENT machine_id ==")
    r = client.post("/api/vision/align", json={
        "image_base64": synth_scene_b64(workpiece={"center_mm": (150, 150), "size_mm": (60, 40), "theta_deg": 0}),
        "machine_id": "never-calibrated-machine",
    })
    check(r.status_code == 200, "align on an uncalibrated machine still returns 200, not a crash")
    check(r.json()["success"] is False, "align refuses (success:false) with no calibration for that machine_id")

    print("\n== C. align endpoint against the calibration from A ==")
    true_center = (162.0, 91.0)
    true_theta = 7.5
    align_img_b64 = synth_scene_b64(workpiece={"center_mm": true_center, "size_mm": (60, 40), "theta_deg": true_theta})
    r = client.post("/api/vision/align", json={
        "image_base64": align_img_b64, "machine_id": "test-machine",
        "nominal_x": 125.0, "nominal_y": 125.0, "nominal_theta": 0.0,
        "item_uid": "EC-TEST-0001",
    })
    check(r.status_code == 200, "POST /api/vision/align returns 200 (got %d)" % r.status_code)
    body = r.json()
    check(body["success"], "alignment reports success (%s)" % body.get("error"))
    exp_dx, exp_dy = true_center[0] - 125.0, true_center[1] - 125.0
    check(abs(body["dx_mm"] - exp_dx) < 0.5, "dx_mm matches ground truth (got %.3f expected %.3f)" % (body["dx_mm"], exp_dx))
    check(abs(body["dy_mm"] - exp_dy) < 0.5, "dy_mm matches ground truth (got %.3f expected %.3f)" % (body["dy_mm"], exp_dy))
    check(abs(body["theta_deg"] - true_theta) < 0.5, "theta_deg matches ground truth (got %.3f expected %.3f)" % (body["theta_deg"], true_theta))

    print("\n== D. latest-alignment polling endpoint (desktop app's side) ==")
    r = client.get("/api/vision/latest-alignment", params={"machine_id": "test-machine"})
    check(r.status_code == 200, "GET /api/vision/latest-alignment returns 200")
    body = r.json()
    check(body["available"] is True, "a reading is available for test-machine")
    check(abs(body["dx_mm"] - exp_dx) < 0.5, "polled dx_mm matches the reading just submitted")
    check(body["item_uid"] == "EC-TEST-0001", "item_uid round-trips through the DB (%s)" % body.get("item_uid"))

    r = client.get("/api/vision/latest-alignment", params={"machine_id": "some-other-machine"})
    check(r.json()["available"] is False, "a machine_id with no readings correctly reports unavailable")

    r = client.get("/api/vision/latest-alignment", params={"machine_id": "test-machine", "max_age_seconds": 0})
    check(r.json()["available"] is False and r.json().get("reason") == "stale",
          "max_age_seconds=0 correctly treats even a just-submitted reading as stale")

    print("\n== E. low-confidence reading is refused, not silently handed back ==")
    edge_img_b64 = synth_scene_b64(workpiece={"center_mm": (125, 125), "size_mm": (60, 40), "theta_deg": 44.0})
    r = client.post("/api/vision/align", json={
        "image_base64": edge_img_b64, "machine_id": "test-machine",
        "nominal_x": 125.0, "nominal_y": 125.0, "nominal_theta": 0.0,
    })
    check(r.status_code == 200, "near-45deg reading still returns 200 (not a server error)")
    check(r.json()["success"] is False, "near-45deg reading is refused (success:false), matching desktop CLI behavior")


if __name__ == "__main__":
    try:
        main()
    finally:
        try:
            os.unlink(_tmp_db.name)
        except OSError:
            pass
    print()
    if FAILS:
        print("VISION ENDPOINT TEST: %d FAILURES:" % len(FAILS))
        for f in FAILS:
            print("  - " + f)
        sys.exit(1)
    print("VISION ENDPOINT TEST OK -- calibrate, align, latest-alignment polling and confidence "
          "gating all verified against a throwaway test database (never the real production DB)")
    sys.exit(0)
