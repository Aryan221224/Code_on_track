"""
Mobile Scanning Backend - Simple FastAPI server for RailChinh Flutter App
With YOLO Detection and Multi-Model Inspection Pipeline
"""

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Dict
import hashlib
from datetime import datetime
import os
from sqlalchemy import create_engine, Column, Integer, String, Boolean, DateTime, Enum, Text, Float
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import enum
import io
import json
from PIL import Image
import numpy as np
import base64

# Import inspection pipeline
try:
    from pipeline import get_pipeline, InspectionPipeline
    PIPELINE_AVAILABLE = True
except ImportError:
    PIPELINE_AVAILABLE = False
    print("⚠️ Pipeline module not available")

# Import camera-based workpiece vision alignment (see VISION_ALIGNMENT.md).
# Same vision_lib.py used by the desktop app's USB-camera path (GENGRAV/vision) --
# copied here rather than imported cross-package so this backend has no
# runtime dependency on the Electron app's folder layout.
try:
    import vision_lib
    VISION_AVAILABLE = True
except ImportError as e:
    VISION_AVAILABLE = False
    print(f"⚠️ Vision module not available: {e}")

# Database setup
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres.aktfgilmfoprdkwkzybd:Alqawwiy%40123@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres"
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Enums
class UserRole(str, enum.Enum):
    INVENTORY = "inventory"
    INSTALLATION = "installation"
    MANAGEMENT = "management"
    INSPECTION = "inspection"
    ADMIN = "admin"

# Database Models
class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(100), unique=True, nullable=False)
    email = Column(String(255), unique=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    full_name = Column(String(255))
    department = Column(Enum(UserRole), default=UserRole.INVENTORY)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime)

class Item(Base):
    __tablename__ = "items"
    
    id = Column(Integer, primary_key=True, index=True)
    uid = Column(String(100), unique=True, nullable=False, index=True)
    component_type = Column(String(100), nullable=False)
    lot_number = Column(String(100))
    vendor_id = Column(Integer)
    quantity = Column(Integer, default=1)
    warranty_years = Column(Integer, default=0)
    manufacture_date = Column(DateTime)
    current_status = Column(String(50), default="manufactured")
    qr_image_url = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

# Pydantic Models
class LoginRequest(BaseModel):
    username: str
    password: str

class LoginResponse(BaseModel):
    token: str
    user: dict

class StatusUpdate(BaseModel):
    current_status: str

class InspectionRequest(BaseModel):
    qr_id: str
    status: str
    remark: str
    inspector_id: Optional[int] = None

class DefectClassificationRequest(BaseModel):
    image_base64: str  # Base64 encoded image

class DefectClassificationResponse(BaseModel):
    predicted_class: str
    confidence: float
    all_probabilities: Dict[str, float]
    remark: str  # Human-readable remark
    status: Optional[str] = "OK"
    model_available: Optional[bool] = True

class BoundingBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float

class ComponentDetection(BaseModel):
    class_id: int
    class_name: str
    confidence: float
    bbox: BoundingBox

class ComponentDetectionResponse(BaseModel):
    num_detections: int
    detections: list[ComponentDetection]
    model_available: bool = True
    inference_time_ms: Optional[float] = None

# Database Model for Inspections
class Inspection(Base):
    __tablename__ = "inspections"
    
    id = Column(Integer, primary_key=True, index=True)
    item_uid = Column(String(100), nullable=False, index=True)
    status = Column(String(50), nullable=False)
    remark = Column(Text)
    inspector_id = Column(Integer)
    photo_url = Column(Text)
    # AI fields are commented out until migration is run
    # ai_classification = Column(String(50))  # AI predicted defect class
    # ai_confidence = Column(Float)  # AI confidence score
    inspected_at = Column(DateTime, default=datetime.utcnow)
    created_at = Column(DateTime, default=datetime.utcnow)

# Database Models for Vision Alignment (see VISION_ALIGNMENT.md)
class VisionCalibration(Base):
    """Camera<->bed homography, computed from a photo of the 4 fixed ArUco
    bed markers. Stored per machine_id (not on local disk, unlike the
    desktop app's calibration.json) because this backend is intended to run
    on Render, which has no persistent local filesystem across deploys."""
    __tablename__ = "vision_calibrations"

    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(String(100), nullable=False, index=True, default="default")
    homography_json = Column(Text, nullable=False)     # 3x3 matrix, JSON-encoded
    reprojection_error_mm = Column(Float)
    created_at = Column(DateTime, default=datetime.utcnow)

class VisionAlignment(Base):
    """A single alignment reading (from a phone or, in principle, any other
    capture device hitting this same endpoint), persisted so the desktop
    app can poll for it -- see engraving-app/src/main.js's
    vision:pullFromPhone handler. A phone has no serial port to drive GRBL
    itself, so this table is the hand-off point between 'a phone took a
    photo' and 'the machine actually applies the correction'."""
    __tablename__ = "vision_alignments"

    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(String(100), nullable=False, index=True, default="default")
    item_uid = Column(String(100), index=True)
    dx_mm = Column(Float, nullable=False)
    dy_mm = Column(Float, nullable=False)
    theta_deg = Column(Float, nullable=False)
    confidence = Column(Float, nullable=False)
    nominal_x = Column(Float)
    nominal_y = Column(Float)
    nominal_theta = Column(Float)
    source = Column(String(20), default="phone")
    created_at = Column(DateTime, default=datetime.utcnow)

# Create tables if they don't exist
try:
    Base.metadata.create_all(bind=engine, checkfirst=True)
except Exception as e:
    print(f"Warning: Could not create tables: {e}")

# Create FastAPI app
app = FastAPI(
    title="RailChinh Mobile Backend",
    description="Backend API for Railway Component Tracking Mobile App",
    version="1.0.0"
)

# CORS - Allow all origins for mobile app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Helper functions
def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def generate_token(username: str) -> str:
    data = f"{username}:{datetime.utcnow().isoformat()}"
    return hashlib.sha256(data.encode()).hexdigest()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ============================================================================
# YOLO OBJECT DETECTION MODEL (LEGACY - kept for backward compatibility)
# ============================================================================

# Global variable to store YOLO model
_yolo_model = None
_component_class_names = ['elastic_clip_good', 'elastic_clip_missing']

# Defect class names - used by fallback classifier
_class_names = ['Broken', 'Crack', 'Damaged', 'Normal', 'Rust']

# Component descriptions for API response
COMPONENT_DESCRIPTIONS = {
    'elastic_clip_good': 'Elastic Railway Clip - Good condition, properly secured',
    'elastic_clip_missing': 'Elastic Railway Clip - Missing or damaged, needs replacement'
}

# Remark templates for each defect class
DEFECT_REMARKS = {
    'Rust': 'Component shows signs of rust/corrosion. Metal surface oxidation detected.',
    'Crack': 'Crack detected in component. Structural integrity compromised.',
    'Broken': 'Component is broken or severely damaged. Immediate replacement required.',
    'Damaged': 'General damage/wear detected. Component shows signs of deterioration.',
    'Normal': 'Component appears to be in good condition. No visible defects detected.'
}



def load_yolo_model():
    """Load YOLO object detection model on startup"""
    global _yolo_model
    
    try:
        from ultralytics import YOLO
        from pathlib import Path
        
        # Path to the trained YOLO model - try multiple locations
        # Priority 1: Railway YOLO detection project
        model_path = Path(__file__).parent.parent / 'railway-yolo-detection' / 'models' / 'best.pt'
        
        if not model_path.exists():
            # Priority 2: Alternative absolute path (local dev)
            model_path = Path('/Users/dakshrathore/Desktop/Code_on_track/railway-yolo-detection/models/best.pt')
        
        if not model_path.exists():
            # Priority 3: Local yolo_best.pt (for deployment)
            model_path = Path(__file__).parent / 'yolo_best.pt'
        
        if not model_path.exists():
            # Priority 4: Try /opt/render paths for production
            render_path = Path('/opt/render/project/src/mobile_backend/yolo_best.pt')
            if render_path.exists():
                model_path = render_path
        
        if model_path.exists():
            print(f"Loading YOLO model from: {model_path}")
            _yolo_model = YOLO(str(model_path))
            print("✅ YOLO object detection model loaded successfully!")
            return True
        else:
            print(f"⚠️  YOLO model not found at: {model_path}")
            print("Model will need to be trained first. Run: python railway-yolo-detection/scripts/train_yolo.py")
            return False
            
    except ImportError:
        print("⚠️  Ultralytics not installed. Install with: pip install ultralytics")
        return False
    except Exception as e:
        print(f"⚠️  Error loading YOLO model: {e}")
        return False

def detect_components(image: Image.Image, conf_threshold: float = 0.25) -> dict:
    """Detect railway components using YOLO model"""
    global _yolo_model, _component_class_names
    import time
    
    if _yolo_model is None:
        # Try to load model if not already loaded
        if not load_yolo_model():
            return {
                "num_detections": 0,
                "detections": [],
                "model_available": False,
                "message": "YOLO model not available. Please train the model first."
            }
    
    try:
        start_time = time.time()
        
        # Convert PIL Image to numpy array
        img_array = np.array(image)
        
        # Run inference
        results = _yolo_model.predict(
            source=img_array,
            conf=conf_threshold,
            save=False,
            verbose=False
        )
        
        inference_time = (time.time() - start_time) * 1000  # Convert to ms
        
        # Parse results
        detections = []
        for result in results:
            boxes = result.boxes
            
            for i in range(len(boxes)):
                class_id = int(boxes.cls[i].item())
                class_name = _component_class_names[class_id] if class_id < len(_component_class_names) else f"class_{class_id}"
                
                detection = {
                    'class_id': class_id,
                    'class_name': class_name,
                    'confidence': float(boxes.conf[i].item()),
                    'bbox': {
                        'x1': float(boxes.xyxy[i][0].item()),
                        'y1': float(boxes.xyxy[i][1].item()),
                        'x2': float(boxes.xyxy[i][2].item()),
                        'y2': float(boxes.xyxy[i][3].item())
                    }
                }
                detections.append(detection)
        
        return {
            'num_detections': len(detections),
            'detections': detections,
            'model_available': True,
            'inference_time_ms': round(inference_time, 2)
        }
        
    except Exception as e:
        raise Exception(f"Detection error: {str(e)}")



# Routes
@app.get("/")
def root():
    """Health check endpoint"""
    return {"status": "ok", "message": "RailChinh Mobile Backend is running"}

@app.get("/health")
def health_check():
    """Health check for monitoring"""
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}

@app.post("/api/auth/login", response_model=LoginResponse)
def login(request: LoginRequest):
    """
    Authenticate user and return token
    """
    print(f"=== LOGIN ATTEMPT ===")
    print(f"Username: '{request.username}'")
    print(f"Password: '{request.password}'")
    print(f"Password length: {len(request.password)}")
    
    db = SessionLocal()
    try:
        # Find user
        user = db.query(User).filter(User.username == request.username).first()
        
        print(f"User found: {user is not None}")
        
        if not user:
            print("ERROR: User not found")
            raise HTTPException(status_code=401, detail="Invalid username or password")
        
        if not user.is_active:
            print("ERROR: User not active")
            raise HTTPException(status_code=403, detail="User account is disabled")
        
        # Verify password
        provided_hash = hash_password(request.password)
        print(f"Stored hash: {user.hashed_password[:20]}...")
        print(f"Provided hash: {provided_hash[:20]}...")
        print(f"Password match: {user.hashed_password == provided_hash}")
        
        if user.hashed_password != provided_hash:
            print("ERROR: Password mismatch")
            raise HTTPException(status_code=401, detail="Invalid username or password")
        
        # Update last login
        user.last_login = datetime.utcnow()
        db.commit()
        
        # Generate token
        token = generate_token(user.username)
        
        print("SUCCESS: Login successful")
        
        return {
            "token": token,
            "user": {
                "id": user.id,
                "username": user.username,
                "email": user.email,
                "full_name": user.full_name,
                "department": user.department.value if user.department else "user",
                "role": user.department.value if user.department else "user",
                "is_active": user.is_active
            }
        }
    finally:
        db.close()

@app.get("/api/items/{uid}")
def get_item(uid: str):
    """
    Get item details by UID (from QR code scan)
    """
    db = SessionLocal()
    try:
        item = db.query(Item).filter(Item.uid == uid).first()
        
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        
        return {
            "uid": item.uid,
            "component_type": item.component_type,
            "lot_number": item.lot_number,
            "vendor_id": item.vendor_id,
            "quantity": item.quantity,
            "warranty_years": item.warranty_years,
            "manufacture_date": item.manufacture_date.isoformat() if item.manufacture_date else None,
            "current_status": item.current_status,
            "created_at": item.created_at.isoformat() if item.created_at else None,
            "updated_at": item.updated_at.isoformat() if item.updated_at else None
        }
    finally:
        db.close()

@app.get("/api/items")
def get_all_items(skip: int = 0, limit: int = 100):
    """
    Get all items with pagination
    """
    db = SessionLocal()
    try:
        items = db.query(Item).offset(skip).limit(limit).all()
        return [
            {
                "uid": item.uid,
                "component_type": item.component_type,
                "lot_number": item.lot_number,
                "vendor_id": item.vendor_id,
                "quantity": item.quantity,
                "current_status": item.current_status,
            }
            for item in items
        ]
    finally:
        db.close()

@app.put("/api/items/{uid}")
def update_item(uid: str, status_update: StatusUpdate):
    """
    Update item status
    """
    db = SessionLocal()
    try:
        item = db.query(Item).filter(Item.uid == uid).first()
        
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        
        item.current_status = status_update.current_status
        item.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(item)
        
        return {
            "uid": item.uid,
            "component_type": item.component_type,
            "current_status": item.current_status,
            "updated_at": item.updated_at.isoformat()
        }
    finally:
        db.close()

@app.post("/qr/inspection")
def submit_inspection(request: InspectionRequest):
    """
    Submit inspection result for a QR scanned item
    """
    db = SessionLocal()
    try:
        # Check if item exists
        item = db.query(Item).filter(Item.uid == request.qr_id).first()
        
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        
        # Create inspection record without AI fields (optional)
        inspection_data = {
            'item_uid': request.qr_id,
            'status': request.status,
            'remark': request.remark,
            'inspector_id': request.inspector_id,
            'inspected_at': datetime.utcnow()
        }
        
        inspection = Inspection(**inspection_data)
        db.add(inspection)
        
        # Update item status based on inspection
        if request.status in ["approved", "passed", "ok"]:
            item.current_status = "inspected"
        elif request.status in ["rejected", "failed", "damaged"]:
            item.current_status = "rejected"
        else:
            item.current_status = request.status
        
        item.updated_at = datetime.utcnow()
        db.commit()
        
        return {
            "success": True,
            "message": "Inspection submitted successfully",
            "inspection_id": inspection.id,
            "item_uid": request.qr_id,
            "new_status": item.current_status
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Error saving inspection: {str(e)}")
    finally:
        db.close()

@app.get("/api/inspections/{uid}")
def get_inspections(uid: str):
    """
    Get all inspections for an item
    """
    db = SessionLocal()
    try:
        inspections = db.query(Inspection).filter(Inspection.item_uid == uid).order_by(Inspection.inspected_at.desc()).all()
        return [
            {
                "id": insp.id,
                "item_uid": insp.item_uid,
                "status": insp.status,
                "remark": insp.remark,
                "inspector_id": insp.inspector_id,
                "ai_classification": insp.ai_classification,
                "ai_confidence": insp.ai_confidence,
                "inspected_at": insp.inspected_at.isoformat() if insp.inspected_at else None
            }
            for insp in inspections
        ]
    finally:
        db.close()



# ============================================================================
# YOLO COMPONENT DETECTION ENDPOINTS
# ============================================================================

@app.get("/api/detection-model-status")
def get_detection_model_status():
    """Check if YOLO object detection model is loaded and ready"""
    global _yolo_model
    
    is_loaded = _yolo_model is not None
    
    return {
        "model_loaded": is_loaded,
        "model_type": "YOLOv8 Object Detection" if is_loaded else None,
        "classes": _component_class_names if is_loaded else [],
        "class_descriptions": COMPONENT_DESCRIPTIONS if is_loaded else {},
        "status": "ready" if is_loaded else "not loaded",
        "message": "Model is ready for component detection" if is_loaded else "Model needs to be trained first"
    }

@app.post("/api/detect-components", response_model=ComponentDetectionResponse)
async def detect_railway_components(
    file: UploadFile = File(...),
    conf: float = 0.25
):
    """
    Detect railway track components in uploaded image
    
    Components detected:
    - elastic_clip: Spring clip holding rails to sleepers
    - liner: Metal plate between rail and sleeper
    - rubber_pad: Rubber cushion for vibration dampening
    - sleeper: Concrete/wooden cross-tie supporting rails
    
    Returns bounding boxes, class labels, and confidence scores for each detected component
    """
    try:
        # Read image file
        image_data = await file.read()
        image = Image.open(io.BytesIO(image_data))
        
        # Detect components
        result = detect_components(image, conf_threshold=conf)
        
        # Convert to response model format
        detections = []
        for det in result.get('detections', []):
            detections.append(ComponentDetection(
                class_id=det['class_id'],
                class_name=det['class_name'],
                confidence=det['confidence'],
                bbox=BoundingBox(**det['bbox'])
            ))
        
        return ComponentDetectionResponse(
            num_detections=result['num_detections'],
            detections=detections,
            model_available=result.get('model_available', True),
            inference_time_ms=result.get('inference_time_ms')
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Detection failed: {str(e)}")

@app.post("/api/detect-components-base64")
def detect_components_base64(request: DefectClassificationRequest, conf: float = 0.25):
    """
    Detect railway components from base64 encoded image
    Used by mobile app to send captured photos
    """
    try:
        # Decode base64 image
        image_data = base64.b64decode(request.image_base64)
        image = Image.open(io.BytesIO(image_data))
        
        # Detect components
        result = detect_components(image, conf_threshold=conf)
        
        return result
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Detection failed: {str(e)}")

@app.get("/api/component-classes")
def get_component_classes():
    """Get list of detectable railway component classes with descriptions"""
    return {
        "classes": _component_class_names,
        "descriptions": COMPONENT_DESCRIPTIONS
    }

# ============================================================================
# MULTI-MODEL INSPECTION PIPELINE
# ============================================================================

class InspectionRequest(BaseModel):
    image_base64: str
    component_type: Optional[str] = None  # Optional: 'erc', 'sleeper', 'liner', 'rubber_pad'
    expected_component: Optional[str] = None  # From QR code: validate detected matches expected

class InspectionResponse(BaseModel):
    success: bool
    component_detected: Optional[str] = None  # Human-readable: "Sleeper", "Elastic Rail Clip", etc.
    component_type: Optional[str] = None  # Internal type: 'erc', 'sleeper'
    component_class: Optional[str] = None  # Detection class name
    detection_confidence: Optional[float] = None
    severity: Optional[str] = None  # "Good", "Fair", "Bad"
    condition: Optional[str] = None  # Alias for severity
    defects: list = []
    recommendations: list = []
    error: Optional[str] = None
    wrong_component: bool = False  # True if detected != expected

@app.post("/api/inspect-component", response_model=InspectionResponse)
async def inspect_component(request: InspectionRequest):
    """
    Multi-model inspection pipeline:
    1. YOLO detects component type
    2. ResNet classifies condition/defects
    
    Single-component policy: Returns error if multiple components detected.
    """
    if not PIPELINE_AVAILABLE:
        return InspectionResponse(
            success=False,
            error="Inspection pipeline not available"
        )
    
    try:
        # Decode base64 image
        image_data = base64.b64decode(request.image_base64)
        
        # Get pipeline and run inspection
        pipeline = get_pipeline()
        result = pipeline.inspect(image_data, request.component_type)
        
        if result['success']:
            detected_type = result.get('component_type', '').lower()
            
            # Component name mapping for display
            COMPONENT_DISPLAY_NAMES = {
                'erc': 'Elastic Rail Clip',
                'sleeper': 'Sleeper',
                'liner': 'Liner',
                'rubber_pad': 'Rubber Pad'
            }
            component_detected = COMPONENT_DISPLAY_NAMES.get(detected_type, detected_type.title())
            
            # Validate expected component if provided (from QR code)
            if request.expected_component:
                expected = request.expected_component.lower()
                if detected_type != expected:
                    expected_name = COMPONENT_DISPLAY_NAMES.get(expected, expected.title())
                    return InspectionResponse(
                        success=False,
                        component_detected=component_detected,
                        component_type=detected_type,
                        detection_confidence=result.get('detection_confidence'),
                        wrong_component=True,
                        error=f"Wrong component! Expected {expected_name} but detected {component_detected}. Please position the correct component in front of the camera."
                    )
            
            # Success - return full results
            condition = result.get('condition', 'Unknown')
            return InspectionResponse(
                success=True,
                component_detected=component_detected,
                component_type=detected_type,
                component_class=result.get('component_class'),
                detection_confidence=result.get('detection_confidence'),
                severity=condition,
                condition=condition,
                defects=result.get('defects', []),
                recommendations=result.get('recommendations', [])
            )
        else:
            return InspectionResponse(
                success=False,
                error=result.get('error', 'Inspection failed')
            )
            
    except Exception as e:
        return InspectionResponse(
            success=False,
            error=f"Inspection error: {str(e)}"
        )

@app.get("/api/pipeline-status")
async def get_pipeline_status():
    """Get status of the multi-model inspection pipeline."""
    if not PIPELINE_AVAILABLE:
        return {
            "available": False,
            "error": "Pipeline module not imported"
        }
    
    try:
        pipeline = get_pipeline()
        status = pipeline.get_status()
        return {
            "available": True,
            **status
        }
    except Exception as e:
        return {
            "available": False,
            "error": str(e)
        }

# ============================================================================
# CAMERA-BASED WORKPIECE VISION ALIGNMENT (see VISION_ALIGNMENT.md)
#
# Lets a phone's camera stand in for the desktop app's fixed USB webcam.
# Same vision_lib.py core (ArUco homography calibration + contour-based
# workpiece detection) either way -- only the capture device and the
# transport (HTTP+base64 here, direct OpenCV VideoCapture on desktop)
# differ. A phone can't drive GRBL itself, so /api/vision/align both
# returns the reading to the phone AND persists it, so the desktop app can
# poll /api/vision/latest-alignment and apply it to the G-code.
# ============================================================================
MIN_VISION_CONFIDENCE = 0.5

class VisionCalibrateRequest(BaseModel):
    image_base64: str
    machine_id: str = "default"

class VisionCalibrateResponse(BaseModel):
    success: bool
    reprojection_error_mm: Optional[Dict[str, float]] = None
    markers_used: Optional[list] = None
    error: Optional[str] = None

class VisionAlignRequest(BaseModel):
    image_base64: str
    machine_id: str = "default"
    item_uid: Optional[str] = None
    nominal_x: Optional[float] = None
    nominal_y: Optional[float] = None
    nominal_theta: float = 0.0

class VisionAlignResponse(BaseModel):
    success: bool
    dx_mm: Optional[float] = None
    dy_mm: Optional[float] = None
    theta_deg: Optional[float] = None
    confidence: Optional[float] = None
    error: Optional[str] = None

def _decode_image_bgr(image_base64: str):
    """base64 (as sent by the Flutter app, same convention as
    DefectClassificationRequest elsewhere in this file) -> OpenCV BGR array."""
    image_data = base64.b64decode(image_base64)
    pil_image = Image.open(io.BytesIO(image_data)).convert("RGB")
    rgb = np.array(pil_image)
    return np.ascontiguousarray(rgb[:, :, ::-1])  # RGB -> BGR for OpenCV/vision_lib

@app.post("/api/vision/calibrate", response_model=VisionCalibrateResponse)
def vision_calibrate(request: VisionCalibrateRequest):
    """Calibrate the camera<->bed homography from a photo of the 4 fixed
    ArUco bed markers -- works from a phone photo exactly like the desktop
    USB-camera path (vision/calibrate.py), same vision_lib.py underneath.
    Persisted per machine_id so a later /align call (from the phone or the
    desktop) can reuse it without recalibrating."""
    if not VISION_AVAILABLE:
        raise HTTPException(status_code=503, detail="vision module not available on this deployment")
    try:
        image = _decode_image_bgr(request.image_base64)
        H, report = vision_lib.calibrate_from_image(image)
        db = SessionLocal()
        try:
            db.add(VisionCalibration(
                machine_id=request.machine_id,
                homography_json=json.dumps(H.tolist()),
                reprojection_error_mm=report["reprojection_error_mm"]["max"],
            ))
            db.commit()
        finally:
            db.close()
        return VisionCalibrateResponse(success=True, reprojection_error_mm=report["reprojection_error_mm"],
                                        markers_used=report["markers_used"])
    except vision_lib.VisionError as e:
        return VisionCalibrateResponse(success=False, error=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Calibration failed: {str(e)}")

@app.post("/api/vision/align", response_model=VisionAlignResponse)
def vision_align(request: VisionAlignRequest):
    """Read the workpiece alignment offset from a phone photo, against the
    most recent calibration saved for this machine_id. Always persists the
    attempt's reading (even a low-confidence one) for visibility, but only
    reports success when it clears MIN_VISION_CONFIDENCE -- a caller must
    never be handed a reading it didn't ask to be told was unreliable."""
    if not VISION_AVAILABLE:
        raise HTTPException(status_code=503, detail="vision module not available on this deployment")
    db = SessionLocal()
    try:
        calib_row = (db.query(VisionCalibration)
                     .filter(VisionCalibration.machine_id == request.machine_id)
                     .order_by(VisionCalibration.created_at.desc())
                     .first())
        if not calib_row:
            return VisionAlignResponse(success=False, error=(
                "no calibration saved for machine_id='%s' -- run /api/vision/calibrate first"
                % request.machine_id))

        H = np.array(json.loads(calib_row.homography_json), dtype=np.float64)
        calib_report = {"reprojection_error_mm": {"max": calib_row.reprojection_error_mm}}
        bed_markers = vision_lib.load_bed_markers()

        if request.nominal_x is None or request.nominal_y is None:
            xs = [m[0] for m in bed_markers.values()]
            ys = [m[1] for m in bed_markers.values()]
            nominal = {"x": request.nominal_x if request.nominal_x is not None else (min(xs) + max(xs)) / 2,
                       "y": request.nominal_y if request.nominal_y is not None else (min(ys) + max(ys)) / 2,
                       "theta_deg": request.nominal_theta}
        else:
            nominal = {"x": request.nominal_x, "y": request.nominal_y, "theta_deg": request.nominal_theta}

        image = _decode_image_bgr(request.image_base64)
        # Same core math as the desktop CLI path -- see the docstring on
        # compute_alignment_offset_from_homography() for why this shares
        # code instead of reimplementing the pixel->mm math here.
        result = vision_lib.compute_alignment_offset_from_homography(image, nominal, H, calib_report, bed_markers)

        db.add(VisionAlignment(
            machine_id=request.machine_id, item_uid=request.item_uid,
            dx_mm=result["dx_mm"], dy_mm=result["dy_mm"], theta_deg=result["theta_deg"],
            confidence=result["confidence"], nominal_x=nominal["x"], nominal_y=nominal["y"],
            nominal_theta=nominal["theta_deg"], source="phone",
        ))
        db.commit()

        if result["confidence"] < MIN_VISION_CONFIDENCE:
            return VisionAlignResponse(success=False, error=(
                "alignment confidence %.2f below minimum %.2f -- refusing to report a reading a "
                "caller could apply to a job" % (result["confidence"], MIN_VISION_CONFIDENCE)))
        return VisionAlignResponse(success=True, dx_mm=result["dx_mm"], dy_mm=result["dy_mm"],
                                    theta_deg=result["theta_deg"], confidence=result["confidence"])
    except vision_lib.VisionError as e:
        return VisionAlignResponse(success=False, error=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Alignment failed: {str(e)}")
    finally:
        db.close()

@app.get("/api/vision/latest-alignment")
def vision_latest_alignment(machine_id: str = "default", max_age_seconds: int = 300):
    """Polled by the desktop app (engraving-app main.js: vision:pullFromPhone)
    to pick up the most recent phone-submitted alignment. max_age_seconds
    guards against silently applying a stale reading to a workpiece that
    isn't on the bed anymore -- default 5 minutes, generous enough for an
    operator to walk from the phone back to the machine, short enough that
    a forgotten reading from yesterday can never be picked up by accident."""
    db = SessionLocal()
    try:
        row = (db.query(VisionAlignment)
               .filter(VisionAlignment.machine_id == machine_id)
               .order_by(VisionAlignment.created_at.desc())
               .first())
        if not row:
            return {"available": False}
        age = (datetime.utcnow() - row.created_at).total_seconds()
        if age > max_age_seconds:
            return {"available": False, "reason": "stale", "age_seconds": age}
        return {
            "available": True,
            "dx_mm": row.dx_mm, "dy_mm": row.dy_mm, "theta_deg": row.theta_deg,
            "confidence": row.confidence,
            "nominal_mm": {"x": row.nominal_x, "y": row.nominal_y, "theta_deg": row.nominal_theta},
            "item_uid": row.item_uid, "age_seconds": age,
        }
    finally:
        db.close()

# Load models on startup
@app.on_event("startup")
async def startup_event():
    """Initialize inspection pipeline when server starts"""
    print("\n" + "="*70)
    print("🚂 Railway Component Inspection Backend Starting...")
    print("="*70)
    print("\n📦 Loading AI Pipeline...")
    
    # Initialize the new multi-model pipeline
    if PIPELINE_AVAILABLE:
        try:
            pipeline = get_pipeline()
            status = pipeline.get_status()
            print(f"✅ Pipeline loaded: {len(status['detectors'])} detectors, {len(status['classifiers'])} classifiers")
        except Exception as e:
            print(f"⚠️ Pipeline initialization error: {e}")
    else:
        print("⚠️ Pipeline module not available")
    
    # Load legacy YOLO model for backward compatibility
    load_yolo_model()
    print("="*70 + "\n")

# Run with: uvicorn main:app --host 0.0.0.0 --port 8000
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
