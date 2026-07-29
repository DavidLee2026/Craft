---
name: ark-api-key-management
description: 火山方舟 ARK API Key 的正确获取方式——模型下建 Key 而非通用 Key
metadata:
  type: reference
---

火山引擎 ARK（方舟）API 有两种 API Key：

**1. API Key 管理页面创建的通用 Key（踩坑版）**
- 位置：控制台 → API Key 管理
- 这类 Key 只是一个身份凭证，**还需要额外创建「接入点」（Endpoint）** 才能调模型
- 接入点 ID 是 `ep-20250723-xxxxx` 格式，需要用这个 ID 而不是模型名

**2. 模型详情页下方「API接入」创建的 Key（正确版）**
- 位置：控制台 → 模型广场 → 某个模型详情 → 拉到下方「API 接入」
- 这类 Key **自动绑定了该模型的接入点**，直接用模型名（如 `doubao-seed-2-1-turbo-260628`）就能调
- 不需要额外创建 Endpoint

**调用方式**（用 OpenAI SDK）：
```python
from openai import OpenAI
client = OpenAI(
    api_key="ark-xxx",  # 模型下建的 Key
    base_url="https://ark.cn-beijing.volces.com/api/v3"
)
resp = client.chat.completions.create(
    model="doubao-seed-2-1-turbo-260628",  # 模型名即可
    messages=[...]
)
```

**关掉深度思考**：加 `extra_body={"thinking": {"type": "disabled"}}`，响应时间从 ~15s 降至 ~6s。

**模型选型记录**：
- `doubao-1.5-vision-pro-250328` — 视觉模型，但这个账号没开通成功
- `doubao-seed-1-6-vision-250815` — 只支持 Responses API（`/v3/responses`），且即将下架
- `doubao-seed-2-1-turbo-260628` ✅ — 支持 Chat Completions API，效果好，~0.009 元/次
