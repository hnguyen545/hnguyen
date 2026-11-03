# HNGUYEN — Netlify + Supabase + SePay

Bản chuyển backend từ Node.js/SQLite lưu trên ổ đĩa sang Netlify Functions + Supabase Postgres + Supabase Storage. Giữ nguyên website khách, giỏ hàng, QR VietQR/SePay, trang Admin, đơn hàng, doanh thu, quản lý sản phẩm, file giao khách và form hỗ trợ.

## Kiến trúc

- `public/`: website và trang Admin (giữ nguyên giao diện).
- `netlify/functions/api.mjs`: API serverless; tạo đơn, đọc sản phẩm/trạng thái đơn, xác thực Admin, webhook SePay, tạo URL upload/download có chữ ký.
- `supabase/schema.sql`: bảng dữ liệu, seed 3 sản phẩm mẫu, RPC xử lý thanh toán SePay idempotent và bucket riêng tư.
- `supabase`: Postgres lưu sản phẩm, đơn, giao dịch, hỗ trợ.
- `hnguyen-private`: bucket riêng tư chứa file project. Không public trực tiếp.

## 1. Tạo Supabase

1. Mở https://supabase.com/dashboard và tạo project.
2. Chọn mật khẩu database mạnh, lưu lại; chọn region gần Việt Nam nếu có.
3. Vào **SQL Editor → New query**, mở file `supabase/schema.sql`, dán toàn bộ và bấm **Run**.
4. Vào **Project Settings → API** (hoặc **API Keys**): lấy Project URL và `service_role` secret key. Chỉ đặt service role key trong Netlify Environment Variables; tuyệt đối không đưa vào HTML, GitHub hay gửi cho khách.
5. Vào **Storage** kiểm tra bucket `hnguyen-private` đã được tạo và đang ở chế độ Private.

## 2. Đưa mã nguồn lên GitHub

1. Giải nén ZIP này.
2. Tạo GitHub repository mới, ví dụ `hnguyen-store`.
3. Upload toàn bộ nội dung thư mục này lên repository (không upload file `.env` thật, mật khẩu hoặc key).
4. Đảm bảo `netlify.toml`, `package.json`, `public/`, `netlify/functions/` và `supabase/schema.sql` nằm ở thư mục gốc repository.

## 3. Tạo website trên Netlify

1. Mở https://app.netlify.com/ → **Add new site → Import an existing project**.
2. Chọn GitHub và repository `hnguyen-store`.
3. Build settings: Build command `npm run build`; Publish directory `public`. `netlify.toml` đã khai báo functions directory.
4. Trước khi deploy, vào **Site configuration → Environment variables** (hoặc **Project configuration → Environment variables**) và thêm:
   - `ADMIN_USERNAME`: tên đăng nhập Admin bạn tự chọn.
   - `ADMIN_PASSWORD`: mật khẩu Admin dài, riêng biệt.
   - `SESSION_SECRET`: chuỗi ngẫu nhiên tối thiểu 32 ký tự.
   - `SUPABASE_URL`: Project URL của Supabase.
   - `SUPABASE_SERVICE_ROLE_KEY`: service_role secret của Supabase.
   - `SUPABASE_STORAGE_BUCKET`: `hnguyen-private`.
   - `SEPAY_WEBHOOK_API_KEY`: API Key tạo trong SePay.
   - `BANK_ID`: mã ngân hàng nhận tiền, ví dụ MB.
   - `BANK_ACCOUNT`: số tài khoản nhận tiền.
   - `BANK_OWNER`: tên chủ tài khoản.
5. Chọn **Deploy**. Sau khi deploy, mở `https://TEN-SITE.netlify.app/api/health`; cần nhận JSON có `ok: true`, `bankConfigured: true`.

## 4. Kết nối SePay

Trong SePay → Webhooks, tạo webhook sự kiện tiền vào, xác thực API Key và đặt URL:

`https://TEN-SITE.netlify.app/api/sepay/webhook`

API Key phải trùng chính xác với `SEPAY_WEBHOOK_API_KEY` trên Netlify. Không sử dụng URL localhost. Sau khi thay đổi biến môi trường, cần trigger deploy lại để Functions nhận cấu hình mới.

## 5. Kiểm tra chức năng

- Mở trang chủ: sản phẩm và giá được tải từ Supabase.
- Thêm sản phẩm vào giỏ, tạo đơn thử: QR phải hiển thị đúng tiền và nội dung mã `HNG...`.
- Dùng SePay gửi thử webhook: endpoint phản hồi JSON.
- Thanh toán thật một đơn nhỏ: chỉ khi webhook hợp lệ, đúng mã đơn, tiền vào và số tiền khớp thì đơn mới chuyển `paid`.
- Mở `/admin.html`: đăng nhập, kiểm tra đơn/doanh thu, thêm sản phẩm, ẩn/hiện sản phẩm, tải file lên Storage, xem và đóng yêu cầu hỗ trợ.
- Sau khi đơn `paid`, link tải được cấp bằng signed URL có thời hạn; file trong bucket không public.

## 6. File sản phẩm và giới hạn kích thước

Admin tạo signed upload URL rồi trình duyệt tải file trực tiếp lên Supabase Storage; file không đi qua Netlify Function. API không nhận nội dung file lớn, tránh giới hạn payload của Functions. Gói Supabase của project phải cho phép dung lượng file tương ứng. Nếu project chỉ cho phép file tối đa nhỏ hơn 500 MB, cần nâng giới hạn/gói hoặc giảm dung lượng file; không thể đảm bảo 500 MB chỉ bằng cấu hình bucket.

## 7. API

- `GET /api/health`
- `GET /api/products`
- `POST /api/orders`
- `GET /api/orders/:code`
- `GET /api/orders/:code/download/:productId`
- `POST /api/support`
- `POST /api/sepay/webhook`
- `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/me`
- `GET /api/admin/dashboard`
- `POST /api/admin/upload-url`
- `POST /api/admin/products`
- `POST /api/admin/products/:id/toggle`
- `POST /api/admin/support/:id/close`

## 8. Bảo mật và vận hành

- Không commit `.env`, service role key, mật khẩu Admin hoặc SePay API Key.
- Service role key chỉ tồn tại trong Netlify Functions. RLS được bật cho các bảng; không có quyền đọc/ghi công khai.
- Storage bucket là private; upload và download sử dụng URL ký tạm thời.
- RPC `process_sepay_payment` khóa đơn và chống xử lý trùng ID giao dịch, kiểm tra đúng số tiền và tài khoản nhận nếu SePay gửi trường tài khoản.
- Trước khi mở bán, hãy đổi toàn bộ secret, xác minh webhook SePay và thanh toán thử một đơn giá nhỏ.
- Không cần Render/VPS. Netlify Functions chạy khi có request; không phải tiến trình Node luôn bật 24/24. Supabase lưu dữ liệu bền vững ngoài filesystem của Netlify.

## 9. Ghi chú nâng cấp từ SQLite

Bản này đã chuyển schema và luồng ứng dụng sang Supabase, nhưng không tự động mang dữ liệu từ SQLite cũ sang. Nếu website cũ đã có đơn hàng/sản phẩm/file thật, cần xuất và nhập dữ liệu trước khi chuyển DNS hoặc mở bán trên bản mới. Ba sản phẩm mẫu được thêm nếu chưa tồn tại. File tải lên trước đây cần tải lại vào bucket Storage riêng tư.
