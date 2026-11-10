# 部署说明

这里只准备配置和入口，**不要在本仓库里执行真实部署**，也不要拿生产密钥在开发机上打付费接口。

两套运行方式：

| 方式 | 入口 | 适用 |
|---|---|---|
| 阿里云函数计算 FC 3.0 | `server/src/fc.ts` 编译后的 `dist/fc.handler` | 按请求计费，HTTP 触发器 |
| 微信云托管（备选） | 根目录 `Dockerfile`，跑 `dist/index.js` | 小程序同账号后端，常驻容器 |

密钥一律放在平台的环境变量里，对照 `server/.env.example`。不要写进 `s.yaml`、镜像或 Git。

## 上线前先准备

1. 已备案的 HTTPS 域名，并配到小程序的 request 合法域名。OSS 桶域名配到 uploadFile / downloadFile 合法域名。
2. PostgreSQL。`REPO=pg`，`DATABASE_URL` 指向它。进程启动时会按顺序执行 `server/migrations/*.sql`。
3. `NODE_ENV=production`。`JWT_SECRET` 用 `openssl rand -base64 48` 生成。少于 32 字节、像占位符、或熵太低时，进程直接拒绝启动。
4. `PROVIDER_MODE=live`，并按 README 的凭证表填上要用的密钥。没填的那一项仍会退回 mock，内容安全如果停在 `CONTENT_SAFETY=mock` 就只有本地词表。

## 函数计算 FC 3.0

配置文件是仓库根目录的 `s.yaml`（Serverless Devs，组件 `fc3`）。函数不监听端口，HTTP 触发器把事件交给 `handler`，里面用 Fastify `inject` 跑同一套路由。

本地先打出 `dist/` 和生产依赖，再部署（下面的命令只是说明，本仓库不执行）：

```bash
cd server
npm ci
npm run build
npm prune --omit=dev
cd ..
# 在 FC 控制台或本机配置 AccessKey 之后：
# s deploy -t s.yaml
```

`s.yaml` 里只写了非密钥的运行参数。下面这些要在函数的环境变量里补上，名字与 `.env.example` 相同：

- `JWT_SECRET`、`DATABASE_URL`
- `WX_APPID`、`WX_SECRET`
- `WX_PAY_MCH_ID`、`WX_PAY_API_V3_KEY`、`WX_PAY_CERT_SERIAL`、`WX_PAY_PRIVATE_KEY`、`WX_PAY_PLATFORM_CERT`、`WX_PAY_PLATFORM_SERIAL`、`WX_PAY_NOTIFY_URL`
- `OSS_REGION`、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`
- 内容安全：`CONTENT_SAFETY=wechat` 时再加 `WX_SAFETY_TOKEN`（安全模式加 `WX_SAFETY_ENCODING_AES_KEY`）；用阿里云则改 `CONTENT_SAFETY=aliyun` 并填 `ALIYUN_GREEN_*`
- 模型密钥与 `MODEL_UNIT_PRICE_CNY`、`MEMBER_PLANS`、额度

私钥和平台证书是 PEM。环境变量里把换行写成 `\n`，进程会还原。

触发器是匿名 HTTP，所以支付回调和内容安全回调可以直接打到函数 URL。上线后把这两个地址填回微信后台：

- 支付通知：`https://<函数公网域名>/pay/wechat/notify`，同时写入 `WX_PAY_NOTIFY_URL`
- 内容安全消息推送：`https://<函数公网域名>/safety/wechat/callback`

函数需要访问公网才能调用微信、支付、OSS、模型和内容安全。VPC 内的数据库要另开访问，或把函数放进能连到数据库的 VPC。超时建议不少于 60 秒，图像任务本身是异步的，单次请求只负责提交或轮询一次。

激活哪个版本由你在控制台决定。`s deploy` 不会在这个仓库里被调用。

## 微信云托管（备选）

根目录 `Dockerfile` 用 Node 22 编译 `server/`，监听 `PORT`（默认 80，云托管会覆盖这个变量）。启动命令是 `node dist/index.js`，走常驻 Fastify，而不是 FC 的事件入口。

```bash
# 仅说明，不要在此执行发布
# docker build -t yishen-haokan .
```

云托管服务里配置与上面相同的环境变量，并把服务关联的公网域名配进小程序合法域名。支付和内容安全回调也指向这个域名的同样路径。

镜像里没有密钥。`.dockerignore` 排除了 `node_modules`、`.env` 和本地 `dist`。

## 发布后核对

1. `GET /health` 返回 `mode` 为 `live`。
2. 用开发者工具走一遍登录。确认没有打到 mock openid（`mock_` 前缀）。
3. 各用一笔最小金额核对微信支付：下单、`wx.requestPayment`、回调开通、再回调一次不会把到期日加两次。
4. 发一条正常文本和一张图片，确认微信或阿里云侧有审核记录；图片要等回调之后任务才成功。
5. 生成一张图，在 OSS 的 `gen/{userId}/` 下能看到对象，并用读图工具看到 XMP / EXIF 里的 `AIGC` 字段。
6. 把免费账号的额度打满，确认第 N+1 次返回 429；会员账号额度更高。
7. `GET /usage/summary` 里，已配置单价的模型有金额，没配置的落在 `unpricedCalls`，不要出现凭空的 0 元。
