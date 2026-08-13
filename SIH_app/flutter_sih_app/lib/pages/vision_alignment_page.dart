import 'dart:io';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import '../services/vision_alignment_service.dart';
import '../theme/app_theme.dart';

/// Lets the operator use this phone's camera as the workpiece-alignment
/// camera instead of (or alongside) the engraver's fixed USB webcam --
/// see VISION_ALIGNMENT.md. Two steps, same order as the desktop app's
/// panel: Calibrate once per camera position, then Align before each job.
///
/// [itemUid] is optional and comes from wherever this page is opened from
/// (e.g. after a QR scan) -- when present, an alignment reading is tagged
/// with it so it's traceable to the job it was taken for.
class VisionAlignmentPage extends StatefulWidget {
  final String baseUrl;
  final String machineId;
  final String? itemUid;

  const VisionAlignmentPage({
    super.key,
    required this.baseUrl,
    this.machineId = 'default',
    this.itemUid,
  });

  @override
  State<VisionAlignmentPage> createState() => _VisionAlignmentPageState();
}

class _VisionAlignmentPageState extends State<VisionAlignmentPage> {
  late final VisionAlignmentService _vision;
  final ImagePicker _picker = ImagePicker();

  bool _busy = false;
  String _status = 'Not calibrated yet on this phone.';
  Color _statusColor = Colors.black87;
  bool _calibrated = false;
  VisionAlignmentResult? _lastAlignment;

  @override
  void initState() {
    super.initState();
    _vision = VisionAlignmentService(baseUrl: widget.baseUrl, machineId: widget.machineId);
  }

  Future<File?> _capturePhoto() async {
    // Higher resolution than this app's other camera captures (which use
    // 1024px for defect classification) -- ArUco marker centroids and the
    // workpiece edge need real pixels to land sub-mm accuracy on, and a
    // compressed low-res photo directly costs calibration/alignment
    // precision, unlike a defect-classification photo where 1024px is
    // already plenty for the model.
    final XFile? photo = await _picker.pickImage(
      source: ImageSource.camera,
      maxWidth: 1920,
      maxHeight: 1920,
      imageQuality: 90,
    );
    if (photo == null) return null;
    return File(photo.path);
  }

  Future<void> _calibrate() async {
    final file = await _capturePhoto();
    if (file == null) return;
    setState(() {
      _busy = true;
      _status = 'Calibrating... hold the phone steady over all 4 bed markers.';
      _statusColor = Colors.orange;
    });

    final result = await _vision.calibrateFromFile(file);
    setState(() {
      _busy = false;
      if (result == null) {
        _status = 'Calibration request failed -- check the backend connection.';
        _statusColor = Colors.red;
      } else if (!result.success) {
        _status = 'Calibration failed: ${result.error}';
        _statusColor = Colors.red;
      } else {
        _calibrated = true;
        final err = result.reprojectionErrorMaxMm ?? 0;
        _status = 'Calibrated -- reprojection error ${err.toStringAsFixed(3)}mm'
            '${result.isGood ? '' : ' (higher than ideal -- recheck marker visibility/focus)'}';
        _statusColor = result.isGood ? Colors.green : Colors.orange;
      }
    });
  }

  Future<void> _align() async {
    final file = await _capturePhoto();
    if (file == null) return;
    setState(() {
      _busy = true;
      _status = 'Reading workpiece position...';
      _statusColor = Colors.orange;
    });

    final result = await _vision.alignFromFile(file, itemUid: widget.itemUid);
    setState(() {
      _busy = false;
      _lastAlignment = result;
      if (result == null) {
        _status = 'Alignment request failed -- check the backend connection.';
        _statusColor = Colors.red;
      } else if (!result.success) {
        _status = 'Alignment failed: ${result.error}';
        _statusColor = Colors.red;
      } else {
        _status = 'Sent to machine -- ${result.summary}';
        _statusColor = Colors.green;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Vision Alignment')),
      body: Container(
        decoration: appBackgroundDecoration,
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'Use this phone as the alignment camera',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Step 1: point the phone straight down at the bed so all 4 corner '
                  'markers are visible, and Calibrate. Step 2: place the workpiece and '
                  'Align before starting the job on the machine.',
                  style: TextStyle(fontSize: 13, color: Colors.black54),
                ),
                const SizedBox(height: 24),
                ElevatedButton.icon(
                  onPressed: _busy ? null : _calibrate,
                  icon: const Icon(Icons.camera_alt),
                  label: const Text('Calibrate Camera'),
                  style: ElevatedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
                ),
                const SizedBox(height: 12),
                ElevatedButton.icon(
                  onPressed: (_busy || !_calibrated) ? null : _align,
                  icon: const Icon(Icons.center_focus_strong),
                  label: const Text('Align Workpiece'),
                  style: ElevatedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
                ),
                if (!_calibrated)
                  const Padding(
                    padding: EdgeInsets.only(top: 4),
                    child: Text('Calibrate first', style: TextStyle(fontSize: 11, color: Colors.black45)),
                  ),
                const SizedBox(height: 24),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: Colors.white.withOpacity(0.85),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: _statusColor.withOpacity(0.4)),
                  ),
                  child: Row(
                    children: [
                      if (_busy)
                        const Padding(
                          padding: EdgeInsets.only(right: 10),
                          child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                        ),
                      Expanded(
                        child: Text(_status, style: TextStyle(color: _statusColor, fontSize: 13)),
                      ),
                    ],
                  ),
                ),
                if (_lastAlignment?.success == true) ...[
                  const SizedBox(height: 16),
                  const Text(
                    'The desktop app will pick this up automatically the next time it '
                    'checks (or click "Use Phone Reading" there) -- this reading stays '
                    'valid for 5 minutes.',
                    style: TextStyle(fontSize: 12, color: Colors.black54, fontStyle: FontStyle.italic),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
