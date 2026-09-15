"""Local persistent API for Watermark Social."""
from __future__ import annotations

import base64, hashlib, hmac, json, os, re, secrets, sys, tempfile, threading, uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

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
USERS_FILE, POSTS_FILE, SESSIONS_FILE, HISTORY_FILE, NOTIFICATIONS_FILE = (RUNTIME / name for name in ("users.json", "posts.json", "sessions.json", "verification_history.json", "notifications.json"))
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


def native_path(path: Path) -> str:
    """Return a Windows extended-length path for libraries that do not add it."""
    value = str(path.resolve())
    if os.name == "nt" and not value.startswith("\\\\?\\"):
        return "\\\\?\\" + value
    return value


def unlink_file(path: Path) -> None:
    try:
        os.remove(native_path(path))
    except FileNotFoundError:
        pass


def read_file_bytes(path: Path) -> bytes:
    with open(native_path(path), "rb") as source:
        return source.read()


def read_image(path: Path) -> np.ndarray:
    """Read through NumPy so Windows long paths work with OpenCV."""
    source = native_path(path)
    if not os.path.isfile(source):
        raise FileNotFoundError(f"Không tìm thấy ảnh bài viết: {path.name}")
    image = cv2.imdecode(np.fromfile(source, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"File ảnh bài viết không hợp lệ: {path.name}")
    return image


def write_image(path: Path, image: np.ndarray) -> None:
    """Encode first, then write through NumPy for Windows long-path support."""
    ok, encoded = cv2.imencode(
        ".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, FACEBOOK_PREUPLOAD_JPEG_QUALITY]
    )
    if not ok:
        raise ValueError(f"Không thể mã hóa ảnh: {path.name}")
    destination = native_path(path)
    encoded.tofile(destination)
    if not os.path.isfile(destination) or os.path.getsize(destination) == 0:
        raise OSError(f"Không thể lưu ảnh: {path.name}")


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
    try:
        write_image(original_path, host); write_image(marked_path, marked)
        save_key_file(native_path(key_path), positions, safe_kp, safe_des, watermark.shape, raw.shape, alpha, seed, "text", account_id, "", repeat_k, payload_repeat, "utf-8", str(original_path), "", include_length_header=True)
        return {"id": artifact_id, "imageFile": marked_path.name, "keyFile": key_path.name}
    except Exception:
        for path in (original_path, marked_path, key_path): unlink_file(path)
        raise


def public_post(post: dict, viewer: str = "") -> dict:
    artifacts = post.get("artifacts") or [{"id": post["id"], "imageFile": post["imageFile"], "keyFile": post["keyFile"]}]
    images = [image_to_data_url(read_image(RUNTIME / artifact["imageFile"])) for artifact in artifacts]
    public = {k: v for k, v in post.items() if k not in {"artifacts", "imageFile", "keyFile", "likedBy"}}
    return {**public, "image": images[0], "images": images, "comments": post.get("comments", []), "likes": len(post.get("likedBy", [])), "liked": viewer in post.get("likedBy", [])}


def create_post(image_data: str | list[str], caption: str, username: str, user: dict) -> dict:
    image_items = image_data if isinstance(image_data, list) else [image_data]
    if not image_items or len(image_items) > 10:
        raise ValueError("Mỗi bài viết cần từ 1 đến 10 ảnh.")
    artifacts = []
    try:
        for item in image_items:
            artifacts.append(embed(item, user["accountId"]))
        post = {"id": str(uuid.uuid4()), "username": username, "author": user["displayName"], "accountId": user["accountId"], "caption": caption.strip(), "artifacts": artifacts, "createdAt": datetime.now(timezone.utc).isoformat(), "likedBy": [], "comments": [], "reported": False}
        # Confirm every generated image can be read before publishing metadata.
        result = public_post(post, username)
        with DATA_LOCK:
            posts = read_json(POSTS_FILE, []); posts.insert(0, post); write_json(POSTS_FILE, posts)
        return result
    except Exception:
        for artifact in artifacts:
            for field in ("imageFile", "keyFile"):
                unlink_file(RUNTIME / artifact[field])
            unlink_file(RUNTIME / f"{artifact['id']}_original.jpg")
        raise


def feed(username: str) -> list[dict]:
    result = []
    for post in read_json(POSTS_FILE, []):
        try:
            result.append(public_post(post, username))
        except (FileNotFoundError, ValueError):
            # A stale local record must not make the whole shared feed unusable.
            continue
    return result


def assets(username: str) -> list[dict]:
    result = []
    for post in read_json(POSTS_FILE, []):
        if post["username"] != username: continue
        artifacts = post.get("artifacts") or [{"id": post["id"], "imageFile": post["imageFile"], "keyFile": post["keyFile"]}]
        for artifact in artifacts:
            try:
                image = image_to_data_url(read_image(RUNTIME / artifact["imageFile"]))
                result.append({"id": artifact["id"], "postId": post["id"], "username": post["username"], "author": post["author"], "accountId": post["accountId"], "caption": post["caption"], "image": image, "createdAt": post["createdAt"], "likes": len(post.get("likedBy", [])), "liked": username in post.get("likedBy", []), "reported": post.get("reported", False), "keyBase64": base64.b64encode(read_file_bytes(RUNTIME / artifact["keyFile"])).decode()})
            except (FileNotFoundError, ValueError):
                continue
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


def add_comment(post_id: str, text: str, username: str, user: dict) -> dict:
    content = text.strip()
    if not content: raise ValueError("Nội dung bình luận không được để trống.")
    if len(content) > 1000: raise ValueError("Bình luận không được vượt quá 1000 ký tự.")
    comment = {"id": str(uuid.uuid4()), "username": username, "author": user["displayName"], "text": content, "createdAt": datetime.now(timezone.utc).isoformat()}
    with DATA_LOCK:
        posts = read_json(POSTS_FILE, [])
        post = next((item for item in posts if item["id"] == post_id), None)
        if not post: raise ValueError("Bài viết không tồn tại.")
        post.setdefault("comments", []).append(comment)
        write_json(POSTS_FILE, posts)
    return comment


def edit_post(post_id: str, caption: str, username: str) -> dict:
    content = caption.strip()
    if len(content) > 5000: raise ValueError("Nội dung bài viết không được vượt quá 5000 ký tự.")
    with DATA_LOCK:
        posts = read_json(POSTS_FILE, [])
        post = next((item for item in posts if item["id"] == post_id), None)
        if not post: raise ValueError("Bài viết không tồn tại.")
        if post.get("username") != username: raise PermissionError("Bạn chỉ có thể chỉnh sửa bài viết của mình.")
        post["caption"] = content
        write_json(POSTS_FILE, posts)
    return {"id": post_id, "caption": content}


def delete_post(post_id: str, username: str) -> dict:
    with DATA_LOCK:
        posts = read_json(POSTS_FILE, [])
        post = next((item for item in posts if item["id"] == post_id), None)
        if not post: raise ValueError("Bài viết không tồn tại.")
        if post.get("username") != username: raise PermissionError("Bạn chỉ có thể xóa bài viết của mình.")
        write_json(POSTS_FILE, [item for item in posts if item["id"] != post_id])
    artifacts = post.get("artifacts") or [{"id": post["id"], "imageFile": post.get("imageFile", ""), "keyFile": post.get("keyFile", "")}]
    for artifact in artifacts:
        for filename in (artifact.get("imageFile"), artifact.get("keyFile"), f"{artifact.get('id')}_original.jpg"):
            if filename: unlink_file(RUNTIME / filename)
    return {"ok": True, "deletedPostId": post_id}


def search_accounts(query: str) -> list[dict]:
    term = query.strip().casefold()
    if len(term) < 2: return []
    posts = read_json(POSTS_FILE, [])
    counts = {}
    for post in posts: counts[post.get("username")] = counts.get(post.get("username"), 0) + 1
    result = []
    for username, user in read_json(USERS_FILE, {}).items():
        haystack = " ".join((username, user.get("displayName", ""), str(user.get("accountId", "")))).casefold()
        if term in haystack:
            result.append({"username": username, "displayName": user.get("displayName", username), "accountId": user.get("accountId", ""), "postCount": counts.get(username, 0)})
    return result[:12]


def profile(profile_username: str, viewer: str) -> dict:
    users = read_json(USERS_FILE, {})
    user = users.get(profile_username)
    if not user: raise ValueError("Không tìm thấy tài khoản.")
    profile_posts = []
    for post in read_json(POSTS_FILE, []):
        if post.get("username") != profile_username: continue
        try: profile_posts.append(public_post(post, viewer))
        except (FileNotFoundError, ValueError): continue
    return {"username": profile_username, "displayName": user.get("displayName", profile_username), "accountId": user.get("accountId", ""), "posts": profile_posts}


def account_identity(account_id: str) -> str:
    for user in read_json(USERS_FILE, {}).values():
        if str(user.get("accountId", "")) == str(account_id):
            return user.get("displayName", "")
    return ""


def report_post(post_id: str, username: str, history_id: str) -> dict:
    with DATA_LOCK:
        posts = read_json(POSTS_FILE, [])
        post = next((item for item in posts if item["id"] == post_id), None)
        if not post: raise ValueError("Bài viết không tồn tại.")
        if post.get("username") == username: raise PermissionError("Bạn không thể báo cáo bài viết của chính mình.")
        history = read_json(HISTORY_FILE, [])
        proof = next((item for item in history if item.get("id") == history_id and item.get("username") == username and item.get("postId") == post_id), None)
        if not proof or not proof.get("matched"):
            raise PermissionError("Cần xác minh watermark hợp lệ trước khi gỡ bài viết.")
        users = read_json(USERS_FILE, {})
        claimant = users.get(username, {})
        claimant_name = claimant.get("displayName", "Chủ sở hữu")
        claimant_id = claimant.get("accountId", proof.get("extractedId", ""))
        notifications = read_json(NOTIFICATIONS_FILE, [])
        notifications.insert(0, {
            "id": str(uuid.uuid4()), "username": post["username"], "type": "copyright_removal",
            "title": "Bài viết đã bị gỡ do vi phạm bản quyền",
            "message": f"Một hình ảnh trong bài viết của bạn đã được xác minh thuộc quyền sở hữu của {claimant_name} (Account ID {claimant_id}). Bài viết đã được gỡ để bảo vệ quyền tác giả.",
            "ownerName": claimant_name, "ownerAccountId": claimant_id,
            "postCaption": post.get("caption", ""), "createdAt": datetime.now(timezone.utc).isoformat(), "read": False,
        })
        proof["action"] = "post_removed"
        posts = [item for item in posts if item["id"] != post_id]
        write_json(POSTS_FILE, posts); write_json(HISTORY_FILE, history); write_json(NOTIFICATIONS_FILE, notifications[:500])
    artifacts = post.get("artifacts") or [{"id": post["id"], "imageFile": post.get("imageFile", ""), "keyFile": post.get("keyFile", "")}]
    for artifact in artifacts:
        for filename in (artifact.get("imageFile"), artifact.get("keyFile"), f"{artifact.get('id')}_original.jpg"):
            if filename: unlink_file(RUNTIME / filename)
    return {"ok": True, "removedPostId": post_id}


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
        return {"matched": matched, "extractedId": extracted, "expectedId": expected, "extractedOwner": account_identity(extracted), "confidence": confidence}
    finally: key_path.unlink(missing_ok=True)


def record_verification(username: str, payload: dict, result: dict) -> dict:
    record = {
        "id": str(uuid.uuid4()),
        "username": username,
        "postId": str(payload.get("postId", "")),
        "imageIndex": max(0, int(payload.get("imageIndex", 0))),
        "method": "file" if payload.get("method") == "file" else "vault",
        "sourceName": str(payload.get("sourceName", ""))[:120],
        "matched": bool(result.get("matched")),
        "extractedId": str(result.get("extractedId", "")),
        "expectedId": str(result.get("expectedId", "")),
        "extractedOwner": str(result.get("extractedOwner", "")),
        "confidence": float(result.get("confidence", 0)),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    with DATA_LOCK:
        history = read_json(HISTORY_FILE, [])
        history.insert(0, record)
        write_json(HISTORY_FILE, history[:500])
    return record


def notifications(username: str) -> list[dict]:
    return [item for item in read_json(NOTIFICATIONS_FILE, []) if item.get("username") == username]


def mark_notifications_read(username: str) -> dict:
    with DATA_LOCK:
        items = read_json(NOTIFICATIONS_FILE, [])
        for item in items:
            if item.get("username") == username: item["read"] = True
        write_json(NOTIFICATIONS_FILE, items)
    return {"ok": True}


def verification_history(username: str) -> list[dict]:
    posts = {post["id"]: post for post in read_json(POSTS_FILE, [])}
    result = []
    for record in read_json(HISTORY_FILE, []):
        if record.get("username") != username:
            continue
        item = dict(record)
        post = posts.get(record.get("postId"))
        if post:
            artifacts = post.get("artifacts") or [{"imageFile": post.get("imageFile", "")}]
            index = min(record.get("imageIndex", 0), len(artifacts) - 1)
            try:
                item["image"] = image_to_data_url(read_image(RUNTIME / artifacts[index]["imageFile"]))
                item["postAuthor"] = post.get("author", "")
                item["caption"] = post.get("caption", "")
            except (FileNotFoundError, ValueError):
                item["image"] = ""
        result.append(item)
    return result


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
            parsed = urlparse(self.path); path = parsed.path; query = parse_qs(parsed.query)
            if path == "/api/feed": result = feed(username)
            elif path == "/api/assets": result = assets(username)
            elif path == "/api/verifications": result = verification_history(username)
            elif path == "/api/notifications": result = notifications(username)
            elif path == "/api/accounts/search": result = search_accounts(query.get("q", [""])[0])
            elif path == "/api/profile": result = profile(query.get("username", [username])[0], username)
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
                elif self.path == "/api/posts": result = create_post(payload.get("images") or payload["image"], payload.get("caption", ""), username, user)
                elif self.path == "/api/like": result = toggle_like(payload["postId"], username)
                elif self.path == "/api/comments": result = add_comment(payload["postId"], payload.get("text", ""), username, user)
                elif self.path == "/api/posts/edit": result = edit_post(payload["postId"], payload.get("caption", ""), username)
                elif self.path == "/api/posts/delete": result = delete_post(payload["postId"], username)
                elif self.path == "/api/report": result = report_post(payload["postId"], username, payload.get("historyId", ""))
                elif self.path == "/api/verify":
                    result = verify(payload["image"], payload["keyBase64"], user["accountId"])
                    record = record_verification(username, payload, result)
                    result["historyId"] = record["id"]
                elif self.path == "/api/notifications/read": result = mark_notifications_read(username)
                else: self.send_error(404); return
            self.send_json(result)
        except Exception as error: self.send_json({"error": str(error)}, 401 if isinstance(error, PermissionError) else 400)


if __name__ == "__main__":
    print("Watermark API: http://127.0.0.1:8787", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8787), Handler).serve_forever()
