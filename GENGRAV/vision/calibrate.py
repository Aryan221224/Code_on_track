#!/usr/bin/env python3
"""calibrate.py -- one-time (or occasional) camera<->bed calibration.

Captures a frame of the bed (with all 4 ArUco calibration markers visible
and unobstructed), computes the camera-pixel -> machine-mm homography, and
saves it to calibration.json. Re-run this whenever the camera is
unmounted/remounted or moved -- align.py refuses to run without a saved
calibration.

Usage
  python3 vision/calibrate.py                  # capture from the default camera
  python3 vision/calibrate.py --camera 1        # use a specific camera index
  python3 vision/calibrate.py --image path.jpg  # calibrate from a still image
                                                 # (testing, or a phone photo)

Always prints a single JSON object to stdout -- this is the contract the
Electron main process (main.js) parses, so nothing else should go to stdout.
Human-readable progress goes to stderr.
"""
import argparse
import json
import sys

import cv2

from vision_lib import calibrate_from_image, save_calibration, VisionError, DEFAULT_BED_MARKERS_PATH


def capture_frame(camera_index):
    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        raise VisionError("could not open camera index %d" % camera_index)
    try:
        # Warm up: the first few frames from many UVC webcams are dark/out of
        # auto-exposure convergence -- discard them rather than calibrate off
        # a bad frame.
        frame = None
        for _ in range(10):
            ok, frame = cap.read()
            if not ok:
                raise VisionError("camera opened but did not return a frame")
        return frame
    finally:
        cap.release()


def main():
    ap = argparse.ArgumentParser(description="Calibrate the bed camera (camera px -> machine mm)")
    ap.add_argument("--camera", type=int, default=0, help="camera device index")
    ap.add_argument("--image", type=str, default=None, help="calibrate from a still image instead of a live camera")
    ap.add_argument("--bed-markers", type=str, default=DEFAULT_BED_MARKERS_PATH,
                     help="path to the bed_markers.json describing known marker positions")
    ap.add_argument("--save-frame", type=str, default=None,
                     help="also save the captured frame here (useful for debugging marker detection)")
    args = ap.parse_args()

    try:
        if args.image:
            frame = cv2.imread(args.image)
            if frame is None:
                raise VisionError("could not read image: %s" % args.image)
        else:
            print("capturing from camera %d..." % args.camera, file=sys.stderr)
            frame = capture_frame(args.camera)

        if args.save_frame:
            cv2.imwrite(args.save_frame, frame)

        H, report = calibrate_from_image(frame, bed_markers_path=args.bed_markers)
        path = save_calibration(H, report)

        print("calibration OK -- max reprojection error %.3f mm (mean %.3f mm)"
              % (report["reprojection_error_mm"]["max"], report["reprojection_error_mm"]["mean"]),
              file=sys.stderr)

        print(json.dumps({"success": True, "calibration_path": path, "report": report}))
        sys.exit(0)

    except VisionError as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"success": False, "error": "unexpected error: %s" % e}))
        sys.exit(1)


if __name__ == "__main__":
    main()
