# 51Talk 好评截图上传

GitHub 保存源码，Cloudflare Workers Builds 监听 `main` 并自动部署到现有 Worker `51talk-review-upload`。

线上入口：https://51talkpingjia.shop/；管理入口：https://51talkpingjia.shop/admin.html。

## 自动部署

在 Cloudflare Worker 的 Settings → Builds 连接 `ylbabygo/51talk-review-upload`，生产分支设为 `main`。

- Build command：`npm run check && npm test && npm run build`
- Deploy command：`npx --yes wrangler@4.151.0 deploy`
- Root directory：仓库根目录
- Build variable：`NODE_VERSION=24`
- 关闭 Preview builds，防止预览环境使用生产数据。

修改代码后提交并推送到 `main`，Cloudflare 自动检查、构建、部署。GitHub Actions 同时进行代码和构建检查。部署不需要在 GitHub 配置 Cloudflare 密钥。

`src/worker.ts` 从原生产版本 `6c97cd51-6a09-4dec-85b7-fb238309b4f2` 的 source map 恢复；HTML 同步原线上版本，后端业务逻辑保持一致。

## 现有后端与数据

`wrangler.jsonc` 保留原来的 D1 `DB`、KV `IMAGES`、域名路由、兼容日期和安全响应处理。部署不创建或迁移数据库，也不运行数据清理。`ADMIN_PASSWORD` 和 `ADMIN_SESSION_SECRET` 继续保存在 Cloudflare 的加密 Secrets 中，不写入源码或构建变量。

`scripts/build.js` 仅复制六个页面/品牌素材到 `dist`，不发布源码、配置或用户上传数据。`data/` 保留为本地 Node 开发数据并排除后续 Git 同步；旧 Git 历史中的文件仍保留。

## 本地验证

使用 Node.js 24：

```sh
npm run check
npm test
npm run build
npx --yes wrangler@4.151.0 deploy --dry-run
```

检查包含页面脚本/Worker 语法、上传持久化、重复提交、后台鉴权和会话、安全响应头。测试使用内存 D1/KV，不写入生产数据。Wrangler dry-run 验证 Worker 打包及资源绑定配置；这不是完整 TypeScript 类型检查。

本地旧 Node 服务仍可用 `npm start` 在 `http://localhost:5000` 预览，但其本地存储与生产 D1/KV 分开。生产部署入口是 `src/worker.ts`，手动部署可用 `npm run deploy`（需要 Cloudflare CLI 登录）。
