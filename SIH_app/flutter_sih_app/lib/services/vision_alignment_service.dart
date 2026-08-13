import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;

/// Service for camera-based workpiece alignment (see VISION_ALIGNMENT.md).
///
/// Lets this phone's camera stand in for the desktop app's fixed USB
/// webcam: same underlying vision_lib.py (ArUco homography calibration +
/// contour-based workpiece detection) runs on the backend either way, just
/// fed a phone photo instead of a live OpenCV VideoCapture frame. A phone
/// has no serial port to drive GRBL, so this deliberately does not try to
/// control the machine directly -- it reads a photo, gets back a
/// dx/dy/theta correction, and the reading is persisted server-side so the
/// desktop app can pick it up (see engraving-app/src/main.js's
/// vision:pullFromPhone handler) and apply it to the G-code itself.
class VisionAlignmentService {
  final String baseUrl;
  final String machineId;

  VisionAlignmentService({required this.baseUrl, this.machineId = 'default'});

  Future<VisionCalibrationResult?> calibrateFromFile(File imageFile) async {
    try {
      final bytes = await imageFile.readAsBytes();
      return await calibrateFromBase64(base64Encode(bytes));
    } catch (e) {
      print('Error calibrating from file: $e');
      return null;
    }
  }

  Future<VisionCalibrationResult?> calibrateFromBase64(String base64Image) async {
    try {
      final url = Uri.parse('$baseUrl/api/vision/calibrate');
      final response = await http
          .post(
            url,
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'image_base64': base64Image, 'machine_id': machineId}),
          )
          .timeout(const Duration(seconds: 30));

      if (response.statusCode != 200) {
        print('Calibration failed: ${response.statusCode} - ${response.body}');
        return null;
      }
      return VisionCalibrationResult.fromJson(jsonDecode(response.body));
    } catch (e) {
      print('Error calling calibration API: $e');
      return null;
    }
  }

  /// [itemUid] ties the reading to the same item/QR identifier already used
  /// everywhere else in this app, so an alignment reading can be correlated
  /// with the job it was taken for.
  Future<VisionAlignmentResult?> alignFromFile(
    File imageFile, {
    double? nominalX,
    double? nominalY,
    double nominalTheta = 0.0,
    String? itemUid,
  }) async {
    try {
      final bytes = await imageFile.readAsBytes();
      return await alignFromBase64(
        base64Encode(bytes),
        nominalX: nominalX,
        nominalY: nominalY,
        nominalTheta: nominalTheta,
        itemUid: itemUid,
      );
    } catch (e) {
      print('Error aligning from file: $e');
      return null;
    }
  }

  Future<VisionAlignmentResult?> alignFromBase64(
    String base64Image, {
    double? nominalX,
    double? nominalY,
    double nominalTheta = 0.0,
    String? itemUid,
  }) async {
    try {
      final url = Uri.parse('$baseUrl/api/vision/align');
      final requestBody = <String, dynamic>{
        'image_base64': base64Image,
        'machine_id': machineId,
        'nominal_theta': nominalTheta,
      };
      if (nominalX != null) requestBody['nominal_x'] = nominalX;
      if (nominalY != null) requestBody['nominal_y'] = nominalY;
      if (itemUid != null) requestBody['item_uid'] = itemUid;

      final response = await http
          .post(url, headers: {'Content-Type': 'application/json'}, body: jsonEncode(requestBody))
          .timeout(const Duration(seconds: 30));

      if (response.statusCode != 200) {
        print('Alignment failed: ${response.statusCode} - ${response.body}');
        return null;
      }
      return VisionAlignmentResult.fromJson(jsonDecode(response.body));
    } catch (e) {
      print('Error calling alignment API: $e');
      return null;
    }
  }

  /// Not normally needed by the phone app itself (the desktop app is the
  /// one that polls this) -- exposed here mainly so the phone can show the
  /// operator "yes, the machine picked this up" confirmation after sending
  /// a reading, closing the loop visually.
  Future<Map<String, dynamic>?> getLatestAlignment() async {
    try {
      final url = Uri.parse('$baseUrl/api/vision/latest-alignment?machine_id=$machineId');
      final response = await http.get(url).timeout(const Duration(seconds: 10));
      if (response.statusCode != 200) return null;
      return jsonDecode(response.body) as Map<String, dynamic>;
    } catch (e) {
      print('Error checking latest alignment: $e');
      return null;
    }
  }
}

class VisionCalibrationResult {
  final bool success;
  final double? reprojectionErrorMaxMm;
  final double? reprojectionErrorMeanMm;
  final List<int> markersUsed;
  final String? error;

  VisionCalibrationResult({
    required this.success,
    this.reprojectionErrorMaxMm,
    this.reprojectionErrorMeanMm,
    this.markersUsed = const [],
    this.error,
  });

  factory VisionCalibrationResult.fromJson(Map<String, dynamic> json) {
    final err = json['reprojection_error_mm'] as Map<String, dynamic>?;
    return VisionCalibrationResult(
      success: json['success'] ?? false,
      reprojectionErrorMaxMm: (err?['max'] as num?)?.toDouble(),
      reprojectionErrorMeanMm: (err?['mean'] as num?)?.toDouble(),
      markersUsed: List<int>.from(json['markers_used'] ?? []),
      error: json['error'],
    );
  }

  /// Good rule of thumb surfaced to the operator: well under 1mm is a
  /// healthy calibration; anything higher means re-check marker placement,
  /// lighting, or focus before trusting an alignment read off of it.
  bool get isGood => success && (reprojectionErrorMaxMm ?? 999) < 1.0;
}

class VisionAlignmentResult {
  final bool success;
  final double? dxMm;
  final double? dyMm;
  final double? thetaDeg;
  final double? confidence;
  final String? error;

  VisionAlignmentResult({
    required this.success,
    this.dxMm,
    this.dyMm,
    this.thetaDeg,
    this.confidence,
    this.error,
  });

  factory VisionAlignmentResult.fromJson(Map<String, dynamic> json) {
    return VisionAlignmentResult(
      success: json['success'] ?? false,
      dxMm: (json['dx_mm'] as num?)?.toDouble(),
      dyMm: (json['dy_mm'] as num?)?.toDouble(),
      thetaDeg: (json['theta_deg'] as num?)?.toDouble(),
      confidence: (json['confidence'] as num?)?.toDouble(),
      error: json['error'],
    );
  }

  String get summary => success
      ? 'dx=${dxMm!.toStringAsFixed(2)}mm  dy=${dyMm!.toStringAsFixed(2)}mm  '
          'dθ=${thetaDeg!.toStringAsFixed(2)}°  (${((confidence ?? 0) * 100).toStringAsFixed(0)}% confidence)'
      : (error ?? 'Alignment failed');
}
