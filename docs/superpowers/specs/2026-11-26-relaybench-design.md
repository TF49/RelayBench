# RelayBench 设计文档 · 中转站渠道稳定性批量测评

日期：2026-11-26

## 1. 目标

用户给出若干「中转站地址 + 该站创建的 API Key」（new-api / sub2api / 其他 OpenAI 兼容中转），工具全自动：

1. 识别站点类型、查询余额、拉取模型列表；
2. 对勾选的模型批量发请求，统计**报错、速度、稳定性**；
3. 跑一组带标准答案的质量小题；
4. 交给一个独立的**评审模型**打分点评；
5. 输出排行榜与详细报告，保存历史，可导出。

非目标：模型真伪/渠道指纹鉴定（ModelTest 的领域），定时巡检，多用户部署。

## 2. 形态与架构

浏览器工具 + 本地 Python 代理（方案 A）。

- sub2api 默认不开 CORS；new-api 虽开 CORS 但不暴露响应头 → 所有出站请求走本地代理 `/api/proxy?target=<url>`。
- 代理必须**流式透传**（逐块 flush），否则 TTFT 失真；**不做重试**，否则掩盖不稳定。
- 代理只监听 `127.0.0.1`，校验 `Host` 为本机、要求自定义头 `X-RB-Proxy: 1`（跨站页面无法通过预检），防止被其他网页当作开放代理。
- 前端：原生 ES Modules，无构建。`core/` 纯逻辑不碰 DOM，用 `node --test` 单测。

```
server.py               静态服务 + 流式代理
index.html / css/app.css
js/main.js              入口 + 视图切换
js/core/http.js         经代理 fetch、超时/中止
js/core/client.js       OpenAI chat / Anthropic messages 请求，SSE 解析，计时
js/core/relay.js        URL 规范化、站点类型识别、余额、模型列表
js/core/errors.js       错误分类
js/core/probes.js       稳定性提示词 + 质量题（本地判分）
js/core/stats.js        统计
js/core/scoring.js      规则分
js/core/judge.js        评审 prompt 构造与结果解析
js/core/runner.js       调度（并发池、中止、进度事件）
js/store/db.js          IndexedDB（sites / runs / settings）
js/ui/*.js              sites / run / report / history / settings 视图
tools/mock_relay.py     模拟中转站（用于端到端自测）
tests/*.test.mjs        核心模块单测
```

## 3. 站点适配（基于 new-api / sub2api 源码）

- **URL 规范化**：去尾部 `/`、去尾部 `/v1`。
- **类型识别 + 余额**（失败不阻塞）：
  - `GET /api/usage/token/`（Bearer）返回 `{code:true,data:{total_available,total_used,unlimited_quota,expires_at}}` → new-api。额度单位换算用 `GET /api/status` 的 `quota_per_unit`（缺省 500000/USD）。
  - 否则 `GET /v1/usage` 返回 `remaining` / `quota` / `balance` → sub2api（单位 USD）。
  - 否则 `GET /dashboard/billing/subscription` + `/dashboard/billing/usage`（one-api / 旧版 new-api）→ 「one-api 兼容」。剩余 = `hard_limit_usd − total_usage/100`。
  - 都失败 → 「通用 OpenAI 兼容」，不显示余额。
- **模型列表**：`GET /v1/models`（Bearer）→ `data[].id`。按「常用模型」关键字（设置里可改）自动预选。
- **协议**：站点级 `auto | openai | anthropic`。auto：模型名含 `claude` → `POST /v1/messages`（同时带 `Authorization` 与 `x-api-key`、`anthropic-version: 2023-06-01`，`max_tokens: 1024`）；其他 → `POST /v1/chat/completions`（`stream_options.include_usage`，不传长度上限以兼容新模型）。
- 测试前后各查一次余额，得出「本次消耗」。

## 4. 测试流程

每个「站点 × 模型」：

- **稳定性请求** N 次（默认 10），全部流式。提示词从题库轮换并带随机话题，避免缓存命中。
- **质量题** 4 道（各 1 次，流式，同样计入统计）：算术、指令遵循（格式）、JSON 输出、简单推理。本地按标准答案判 pass/fail。
- 并发：每站并发（默认 3），全局并发上限 6（浏览器对同一主机最多 6 个 HTTP/1.1 连接，超过会在浏览器内排队、虚增延迟）。
- 计时校正：代理回传 `X-RB-Upstream-Ms`（上游返回响应头的耗时），前端用「响应头到达时间 − 该值」估算本地排队时间，并从首字与总耗时中扣除。
- 超时：首字超时 30s、总超时 120s（可配）。
- 随时可停止：中止信号传到所有在途请求。

每次请求记录：`ok, status, errorType, errorMessage, requestId, ttftMs, totalMs, queueMs, outputTokens, tps, text`（稳定性请求截断 300 字，质量题 1500 字）。

## 5. 错误分类

`auth`（Key 无效/禁用/过期）· `quota`（额度/余额不足）· `no_channel`（无可用渠道/账号）· `model_not_found` · `rate_limit` · `upstream`（上游错误、5xx）· `timeout` · `network`（代理/网络失败）· `stream_broken`（流中断/解析失败）· `empty`（200 但无内容）· `bad_request`（其他 4xx）· `other`。
依据 HTTP 状态码 + 错误体中的 `code/type/message` 关键字（来自两个项目的错误定义）。从 message 中提取 `(request id: xxx)`。

## 6. 统计与规则分（0–100）

统计：成功率、各错误类型计数、TTFT 与总耗时的 avg/P50/P95、TPS（输出 token ÷ (总耗时 − TTFT)，无 usage 时按字符估算）、TTFT 变异系数 CV、质量题通过数。

| 维度 | 分值 | 规则 |
|---|---|---|
| 可用性 | 45 | 成功率 × 45 |
| 速度 | 25 | TTFT P50：≤1s 满分、≥10s 零分，线性（15）；TPS：≥60 满分、≤5 零分，线性（10） |
| 稳定性 | 15 | TTFT CV：≤0.2 满分、≥1.0 零分（10）；总耗时 P95/P50：≤1.5 满分、≥4 零分（5） |
| 质量 | 15 | 质量题通过率 × 15 |

无成功请求时速度/稳定性记 0。等级：S≥90，A≥80，B≥70，C≥60，D<60。

## 7. AI 评审

设置里单独配置评审渠道（地址、Key、模型、协议），非流式调用。

- **逐项评审**：每个站点×模型一次。输入统计摘要、错误样本（最多 5 条）、质量题问答与本地判分。要求只输出 JSON：`{score, quality_score, verdict, strengths[], issues[], suggestion}`。解析容错（去代码块、截取首个 `{...}`），失败记为评审失败，不影响规则分。
- **综合点评**：全部完成后一次调用，输入排行榜摘要，输出一段中文推荐结论。
- **综合分** = round(0.6 × 规则分 + 0.4 × AI 分)；无 AI 分时等于规则分。

## 8. 界面

顶部导航：站点 · 测试 · 报告 · 历史 · 设置。

- **站点**：单个添加 + **批量导入**（每行 `地址 Key [名称]`）。卡片显示类型、余额、已选模型数；「检测」按钮拉模型与余额；模型勾选面板（搜索、全选、按常用关键字预选）。
- **测试**：开始/停止；每个站点×模型一行实时进度（完成数、成功率、平均 TTFT）；最近请求滚动日志。
- **报告**：AI 综合点评；排行榜（排名、站点、模型、综合分、等级、成功率、TTFT P50/P95、TPS、主要错误、AI 结论），可排序；点击展开详情（错误分布、耗时分布条形图、质量题答案、AI 优缺点建议、请求明细）。导出 JSON / CSV。
- **历史**：运行记录列表，打开即进入报告视图，可删除。
- **设置**：评审渠道、N、并发、超时、常用模型关键字、规则/AI 权重。

## 9. 数据与隐私

IndexedDB 存 `sites`、`runs`、`settings`。Key 默认只在内存；站点勾选「记住 Key」才落库。运行记录**永不**含 Key。评审 Key 同样规则。

## 10. 测试策略

- `node --test`：errors / stats / scoring / probes 判分 / judge 解析 / SSE 解析 / relay URL 规范化与余额解析。
- `tools/mock_relay.py`：模拟 new-api 与 sub2api 的模型、余额、流式对话，并按比例注入 429/502/超时/断流，用于浏览器端到端验证。
