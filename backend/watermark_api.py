"""Local persistent API for Watermark Social."""
from __future__ import annotations

import base64, hashlib, hmac, json, re, secrets, sys, tempfile, threading, uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "Code"))
from models.watermark_pipeline import (  # noqa: E402
    bin_image_to_text, embed_watermark, extract_watermark, load_key_file,
    pad_watermark, save_key_file, text_to_bin_image,
)

RUNTIME = Path(__file__).resolve().parent / "runtime"
RUNTIME.mkdir(exist_ok=True)
USERS_FILE, POSTS_FILE, SESSIONS_FILE = (RUNTIME / name for name in ("users.json", "posts.json", "sessions.json"))
DATA_LOCK = threading.RLock()
FACEBOOK_MAX_SIDE, FACEBOOK_PREUPLOAD_JPEG_QUALITY = 2048, 100


def read_json(path: Path, default):
    if not path.exists(): return default
    try: return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError): return default


def write_json(path: Path, value) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def new_account_id(users: dict) -> str:
    existing = {str(user.get("accountId", "")) for user in users.values()}
    while True:
        candidate = str(secrets.randbelow(9_000_000_000) + 1_000_000_000)
        if candidate not in existing: return candidate


def password_record(password: str) -> dict[str, str]:
    if len(password) < 8: raise ValueError("Mật khẩu cần có ít nhất 8 ký tự.")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return {"salt": base64.b64encode(salt).decode(), "hash": base64.b64encode(digest).decode()}


def valid_password(password: str, record: dict) -> bool:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(record["salt"]), 200_000)
    return hmac.compare_digest(base64.b64encode(digest).decode(), record["hash"])


def create_session(username: str, user: dict) -> dict:
    token = secrets.token_urlsafe(32)
    with DATA_LOCK:
        sessions = read_json(SESSIONS_FILE, {})
        sessions[token] = username
        write_json(SESSIONS_FILE, sessions)
    return {"token": token, "username": username, "accountId": user["accountId"], "displayName": user["displayName"]}


def register(username: str, display_name: str, password: str) -> dict:
    username = username.strip().lower()
    is_email = bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", username))
    is_phone = bool(re.fullmatch(r"(?:\+84|0)\d{9,10}", username))
    if not (is_email or is_phone):
        raise ValueError("Nhập email hợp lệ hoặc số điện thoại Việt Nam (ví dụ 0912345678 hoặc +84912345678).")
    with DATA_LOCK:
        users = read_json(USERS_FILE, {})
        if username in users: raise ValueError("Tên đăng nhập này đã tồn tại.")
        users[username] = {"displayName": display_name.strip() or username, "accountId": new_account_id(users), **password_record(password)}
        write_json(USERS_FILE, users)
        user = users[username]
    return create_session(username, user)


def login(username: str, password: str) -> dict:
    username = username.strip().lower()
    with DATA_LOCK:
        users = read_json(USERS_FILE, {})
        user = users.get(username)
        if user and "accountId" not in user:  # migrate accounts made by the earlier demo
            user["accountId"] = new_account_id(users); write_json(USERS_FILE, users)
    if not user or not valid_password(password, user): raise ValueError("Tên đăng nhập hoặc mật khẩu không đúng.")
    return create_session(username, user)


def logout(token: str) -> dict:
    with DATA_LOCK:
        sessions = read_json(SESSIONS_FILE, {}); sessions.pop(token, None); write_json(SESSIONS_FILE, sessions)
    return {"ok": True}


def current_user(handler: BaseHTTPRequestHandler) -> tuple[str, dict, str]:
    token = handler.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    username = read_json(SESSIONS_FILE, {}).get(token)
    user = read_json(USERS_FILE, {}).get(username or "")
    if not username or not user: raise PermissionError("Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.")
    return username, user, token


def data_url_to_image(data_url: str) -> np.ndarray:
    _, encoded = data_url.split(",", 1)
    image = cv2.imdecode(np.frombuffer(base64.b64decode(encoded), np.uint8), cv2.IMREAD_COLOR)
    if image is None: raise ValueError("Không thể đọc ảnh gửi lên.")
    return image


def resize_for_facebook(image: np.ndarray) -> np.ndarray:
    height, width = image.shape[:2]; longest = max(width, height)
    if longest <= FACEBOOK_MAX_SIDE: return image
    scale = FACEBOOK_MAX_SIDE / longest
    return cv2.resize(image, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)


def image_to_data_url(image: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, FACEBOOK_PREUPLOAD_JPEG_QUALITY])
    if not ok: raise ValueError("Không thể mã hóa ảnh watermark.")
    return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode()


def embed(image_data: str, account_id: str) -> dict:
    host = resize_for_facebook(data_url_to_image(image_data))
    seed, repeat_k, payload_repeat, alpha, roi_count = 42, 3, 1, 100.0, 10
    raw = text_to_bin_image(account_id, repeat_k=repeat_k, payload_repeat=payload_repeat, encoding="utf-8", payload_seed=seed) * 255
    padded, _ = pad_watermark(raw, color=255); watermark = (padded > 127).astype(np.uint8)
    marked, _, positions, safe_des, safe_kp = embed_watermark(host, watermark, alpha, roi_count, seed)
    if not positions: raise ValueError("Ảnh không có đủ vùng đặc trưng ổn định để nhúng watermark.")
    artifact_id = str(uuid.uuid4())
    original_path, marked_path, key_path = (RUNTIME / f"{artifact_id}_{suffix}" for suffix in ("original.jpg", "watermarked.jpg", "key.npz"))
    cv2.imwrite(str(original_path), host); cv2.imwrite(str(marked_path), marked)
    save_key_file(str(key_path), positions, safe_kp, safe_des, watermark.shape, raw.shape, alpha, seed, "text", account_id, "", repeat_k, payload_repeat, "utf-8", str(original_path), "", include_length_header=True)
    return {"id": artifact_id, "imageFile": marked_path.name, "keyFile": key_path.name}


def public_post(post: dict, viewer: str = "") -> dict:
    image_path = RUNTIME / post["imageFile"]
    image = cv2.imread(str(image_path))
    return {**{k: v for k, v in post.items() if k not in {"imageFile", "keyFile", "likedBy"}}, "image": image_to_data_url(image), "likes": len(post.get("likedBy", [])), "liked": viewer in post.get("likedBy", [])}


def create_post(image_data: str, caption: str, username: str, user: dict) -> dict:
    artifact = embed(image_data, user["accountId"])
    post = {"id": artifact["id"], "username": username, "author": user["displayName"], "accountId": user["accountId"], "caption": caption.strip() or "Ảnh không có tiêu đề", "imageFile": artifact["imageFile"], "keyFile": artifact["keyFile"], "createdAt": datetime.now(timezone.utc).isoformat(), "likedBy": [], "reported": False}
    with DATA_LOCK:
        posts = read_json(POSTS_FILE, []); posts.insert(0, post); write_json(POSTS_FILE, posts)
    return public_post(post, username)


def feed(username: str) -> list[dict]:
    return [public_post(post, username) for post in read_json(POSTS_FILE, [])]


def assets(username: str) -> list[dict]:
    result = []
    for post in read_json(POSTS_FILE, []):
        if post["username"] != username: continue
        item = public_post(post, username)
        item["keyBase64"] = base64.b64encode((RUNTIME / post["keyFile"]).read_bytes()).decode()
        result.append(item)
    return result


def toggle_like(post_id: str, username: str) -> dict:
    with DATA_LOCK:
        posts = read_json(POSTS_FILE, [])
        post = next((item for item in posts if item["id"] == post_id), None)
        if not post: raise ValueError("Bài viết không tồn tại.")
        liked = post.setdefault("likedBy", [])
        liked.remove(username) if username in liked else liked.append(username)
        write_json(POSTS_FILE, posts)
    return {"likes": len(liked), "liked": username in liked}


def report_post(post_id: str) -> dict:
    with DATA_LOCK:
        posts = read_json(POSTS_FILE, []); post = next((item for item in posts if item["id"] == post_id), None)
        if not post: raise ValueError("Bài viết không tồn tại.")
        post["reported"] = True; write_json(POSTS_FILE, posts)
    return {"ok": True}


def verify(image_data: str, key_base64: str, owner_id: str) -> dict:
    host = data_url_to_image(image_data)
    with tempfile.NamedTemporaryFile(suffix=".npz", delete=False) as temp:
        temp.write(base64.b64decode(key_base64)); key_path = Path(temp.name)
    try:
        key = load_key_file(str(key_path))
        padded = extract_watermark(host, key["safe_des_orig"], key["safe_kp_orig"], key["alpha"], key["pos"], key["wm_shape"], seed=key["seed"], use_affine_correction=True)
        height, width = key["orig_shape"]; recovered = padded[:height, :width]
        extracted = bin_image_to_text(recovered, repeat_k=key["repeat_k"], payload_repeat=key["payload_repeat"], encoding=key["text_encoding"], payload_seed=key["seed"]).strip()
        expected = key["text_input"]; matched = extracted == expected == owner_id
        confidence = 100.0 if matched else round(100 * sum(a == b for a, b in zip(extracted, expected)) / max(len(expected), 1), 1)
        return {"matched": matched, "extractedId": extracted, "expectedId": expected, "confidence": confidence}
    finally: key_path.unlink(missing_ok=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): print("[watermark-api] " + fmt % args)
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    def send_json(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode(); self.send_response(status); self.send_header("Content-Type", "application/json; charset=utf-8"); self.cors(); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_OPTIONS(self): self.send_response(204); self.cors(); self.end_headers()
    def do_GET(self):
        try:
            username, _, _ = current_user(self)
            if self.path == "/api/feed": result = feed(username)
            elif self.path == "/api/assets": result = assets(username)
            else: self.send_error(404); return
            self.send_json(result)
        except Exception as error: self.send_json({"error": str(error)}, 401 if isinstance(error, PermissionError) else 400)
    def do_POST(self):
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            if self.path == "/api/register": result = register(payload["username"], payload.get("displayName", ""), payload["password"])
            elif self.path == "/api/login": result = login(payload["username"], payload["password"])
            else:
                username, user, token = current_user(self)
                if self.path == "/api/logout": result = logout(token)
                elif self.path == "/api/posts": result = create_post(payload["image"], payload.get("caption", ""), username, user)
                elif self.path == "/api/like": result = toggle_like(payload["postId"], username)
                elif self.path == "/api/report": result = report_post(payload["postId"])
                elif self.path == "/api/verify": result = verify(payload["image"], payload["keyBase64"], user["accountId"])
                else: self.send_error(404); return
            self.send_json(result)
        except Exception as error: self.send_json({"error": str(error)}, 401 if isinstance(error, PermissionError) else 400)


if __name__ == "__main__":
    print("Watermark API: http://127.0.0.1:8787", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8787), Handler).serve_forever()
