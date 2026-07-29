# Release Checklist — z-zero-mcp-server

Mỗi lần release npm, đi đủ các bước sau **theo thứ tự**. Đừng bỏ bước 5-8 — bước 7 là lý do MCP Registry từng stale ở 1.3.4 suốt nhiều tháng, và bước 6 (khác repo) là lý do agent cũ không được báo nâng cấp.

## 1. Bump version
```bash
npm version patch --no-git-tag-version   # hoặc minor/major
```

## 2. Sync server.json
Sửa **cả 2 chỗ** version trong `server.json` (root `version` + `packages[0].version`) cho khớp `package.json`. Kiểm tra luôn `websiteUrl` = https://z-zero.xyz.

## 3. Build + smoke test
```bash
npm run build
```
Smoke: pipe `initialize` + `tools/list` vào `node dist/index.js`, xác nhận `serverInfo.version` = version mới.

## 4. Publish npm
```bash
npm publish
```
(Cần `npm login` còn hạn. Verify: `npm view z-zero-mcp-server version`.)

## 5. Commit + push
```bash
git add package.json package-lock.json server.json && git commit -m "release: vX.Y.Z" && git push
```

## 6. Sync `/api/version` bên DASHBOARD ← KHÁC REPO, DỄ QUÊN NHẤT & HẬU QUẢ NẶNG NHẤT

Repo `z-zero-dashboard` → `src/app/api/version/route.ts`:
- `LATEST_MCP_VERSION` = version vừa publish.
- Thêm 1 dòng vào `RELEASE_NOTES` cho version đó (agent ĐỌC câu này để biết vì sao phải nâng).
- Nếu homepage có nhãn version (`MCP_VERSION` trong `src/app/page.tsx`) + dòng SHIPPED thì cập nhật cùng lượt.
- Build + push (push main = deploy).

**Vì sao không được bỏ:** đây là **kênh DUY NHẤT** báo cho agent đang chạy bản cũ biết mình lỗi thời — MCP gửi header `X-MCP-Version`, backend so với `LATEST_MCP_VERSION` rồi trả cảnh báo. Để lệch thì:
- agent cũ **không bao giờ được nhắc nâng cấp** → nó tiếp tục chạy bản có lỗi đã sửa;
- nguy hiểm nhất là các bản **trước 1.6** (trỏ API về host cũ `clawcard.store`, giờ 301 sang z-zero.xyz — redirect cross-domain **làm rơi header Authorization** → gọi API fail, và fail IM LẶNG);
- lệch ngược (endpoint ghi version cao hơn npm) thì agent bị bảo nâng lên bản không tồn tại.

⚠️ Làm bước này **SAU** khi npm publish xong (bước 4) — quảng bá một version chưa có trên npm là đẩy agent vào ngõ cụt.

*(Sự cố có thật: 29/07/2026 npm đã 1.6.1 trong khi endpoint còn 1.5.1 — trôi 2 version qua đúng đợt đổi domain.)*

## 7. Republish MCP Registry ← BƯỚC HAY QUÊN
```bash
mcp-publisher login github   # auth GitHub (namespace io.github.Dempty-glitch), chỉ cần khi token hết hạn
mcp-publisher publish        # chạy từ root repo, đọc server.json
```

## 8. Verify registry
```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=z-zero"
```
Phải thấy version mới + websiteUrl https://z-zero.xyz. Registry chỉ nhận version đã tồn tại trên npm — nên bước này luôn SAU bước 4.

## Ghi chú Socket.dev (score supply-chain)
- **Đừng thêm lại `postinstall`** vào package.json — install script là alert Socket phạt nặng (đã gỡ ở 1.6.1; playwright tự tải browser khi install, không cần echo nhắc).
- **Giữ block `overrides`** (map 8 polyfill sang `@socketregistry/*`) — đó là fix cho "Dependencies have 8 high alerts". Xoá block này là score tụt lại.
- Socket index version mới chậm vài ngày; check tại https://socket.dev/npm/package/z-zero-mcp-server
