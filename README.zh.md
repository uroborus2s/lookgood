# 一身好看（暂定）

女性全身形象 AI 顾问：穿搭 → 唇色 → 妆容 → 发型 → 整体造型。微信小程序（原生 + TypeScript）+ Node/TypeScript 后端。可点击原型在 `prototype/index.html`。

## 目录
```
miniprogram/            小程序（原生 + TypeScript）
  utils/api.ts          后端接口封装（BASE_URL 在此修改）
  pages/                index consent chat photo analysis plans tryon lip makeup hair fulllook favorites member
server/                 Fastify + zod + vitest
  src/config.ts         读取 .env；PROVIDER_MODE=mock 时不调用任何付费 API
  src/llm/client.ts     OpenAI 兼容客户端 + Mock + 按任务路由
  src/state/            对话状态机与抽槽
  src/schema/lookSpec.ts
  src/prompts/system.md
  src/adapters/         百炼试衣 / 整体造型、腾讯云试唇色
  src/safety/           内容安全：mock / 微信 / 阿里云，由 CONTENT_SAFETY 选择
  src/pay/              微信支付 v3 会员下单、回调、续期
  src/storage/          OSS 直传、生成图转存 gen/、隐式 AI 标识
  src/fc.ts             阿里云函数计算 FC 3.0 HTTP 事件入口
  migrations/           PostgreSQL
  test/                 vitest（外部 HTTP 全部用假 fetch）
docs/deploy.zh.md       FC 3.0 与微信云托管部署说明（不执行部署）
s.yaml                  FC 3.0 Serverless Devs 配置
Dockerfile              微信云托管备选镜像
```

## 本地运行（不需要任何 key）
```bash
cd server && npm ci
cp .env.example .env          # 默认 PROVIDER_MODE=mock、REPO=memory、CONTENT_SAFETY=mock
npm test                      # 单元测试，不触网
npm run smoke                 # mock 全流程，成功时打印 SMOKE OK
npm run dev                   # http://localhost:3000
```
仓库根目录再执行一次小程序类型检查：`npm ci && npm run typecheck`。

用 PostgreSQL：根目录 `docker compose up -d`，`.env` 里设 `REPO=pg`、`DATABASE_URL=postgres://yishen:yishen@127.0.0.1:5432/yishen`。启动时自动执行 `server/migrations/*.sql`。

小程序：微信开发者工具导入仓库根目录（`project.config.json`），把 appid 改成你的；开发阶段勾选「不校验合法域名」。`miniprogram/utils/api.ts` 的 `BASE_URL` 指向本地服务。mock 模式下上传地址是 `example.invalid`，客户端不会真的把图传出去；支付会走 `/pay/orders/:id/mock-confirm`，不会调起微信支付。

## mock / live 切换
`PROVIDER_MODE=live` 之后，**每一项只有填了对应 key 才走真实接口**，没填的继续 mock。内容安全例外：live 且 `CONTENT_SAFETY=wechat|aliyun` 时一定会走对应客户端，缺 key 则该请求失败，避免「以为审过了」。`PROVIDER_MODE=mock` 时内容安全固定本地词表，即使 provider 写成 wechat/aliyun 也不出网。

| 能力 | 需要的 env | 实现 |
|---|---|---|
| 对话 / 抽槽 / look_spec | `LLM_*` | `src/llm/client.ts` |
| 试衣 qwen-image-3.0 | `DASHSCOPE_API_KEY` | `src/adapters/dashscope.ts` |
| 整体造型 / 发型 wan2.7-image | `DASHSCOPE_API_KEY` | `src/adapters/dashscope.ts` |
| 试唇色 TryLipstickPic | `TENCENTCLOUD_SECRET_ID/KEY` | `src/adapters/tencent.ts` |
| OSS 直传 + 24h 清理 + 生成图转存 | `OSS_*` | `src/storage/oss.ts`、`src/storage/archive.ts` |
| 微信登录 | `WX_APPID` / `WX_SECRET` / `JWT_SECRET` | `src/auth/` |
| 内容安全 | `CONTENT_SAFETY` + 对应 key | `src/safety/` |
| 微信支付会员 | `WX_PAY_*` | `src/pay/` |

模型单价不写死。`MODEL_UNIT_PRICE_CNY=模型id=元,模型id=元`。没配的调用记为未定价（`priced=false`），汇总里单独计数，不会当成 0 元。mock 渲染的键是 `tryon` / `lip` / `hair` / `fulllook`，mock 对话是 `mock`；live 试衣用 `TRYON_MODEL`，造型和发色用 `FULLLOOK_MODEL`，唇色是 `tencent-fmu`，对话用各自的模型 id。

## 内容安全
`CONTENT_SAFETY=mock|wechat|aliyun`。

- 微信文本：`msgSecCheck` v2（需要 openid）。`pass` 才放行，`review` 和 `risky` 都拦截。
- 微信图片：`mediaCheckAsync`。提交后任务保持 `RUNNING`，等 `POST /safety/wechat/callback`。验签用 `WX_SAFETY_TOKEN`；若带 `Encrypt`，用 `WX_SAFETY_ENCODING_AES_KEY` 做 32 字节块的 AES-256-CBC 解密，并核对 AppID。`GET` 同一路径用于微信后台的 URL 校验，通过后原样返回 `echostr`。
- 阿里云：内容安全增强版 `TextModerationPlus` / `ImageModeration`（2022-03-02，ACS3-HMAC-SHA256）。`RiskLevel` 为 none/low 通过，medium 复核拦截，high 拦截。服务名可用 `ALIYUN_GREEN_TEXT_SERVICE` / `ALIYUN_GREEN_IMAGE_SERVICE` 改。

回调地址要配到微信公众平台的消息推送，见 `docs/deploy.zh.md`。

## 会员与微信支付
默认档位（只是默认值，用 `MEMBER_PLANS` JSON 覆盖）：

| sku | 名称 | 价格 | 时长 |
|---|---|---|---|
| month | 月卡 | 12.9 元（1290 分） | 30 天 |
| quarter | 季卡 | 29 元（2900 分） | 90 天 |
| year | 年卡 | 198 元（19800 分） | 365 天 |

`POST /pay/orders` 在 live 且支付密钥齐全时调用微信支付 v3 JSAPI 下单，返回小程序 `wx.requestPayment` 要的 `timeStamp / nonceStr / package / paySign`。回调 `POST /pay/wechat/notify` 验平台证书签名、用 APIv3 key 做 AES-256-GCM 解密，核对金额、商户号、AppID 和付款人 openid。只有第一次把订单从 `CREATED` 改成 `PAID` 时才延长会员；重复通知不会叠加。未过期再买，从当前到期日往后加。

mock 模式不请求微信支付。小程序发现 `mock: true` 后调用 `POST /pay/orders/:outTradeNo/mock-confirm`。live 但密钥不全时下单返回 503，并且没有这个确认接口。

`WX_PAY_API_V3_KEY` 必须是 32 字节。私钥和平台证书支持在环境变量里用 `\n` 表示换行。

## 收藏
`POST /favorites` 新增，`DELETE /favorites/:id` 删除，`GET /favorites?limit=&cursor=` 按时间倒序分页。只能看和删自己的。小程序收藏页接了这三件事，下拉刷新、上拉加载、空态和失败重试都有。试穿、唇色、发型、整体造型和方案页的「收藏」走同一个接口。

## 每日额度与成本
生成次数按北京时间自然日计算，只统计渲染任务，不算对话。`FREE_DAILY_QUOTA`（默认 5）和 `MEMBER_DAILY_QUOTA`（默认 100）分开配置。超限返回 429。会员身份看 `member_expire_at` 是否晚于当前时间。

每次模型调用写一条 `usage_events`。`GET /usage/summary` 返回当前用户的额度快照，以及区间内按模型汇总的金额和未定价次数。同一渲染任务只记一笔。

## 生成图与隐式标识
渲染成功后，图片先过审，再写入隐式标识并上传到 OSS 的 `gen/{userId}/{taskId}.jpg|png|webp`。mock 模式不下载厂商 URL，用内置 JPEG 做同一套写入，避免请求 `example.invalid`。

隐式字段按生成合成内容标识的常见元数据：`Label`（固定 `1`，表示属于 AI 生成）、`ContentProducer`、`ProduceID`、`ReservedCode1`、`ContentPropagator`、`PropagateID`、`ReservedCode2`。JPEG 写入 XMP（`TC260:AIGC`）和 EXIF UserComment，PNG 写入 iTXt，WEBP 写入 XMP chunk。显式标识仍是画面上的「AI 生成」角标，由小程序叠加，不把字烧进像素。

`ReservedCode*` 在设置了 `AIGC_RESERVED_SECRET` 时是 HMAC-SHA256，否则是 SHA-256 摘要。这不是监管平台的证书签名，正式主体编码和官方签名要上线前替换。原图仍在 `raw/`，24 小时删除；`gen/` 不参与这趟清理。

## 生产启动检查
`NODE_ENV=production` 时，`JWT_SECRET` 必须同时满足：UTF-8 至少 32 字节、含字母和数字、至少 16 种字符、香农熵不低于 3.5，且不含 `change-me`、`dev-only`、`placeholder` 这类占位词。否则进程拒绝监听。生成：`openssl rand -base64 48`。FC 入口和常驻入口都会做这个检查。

## 部署
见 [docs/deploy.zh.md](docs/deploy.zh.md)。FC 3.0 用根目录 `s.yaml`，入口 `dist/fc.handler`。微信云托管用根目录 `Dockerfile`。两边都不要在这个仓库里真的发布。

## 接口（除下表公开路径外，均需 `Authorization: Bearer <JWT>`）
公开：`GET /health`、`POST /auth/login`、`POST /pay/wechat/notify`、`GET|POST /safety/wechat/callback`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /auth/login | code2Session → JWT |
| POST | /chat/message | 对话一轮 |
| POST | /consent/face | 人脸授权 / 撤回 |
| POST | /photo/upload-ticket | OSS POST 直传凭证；body/face 需已授权 |
| POST | /analysis | 视觉模型诊断 |
| POST | /look/generate | 生成并校验 look_spec |
| POST | /render/tryon · /render/lip · /render/hair · /render/fulllook | 创建渲染任务 |
| GET | /render/tasks/:id | 查询任务；结果 URL 在审核和转存之后才是 `gen/` |
| GET | /favorites | 分页收藏 |
| POST | /favorites | 新增收藏 |
| DELETE | /favorites/:id | 删除收藏 |
| GET | /member | 会员状态、额度、档位 |
| POST | /pay/orders | 创建会员订单 |
| POST | /pay/orders/:outTradeNo/mock-confirm | 仅 mock 模式 |
| GET | /pay/orders/:outTradeNo | 订单状态；live 时会向微信补查一次 |
| GET | /usage/summary | 额度与成本汇总 |
| POST | /pay/wechat/notify | 微信支付回调 |
| GET/POST | /safety/wechat/callback | 微信 URL 校验与图片审核回调 |

## 上线前必须换成真实凭证的项
本地 mock 全绿不等于这些接口在生产可用。每一项都要在对应控制台开通，并把值放进环境变量（见 `server/.env.example`），再用一笔真实调用核对。

| 事项 | 变量 | 没有它时会怎样 |
|---|---|---|
| 小程序 AppID、AppSecret | `WX_APPID` `WX_SECRET` | 登录停在 mock openid，支付和微信审核也缺少调用方 |
| JWT | `JWT_SECRET` | 生产环境直接拒绝启动 |
| 微信支付商户号 | `WX_PAY_MCH_ID` | 无法下单 |
| APIv3 密钥（32 字节） | `WX_PAY_API_V3_KEY` | 无法解密回调 |
| 商户 API 证书序列号 + 私钥 PEM | `WX_PAY_CERT_SERIAL` `WX_PAY_PRIVATE_KEY` | 无法给 JSAPI 请求签名 |
| 微信支付平台证书 + 序列号 | `WX_PAY_PLATFORM_CERT` `WX_PAY_PLATFORM_SERIAL` | 回调验签失败 |
| 支付通知 URL | `WX_PAY_NOTIFY_URL` | 下单被微信拒绝；必须是公网 HTTPS |
| 内容安全（微信） | `CONTENT_SAFETY=wechat`、`WX_SAFETY_TOKEN`，安全模式再加 `WX_SAFETY_ENCODING_AES_KEY` | 文本/图片审核不会打到微信 |
| 内容安全（阿里云，二选一或切换） | `ALIYUN_GREEN_ACCESS_KEY_ID/SECRET`、地域、可选 endpoint、文本/图片 service 名 | 切到 aliyun 时请求失败 |
| OSS | `OSS_REGION` `OSS_BUCKET` `OSS_ACCESS_KEY_ID` `OSS_ACCESS_KEY_SECRET` | 直传和 `gen/` 转存停在内存 URL |
| 数据库 | `REPO=pg` `DATABASE_URL` | 重启后用户、订单、收藏、用量都丢 |
| 对话 / 看图模型 | `LLM_*_API_KEY` 与 base URL、模型名 | 对话和方案保持 mock 文案 |
| 百炼图像 | `DASHSCOPE_API_KEY`、`TRYON_MODEL`、`FULLLOOK_MODEL` | 试衣和造型保持 mock 图 |
| 腾讯云试唇色 | `TENCENTCLOUD_SECRET_ID` `TENCENTCLOUD_SECRET_KEY` | 唇色保持 mock |
| 模型单价 | `MODEL_UNIT_PRICE_CNY` | 调用会记上，但金额为空，汇总里算未定价 |
| 会员价格与额度 | `MEMBER_PLANS` `FREE_DAILY_QUOTA` `MEMBER_DAILY_QUOTA` | 使用代码里的默认 12.9/29/198 元和 5/100 次 |
| AI 标识主体 | `AIGC_CONTENT_PRODUCER` `AIGC_CONTENT_PROPAGATOR` `AIGC_RESERVED_SECRET` | 生产者显示「一身好看」，ReservedCode 只是摘要 |

另外要在小程序后台配置服务器域名和 OSS 域名，在微信商户平台把支付通知 URL 指到 `/pay/wechat/notify`，在消息推送里把内容安全回调指到 `/safety/wechat/callback`。桶上建议再加一条生命周期：`raw/` 前缀 1 天后删除（代码里的 `LIFECYCLE_XML`）。

## 还要用真实 key 才能核实的点
代码按公开文档写了请求形状，并用假 HTTP 做了单测。下面这些没有打过真实环境，上线前各走一遍：

- 微信 `code2Session`、`msgSecCheck`、`mediaCheckAsync` 的字段和错误码；安全模式回调的 32 字节填充是否与当前公众平台一致。
- 微信支付 JSAPI 下单、调起签名、回调验签（平台证书序列号轮换）和金额字段。商户平台证书要定期更换，代码只认环境变量里的那一张。
- 阿里云内容安全 ACS3 签名、`Service` 名称和 `RiskLevel` 的实际取值。
- 百炼 qwen-image-3.0 / wan2.7-image 返回图片的路径（代码兼容 `output.choices[].message.content[].image` 和 `output.results[].url`）。
- 腾讯云 TryLipstickPic 的 `ResultUrl`。官方示例密钥在文档里是打码的，单测只核对到 CanonicalRequest 哈希。
- OSS PutObject 后小程序是否真的能打开 `gen/` 的 URL（私有桶需要签名 URL 或桶策略，当前返回的是虚拟主机风格的对象 URL）。
- 隐式标识字段是否满足应用商店或网信部门抽查用的读取工具；`ReservedCode` 若被要求为官方证书签名，需要换掉现在的 HMAC。
- 函数计算 HTTP 触发器的事件包装（`rawPath`、`isBase64Encoded`）与当前 FC 3.0 运行时是否一致。单测只覆盖了我们实现的适配函数。

## 换大模型
对话类模型走 OpenAI 兼容接口，只改 `.env`：

- DeepSeek：`https://api.deepseek.com`，`deepseek-flash`
- 通义千问：`https://dashscope.aliyuncs.com/compatible-mode/v1`，`qwen-plus` / `qwen3.7-plus` / `qwen3-vl-plus`
- 豆包：`https://ark.cn-beijing.volces.com/api/v3`，`doubao-seed-2.0-mini` 等

改完记得把新模型 id 补进 `MODEL_UNIT_PRICE_CNY`。
