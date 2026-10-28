# Changelog

## 1.1.0 — 2026-10-29

### 中文

- 增加 GPT、反重力 Gemini、反重力 Claude / GPT 的「额度充足度」指标。
- 使用 −10 到 +10 的有符号评分和红黄绿刻度，按剩余额度与距重置时间的关系估算消耗压力。
- 指标使用独立的模型族额度，支持实际重置时间和加载中状态，不增加上游查询。
- 增加测试覆盖、`pressure.js` 静态资源和可选的 iframe 来源白名单配置。

### English

- Add signed −10 to +10 quota sufficiency indicators for GPT, Antigravity Gemini, and Antigravity Claude / GPT.
- Estimate pace pressure from remaining quota and time until reset with a red-to-green scale.
- Use independent model-family windows, actual reset times, and an explicit loading state without adding upstream polling.
- Add coverage tests, the public `pressure.js` asset, and an optional iframe origin allowlist.
