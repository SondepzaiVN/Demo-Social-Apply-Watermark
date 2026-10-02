# Kế hoạch chống nhúng watermark chồng

## Mục tiêu

Trước khi nhúng watermark, hệ thống phải xác định ảnh tải lên là ảnh mới, ảnh của chính
người đăng đã được bảo vệ, hay ảnh đã được một tài khoản khác đăng ký.

## Luồng đang triển khai

1. Chuẩn hóa ảnh theo giới hạn kích thước của nền tảng.
2. Tính SHA-256 trên pixel để nhận diện bản sao chính xác.
3. Tính pHash và chỉ lấy tối đa 20 ứng viên gần nhất.
4. Dùng SIFT + RANSAC để xác minh hình học trên các ứng viên, tránh kết luận nhầm chỉ vì
   hai ảnh có bố cục hoặc màu sắc giống nhau.
5. Xử lý kết quả:
   - Ảnh mới: nhúng Account ID, tạo key và đăng ký asset.
   - Ảnh đã thuộc chính tài khoản: dùng lại ảnh watermark và key cũ, không nhúng lần hai.
   - Ảnh thuộc tài khoản khác: chặn đăng trước khi nhúng, hiển thị chủ sở hữu và Account ID;
     người đăng có thể gửi yêu cầu sử dụng.

## Quy trình cấp quyền đăng lại

1. Người muốn đăng lại gửi toàn bộ bản nháp gồm caption và danh sách ảnh từ hộp cảnh báo.
2. Chủ sở hữu nhận thông báo, xem trước bài viết hoàn chỉnh và chọn **Cho phép đăng** hoặc
   **Từ chối**.
3. Hệ thống tạo SHA-256 cho caption cùng pixel của từng ảnh. Giấy phép chỉ hợp lệ với đúng
   snapshot đã trình duyệt.
4. Khi được phép, người yêu cầu dùng nút **Đăng bài đã duyệt**; backend đăng trực tiếp snapshot,
   dùng asset, watermark và key gốc, không nhúng Account ID của người đăng lại.
5. Mỗi giấy phép chỉ dùng được một lần. Bài đã cấp quyền không được sửa caption hoặc thay ảnh.
6. Bài viết hiển thị tên và Account ID của chủ sở hữu gốc.
7. Trình xử lý report kiểm tra giấy phép để không tự động gỡ một bài đã được cấp quyền.

Yêu cầu và trạng thái cấp quyền được lưu tại `backend/runtime/license_requests.json`.
Trang cá nhân của mỗi tài khoản tổng hợp riêng hai danh sách **Các bài viết cần duyệt** và
**Đã gửi yêu cầu duyệt**, kèm preview và hành động phù hợp với vai trò hiện tại.

Registry cục bộ nằm tại `backend/runtime/asset_registry.json`. Mỗi asset giữ dấu vân tay
của cả ảnh nguồn và ảnh watermark, chủ sở hữu, file ảnh và file key.

## Lộ trình khi chuyển sang quy mô thật

- Chuyển metadata registry sang PostgreSQL.
- Lưu vector pHash/embedding trong HNSW, pgvector hoặc FAISS để truy vấn gần đúng thay vì
  duyệt tuần tự toàn bộ kho.
- Chạy đối sánh SIFT trong worker queue và cache kết quả fingerprint.
- Bổ sung trạng thái khiếu nại/kháng nghị thay vì tự động xử lý mọi trường hợp biên.
- Đánh giá ngưỡng bằng tập kiểm thử gồm resize, crop, JPEG, screenshot, chèn chữ và thay đổi
  màu; công bố precision, recall, false-positive rate và thời gian truy vấn.

