"""每日绘 Craft · 后端服务主入口

Flask app 组装：注册社区 Blueprint，定义核心路由，启动服务。
（v2.1 重构：按职责拆分为 config / data_store / ai_service / community_api）
"""
import os
import json
import base64
import uuid
import random
import re
import time as _time_module
from datetime import datetime, date, timedelta
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS

from config import (
    BASE_DIR,
    DATA_DIR,
    IMAGES_DIR,
    RECORDS_FILE,
    TRACKING_FILE,
    COMMUNITY_FILE,
    ARK_API_KEY,
    ARK_MODEL,
    client,
)
from data_store import (
    log_event,
    get_funnel_stats,
    load_records,
    save_records,
    load_community_posts,
    save_community_posts,
    load_profile,
    save_profile,
    get_drawing_stage,
    get_milestone,
    _layers_to_text,
    _record_date,
    calc_streak,
    calc_max_streak,
    get_recommendation,
    MASTER_INDEX,
    RECOMMENDATION_POOL,
    THEME_LIBRARY,
    DIFFICULTY_LABELS,
)
from ai_service import analyze_drawing, _compress_image_b64, _build_analyze_prompt, analyze_drawing_stream, _sse_event
from community_api import community_bp

app = Flask(__name__)
CORS(app)
app.register_blueprint(community_bp)

# growth_stages import removed in v3.0 (Phase 2, hidden for MVP)

# ── API 路由 ──────────────────────────────────────────


@app.route("/")
def index():
    return send_from_directory(str(BASE_DIR / "static"), "index.html")


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    if "image" not in request.files:
        return jsonify({"error": "请上传图片"}), 400

    file = request.files["image"]
    if file.filename == "":
        return jsonify({"error": "请选择图片"}), 400

    record_id = str(uuid.uuid4())[:8]
    timestamp = datetime.now().isoformat()
    ext = os.path.splitext(file.filename)[1] or ".jpg"
    filename = f"{timestamp[:10]}_{record_id}{ext}"
    image_path = IMAGES_DIR / filename
    file.save(image_path)

    past_records = load_records()
    profile = load_profile()
    history = [r["feedback"] for r in past_records[-2:]] if past_records else None
    total = len(past_records) + 1

    try:
        feedback, feedback_json, elapsed, boss_result = analyze_drawing(
            image_path,
            history=history,
            user_name=profile.get("name", "小伙伴"),
            total_drawings=total,
            user_level=profile.get("level"),
            user_goal=profile.get("goal"),
        )
    except Exception as e:
        return jsonify({"error": f"分析失败: {str(e)}"}), 500

    note = request.form.get("note", "").strip()[:200]

    milestone = get_milestone(total)

    record = {
        "id": record_id,
        "image": f"images/{filename}",
        "feedback": feedback,
        "feedback_json": feedback_json,
        "milestone": milestone,
        "note": note,
        "elapsed_s": round(elapsed, 1),
        "timestamp": timestamp,
    }
    records = load_records()
    records.append(record)
    save_records(records)

    # 埋点：上传画作
    log_event("image_uploaded", {"total": total, "record_id": record_id})

    # 画完后推荐下一幅
    next_rec = get_recommendation(profile, total + 1)

    return jsonify({"record": record, "next_recommendation": next_rec, "boss_result": None})


@app.route("/api/check-drawing", methods=["POST"])
def api_check_drawing():
    """快速判断上传的图片是否为手绘画作。"""
    if "image" not in request.files:
        return jsonify({"is_drawing": True})  # 没有图片就不拦

    file = request.files["image"]
    image_b64 = _compress_image_b64(file)

    try:
        resp = client.chat.completions.create(
            model=ARK_MODEL,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "判断这张图片是不是手绘的画作（素描/速写/涂鸦/水彩/油画等）。"
                                "只回答一个词：drawing 或 not_drawing。"
                            ),
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{image_b64}"
                            },
                        },
                    ],
                }
            ],
            max_tokens=5,
            temperature=0,
            extra_body={"thinking": {"type": "disabled"}},
        )
        answer = resp.choices[0].message.content.strip().lower()
        is_drawing = "drawing" in answer and "not" not in answer
        print(f"[check-drawing] AI 判定: {answer} → is_drawing={is_drawing}", flush=True)
        return jsonify({"is_drawing": is_drawing})
    except Exception as e:
        print(f"[check-drawing] 检测失败: {e}，默认放行", flush=True)
        return jsonify({"is_drawing": True})  # 检测失败就放行


@app.route("/api/analyze/stream", methods=["POST"])
def api_analyze_stream():
    """流式分析画作（SSE）。

    与 ``/api/analyze`` 行为一致（保存图片、获取历史/profile、持久化 record、
    推荐下一幅），只是反馈以 Server-Sent Events 流式返回：
      data: {"type":"layer","layer":{...}}        # 每完成一层
      ...
      data: {"type":"complete","record":{...},"milestone":{...},"next_recommendation":{...}}
      data: {"type":"error","message":"..."}       # 出错时
    """
    if "image" not in request.files:
        return jsonify({"error": "请上传图片"}), 400

    file = request.files["image"]
    if file.filename == "":
        return jsonify({"error": "请选择图片"}), 400

    # 1. 保存图片（同现有逻辑）
    record_id = str(uuid.uuid4())[:8]
    timestamp = datetime.now().isoformat()
    ext = os.path.splitext(file.filename)[1] or ".jpg"
    filename = f"{timestamp[:10]}_{record_id}{ext}"
    image_path = IMAGES_DIR / filename
    file.save(image_path)

    # 2. 获取历史记录、profile
    past_records = load_records()
    profile = load_profile()
    history = [r["feedback"] for r in past_records[-2:]] if past_records else None
    total = len(past_records) + 1
    note = request.form.get("note", "").strip()[:200]
    theme = request.form.get("theme", "").strip()[:100]

    record_context = {
        "record_id": record_id,
        "image_relpath": f"images/{filename}",
        "timestamp": timestamp,
        "note": note,
        "theme": theme,
        "profile": profile,
    }

    # 3. 调用 analyze_drawing_stream 生成器
    def generate():
        for sse in analyze_drawing_stream(
            image_path,
            history=history,
            user_name=profile.get("name", "小伙伴"),
            total_drawings=total,
            user_level=profile.get("level"),
            user_goal=profile.get("goal"),
            record_context=record_context,
        ):
            yield sse

    # 4. 返回 SSE 响应
    resp = Response(generate(), mimetype="text/event-stream", direct_passthrough=True)
    resp.headers["Cache-Control"] = "no-cache, no-transform"
    resp.headers["X-Accel-Buffering"] = "no"  # 禁用 Nginx 缓冲，确保实时推送
    resp.headers["Connection"] = "keep-alive"
    return resp


@app.route("/api/timeline")
def api_timeline():
    records = load_records()
    records.reverse()
    return jsonify({"records": records})


@app.route("/api/record/<record_id>", methods=["DELETE"])
def api_delete_record(record_id):
    """删除指定画作记录及其图片文件。"""
    records = load_records()
    record = next((r for r in records if r.get("id") == record_id), None)
    if not record:
        return jsonify({"error": "找不到该记录"}), 404

    # 删除图片文件
    image_path = record.get("image", "")
    if image_path:
        full_path = DATA_DIR / image_path
        if full_path.exists():
            try:
                full_path.unlink()
            except Exception:
                pass

    records.remove(record)
    save_records(records)
    log_event("record_deleted", {"record_id": record_id})
    return jsonify({"ok": True})
@app.route("/api/stats")
def api_stats():
    records = load_records()
    profile = load_profile()

    total = len(records)

    # 埋点：首页访问
    log_event("page_home", {"total": total, "onboarding": profile.get("onboarding_done", False)})
    max_streak = calc_max_streak(records)
    current_streak = calc_streak(records)

    # 等级系统：基于最大连胜 + 总张数，不再纯看张数
    # 等级规则：[level, title, 达标所需 streak, 达标所需 total(备选)]
    LEVEL_RULES = [
        (1, "探索者",     0,   1),    # 画了第 1 张
        (2, "坚持者",     3,  10),    # 连续 3 天 or 累计 10 张
        (3, "成长者",     7,  25),    # 连续 7 天 or 累计 25 张
        (4, "磨炼者",    14,  50),    # 连续 14 天 or 累计 50 张
        (5, "创作者",    30, 100),    # 连续 30 天 or 累计 100 张
    ]

    # 判断当前等级
    level = 1
    level_title = "探索者"
    for lv, title, need_streak, need_total in LEVEL_RULES:
        if max_streak >= need_streak or total >= need_total:
            level = lv
            level_title = title
        else:
            break

    # 子等级（星星）：基于"达标进度"
    # 当前等级的目标
    if level < 5:
        _, _, next_need_streak, next_need_total = LEVEL_RULES[level]
        # 用 streak 的完成度作为主要进度，total 作为辅助
        streak_progress = min(100, max_streak / next_need_streak * 100) if next_need_streak else 0
        total_progress = min(100, total / next_need_total * 100) if next_need_total else 0
        progress = max(streak_progress, total_progress)
        sub_level = min(5, max(0, int(progress / 20)))  # 20% 一星
        next_at_streak = next_need_streak
        next_at_total = next_need_total
    else:
        progress = 100
        sub_level = 5
        next_at_streak = None
        next_at_total = None

    level_data = {
        "level": level,
        "title": level_title,
        "sub_level": sub_level,
        "progress": round(progress, 1),
        "next_at_streak": next_at_streak,
        "next_at_total": next_at_total,
        "max_streak": max_streak,
    }

    # 画作标签统计（简单词频）
    tag_counts = {}
    for r in records:
        fb = r.get("feedback", "")
        for tag in ["线条", "色彩", "透视", "明暗", "构图", "人体", "动态", "细节"]:
            if tag in fb:
                tag_counts[tag] = tag_counts.get(tag, 0) + 1
    top_tags = sorted(tag_counts.items(), key=lambda x: -x[1])[:5]
    dominant_skill = top_tags[0][0] if top_tags else "探索中"

    # 近7天频率
    today = date.today()
    week_counts = []
    for i in range(6, -1, -1):
        d = today - timedelta(days=i)
        count = sum(1 for r in records if _record_date(r) == d)
        week_counts.append(count)
    weekly_avg = round(sum(week_counts) / 7, 1)

    # 用户水平标签（3 级简化版，用于前端展示）
    stage = get_drawing_stage(total)
    STAGE_LABELS = {
        "新手期": "基础", "入门期": "基础",
        "成长期": "进阶", "进阶期": "进阶",
        "熟练期": "熟练",
    }
    stage_label = STAGE_LABELS.get(stage, "基础")

    return jsonify({
        "streak": current_streak,
        "max_streak": max_streak,
        "total": total,
        "level": level_data,
        "stage": stage,
        "stage_label": stage_label,
        "weekly_avg": weekly_avg,
        "dominant_skill": dominant_skill,
        "profile": {
            "name": profile.get("name", "小伙伴"),
            "onboarding_done": profile.get("onboarding_done", False),
        },
    })


@app.route("/api/recommend")
def api_recommend():
    """获取今日推荐（按用户等级+兴趣）"""
    profile = load_profile()
    records = load_records()
    rec = get_recommendation(profile, len(records))
    log_event("recommendation_viewed", {"rec_id": rec.get("id", "")})
    return jsonify({"recommendation": rec})


@app.route("/api/themes")
def api_themes():
    """返回主题库，支持按难度 / 分类筛选。

    查询参数：
      - difficulty: beginner | intermediate | advanced（可选）
      - category:   主题分类名，如「日常物品」「人体」（可选）
    """
    difficulty = request.args.get("difficulty", "").strip().lower()
    category = request.args.get("category", "").strip()

    themes = list(THEME_LIBRARY)
    if difficulty in ("beginner", "intermediate", "advanced"):
        themes = [t for t in themes if t["difficulty"] == difficulty]
    if category:
        themes = [t for t in themes if t.get("category") == category]

    # 附上中文难度标签，方便前端直接展示
    for t in themes:
        t["difficulty_label"] = DIFFICULTY_LABELS.get(t["difficulty"], t["difficulty"])

    return jsonify({"themes": themes, "total": len(themes)})


@app.route("/api/today-theme")
def api_today_theme():
    """返回今日主题（单个），支持 ?difficulty=beginner|intermediate|advanced 筛选。

    未指定 difficulty 时，按用户累计张数自动推断：
      1-5 张 → beginner，6-30 张 → intermediate，31+ 张 → advanced。
    主题在同一天内稳定（按 recommendation_index 轮转，不随每次请求变化）。

    ?random=true → 从所有难度中随机选一个（换一换功能）
    ?exclude=xxx → 排除指定 id 的主题（避免换到同一个）
    """
    profile = load_profile()
    records = load_records()
    total = len(records)

    is_random = request.args.get("random", "").strip().lower() == "true"
    exclude_id = request.args.get("exclude", "").strip()

    if is_random:
        # 换一换：从所有主题中随机选一个，排除当前主题
        pool = [t for t in THEME_LIBRARY if t["id"] != exclude_id]
        if not pool:
            pool = list(THEME_LIBRARY)
        theme = dict(random.choice(pool))
        difficulty = theme["difficulty"]
    else:
        difficulty = request.args.get("difficulty", "").strip().lower()
        if difficulty not in ("beginner", "intermediate", "advanced"):
            if total <= 5:
                difficulty = "beginner"
            elif total <= 30:
                difficulty = "intermediate"
            else:
                difficulty = "advanced"

        candidates = [t for t in THEME_LIBRARY if t["difficulty"] == difficulty]
        if not candidates:
            candidates = list(THEME_LIBRARY)

        # 用 recommendation_index 做稳定轮转
        idx = profile.get("recommendation_index", 0) % len(candidates)
        theme = dict(candidates[idx])

    theme["difficulty_label"] = DIFFICULTY_LABELS.get(difficulty, difficulty)

    log_event("today_theme_viewed", {
        "theme_id": theme.get("id", ""),
        "difficulty": difficulty,
        "total": total,
        "random": is_random,
    })
    return jsonify({"theme": theme, "difficulty": difficulty, "total_drawings": total})


@app.route("/api/masters")
def api_masters():
    """返回大师知识库索引（TRAE-01 数据）"""
    return jsonify({
        "masters": {k: {
            "name": v["name"],
            "period": v["period"],
            "tagline": v["tagline"],
            "bio": v["bio"],
            "learn_points": v["learn_points"][:3],
            "works": v["works"],
        } for k, v in MASTER_INDEX.items()}
    })


@app.route("/api/masters/search")
def api_masters_search():
    """搜索大师（按名字模糊匹配）"""
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"results": []})
    results = []
    for name, data in MASTER_INDEX.items():
        if q in name or name.startswith(q):
            results.append({
                "name": name,
                "tagline": data["tagline"],
                "bio": data["bio"],
                "learn_points": data["learn_points"],
                "works": data["works"][:3],
            })
    return jsonify({"results": results})


@app.route("/api/onboarding", methods=["GET", "POST"])
def api_onboarding():
    """获取/保存用户画像（v3.0：仅名字）"""
    if request.method == "POST":
        data = request.get_json() or {}
        profile = load_profile()

        if "name" in data:
            profile["name"] = data["name"].strip()[:20]

        # 有名字即完成引导
        if profile.get("name"):
            profile["onboarding_done"] = True
            profile["onboarding_at"] = datetime.now().isoformat()

        save_profile(profile)

        if profile.get("onboarding_done"):
            log_event("onboarding_complete", {"name": profile.get("name")})

        return jsonify({"profile": profile})

    return jsonify({"profile": load_profile()})


@app.route("/api/profile", methods=["GET", "POST"])
def api_profile():
    """获取/设置用户昵称（兼容旧版）"""
    if request.method == "POST":
        data = request.get_json()
        profile = load_profile()
        if data and "name" in data:
            profile["name"] = data["name"].strip()[:20]
        save_profile(profile)
        return jsonify({"profile": profile})
    return jsonify({"profile": load_profile()})


# Path/stages/advance/switch endpoints removed in v3.0 (Phase 2)


# ── 重置 API ──────────────────────────────────────────

@app.route("/api/reset", methods=["POST"])
def api_reset():
    """清空所有用户数据（记录、画像、进度、埋点、图片）"""
    # 清空记录
    save_records([])
    # 重置画像
    fresh_profile = {
        "name": "小伙伴",
        "onboarding_done": False,
        "onboarding_at": None,
        "recommendation_index": 0,
    }
    save_profile(fresh_profile)
    # 清空埋点
    if TRACKING_FILE.exists():
        TRACKING_FILE.write_text("[]", encoding="utf-8")
    # 清空图片
    for f in IMAGES_DIR.glob("*"):
        if f.is_file():
            f.unlink()
    # 清空社区帖子（否则残留帖子引用已删除的图片）
    if COMMUNITY_FILE.exists():
        save_community_posts([])
    return jsonify({"ok": True, "message": "所有数据已清空，刷新页面后重新开始"})


# ── 埋点 API ──────────────────────────────────────────

@app.route("/api/track", methods=["POST"])
def api_track():
    """前端主动上报事件"""
    data = request.get_json() or {}
    event = data.get("event", "")
    metadata = data.get("metadata", {})
    if event:
        log_event(event, metadata)
    return jsonify({"ok": True})


@app.route("/api/tracking/stats")
def api_tracking_stats():
    """查看埋点漏斗数据"""
    stats = get_funnel_stats()
    # 读取原始事件列表（最近 50 条）
    events = []
    if TRACKING_FILE.exists():
        try:
            events = json.loads(TRACKING_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    recent = sorted(events, key=lambda e: e["ts"], reverse=True)[:50]
    return jsonify({
        "funnel": stats["funnel"],
        "total_events": stats["total_events"],
        "total_users": stats["total_users"],
        "recent_events": recent,
    })
@app.route("/api/reflection", methods=["POST"])
def api_reflection():
    """用户画完画后写下反思，AI 给予个性化的回应（SSE 流式）。

    前端 ``sendReflection()`` 发送用户反思文本+主题，
    后端以 SSE 流式返回 AI 生成的单句回复（逐字推送），让用户立即看到内容不断出现。
    """
    data = request.get_json() or {}
    user_text = (data.get("text") or "").strip()
    subject = (data.get("subject") or "这次画画").strip()

    if not user_text:
        return jsonify({"reply": "嗯，你说了什么吗？我好像没看到 😅"})

    def generate():
        _t0 = _time_module.time()
        try:
            stream = client.chat.completions.create(
                model=ARK_MODEL,
                messages=[
                    {
                        "role": "system",
                        "content": "你是小绘。用户画完画写了一句反思，你用一句话针对内容回应ta，语气自然，不加emoji。",
                    },
                    {
                        "role": "user",
                        "content": f"主题：{subject}\n用户说：「{user_text}」",
                    },
                ],
                max_tokens=20,
                temperature=0.8,
                stream=True,
                extra_body={"thinking": {"type": "disabled"}},
            )
            for chunk in stream:
                token = chunk.choices[0].delta.content or ""
                if token:
                    yield _sse_event({'token': token})
            elapsed = round(_time_module.time() - _t0, 1)
            print(f"[reflection] SSE 完成，耗时 {elapsed:.1f}s", flush=True)
            yield _sse_event({'type': 'done', 'elapsed_s': elapsed})
        except Exception as e:
            yield _sse_event({'type': 'fallback', 'text': '嗯，我听到了。每次进步都值得记下来 ☺️'})

    resp = Response(generate(), mimetype="text/event-stream", direct_passthrough=True)
    resp.headers["Cache-Control"] = "no-cache, no-transform"
    resp.headers["X-Accel-Buffering"] = "no"
    resp.headers["Connection"] = "keep-alive"
    return resp


@app.route("/api/reflection-tags", methods=["POST"])
def api_reflection_tags():
    """根据画作主题和 AI 反馈，生成 3 个个性化的反思快选标签。"""
    data = request.get_json() or {}
    subject = (data.get("subject") or "").strip()
    feedback_snippet = (data.get("feedback_snippet") or "").strip()[:200]

    print(f"[reflection-tags] 收到请求: subject='{subject}' snippet='{feedback_snippet[:50]}...'", flush=True)
    # 兜底：没有足够上下文时返回默认标签
    if not subject and not feedback_snippet:
        print(f"[reflection-tags] ⚠ 上下文不足，返回兜底标签", flush=True)
        return jsonify({"tags": [
            {"text": "形状抓得准", "emoji": "🎯"},
            {"text": "线条更流畅", "emoji": "〰️"},
            {"text": "今天有感觉", "emoji": "🎨"},
        ]})

    _t0 = _time_module.time()
    try:
        resp = client.chat.completions.create(
            model=ARK_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "你是一个绘画陪伴助手。用户画了一幅画，请根据画作主题和AI反馈，"
                        "生成3个简短、具体的反思快选标签，让用户选择最满意的地方。"
                        "每个标签6字以内，去掉'了''的'等虚词。\n"
                        "格式：JSON对象，tags字段是数组，每个元素有text和emoji字段。"
                    ),
                },
                {
                    "role": "user",
                    "content": f"主题：{subject}\n反馈要点：{feedback_snippet}",
                },
            ],
            max_tokens=300,
            temperature=0.7,
            response_format={"type": "json_object"},
            extra_body={"thinking": {"type": "disabled"}},
        )
        result = json.loads(resp.choices[0].message.content)
        tags = result.get("tags", [])[:3]
        elapsed = round(_time_module.time() - _t0, 1)
        print(f"[reflection-tags] API 完成，耗时 {elapsed:.1f}s，生成 {len(tags)} 个标签", flush=True)
        if tags and all(isinstance(t, dict) and t.get("text") for t in tags):
            return jsonify({"tags": tags})
    except Exception as e:
        print(f"[reflection-tags] API 失败: {e}", flush=True)
        pass

    # 兜底
    return jsonify({"tags": [
        {"text": "形状抓得准", "emoji": "🎯"},
        {"text": "线条更流畅", "emoji": "〰️"},
        {"text": "整体感觉不错", "emoji": "✨"},
        {"text": "今天有感觉", "emoji": "🎨"},
    ]})
@app.route("/data/<path:filename>")
def serve_data(filename):
    resp = send_from_directory(str(DATA_DIR), filename)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


# ── PWA：Service Worker / Manifest ─────────────────────
@app.route('/sw.js')
def sw_js():
    resp = send_from_directory(BASE_DIR / 'static', 'sw.js', mimetype='application/javascript')
    resp.headers['Service-Worker-Allowed'] = '/'
    return resp

@app.route('/manifest.json')
def manifest_json():
    return send_from_directory(BASE_DIR / 'static', 'manifest.json', mimetype='application/manifest+json')


# ── 启动 ──────────────────────────────────────────────

if __name__ == "__main__":
    if not ARK_API_KEY:
        print("⚠️  未设置 ARK_API_KEY 环境变量！")
    else:
        print(f"✅ ARK API 已配置 · 模型: {ARK_MODEL}")
        print(f"   数据目录: {DATA_DIR}")

    # 模型预热：发一个空请求让模型保持热状态，减少后续请求冷启动延迟
    if ARK_API_KEY:
        try:
            client.chat.completions.create(
                model=ARK_MODEL,
                messages=[{"role": "user", "content": "你好"}],
                max_tokens=1,
                stream=False,
            )
            print("🌡️  模型已预热")
        except Exception as e:
            print(f"⚠️  模型预热失败（不影响运行）: {e}")

    # 检测是否有 Onboarding 数据
    profile = load_profile()
    if profile.get("onboarding_done"):
        name = profile.get("name", "小伙伴")
        level = {"beginner": "新手", "intermediate": "有基础", "advanced": "进阶"}.get(
            profile.get("level", ""), "未知"
        )
        print(f"👤 当前用户: {name} · 水平: {level}")
    else:
        print("🆕 首次启动 · 等待用户完成引导")

    print(f"\n🚀 启动服务: http://0.0.0.0:5001")
    print(f"   手机访问: http://<本机IP>:5001")
    app.run(host="0.0.0.0", port=5001, debug=os.getenv('FLASK_DEBUG', 'false').lower() == 'true')
