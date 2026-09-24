# Ảnh chạy cho Fly.io (hoặc bất kỳ nền tảng nào nhận Docker).
#
# Dự án không có dependency npm nào nên không có bước `npm install`: chỉ cần
# Node đủ mới cho type-stripping và node:sqlite, rồi chép mã nguồn vào.
# L-06: ghim theo digest (multi-arch index của node:24-alpine, 24/09/2026) để build tái lập được; cập nhật digest có chủ đích.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app

# Chép trước phần ít đổi để tận dụng cache tầng ảnh.
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY README.md ./

# Thư mục dữ liệu SQLite. Gắn volume vào đây nếu muốn giữ dữ liệu qua các lần
# khởi động lại; không gắn thì `seedIfEmpty()` tự nạp lại dữ liệu mẫu.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

ENV PORT=8080
EXPOSE 8080

# Chạy bằng người dùng không phải root.
USER node

CMD ["node", "src/main.ts"]
