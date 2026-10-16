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
5. Xếp hạng các ảnh đã vượt qua SIFT + RANSAC theo số inlier và khoảng cách pHash.
6. Với tối đa 3 ứng viên hình học tốt nhất, lần lượt nạp file key `.npz` của chính ứng viên đó,
   trích xuất watermark từ ảnh tải lên và đối chiếu ID đọc được với Account ID trong registry.
   Dừng ngay khi tìm được một ID hợp lệ trùng khớp.
7. Xử lý kết quả:
   - Ảnh mới: nhúng Account ID, tạo key và đăng ký asset.
   - Ảnh đã thuộc chính tài khoản: dùng lại ảnh watermark và key cũ, không nhúng lần hai.
   - Ảnh thuộc tài khoản khác: chặn đăng trước khi nhúng, hiển thị chủ sở hữu và Account ID;
     người đăng có thể gửi yêu cầu sử dụng.

Nếu SIFT + RANSAC xác nhận ảnh cùng nguồn nhưng watermark đã bị crop/nén/resize quá mạnh nên
không đọc lại được ID, hệ thống vẫn xem đây là ảnh liên quan thay vì ảnh mới. Giao diện phải ghi
rõ trạng thái **không khôi phục được ID**, không được giả vờ rằng bước trích xuất đã thành công.

Ảnh nguồn trùng tuyệt đối là trường hợp riêng: nó chưa từng chứa watermark, vì vậy hệ thống xác
nhận bằng SHA-256 của ảnh nguồn và không chạy bước trích xuất vốn chắc chắn không có dữ liệu để đọc.

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

Menu **Lịch sử xác minh** thủ công được thay bằng **Nhật ký bản quyền** tự động. Nhật ký ghi
việc đăng ký ảnh mới, chặn lượt đăng ảnh trùng, gửi yêu cầu sử dụng, duyệt/từ chối và đăng bài
đã được cấp quyền. File key `.npz` vẫn được chủ sở hữu tải về làm bằng chứng dự phòng, nhưng
không còn là thao tác bắt buộc trong luồng kiểm tra chính của giao diện.

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

