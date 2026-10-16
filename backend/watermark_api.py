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
USERS_FILE, POSTS_FILE, SESSIONS_FILE, HISTORY_FILE, NOTIFICATIONS_FILE, REGISTRY_FILE, LICENSES_FILE, COPYRIGHT_LOG_FILE = (
    RUNTIME / name for name in (
        "users.json", "posts.json", "sessions.json", "verification_history.json",
        "notifications.json", "asset_registry.json", "license_requests.json", "copyright_log.json",
    )
)
DATA_LOCK = threading.RLock()
FACEBOOK_MAX_SIDE, FACEBOOK_PREUPLOAD_JPEG_QUALITY = 2048, 100
PHASH_SHORTLIST_DISTANCE = 18
REGISTRY_EXTRACTION_LIMIT = 3


class ProvenanceConflict(Exception):
    """Raised when an upload matches an image registered by another account."""

    def __init__(self, details: dict):
        super().__init__("Ảnh này đã được đăng ký bản quyền bởi một tài khoản khác.")
        self.details = details


def read_json(path: Path, default):
    if not path.exists(): return default
    try: return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError): return default


def write_json(path: Path, value) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def append_copyright_event(event_type: str, participants: list[str], **details) -> dict:
    """Persist a compact audit event without storing another copy of the image."""
    record = {
        "id": str(uuid.uuid4()), "type": event_type,
        "participants": list(dict.fromkeys(item for item in participants if item)),
        "createdAt": datetime.now(timezone.utc).isoformat(), **details,
    }
    with DATA_LOCK:
        events = read_json(COPYRIGHT_LOG_FILE, [])
        events.insert(0, record)
        write_json(COPYRIGHT_LOG_FILE, events[:1000])
    return record


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


def image_sha256(image: np.ndarray) -> str:
    """Hash decoded pixels, so equivalent PNG/JPEG containers are treated alike."""
    height, width = image.shape[:2]
    digest = hashlib.sha256(f"{width}x{height}x{image.shape[2]}".encode())
    digest.update(np.ascontiguousarray(image).tobytes())
    return digest.hexdigest()


def image_phash(image: np.ndarray) -> str:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    low = cv2.dct(small)[:8, :8]
    median = float(np.median(low.flatten()[1:]))
    bits = (low >= median).flatten()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return f"{value:016x}"


def phash_distance(first: str, second: str) -> int:
    try:
        return (int(first, 16) ^ int(second, 16)).bit_count()
    except (TypeError, ValueError):
        return 64


def sift_evidence(query: np.ndarray, candidate: np.ndarray) -> dict:
    """Geometrically verify a pHash candidate to avoid similar-looking false matches."""
    sift = cv2.SIFT_create(nfeatures=1800)
    query_gray = cv2.cvtColor(query, cv2.COLOR_BGR2GRAY)
    candidate_gray = cv2.cvtColor(candidate, cv2.COLOR_BGR2GRAY)
    query_kp, query_des = sift.detectAndCompute(query_gray, None)
    candidate_kp, candidate_des = sift.detectAndCompute(candidate_gray, None)
    if query_des is None or candidate_des is None or len(query_kp) < 8 or len(candidate_kp) < 8:
        return {"matched": False, "matches": 0, "inliers": 0, "inlierRatio": 0.0}
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(query_des, candidate_des, k=2)
    good = [first for first, second in pairs if first.distance < 0.75 * second.distance]
    if len(good) < 10:
        return {"matched": False, "matches": len(good), "inliers": 0, "inlierRatio": 0.0}
    source = np.float32([query_kp[item.queryIdx].pt for item in good]).reshape(-1, 1, 2)
    target = np.float32([candidate_kp[item.trainIdx].pt for item in good]).reshape(-1, 1, 2)
    _, mask = cv2.findHomography(source, target, cv2.RANSAC, 5.0)
    inliers = int(mask.sum()) if mask is not None else 0
    ratio = inliers / max(len(good), 1)
    return {
        "matched": inliers >= 8 and ratio >= 0.35,
        "matches": len(good), "inliers": inliers, "inlierRatio": round(ratio, 3),
    }


def extract_identity_with_key(host: np.ndarray, key: dict) -> dict:
    padded = extract_watermark(
        host, key["safe_des_orig"], key["safe_kp_orig"], key["alpha"],
        key["pos"], key["wm_shape"], seed=key["seed"], use_affine_correction=True,
    )
    height, width = key["orig_shape"]
    recovered = padded[:height, :width]
    extracted_raw = bin_image_to_text(
        recovered, repeat_k=key["repeat_k"], payload_repeat=key["payload_repeat"],
        encoding=key["text_encoding"], payload_seed=key["seed"],
    ).strip()
    expected = str(key.get("text_input", "")).strip()
    # Account IDs in this application are exactly ten decimal digits. A damaged
    # payload can still decode to arbitrary UTF-8; never expose that noise as an ID.
    extracted = extracted_raw if re.fullmatch(r"\d{10}", extracted_raw) else ""
    confidence = round(
        100 * sum(first == second for first, second in zip(extracted_raw, expected)) /
        max(len(expected), 1), 1
    )
    return {
        "matched": extracted == expected and bool(expected),
        "extractedId": extracted, "expectedId": expected, "confidence": confidence,
    }


def extract_registry_identity(host: np.ndarray, item: dict) -> dict:
    key_file = item.get("keyFile", "")
    if not key_file:
        return {"matched": False, "extractedId": "", "expectedId": "", "confidence": 0.0,
                "error": "Asset không có key trích xuất."}
    try:
        result = extract_identity_with_key(host, load_key_file(native_path(RUNTIME / key_file)))
        owner_id = str(item.get("ownerAccountId", ""))
        result["matched"] = bool(result["matched"] and result["extractedId"] == owner_id)
        return result
    except Exception as error:
        return {"matched": False, "extractedId": "", "expectedId": str(item.get("ownerAccountId", "")),
                "confidence": 0.0, "error": str(error)}


def image_to_data_url(image: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, FACEBOOK_PREUPLOAD_JPEG_QUALITY])
    if not ok: raise ValueError("Không thể mã hóa ảnh watermark.")
    return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode()


def embed_image(host: np.ndarray, account_id: str) -> dict:
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


def registry_record(artifact: dict, owner_username: str, user: dict, source: np.ndarray | None = None) -> dict:
    original_path = RUNTIME / f"{artifact['id']}_original.jpg"
    marked_path = RUNTIME / artifact["imageFile"]
    original = source if source is not None else read_image(original_path)
    marked = read_image(marked_path)
    return {
        "id": artifact["id"], "ownerUsername": owner_username,
        "ownerDisplayName": user.get("displayName", owner_username),
        "ownerAccountId": str(user.get("accountId", "")),
        "imageFile": artifact["imageFile"], "keyFile": artifact["keyFile"],
        "originalFile": original_path.name,
        "sourceSha256": image_sha256(original), "watermarkedSha256": image_sha256(marked),
        "sourcePHash": image_phash(original), "watermarkedPHash": image_phash(marked),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


def ensure_asset_registry() -> list[dict]:
    """Migrate artifacts made before provenance tracking without changing their keys."""
    with DATA_LOCK:
        registry = read_json(REGISTRY_FILE, [])
        known = {item.get("id") for item in registry}
        changed = False
        users = read_json(USERS_FILE, {})
        for post in read_json(POSTS_FILE, []):
            artifacts = post.get("artifacts") or [{
                "id": post["id"], "imageFile": post.get("imageFile", ""),
                "keyFile": post.get("keyFile", ""),
            }]
            for artifact in artifacts:
                if not artifact.get("id") or artifact["id"] in known:
                    continue
                try:
                    owner = users.get(post.get("username", ""), {
                        "displayName": post.get("author", ""), "accountId": post.get("accountId", ""),
                    })
                    registry.append(registry_record(artifact, post.get("username", ""), owner))
                    known.add(artifact["id"]); changed = True
                except (FileNotFoundError, ValueError, OSError):
                    continue
        if changed or not REGISTRY_FILE.exists():
            write_json(REGISTRY_FILE, registry)
        return registry


def registered_match(image: np.ndarray, registry: list[dict]) -> dict | None:
    query_sha, query_phash = image_sha256(image), image_phash(image)
    for item in registry:
        if query_sha == item.get("sourceSha256"):
            return {
                **item, "matchMethod": "sha256-source", "pHashDistance": 0,
                "siftMatches": 0, "siftInliers": 0, "watermarkStatus": "source-original",
                "extractedId": "", "extractionConfidence": 0.0,
                "extractionCandidatesChecked": 0,
            }
        if query_sha == item.get("watermarkedSha256"):
            extraction = extract_registry_identity(image, item)
            return {
                **item, "matchMethod": "sha256-watermarked", "pHashDistance": 0,
                "siftMatches": 0, "siftInliers": 0,
                "watermarkStatus": "verified" if extraction["matched"] else "not-extracted",
                "extractedId": extraction.get("extractedId", ""),
                "extractionConfidence": extraction.get("confidence", 0.0),
                "extractionError": extraction.get("error", ""),
                "extractionCandidatesChecked": 1,
            }

    candidates = []
    for item in registry:
        distance = min(
            phash_distance(query_phash, item.get("sourcePHash", "")),
            phash_distance(query_phash, item.get("watermarkedPHash", "")),
        )
        if distance <= PHASH_SHORTLIST_DISTANCE:
            candidates.append((distance, item))
    geometric_matches = []
    for distance, item in sorted(candidates, key=lambda pair: pair[0])[:20]:
        best = None
        for filename in (item.get("imageFile"), item.get("originalFile")):
            if not filename:
                continue
            try:
                evidence = sift_evidence(image, read_image(RUNTIME / filename))
            except (FileNotFoundError, ValueError):
                continue
            if best is None or evidence["inliers"] > best["inliers"]:
                best = evidence
            if evidence["matched"]:
                geometric_matches.append({
                    **item, "matchMethod": "phash+sift", "pHashDistance": distance,
                    "siftMatches": evidence["matches"], "siftInliers": evidence["inliers"],
                    "siftInlierRatio": evidence["inlierRatio"],
                })
                break
        # Very close pHash is accepted only when both images lack enough SIFT evidence.
        if distance <= 2 and best and best["matches"] == 0 and not any(
            match.get("id") == item.get("id") for match in geometric_matches
        ):
            geometric_matches.append({
                **item, "matchMethod": "phash", "pHashDistance": distance,
                "siftMatches": 0, "siftInliers": 0, "siftInlierRatio": 0.0,
            })

    if not geometric_matches:
        return None
    geometric_matches.sort(key=lambda item: (-item.get("siftInliers", 0), item["pHashDistance"]))
    extraction_results = []
    for candidate in geometric_matches[:REGISTRY_EXTRACTION_LIMIT]:
        extraction = extract_registry_identity(image, candidate)
        enriched = {
            **candidate,
            "watermarkStatus": "verified" if extraction["matched"] else "not-extracted",
            "extractedId": extraction.get("extractedId", ""),
            "extractionConfidence": extraction.get("confidence", 0.0),
            "extractionError": extraction.get("error", ""),
            "extractionCandidatesChecked": len(extraction_results) + 1,
            "geometricCandidateCount": len(geometric_matches),
        }
        extraction_results.append(enriched)
        if extraction["matched"]:
            enriched["matchMethod"] = "phash+sift+watermark"
            return enriched

    # A geometrically strong match may be an original image that never contained a watermark,
    # or a heavily attacked copy. Keep it related to the registered asset, but expose that the
    # embedded identity could not be recovered instead of incorrectly treating it as a new image.
    best_match = extraction_results[0]
    best_match["extractionCandidatesChecked"] = len(extraction_results)
    return best_match


def artifact_from_registry(item: dict) -> dict:
    return {"id": item["id"], "imageFile": item["imageFile"], "keyFile": item["keyFile"]}


def draft_fingerprint(caption: str, images: list[np.ndarray]) -> str:
    snapshot = {"caption": caption.strip(), "images": [image_sha256(image) for image in images]}
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def approved_license(asset_id: str, requester_username: str, draft_hash: str, request_id: str) -> dict | None:
    return next((item for item in read_json(LICENSES_FILE, []) if
                 item.get("assetId") == asset_id and
                 item.get("requesterUsername") == requester_username and
                 item.get("status") == "approved" and
                 not item.get("consumedAt") and
                 item.get("draftHash") == draft_hash and
                 item.get("id") == request_id), None)


def public_post(post: dict, viewer: str = "") -> dict:
    artifacts = post.get("artifacts") or [{"id": post["id"], "imageFile": post["imageFile"], "keyFile": post["keyFile"]}]
    images = [image_to_data_url(read_image(RUNTIME / artifact["imageFile"])) for artifact in artifacts]
    public = {k: v for k, v in post.items() if k not in {"artifacts", "imageFile", "keyFile", "likedBy"}}
    return {**public, "image": images[0], "images": images, "comments": post.get("comments", []), "likes": len(post.get("likedBy", [])), "liked": viewer in post.get("likedBy", [])}


def create_post(image_data: str | list[str], caption: str, username: str, user: dict, license_request_id: str = "") -> dict:
    image_items = image_data if isinstance(image_data, list) else [image_data]
    if not image_items or len(image_items) > 10:
        raise ValueError("Mỗi bài viết cần từ 1 đến 10 ảnh.")
    hosts = [resize_for_facebook(data_url_to_image(item)) for item in image_items]
    current_draft_hash = draft_fingerprint(caption, hosts)
    artifacts, created_artifacts, new_records = [], [], []
    used_permissions = []
    reused_count = licensed_count = 0
    try:
        with DATA_LOCK:
            registry = ensure_asset_registry()
            for index, host in enumerate(hosts):
                matched = registered_match(host, registry)
                license_record = approved_license(
                    matched.get("id", ""), username, current_draft_hash, license_request_id
                ) if matched else None
                if matched and matched.get("ownerUsername") != username and not license_record:
                    conflict = {
                        "imageIndex": index, "assetId": matched.get("id", ""),
                        "ownerUsername": matched.get("ownerUsername", ""),
                        "ownerDisplayName": matched.get("ownerDisplayName", ""),
                        "ownerAccountId": matched.get("ownerAccountId", ""),
                        "registeredAt": matched.get("createdAt", ""),
                        "matchMethod": matched.get("matchMethod", ""),
                        "pHashDistance": matched.get("pHashDistance"),
                        "siftMatches": matched.get("siftMatches"),
                        "siftInliers": matched.get("siftInliers"),
                        "watermarkStatus": matched.get("watermarkStatus", "not-extracted"),
                        "extractedId": matched.get("extractedId", ""),
                        "extractionConfidence": matched.get("extractionConfidence", 0.0),
                        "extractionCandidatesChecked": matched.get("extractionCandidatesChecked", 0),
                        "geometricCandidateCount": matched.get("geometricCandidateCount", 0),
                    }
                    append_copyright_event(
                        "upload_blocked", [username, conflict["ownerUsername"]],
                        assetId=conflict["assetId"], ownerUsername=conflict["ownerUsername"],
                        ownerDisplayName=conflict["ownerDisplayName"],
                        ownerAccountId=conflict["ownerAccountId"],
                        actorUsername=username, actorDisplayName=user.get("displayName", username),
                        actorAccountId=str(user.get("accountId", "")), caption=caption.strip(),
                        matchMethod=conflict["matchMethod"], watermarkStatus=conflict["watermarkStatus"],
                        extractedId=conflict["extractedId"],
                        extractionConfidence=conflict["extractionConfidence"],
                    )
                    raise ProvenanceConflict(conflict)
                if matched:
                    artifacts.append(artifact_from_registry(matched))
                    if matched.get("ownerUsername") == username:
                        reused_count += 1
                    else:
                        licensed_count += 1; used_permissions.append(license_record)
                    continue
                artifact = embed_image(host, user["accountId"])
                record = registry_record(artifact, username, user, host)
                artifacts.append(artifact); created_artifacts.append(artifact)
                new_records.append(record); registry.append(record)

            provenance = {
                "status": "licensed" if licensed_count else "reused" if reused_count else "new",
                "reusedCount": reused_count, "licensedCount": licensed_count,
                "newCount": len(new_records),
            }
            licenses = [{
                "requestId": permission["id"], "assetId": permission["assetId"],
                "ownerUsername": permission["ownerUsername"],
                "ownerDisplayName": permission["ownerDisplayName"],
                "ownerAccountId": permission["ownerAccountId"],
                "approvedAt": permission.get("respondedAt", ""),
                "draftHash": permission.get("draftHash", ""),
            } for permission in used_permissions if permission]
            post = {"id": str(uuid.uuid4()), "username": username, "author": user["displayName"], "accountId": user["accountId"], "caption": caption.strip(), "artifacts": artifacts, "provenance": provenance, "licenses": licenses, "createdAt": datetime.now(timezone.utc).isoformat(), "likedBy": [], "comments": [], "reported": False}
            # Confirm every generated/reused image can be read before publishing metadata.
            result = public_post(post, username)
            posts = read_json(POSTS_FILE, []); posts.insert(0, post)
            write_json(REGISTRY_FILE, registry); write_json(POSTS_FILE, posts)
            for record in new_records:
                append_copyright_event(
                    "asset_registered", [username], assetId=record["id"],
                    ownerUsername=username, ownerDisplayName=user.get("displayName", username),
                    ownerAccountId=str(user.get("accountId", "")),
                    actorUsername=username, actorDisplayName=user.get("displayName", username),
                    actorAccountId=str(user.get("accountId", "")), caption=caption.strip(),
                    matchMethod="new", watermarkStatus="embedded",
                    extractedId=str(user.get("accountId", "")),
                )
        return result
    except Exception:
        for artifact in created_artifacts:
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
    posts = read_json(POSTS_FILE, [])
    for item in ensure_asset_registry():
        if item.get("ownerUsername") != username:
            continue
        post = next((candidate for candidate in posts if any(
            artifact.get("id") == item.get("id") for artifact in candidate.get("artifacts", [])
        )), {})
        try:
            result.append({
                "id": item["id"], "postId": post.get("id", ""), "username": username,
                "author": item.get("ownerDisplayName", ""), "accountId": item.get("ownerAccountId", ""),
                "caption": "", "image": image_to_data_url(read_image(RUNTIME / item["imageFile"])),
                "createdAt": item.get("createdAt", ""), "likes": 0, "liked": False,
                "reported": False,
                "keyBase64": base64.b64encode(read_file_bytes(RUNTIME / item["keyFile"])).decode(),
            })
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
        if post.get("licenses"):
            raise PermissionError("Bài viết được cấp quyền phải giữ nguyên nội dung đã được chủ sở hữu duyệt.")
        post["caption"] = content
        write_json(POSTS_FILE, posts)
    return {"id": post_id, "caption": content}


def release_unreferenced_assets(removed_post: dict, remaining_posts: list[dict]) -> None:
    """Only remove shared artifact files after their final post reference disappears."""
    removed = removed_post.get("artifacts") or [{
        "id": removed_post["id"], "imageFile": removed_post.get("imageFile", ""),
        "keyFile": removed_post.get("keyFile", ""),
    }]
    referenced = {
        artifact.get("id")
        for post in remaining_posts
        for artifact in (post.get("artifacts") or [{"id": post.get("id")}])
    }
    releasable = {artifact.get("id") for artifact in removed if artifact.get("id") not in referenced}
    registry = ensure_asset_registry()
    by_id = {item.get("id"): item for item in registry}
    for artifact_id in releasable:
        item = by_id.get(artifact_id, {})
        fallback = next((artifact for artifact in removed if artifact.get("id") == artifact_id), {})
        for filename in (
            item.get("imageFile") or fallback.get("imageFile"),
            item.get("keyFile") or fallback.get("keyFile"),
            item.get("originalFile") or f"{artifact_id}_original.jpg",
        ):
            if filename:
                unlink_file(RUNTIME / filename)
    write_json(REGISTRY_FILE, [item for item in registry if item.get("id") not in releasable])


def delete_post(post_id: str, username: str) -> dict:
    with DATA_LOCK:
        posts = read_json(POSTS_FILE, [])
        post = next((item for item in posts if item["id"] == post_id), None)
        if not post: raise ValueError("Bài viết không tồn tại.")
        if post.get("username") != username: raise PermissionError("Bạn chỉ có thể xóa bài viết của mình.")
        remaining = [item for item in posts if item["id"] != post_id]
        write_json(POSTS_FILE, remaining)
        release_unreferenced_assets(post, remaining)
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
        artifacts = post.get("artifacts", [])
        image_index = min(max(0, int(proof.get("imageIndex", 0))), max(0, len(artifacts) - 1))
        asset_id = artifacts[image_index].get("id", "") if artifacts else ""
        permission = next((item for item in post.get("licenses", []) if
                           item.get("assetId") == asset_id and
                           item.get("ownerUsername") == username), None)
        if permission:
            raise PermissionError("Bạn đã cấp quyền sử dụng ảnh này cho người đăng nên bài viết không vi phạm bản quyền.")
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
        release_unreferenced_assets(post, posts)
    return {"ok": True, "removedPostId": post_id}


def verify(image_data: str, key_base64: str, owner_id: str) -> dict:
    host = data_url_to_image(image_data)
    with tempfile.NamedTemporaryFile(suffix=".npz", delete=False) as temp:
        temp.write(base64.b64decode(key_base64)); key_path = Path(temp.name)
    try:
        key = load_key_file(str(key_path))
        result = extract_identity_with_key(host, key)
        result["matched"] = bool(result["matched"] and result["extractedId"] == owner_id)
        result["extractedOwner"] = account_identity(result["extractedId"])
        return result
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
    requests = {item.get("id"): item for item in read_json(LICENSES_FILE, [])}
    result = []
    for source in read_json(NOTIFICATIONS_FILE, []):
        if source.get("username") != username:
            continue
        item = dict(source)
        request = requests.get(item.get("requestId"))
        if request:
            item["draftCaption"] = request.get("draftCaption", "")
            item["draftImages"] = request.get("draftImages", [])
            item["licensedImageIndex"] = request.get("imageIndex", 0)
            item["requestStatus"] = "published" if request.get("consumedAt") else request.get("status", item.get("requestStatus"))
        result.append(item)
    return result


def license_center(username: str) -> dict:
    def public_request(source: dict) -> dict:
        status = "published" if source.get("consumedAt") else source.get("status", "pending")
        return {
            "id": source.get("id", ""), "assetId": source.get("assetId", ""),
            "status": status, "ownerUsername": source.get("ownerUsername", ""),
            "ownerDisplayName": source.get("ownerDisplayName", ""),
            "ownerAccountId": source.get("ownerAccountId", ""),
            "requesterUsername": source.get("requesterUsername", ""),
            "requesterDisplayName": source.get("requesterDisplayName", ""),
            "requesterAccountId": source.get("requesterAccountId", ""),
            "draftCaption": source.get("draftCaption", ""),
            "draftImages": source.get("draftImages", []),
            "imageIndex": source.get("imageIndex", 0),
            "createdAt": source.get("createdAt", ""),
            "respondedAt": source.get("respondedAt", ""),
            "postId": source.get("postId", ""),
        }

    requests = read_json(LICENSES_FILE, [])
    return {
        "incoming": [public_request(item) for item in requests if item.get("ownerUsername") == username],
        "outgoing": [public_request(item) for item in requests if item.get("requesterUsername") == username],
    }


def request_image_license(asset_id: str, payload: dict, username: str, user: dict) -> dict:
    image_items = payload.get("images") or []
    if not isinstance(image_items, list) or not image_items or len(image_items) > 10:
        raise ValueError("Bản nháp xin quyền cần từ 1 đến 10 ảnh.")
    caption = str(payload.get("caption", "")).strip()
    if len(caption) > 5000:
        raise ValueError("Nội dung bài viết không được vượt quá 5000 ký tự.")
    image_index = max(0, min(int(payload.get("imageIndex", 0)), len(image_items) - 1))
    hosts = [resize_for_facebook(data_url_to_image(item)) for item in image_items]
    draft_hash = draft_fingerprint(caption, hosts)
    with DATA_LOCK:
        registry = ensure_asset_registry()
        asset = next((item for item in registry if item.get("id") == asset_id), None)
        if not asset:
            raise ValueError("Ảnh bản quyền này không còn tồn tại.")
        if asset.get("ownerUsername") == username:
            raise ValueError("Bạn đã là chủ sở hữu của ảnh này.")
        matched = registered_match(hosts[image_index], registry)
        if not matched or matched.get("id") != asset_id:
            raise ValueError("Ảnh trong bản nháp không còn khớp với tài sản bản quyền đã phát hiện.")
        requests = read_json(LICENSES_FILE, [])
        existing = next((item for item in requests if
                         item.get("assetId") == asset_id and
                         item.get("requesterUsername") == username and
                         item.get("draftHash") == draft_hash and
                         item.get("status") in {"pending", "approved"}), None)
        if existing:
            return {**existing, "alreadyExists": True}
        now = datetime.now(timezone.utc).isoformat()
        record = {
            "id": str(uuid.uuid4()), "assetId": asset_id, "status": "pending",
            "ownerUsername": asset.get("ownerUsername", ""),
            "ownerDisplayName": asset.get("ownerDisplayName", ""),
            "ownerAccountId": asset.get("ownerAccountId", ""),
            "requesterUsername": username, "requesterDisplayName": user.get("displayName", username),
            "requesterAccountId": str(user.get("accountId", "")),
            "draftCaption": caption, "draftImages": image_items,
            "draftImageHashes": [image_sha256(image) for image in hosts],
            "draftHash": draft_hash, "imageIndex": image_index, "createdAt": now,
        }
        requests.insert(0, record)
        alerts = read_json(NOTIFICATIONS_FILE, [])
        alerts.insert(0, {
            "id": str(uuid.uuid4()), "username": record["ownerUsername"],
            "type": "license_request", "requestId": record["id"], "requestStatus": "pending",
            "title": "Yêu cầu sử dụng ảnh bản quyền",
            "message": f"{record['requesterDisplayName']} (Account ID {record['requesterAccountId']}) muốn đăng lại một ảnh thuộc kho bản quyền của bạn.",
            "requesterName": record["requesterDisplayName"],
            "requesterAccountId": record["requesterAccountId"],
            "createdAt": now, "read": False,
        })
        write_json(LICENSES_FILE, requests); write_json(NOTIFICATIONS_FILE, alerts[:500])
        append_copyright_event(
            "license_requested", [record["ownerUsername"], username],
            requestId=record["id"], assetId=asset_id,
            ownerUsername=record["ownerUsername"], ownerDisplayName=record["ownerDisplayName"],
            ownerAccountId=record["ownerAccountId"], actorUsername=username,
            actorDisplayName=record["requesterDisplayName"],
            actorAccountId=record["requesterAccountId"], caption=caption,
            matchMethod=matched.get("matchMethod", ""),
            watermarkStatus=matched.get("watermarkStatus", "not-extracted"),
            extractedId=matched.get("extractedId", ""),
        )
        return record


def respond_image_license(request_id: str, decision: str, username: str) -> dict:
    if decision not in {"approved", "denied"}:
        raise ValueError("Phản hồi yêu cầu không hợp lệ.")
    with DATA_LOCK:
        requests = read_json(LICENSES_FILE, [])
        record = next((item for item in requests if item.get("id") == request_id), None)
        if not record:
            raise ValueError("Yêu cầu sử dụng ảnh không tồn tại.")
        if record.get("ownerUsername") != username:
            raise PermissionError("Chỉ chủ sở hữu ảnh mới có thể phản hồi yêu cầu này.")
        if record.get("status") != "pending":
            return {"id": request_id, "status": record.get("status")}
        now = datetime.now(timezone.utc).isoformat()
        record["status"] = decision; record["respondedAt"] = now
        alerts = read_json(NOTIFICATIONS_FILE, [])
        for alert in alerts:
            if alert.get("requestId") == request_id and alert.get("username") == username:
                alert["requestStatus"] = decision; alert["read"] = True
        approved = decision == "approved"
        alerts.insert(0, {
            "id": str(uuid.uuid4()), "username": record["requesterUsername"],
            "type": "license_response", "requestId": request_id, "requestStatus": decision,
            "title": "Yêu cầu sử dụng ảnh đã được chấp thuận" if approved else "Yêu cầu sử dụng ảnh bị từ chối",
            "message": (
                f"{record['ownerDisplayName']} đã duyệt bản nháp. Bạn có thể đăng chính xác bài viết đã được duyệt bằng nút bên dưới."
                if approved else
                f"{record['ownerDisplayName']} chưa đồng ý cho bạn sử dụng ảnh này. Bạn không thể đăng lại ảnh."
            ),
            "ownerName": record["ownerDisplayName"], "ownerAccountId": record["ownerAccountId"],
            "createdAt": now, "read": False,
        })
        write_json(LICENSES_FILE, requests); write_json(NOTIFICATIONS_FILE, alerts[:500])
        append_copyright_event(
            "license_approved" if approved else "license_denied",
            [record["ownerUsername"], record["requesterUsername"]],
            requestId=request_id, assetId=record["assetId"],
            ownerUsername=record["ownerUsername"], ownerDisplayName=record["ownerDisplayName"],
            ownerAccountId=record["ownerAccountId"],
            actorUsername=record["requesterUsername"],
            actorDisplayName=record["requesterDisplayName"],
            actorAccountId=record["requesterAccountId"],
            caption=record.get("draftCaption", ""),
        )
        return {"id": request_id, "status": decision}


def publish_approved_license(request_id: str, username: str, user: dict) -> dict:
    with DATA_LOCK:
        requests = read_json(LICENSES_FILE, [])
        record = next((item for item in requests if item.get("id") == request_id), None)
        if not record:
            raise ValueError("Yêu cầu sử dụng ảnh không tồn tại.")
        if record.get("requesterUsername") != username:
            raise PermissionError("Chỉ người gửi yêu cầu mới có thể đăng bản nháp này.")
        if record.get("status") != "approved":
            raise PermissionError("Bản nháp chưa được chủ sở hữu chấp thuận.")
        if record.get("consumedAt"):
            raise ValueError("Bản nháp được cấp quyền này đã được đăng trước đó.")
        post = create_post(
            record.get("draftImages", []), record.get("draftCaption", ""),
            username, user, license_request_id=request_id,
        )
        # Re-read because create_post also acquires the shared lock and writes post metadata.
        requests = read_json(LICENSES_FILE, [])
        record = next(item for item in requests if item.get("id") == request_id)
        record["consumedAt"] = datetime.now(timezone.utc).isoformat()
        record["postId"] = post["id"]
        alerts = read_json(NOTIFICATIONS_FILE, [])
        for alert in alerts:
            if alert.get("requestId") == request_id:
                alert["requestStatus"] = "published"
        write_json(LICENSES_FILE, requests); write_json(NOTIFICATIONS_FILE, alerts)
        append_copyright_event(
            "licensed_post_published", [record["ownerUsername"], record["requesterUsername"]],
            requestId=request_id, assetId=record["assetId"], postId=post["id"],
            ownerUsername=record["ownerUsername"], ownerDisplayName=record["ownerDisplayName"],
            ownerAccountId=record["ownerAccountId"],
            actorUsername=record["requesterUsername"],
            actorDisplayName=record["requesterDisplayName"],
            actorAccountId=record["requesterAccountId"], caption=record.get("draftCaption", ""),
        )
        return post


def mark_notifications_read(username: str) -> dict:
    with DATA_LOCK:
        items = read_json(NOTIFICATIONS_FILE, [])
        for item in items:
            if item.get("username") == username: item["read"] = True
        write_json(NOTIFICATIONS_FILE, items)
    return {"ok": True}


def copyright_log(username: str) -> list[dict]:
    """Return automatic provenance and permission events visible to this account."""
    events = list(read_json(COPYRIGHT_LOG_FILE, []))
    known = {(item.get("type"), item.get("requestId")) for item in events if item.get("requestId")}
    registry_items = ensure_asset_registry()
    registered_assets = {item.get("assetId") for item in events if item.get("type") == "asset_registered"}

    for asset in registry_items:
        asset_id = asset.get("id", "")
        if asset_id in registered_assets:
            continue
        events.append({
            "id": f"legacy-asset-{asset_id}", "type": "asset_registered",
            "participants": [asset.get("ownerUsername", "")], "assetId": asset_id,
            "ownerUsername": asset.get("ownerUsername", ""),
            "ownerDisplayName": asset.get("ownerDisplayName", ""),
            "ownerAccountId": asset.get("ownerAccountId", ""),
            "actorUsername": asset.get("ownerUsername", ""),
            "actorDisplayName": asset.get("ownerDisplayName", ""),
            "actorAccountId": asset.get("ownerAccountId", ""),
            "createdAt": asset.get("createdAt", ""), "matchMethod": "new",
            "watermarkStatus": "embedded", "extractedId": asset.get("ownerAccountId", ""),
        })

    # Existing license data predates the audit log. Project it into the new view so
    # users do not lose context when upgrading from the manual verification screen.
    for request in read_json(LICENSES_FILE, []):
        common = {
            "participants": [request.get("ownerUsername", ""), request.get("requesterUsername", "")],
            "requestId": request.get("id", ""), "assetId": request.get("assetId", ""),
            "ownerUsername": request.get("ownerUsername", ""),
            "ownerDisplayName": request.get("ownerDisplayName", ""),
            "ownerAccountId": request.get("ownerAccountId", ""),
            "actorUsername": request.get("requesterUsername", ""),
            "actorDisplayName": request.get("requesterDisplayName", ""),
            "actorAccountId": request.get("requesterAccountId", ""),
            "caption": request.get("draftCaption", ""),
        }
        request_id = request.get("id", "")
        if ("license_requested", request_id) not in known:
            events.append({"id": f"legacy-request-{request_id}", "type": "license_requested",
                           "createdAt": request.get("createdAt", ""), **common})
        final_type = "licensed_post_published" if request.get("consumedAt") else (
            "license_approved" if request.get("status") == "approved" else
            "license_denied" if request.get("status") == "denied" else ""
        )
        if final_type and (final_type, request_id) not in known:
            events.append({"id": f"legacy-result-{request_id}", "type": final_type,
                           "createdAt": request.get("consumedAt") or request.get("respondedAt", ""),
                           "postId": request.get("postId", ""), **common})

    registry = {item.get("id"): item for item in registry_items}
    result = []
    for source in events:
        if username not in source.get("participants", []):
            continue
        item = dict(source)
        item["perspective"] = "owner" if source.get("ownerUsername") == username else "requester"
        asset = registry.get(source.get("assetId"))
        if asset and asset.get("imageFile"):
            try:
                item["image"] = image_to_data_url(read_image(RUNTIME / asset["imageFile"]))
            except (FileNotFoundError, ValueError):
                item["image"] = ""
        result.append(item)
    return sorted(result, key=lambda item: item.get("createdAt", ""), reverse=True)


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
            elif path == "/api/copyright-log": result = copyright_log(username)
            elif path == "/api/verifications": result = verification_history(username)
            elif path == "/api/notifications": result = notifications(username)
            elif path == "/api/licenses": result = license_center(username)
            elif path == "/api/accounts/search": result = search_accounts(query.get("q", [""])[0])
            elif path == "/api/profile": result = profile(query.get("username", [username])[0], username)
            else: self.send_error(404); return
            self.send_json(result)
        except Exception as error:
            status = 401 if isinstance(error, PermissionError) else 409 if isinstance(error, ProvenanceConflict) else 400
            body = {"error": str(error)}
            if isinstance(error, ProvenanceConflict):
                body.update({"code": "PROVENANCE_CONFLICT", "details": error.details})
            self.send_json(body, status)
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
                elif self.path == "/api/licenses/request": result = request_image_license(payload["assetId"], payload, username, user)
                elif self.path == "/api/licenses/respond": result = respond_image_license(payload["requestId"], payload["decision"], username)
                elif self.path == "/api/licenses/publish": result = publish_approved_license(payload["requestId"], username, user)
                elif self.path == "/api/verify":
                    result = verify(payload["image"], payload["keyBase64"], user["accountId"])
                    record = record_verification(username, payload, result)
                    result["historyId"] = record["id"]
                elif self.path == "/api/notifications/read": result = mark_notifications_read(username)
                else: self.send_error(404); return
            self.send_json(result)
        except Exception as error:
            status = 401 if isinstance(error, PermissionError) else 409 if isinstance(error, ProvenanceConflict) else 400
            body = {"error": str(error)}
            if isinstance(error, ProvenanceConflict):
                body.update({"code": "PROVENANCE_CONFLICT", "details": error.details})
            self.send_json(body, status)


if __name__ == "__main__":
    print("Watermark API: http://127.0.0.1:8787", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8787), Handler).serve_forever()
