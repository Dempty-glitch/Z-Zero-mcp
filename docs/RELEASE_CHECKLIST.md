# Release Checklist — z-zero-mcp-server

Mỗi lần release npm, đi đủ các bước sau **theo thứ tự**. Đừng bỏ bước 5-7 — đó là lý do MCP Registry từng stale ở 1.3.4 suốt nhiều tháng.

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

## 6. Republish MCP Registry ← BƯỚC HAY QUÊN
```bash
mcp-publisher login github   # auth GitHub (namespace io.github.Dempty-glitch), chỉ cần khi token hết hạn
mcp-publisher publish        # chạy từ root repo, đọc server.json
```

## 7. Verify registry
```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=z-zero"
```
Phải thấy version mới + websiteUrl https://z-zero.xyz. Registry chỉ nhận version đã tồn tại trên npm — nên bước này luôn SAU bước 4.

## Ghi chú Socket.dev (score supply-chain)
- **Đừng thêm lại `postinstall`** vào package.json — install script là alert Socket phạt nặng (đã gỡ ở 1.6.1; playwright tự tải browser khi install, không cần echo nhắc).
- **Giữ block `overrides`** (map 8 polyfill sang `@socketregistry/*`) — đó là fix cho "Dependencies have 8 high alerts". Xoá block này là score tụt lại.
- Socket index version mới chậm vài ngày; check tại https://socket.dev/npm/package/z-zero-mcp-server
