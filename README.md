# 51Talk 好评截图上传

一个面向移动端和微信内置浏览器的好评截图提交页面，包含图片压缩、订单与手机号校验，以及带登录保护的管理后台。

## 本地运行

项目只使用 Node.js 内置模块，不需要安装第三方依赖。建议使用 Node.js 20 或更高版本。

PowerShell：

```powershell
$env:ADMIN_PASSWORD='请替换为高强度密码'
npm start
```

启动后访问：

- 用户页面：<http://localhost:5000>
- 管理后台：<http://localhost:5000/admin>

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 生产环境必填 | 管理后台密码；未配置时后台登录会被禁用 |
| `PORT` / `DEPLOY_RUN_PORT` | 否 | 服务端口，默认 `5000` |
| `NODE_ENV` | 建议 | 生产环境设为 `production`，启用 Secure Cookie |
| `TRUST_PROXY` | 反向代理部署建议 | 设为 `true` 时使用 `X-Forwarded-For` 做限流识别 |
| `DATA_DIR` | 生产环境建议 | 私有持久化数据目录，默认使用项目内的 `data/` |

可复制 [`.env.example`](./.env.example) 查看配置示例，但不要提交真实密码或用户数据。

## 安全设计

- 管理端使用服务端随机会话和 `HttpOnly`、`SameSite=Strict` Cookie。
- 管理数据、截图和删除接口均要求登录。
- 静态文件采用白名单，只公开页面、样式和 `public/` 素材。
- 上传请求限制为 15MB，图片解码后限制为 10MB，并校验真实文件签名。
- 用户截图只保存在私有数据目录，不在 JSON 中重复保存 Base64 内容。
- 登录和提交接口有基础的内存限流。
- 生产日志不记录手机号、订单号、密码或图片数据。

管理员会话保存在进程内，服务重启后需要重新登录。若未来进行多实例部署，应改用共享会话存储和数据库/对象存储。

## 验证

```powershell
npm run check
npm test
```

测试覆盖未授权访问、登录、提交校验、私有截图访问、敏感字段不落盘、删除与请求体大小限制。

## 数据注意事项

`data/submissions.json` 和 `data/images/` 已加入 `.gitignore`。不要把真实手机号、订单号或用户截图提交到 Git。若数据曾进入 Git 历史，仅删除当前文件并不足够，还需要清理仓库历史并更换相关凭证。
