"""每日绘 Craft · AI 分析服务

prompt 构建、图片压缩、流式/非流式分析、layer 增量提取。
"""
import json
import re
import base64
from pathlib import Path

from config import ARK_MODEL, client
from data_store import (
    get_drawing_stage,
    _layers_to_text,
    get_milestone,
    load_records,
    save_records,
    log_event,
    get_recommendation,
    load_profile,
)

def analyze_drawing(
    image_path: Path,
    history: list[str] | None = None,
    user_name: str = "小伙伴",
    total_drawings: int = 1,
    user_level: str | None = None,
    user_goal: str | None = None,
) -> tuple[str, float, dict | None]:
    # 图片压缩 + prompt 构建复用共享 helper（与流式端点共用同一套逻辑）
    image_b64 = _compress_image_b64(image_path)
    prompt = _build_analyze_prompt(
        history=history,
        user_name=user_name,
        total_drawings=total_drawings,
        user_level=user_level,
        user_goal=user_goal,
    )

    import time
    t0 = time.time()

    response = client.chat.completions.create(
        model=ARK_MODEL,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{image_b64}"
                        },
                    },
                ],
            }
        ],
        max_tokens=500,
        temperature=0.7,
        extra_body={"thinking": {"type": "disabled"}},
    )

    elapsed = time.time() - t0
    content_raw = response.choices[0].message.content
    if not content_raw:
        raise ValueError("AI 模型未返回有效反馈，请重试")
    raw = content_raw.strip()

    # 尝试解析 JSON（新格式）
    feedback_json = None
    content = raw

    try:
        data = json.loads(raw)
        layers = data.get("layers", [])
        if layers and len(layers) >= 4:
            feedback_json = data
            content = _layers_to_text(layers, user_name)
    except (json.JSONDecodeError, TypeError):
        pass

    return content, feedback_json, elapsed, None


def _compress_image_b64(image_path: Path) -> str:
    """压缩图片并返回 base64 编码（最长边 1200px，JPEG quality 80）。

    被 ``analyze_drawing`` 与 ``analyze_drawing_stream`` 共同复用，避免 ARK 拒收大图。
    """
    from PIL import Image
    import io
    img = Image.open(image_path)
    max_dim = 1200
    if max(img.size) > max_dim:
        ratio = max_dim / max(img.size)
        new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
        img = img.resize(new_size, Image.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=80, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _build_analyze_prompt(
    history: list[str] | None = None,
    user_name: str = "小伙伴",
    total_drawings: int = 1,
    user_level: str | None = None,
    user_goal: str | None = None,
) -> str:
    """构建绘画分析的 prompt（5 级自适应反馈深度）。

    被 ``analyze_drawing``（非流式）与 ``analyze_drawing_stream``（流式）共同复用，
    保证两个端点的 prompt 构建逻辑完全一致。
    """
    stage = get_drawing_stage(total_drawings)

    # ── 5 级自适应反馈深度 ──
    # 新手期(1-5)：生活化语言，禁用术语，重点鼓励
    # 入门期(6-15)：可用 1-2 个基础术语，必须解释
    # 成长期(16-30)：可用术语并简要解释，给可操作建议
    # 进阶期(31-50)：术语不需解释，深入分析构图光影
    # 熟练期(50+)：可引用大师作品对比，挑战性建议
    stage_prompts = {
        "新手期": (
            "用户刚开始画画（1-5 张），可能没有信心。\n"
            "深度策略：只用生活化语言，禁止任何专业术语（不要出现透视、比例、明暗交界线、构图等词）。"
            "重点发掘画中的任何闪光点，语气真诚、自然，像朋友之间平等的交流。\n"
            "改进建议要具体且轻量，像在说「下次可以试试从这个角度入手」。\n"
            "⚠️ 语气注意：用户是 18-35 岁的成年人，语气要成熟自然。"
            "绝对不要用哄小孩的语气（如'太厉害啦''好棒哦''要不要试试画个小玩具呀'），"
            "也不要过度夸张。用平实、真诚的语言表达认可。"
        ),
        "入门期": (
            "用户画了 6-15 张，有了一点感觉但还在摸索。\n"
            "深度策略：可以使用 1-2 个最基础的术语（如透视、比例），"
            "但每个术语必须紧跟一句大白话解释。"
            "在鼓励的同时给出更具体的技巧建议，表现出你注意到 ta 的进步。"
        ),
        "成长期": (
            "用户画了 16-30 张，有一定基础但还会卡住。\n"
            "深度策略：可以自由使用绘画术语并简要解释，给出具体可操作的练习建议。"
            "反馈更有针对性，指出可以提升的具体环节。"
        ),
        "进阶期": (
            "用户画了 31-50 张，积累了相当多的画作，有一定功底。\n"
            "深度策略：专业术语不需要再解释，可以深入分析构图、光影、节奏等更专业的维度。"
            "给出有实质提升意义的建议，甚至可以追问「你试过 XX 画法吗」。"
            "语气是朋友般的，但带着对 ta 能力的尊重。"
        ),
        "熟练期": (
            "用户画了 50 张以上，已经比较熟练。\n"
            "深度策略：可以引用大师作品或流派进行对比分析，给出有挑战性的建议。"
            "鼓励 ta 形成个人风格，探讨更高级的课题（如画面节奏、主观处理、风格化表达）。"
            "语气平等，像和一位有经验的画友交流。"
        ),
    }

    stage_hint = stage_prompts.get(stage, stage_prompts["新手期"])

    # 根据用户目标增加语气提示
    goal_hint = ""
    if user_goal == "relax":
        goal_hint = "用户画画主要是为了放松解压。反馈重点放在过程和感受，不过度强调技巧提升。"
    elif user_goal == "create":
        goal_hint = "用户想创作自己的作品。反馈时可以多鼓励 ta 大胆尝试，肯定创意和想法。"
    elif user_goal == "improve":
        goal_hint = "用户想切实提升绘画水平。可以在鼓励的同时多给一些可操作的练习建议。"

    prompt = (
        f"你是{user_name}的绘画陪伴伙伴。\n\n"
        "你的性格：温暖、细腻、有幽默感，看到好画会真心开心。"
        "你是朋友不是老师，从不居高临下。"
        f"你了解{user_name}的绘画历程，能看到每一次的进步。\n\n"
        "⚠️ 用户画像：18-35 岁的成年人。语气必须成熟、自然、平等。"
        "绝对不要用哄小孩的语气（如'太厉害啦''好棒哦'），"
        "不要用'要不要试试画个小玩具呀'这种幼稚的引导语。"
        "鼓励要真诚有分寸，像成年人朋友之间的交流。\n\n"
        f"现在{user_name}拍了手绘照片给你看。\n\n"
        "⚠️ 重要：不要假定用户是照着实物观察画的——ta 可能是凭记忆或想象在画。"
        "不要强行说'你观察得很仔细/认真'。如果你不确定创作方式，用"
        "'我看到了你的想法/你画出了XX的感觉'这类中性表达。\n\n"
        f"【当前阶段：{stage}（累计 {total_drawings} 张）】\n{stage_hint}\n\n"
    )
    if goal_hint:
        prompt += f"【用户目标提示】\n{goal_hint}\n\n"

    has_progress = total_drawings >= 5

    # 构建 layers 列表——progress 层只在画满 5 张后才加入
    layers_spec = (
        '    {\n'
        '      "type": "identify",\n'
        f'      "content": "先认出画的是什么（物体/人物/场景），表现出你看懂了。然后真诚地夸一个具体的亮点（线条、构图、造型、用笔等，不要虚构\'观察\'）。可以补充你对这幅画的第一印象或感受。称呼用户为{user_name}。2句话内，精炼有温度。必须用 **加粗** 强调关键技巧或优点，如 **排线**、**透视**、**间距控制得很好**。每层最多1处加粗。",\n'
        '    },\n'
        '    {\n'
        '      "type": "observe",\n'
        "      \"content\": \"再指出你在画里注意到的具体细节（某个局部的处理方式、线条走向、比例关系、用笔特点等），让用户感觉到你真的很仔细看了。可以最多2句话，具体不空洞。注意：不要说'你观察到了XX'——用户可能是凭记忆/想象画的，说'我注意到你的XX处理很特别'。\",\n"
        '    },\n'
    )
    if has_progress:
        layers_spec += (
            '    {\n'
            '      "type": "progress",\n'
            '      "content": "对比用户之前的作品，具体指出进步在哪里（线条更稳了、形状更准了、构图更完整了等）。\n'
            '必须说出具体的对比点，不要说\'画得越来越好了\'这种空话。\n'
            '参考用户的历史画作，找到真实的进步痕迹。如果历史画作信息不足，说\'这次画的是新题材，我看到你在XX方面的处理很有意思\'，\n'
            '但绝不要说\'第一次画这个画得不错\'——这听起来像敷衍。",\n'
            '    },\n'
        )
    layers_spec += (
        '    {\n'
        '      "type": "suggestion",\n'
        '      "content": "一个具体可操作的技巧建议，可以说得详细一些，让用户知道怎么改。只给一条，不超过一条。如果用到术语必须紧跟大白话解释。",\n'
        '      "tip": "可选：详细的技巧说明或小贴士，会以 callout 框展示。没有就不填或 null。"\n'
        '    },\n'
        '    {\n'
        '      "type": "encourage",\n'
        '      "content": "以真诚的鼓励收尾，并自然地引出下次可以尝试的方向（如\'下次可以试试画XX，会有新的发现\'）。语气成熟自然，像朋友间的建议，不要用哄小孩的语气。可以结合用户这次画的内容，给出更有个性化的鼓励和期待。2句话内。"\n'
        '    }\n'
    )

    layer_count = 5 if has_progress else 4
    layer_order = "identify → observe → progress → suggestion → encourage" if has_progress else "identify → observe → suggestion → encourage"

    prompt += (
        f"请回复纯 JSON，不要用 ```json 代码块，不要额外文字，只输出 JSON 对象。\n\n"
        "JSON 结构如下：\n"
        "{\n"
        '  "layers": [\n'
        f"{layers_spec}"
        "  ],\n"
        '  "next_hint": "对下次绘画的自然引导，可选。如\'下次可以试试画桌上的马克杯\'。不超过15字。语气成熟，不要用\'要不要\'句式。没有则填null。",\n'
        '  "glossary_context": {}\n'
        "}\n\n"
        "glossary_context 格式示例：\n"
        '{"透视": "在你这幅画里：杯口那个椭圆就是透视的作用", "排线": "在你这幅画里：排线的方向决定了阴影过渡是否柔和"}\n'
        "只填这幅画真正涉及到的术语（1-2个为佳）。如果没有术语，留空对象 {}。\n\n"
        "严格的规则：\n"
        f"- layers 必须有 {layer_count} 个，按顺序：{layer_order}\n"
        "- 每层 content 控制在 2 句话内，精炼有温度，避免冗长\n"
        f"- 称呼用户为{user_name}，让对话有亲密感\n"
        "- 评价画作内容本身，不说照片质量或光线\n"
        "- 识别内容时严谨第一：宁可说得模糊（'看起来像一个人形/一个圆形物体'），也绝不说错\n"
        "- 如果只有 50-70% 的把握，必须用'看起来像一个人形轮廓/一个圆柱形物体'这类开放表达，而不是斩钉截铁说'这是一个XX'\n"
        "- 如果 80%+ 确定（有明确的面部特征/五官/四肢等），可以说'你画的是...对吧？'——用问句结尾，留余地\n"
        "- 认出具体物体/人物/场景时，必须表现出你认出来了（前提是准确）\n"
        "- 即使画得很简单，也要找出值得肯定的地方\n"
        "- 不用'继续加油'这种空话\n"
        "- 如果用到专业绘画术语，必须紧跟一句大白话解释\n"
        "- 反馈深度必须匹配当前阶段策略\n"
        "- 回复纯 JSON，不要任何其他文字或代码块标记\n"
        "- 所有 content 保持中文\n"
    )

    if history:
        prompt += (
            "\n【绘画历史】\n"
            f"以下是{user_name}最近画过的内容（按时间从旧到新）：\n"
        )
        for i, h in enumerate(history, 1):
            snippet = h.strip().replace("\n", " ")[:80]
            prompt += f"{i}. {snippet}\n"
        prompt += (
            "\n请结合历史，让回复有连贯感——比如认出用户进步了、或延续上次的话题。"
            "不要生硬重复。"
        )

    return prompt


def _sse_event(data: dict) -> bytes:
    """把 dict 序列化为一条 SSE 事件，直接返回 bytes。"""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


# 用于在流式输出中增量提取「已完成的 layer 对象」
# 使用 JSONDecoder.raw_decode 代替正则，正确处理 content 内含 } 的场景
_json_decoder = json.JSONDecoder()
_LAYER_TYPES = ("identify", "observe", "progress", "suggestion", "encourage")


def _extract_complete_layers(accumulated: str, seen_count: int = 0) -> list[dict]:
    """从累积文本中提取完整的 layer JSON 对象。

    用 JSONDecoder.raw_decode 逐个尝试解析，正确处理字符串内的 ``}`` 等特殊字符。
    只返回 ``seen_count`` 之后新增的 layer（避免重复）。
    """
    results = []
    i = 0
    found = 0
    while i < len(accumulated):
        match = re.search(r'\{\s*"type"', accumulated[i:])
        if not match:
            break
        idx = i + match.start()
        try:
            obj, consumed = _json_decoder.raw_decode(accumulated[idx:])
            if isinstance(obj, dict) and obj.get("type") in _LAYER_TYPES:
                found += 1
                if found > seen_count:
                    results.append(obj)
                i = idx + consumed
            else:
                i = idx + 1
        except json.JSONDecodeError:
            # JSON 还不完整，跳过继续搜索
            i = idx + 1
    return results


def analyze_drawing_stream(
    image_path: Path,
    history: list[str] | None = None,
    user_name: str = "小伙伴",
    total_drawings: int = 1,
    user_level: str | None = None,
    user_goal: str | None = None,
    record_context: dict | None = None,
):
    """流式分析画作，逐个 yield SSE 事件字符串。

    与 ``analyze_drawing`` 复用同一套 prompt 构建逻辑（``_build_analyze_prompt``），
    仅 API 调用改为 ``stream=True`` 并逐块提取 layers。

    事件类型：
      - {"type":"layer","layer":{...}}           每检测到一个新的完整 layer
      - {"type":"complete","record":...,"milestone":...,"next_recommendation":...}
      - {"type":"error","message":"..."}         出错时

    ``record_context``（可选）用于在 complete 事件中返回与 ``/api/analyze`` 一致的
    完整 record 并持久化，包含字段：
      record_id / image_relpath / timestamp / note / profile
    若不传，complete 事件仅返回分析结果（feedback / feedback_json / elapsed_s）。
    """
    import time

    image_b64 = _compress_image_b64(image_path)
    prompt = _build_analyze_prompt(
        history=history,
        user_name=user_name,
        total_drawings=total_drawings,
        user_level=user_level,
        user_goal=user_goal,
    )

    t0 = time.time()
    accumulated = ""
    streamed_layers: list[dict] = []  # 已发送的 layer dict
    sent_layer_count = 0               # 已发送的 layer 数（用于增量提取）
    first_chunk_time = None

    # ── 首层秒出：立即发送一条"第一印象"消息，让用户不用干等 ──
    yield _sse_event({
        "type": "first_impression",
        "message": "小绘正在仔细看你的画…",
    })

    try:
        stream = client.chat.completions.create(
            model=ARK_MODEL,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{image_b64}"
                            },
                        },
                    ],
                }
            ],
            max_tokens=500,
            temperature=0.7,
            stream=True,
            extra_body={"thinking": {"type": "disabled"}},
        )

        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta

            # 记录首个 chunk 到达时间（用于诊断延迟）
            if first_chunk_time is None:
                first_chunk_time = time.time() - t0
                print(f"[stream] 首个 chunk 到达: {first_chunk_time:.1f}s", flush=True)

            # 处理 reasoning_content（思考链）— 不用于 layer 提取，仅记录
            reasoning = getattr(delta, "reasoning_content", None)
            if reasoning:
                print(f"[stream] reasoning chunk ({len(reasoning)} chars)", flush=True)

            piece = getattr(delta, "content", None)
            if not piece:
                continue
            accumulated += piece

            # 用 JSONDecoder 增量提取已完成的 layer 对象
            new_layers = _extract_complete_layers(accumulated, sent_layer_count)
            for layer_obj in new_layers:
                sent_layer_count += 1
                streamed_layers.append(layer_obj)
                layer_time = time.time() - t0
                print(f"[stream] layer {sent_layer_count} ({layer_obj.get('type')}) sent at {layer_time:.1f}s", flush=True)
                yield _sse_event({"type": "layer", "layer": layer_obj})

        elapsed = time.time() - t0
        print(f"[stream] LLM 完成，耗时 {elapsed:.1f}s，共 {len(streamed_layers)} 层", flush=True)
    except Exception as e:
        # LLM API 失败时，仍保存记录（避免数据丢失），反馈内容为错误提示
        elapsed = time.time() - t0
        error_msg = f"分析失败: {str(e)}"
        if record_context:
            milestone = get_milestone(total_drawings)
            record = {
                "id": record_context.get("record_id", ""),
                "image": record_context.get("image_relpath", ""),
                "feedback": f"抱歉，{error_msg}。你的画已经保存了，请稍后重试。",
                "feedback_json": None,
                "milestone": milestone,
                "note": record_context.get("note", ""),
                "theme": record_context.get("theme", ""),
                "elapsed_s": round(elapsed, 1),
                "timestamp": record_context.get("timestamp", ""),
            }
            try:
                records = load_records()
                records.append(record)
                save_records(records)
                print(f"[stream] ✅ 错误 fallback 记录已保存: id={record.get('id')}", flush=True)
            except Exception as save_err:
                print(f"[stream] ❌ fallback 记录保存失败: {save_err}", flush=True)
            yield _sse_event({
                "type": "complete",
                "record": record,
                "milestone": milestone,
                "next_recommendation": None,
            })
        else:
            yield _sse_event({"type": "error", "message": error_msg})
        return

    # ── 累积完成后，解析完整 JSON 获取所有层（包括 tip 等正则可能遗漏的字段）──
    raw = accumulated.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)

    feedback_json = None
    complete_layers = streamed_layers

    try:
        data = json.loads(raw)
        layers = data.get("layers", [])
        if layers and len(layers) >= 4:
            feedback_json = data
            complete_layers = layers
    except (json.JSONDecodeError, TypeError):
        pass

    # 若流式提取没抓全但完整 JSON 解析出了更多层，补发遗漏的 layer 事件
    sent_types = {l.get("type") for l in streamed_layers}
    for layer in complete_layers:
        if layer.get("type") not in sent_types:
            yield _sse_event({"type": "layer", "layer": layer})
            sent_types.add(layer.get("type"))

    content = _layers_to_text(complete_layers, user_name) if complete_layers else raw
    elapsed_rounded = round(elapsed, 1)
    # milestone 计算容错：任何异常都不能中断记录保存与 complete 事件
    try:
        milestone = get_milestone(total_drawings)
    except Exception as e:
        print(f"[stream] ⚠️ milestone 计算失败（不影响保存）: {e}", flush=True)
        milestone = None

    # 构建 complete 事件（如提供 record_context，则持久化并返回完整 record + 推荐）
    if record_context:
        record = {
            "id": record_context.get("record_id", ""),
            "image": record_context.get("image_relpath", ""),
            "feedback": content,
            "feedback_json": feedback_json,
            "milestone": milestone,
            "note": record_context.get("note", ""),
            "theme": record_context.get("theme", ""),
            "elapsed_s": elapsed_rounded,
            "timestamp": record_context.get("timestamp", ""),
        }
        # 持久化记录（与 /api/analyze 保持一致）
        try:
            records = load_records()
            records.append(record)
            save_records(records)
            log_event("image_uploaded", {
                "total": total_drawings,
                "record_id": record_context.get("record_id", ""),
            })
            print(f"[stream] ✅ 记录已保存: id={record.get('id')}, total={len(records)}", flush=True)
        except Exception as e:
            # 记录保存失败时把完整 traceback 写到文件，便于诊断（服务器 stdout 在用户终端里读不到）
            try:
                import traceback as _tb
                with open("/tmp/craft_save_error.log", "a", encoding="utf-8") as _f:
                    _f.write(f"=== {record.get('id','?')} @ {__import__('datetime').datetime.now()} ===\n")
                    _f.write(_tb.format_exc() + "\n")
            except Exception:
                pass
            print(f"[stream] ❌ 记录保存失败: {e}", flush=True)
        # 画完后推荐下一幅
        profile = record_context.get("profile") or load_profile()
        try:
            next_rec = get_recommendation(profile, total_drawings + 1)
        except Exception:
            next_rec = None
    else:
        record = {
            "feedback": content,
            "feedback_json": feedback_json,
            "elapsed_s": elapsed_rounded,
        }
        next_rec = None

    yield _sse_event({
        "type": "complete",
        "record": record,
        "milestone": milestone,
        "next_recommendation": next_rec,
    })

