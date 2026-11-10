# 一身好看

面向女性的 AI 形象教练微信小程序（中国大陆）。本地运行、接口和上线前凭证见 [README.zh.md](README.zh.md)。部署见 [docs/deploy.zh.md](docs/deploy.zh.md)。

```bash
cd server && npm ci && npm test && npm run smoke
cd .. && npm ci && npm run typecheck
```

可点击原型在 `prototype/index.html`。默认 `PROVIDER_MODE=mock`，不会调用付费接口。
