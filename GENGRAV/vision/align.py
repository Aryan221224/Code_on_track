#!/usr/bin/env python3
"""align.py -- per-job workpiece alignment reading.

Captures a frame of the bed with the workpiece placed on it, detects the
workpiece against the already-saved camera<->bed calibration, and prints the
{dx_mm, dy_mm, theta_deg} correction needed to align the G-code (which was
authored assuming the "nominal" placement) to where the piece actually is.

Usage
  python3 vision/align.py                         # nominal = bed center, 0 deg
  python3 vision/align.py --nominal-x 75 --nominal-y 75
  python3 vision/align.py --image path.jpg         # offline / testing

Always prints a single JSON object to stdout (see calibrate.py for the same
contract). A non-zero exit code means the offset MUST NOT be trusted/applied
-- this is deliberate: a caller (main.js) should never apply a partially-
failed reading to a real G-code job.
"""
import argparse
import json
import sys

import cv2

from vision_lib import compute_alignment_offset, VisionError, DEFAULT_BED_MARKERS_PATH, DEFAULT_CALIBRATION_PATH

MIN_CONFIDENCE = 0.5   # below this, refuse the reading rather than guess


def capture_frame(camera_index):
    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        raise VisionError("could not open camera index %d" % camera_index)
    try:
        frame = None
        for _ in range(10):
            ok, frame = cap.read()
            if not ok:
                raise VisionError("camera opened but did not return a frame")
        return frame
    finally:
        cap.release()


def main():
    ap = argparse.ArgumentParser(description="Read the workpiece alignment offset")
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--image", type=str, default=None, help="use a still image instead of a live camera")
    ap.add_argument("--bed-markers", type=str, default=DEFAULT_BED_MARKERS_PATH)
    ap.add_argument("--calibration", type=str, default=DEFAULT_CALIBRATION_PATH)
    ap.add_argument("--nominal-x", type=float, default=None,
                     help="mm X the G-code assumes the workpiece center is at (default: bed center from bed_markers.json)")
    ap.add_argument("--nominal-y", type=float, default=None)
    ap.add_argument("--nominal-theta", type=float, default=0.0)
    ap.add_argument("--min-confidence", type=float, default=MIN_CONFIDENCE)
    args = ap.parse_args()

    try:
        if args.nominal_x is None or args.nominal_y is None:
            with open(args.bed_markers) as f:
                markers = json.load(f)["markers"].values()
            xs = [m[0] for m in markers]; ys = [m[1] for m in markers]
            nominal = {"x": args.nominal_x if args.nominal_x is not None else (min(xs) + max(xs)) / 2,
                       "y": args.nominal_y if args.nominal_y is not None else (min(ys) + max(ys)) / 2,
                       "theta_deg": args.nominal_theta}
        else:
            nominal = {"x": args.nominal_x, "y": args.nominal_y, "theta_deg": args.nominal_theta}

        if args.image:
            frame = cv2.imread(args.image)
            if frame is None:
                raise VisionError("could not read image: %s" % args.image)
        else:
            print("capturing from camera %d..." % args.camera, file=sys.stderr)
            frame = capture_frame(args.camera)

        result = compute_alignment_offset(frame, nominal, bed_markers_path=args.bed_markers,
                                           calibration_path=args.calibration)
        result["nominal_mm"] = nominal

        if result["confidence"] < args.min_confidence:
            print(json.dumps({
                "success": False,
                "error": "alignment confidence %.2f below minimum %.2f -- refusing to return an "
                         "offset for a job to use" % (result["confidence"], args.min_confidence),
                "detail": result,
            }))
            sys.exit(1)

        print("dx=%.3fmm dy=%.3fmm dtheta=%.3fdeg confidence=%.2f"
              % (result["dx_mm"], result["dy_mm"], result["theta_deg"], result["confidence"]),
              file=sys.stderr)

        print(json.dumps({"success": True, **result}))
        sys.exit(0)

    except VisionError as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"success": False, "error": "unexpected error: %s" % e}))
        sys.exit(1)


if __name__ == "__main__":
    main()
