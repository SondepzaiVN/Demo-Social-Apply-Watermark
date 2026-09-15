"""Local API that connects Watermark Social to the research pipeline.

Run from the repository root:  python web/watermark_api.py
The API only listens on localhost and stores generated artifacts under web/runtime.
"""
from __future__ import annotations

import base64
import json
import sys
import tempfile
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CODE = ROOT / "Code"
sys.path.insert(0, str(CODE))
from models.watermark_pipeline import (  # noqa: E402
    bin_image_to_text, embed_watermark, extract_watermark, load_key_file,
    pad_watermark, save_key_file, text_to_bin_image,
)

RUNTIME = Path(__file__).resolve().parent / "runtime"
RUNTIME.mkdir(exist_ok=True)


def data_url_to_image(data_url: str) -> np.ndarray:
    _, encoded = data_url.split(",", 1)
    image = cv2.imdecode(np.frombuffer(base64.b64decode(encoded), np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Không thể đọc ảnh gửi lên.")
    return image


FACEBOOK_MAX_SIDE = 2048
FACEBOOK_PREUPLOAD_JPEG_QUALITY = 100


def resize_for_facebook(image: np.ndarray) -> np.ndarray:
    """Match the research workflow: preserve aspect ratio, cap long side at 2048."""
    height, width = image.shape[:2]
    longest_side = max(width, height)
    if longest_side <= FACEBOOK_MAX_SIDE:
        return image
    scale = FACEBOOK_MAX_SIDE / longest_side
    return cv2.resize(
        image,
        (round(width * scale), round(height * scale)),
        interpolation=cv2.INTER_AREA,
    )


def image_to_data_url(image: np.ndarray) -> str:
    ok, encoded = cv2.imencode(
        ".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, FACEBOOK_PREUPLOAD_JPEG_QUALITY]
    )
    if not ok:
        raise ValueError("Không thể mã hóa ảnh watermark.")
    return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode()


def embed(image_data: str, account_id: str) -> dict:
    account_id = account_id.strip()
    if not account_id or len(account_id.encode("utf-8")) > 24:
        raise ValueError("Account ID phải có từ 1 đến 24 byte UTF-8.")
    host = resize_for_facebook(data_url_to_image(image_data))
    seed, repeat_k, payload_repeat, alpha, roi_count = 42, 3, 1, 100.0, 10
    raw = text_to_bin_image(account_id, repeat_k=repeat_k, payload_repeat=payload_repeat, encoding="utf-8", payload_seed=seed) * 255
    padded, _ = pad_watermark(raw, color=255)
    watermark = (padded > 127).astype(np.uint8)
    marked, _, positions, safe_des, safe_kp = embed_watermark(host, watermark, alpha, roi_count, seed)
    artifact_id = str(uuid.uuid4())
    original_path = RUNTIME / f"{artifact_id}_original.jpg"
    marked_path = RUNTIME / f"{artifact_id}_watermarked.jpg"
    key_path = RUNTIME / f"{artifact_id}.npz"
    cv2.imwrite(str(original_path), host)
    cv2.imwrite(str(marked_path), marked)
    save_key_file(str(key_path), positions, safe_kp, safe_des, watermark.shape, raw.shape, alpha, seed, "text", account_id, "", repeat_k, payload_repeat, "utf-8", str(original_path), "", include_length_header=True)
    return {"id": artifact_id, "image": image_to_data_url(marked), "keyBase64": base64.b64encode(key_path.read_bytes()).decode()}


def verify(image_data: str, key_base64: str) -> dict:
    host = data_url_to_image(image_data)
    with tempfile.NamedTemporaryFile(suffix=".npz", delete=False) as temp:
        temp.write(base64.b64decode(key_base64))
        key_path = Path(temp.name)
    try:
        key = load_key_file(str(key_path))
        padded = extract_watermark(host, key["safe_des_orig"], key["safe_kp_orig"], key["alpha"], key["pos"], key["wm_shape"], seed=key["seed"], use_affine_correction=True)
        height, width = key["orig_shape"]
        recovered = padded[:height, :width]
        extracted = bin_image_to_text(recovered, repeat_k=key["repeat_k"], payload_repeat=key["payload_repeat"], encoding=key["text_encoding"], payload_seed=key["seed"]).strip()
        expected = key["text_input"]
        matches = extracted == expected
        # Text equality is the legal decision. The percentage is only UI feedback.
        confidence = 100.0 if matches else max(0.0, round(100 * sum(a == b for a, b in zip(extracted, expected)) / max(len(expected), 1), 1))
        return {"matched": matches, "extractedId": extracted, "expectedId": expected, "confidence": confidence}
    finally:
        key_path.unlink(missing_ok=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[watermark-api] " + fmt % args)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            if self.path == "/api/embed": result = embed(payload["image"], payload["accountId"])
            elif self.path == "/api/verify": result = verify(payload["image"], payload["keyBase64"])
            else: self.send_error(404); return
            body = json.dumps(result).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        except Exception as error:
            body = json.dumps({"error": str(error)}).encode()
            self.send_response(400); self.send_header("Content-Type", "application/json"); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)


if __name__ == "__main__":
    print("Watermark API: http://127.0.0.1:8787")
    ThreadingHTTPServer(("127.0.0.1", 8787), Handler).serve_forever()
