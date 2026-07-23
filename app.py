"""
每日绘 Craft · 后端服务
Flask + Doubao-1.5-vision-pro (ARK API)
"""

import os
import json
import base64
import uuid
from datetime import datetime, date, timedelta
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from openai import OpenAI
from dotenv import load_dotenv

# ── 配置 ──────────────────────────────────────────────

BASE_DIR = Path(__file__).parent

# 加载 .env 文件
dotenv_path = BASE_DIR / ".env"
if dotenv_path.exists():
    load_dotenv(dotenv_path)

DATA_DIR = BASE_DIR / "data"
IMAGES_DIR = DATA_DIR / "images"
RECORDS_FILE = DATA_DIR / "records.json"
USER_PROFILE_FILE = DATA_DIR / "profile.json"

# 确保目录存在
IMAGES_DIR.mkdir(parents=True, exist_ok=True)

ARK_API_KEY = os.environ.get("ARK_API_KEY", "")
ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
ARK_MODEL = "doubao-seed-2-1-turbo-260628"  # ARK 模型 ID

# ── Flask ──────────────────────────────────────────────

app = Flask(__name__)
CORS(app)

# ── ARK 客户端 ────────────────────────────────────────

client = OpenAI(api_key=ARK_API_KEY, base_url=ARK_BASE_URL)


def load_records() -> list[dict]:
    """读取本地记录文件"""
    if RECORDS_FILE.exists():
        with open(RECORDS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_records(records: list[dict]):
    """写入本地记录文件"""
    with open(RECORDS_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)


def load_profile() -> dict:
    """读取用户档案"""
    if USER_PROFILE_FILE.exists():
        with open(USER_PROFILE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"name": "小伙伴"}


def save_profile(profile: dict):
    """写入用户档案"""
    with open(USER_PROFILE_FILE, "w", encoding="utf-8") as f:
        json.dump(profile, f, ensure_ascii=False, indent=2)


def get_drawing_stage(count: int) -> str:
    """根据画作数量返回用户所处阶段"""
    if count <= 3:
        return "启蒙期"
    elif count <= 20:
        return "成长期"
    else:
        return "进阶期"


def calc_streak(records: list[dict]) -> int:
    """
    计算连续绘画天数（Streak）

    从今天往回数，连续有记录的日期数。
    如果今天还没画但昨天有记录，streak = 1（昨天算起）。
    """
    if not records:
        return 0

    # 提取所有绘画日期（去重）
    draw_dates = set()
    for r in records:
        try:
            d = datetime.fromisoformat(r["timestamp"]).date()
            draw_dates.add(d)
        except (ValueError, KeyError):
            continue

    today = date.today()
    streak = 0
    check = today

    while check in draw_dates:
        streak += 1
        check -= timedelta(days=1)

    return streak


def analyze_drawing(
    image_path: Path,
    history: list[str] | None = None,
    user_name: str = "小伙伴",
    total_drawings: int = 1,
) -> tuple[str, float]:
    """
    调用 VLM 分析手绘作品

    Args:
        image_path: 图片文件路径
        history: 最近几次绘画的反馈文本列表
        user_name: 用户昵称
        total_drawings: 累计画作数

    Returns:
        (AI 反馈文本, 耗时秒数)
    """
    with open(image_path, "rb") as f:
        image_b64 = base64.b64encode(f.read()).decode("utf-8")

    # 根据绘画数量决定语气阶段
    stage = get_drawing_stage(total_drawings)

    stage_prompts = {
        "启蒙期": (
            "用户刚开始画画没多久，可能没有信心。"
            "请用最温暖、最鼓励的语气，重点发掘画中的任何闪光点。"
            "改进建议要说得很轻、很温柔，像在说「下次试试这样会更有趣哦」。"
        ),
        "成长期": (
            "用户已经画了一段时间，有一定基础但还会卡住。"
            "在鼓励的同时可以给出更具体的技巧建议。"
            "可以偶尔用一两个绘画术语，但必须用大白话解释。"
            "表现出你注意到 ta 的进步。"
        ),
        "进阶期": (
            "用户已经积累了相当多的画作，有一定功底。"
            "反馈可以更有深度，给出有实质提升意义的建议。"
            "可以用专业术语并解释，甚至可以追问「你试过XX画法吗」。"
            "语气依然是朋友般的，但带着对 ta 能力的尊重。"
        ),
    }

    stage_hint = stage_prompts.get(stage, stage_prompts["启蒙期"])

    prompt = (
        f"你叫「艾莉西亚」，是{user_name}的绘画陪伴伙伴。\n\n"
        "你的性格：温暖、细腻、有幽默感，看到好画会真心开心。"
        "你是朋友不是老师，从不居高临下。"
        "你了解{user_name}的绘画历程，能看到每一次的进步。\n\n"
        "现在{user_name}拍了手绘照片给你看。\n\n"
        f"【当前阶段：{stage}】\n{stage_hint}\n\n"
        "请回复三段（每段不超过 2 句话）：\n"
        "1. 先真诚地夸一个具体的亮点（线条、构图、观察力、某个画得好的局部）\n"
        "2. 再给一个具体的改进建议（只给一条，不超过一条）\n"
        "3. 以鼓励和期待收尾\n\n"
        "注意：\n"
        "- 称呼用户为{user_name}，让对话有亲密感\n"
        "- 评价画作内容本身，不说照片质量或光线\n"
        "- 如果画的是具体物体/人物/场景，表现出你认出来了\n"
        "- 即使画得很简单，也要找出值得肯定的地方\n"
        "- 不用'继续加油'这种空话\n"
        "- 如果用到专业绘画术语，必须紧跟一句大白话解释\n"
        "- 回复保持中文\n"
    )

    # 添加上下文记忆
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
        max_tokens=400,
        temperature=0.7,
        # 关闭深度思考模式，减少等待时间
        extra_body={"thinking": {"type": "disabled"}},
    )

    elapsed = time.time() - t0
    return response.choices[0].message.content, elapsed


# ── API 路由 ──────────────────────────────────────────

@app.route("/")
def index():
    """提供前端页面"""
    return send_from_directory(str(BASE_DIR / "static"), "index.html")


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    """
    接收画作图片 → VLM 分析 → 保存记录 → 返回反馈

    Body: multipart/form-data, field "image"
    """
    if "image" not in request.files:
        return jsonify({"error": "请上传图片"}), 400

    file = request.files["image"]
    if file.filename == "":
        return jsonify({"error": "请选择图片"}), 400

    # 保存图片
    record_id = str(uuid.uuid4())[:8]
    timestamp = datetime.now().isoformat()
    ext = os.path.splitext(file.filename)[1] or ".jpg"
    filename = f"{timestamp[:10]}_{record_id}{ext}"
    image_path = IMAGES_DIR / filename
    file.save(image_path)

    # 用户档案与上下文
    past_records = load_records()
    profile = load_profile()
    history = [r["feedback"] for r in past_records[-2:]] if past_records else None
    total = len(past_records) + 1  # +1 当前这张

    # 调用 VLM
    try:
        feedback, elapsed = analyze_drawing(
            image_path,
            history=history,
            user_name=profile.get("name", "小伙伴"),
            total_drawings=total,
        )
    except Exception as e:
        return jsonify({"error": f"分析失败: {str(e)}"}), 500

    # 保存记录
    record = {
        "id": record_id,
        "image": f"images/{filename}",
        "feedback": feedback,
        "elapsed_s": round(elapsed, 1),
        "timestamp": timestamp,
    }
    records = load_records()
    records.append(record)
    save_records(records)

    return jsonify({"record": record})


@app.route("/api/timeline")
def api_timeline():
    """返回所有历史记录（按时间倒序）"""
    records = load_records()
    records.reverse()
    return jsonify({"records": records})


@app.route("/api/stats")
def api_stats():
    """返回统计数据：streak、总画作数"""
    records = load_records()
    return jsonify({
        "streak": calc_streak(records),
        "total": len(records),
    })


@app.route("/api/profile", methods=["GET", "POST"])
def api_profile():
    """获取/设置用户档案"""
    if request.method == "POST":
        data = request.get_json()
        profile = load_profile()
        if data and "name" in data:
            profile["name"] = data["name"].strip()[:20]
        save_profile(profile)
        return jsonify({"profile": profile})
    return jsonify({"profile": load_profile()})


@app.route("/data/<path:filename>")
def serve_data(filename):
    """提供图片文件（带 CORS 头）"""
    resp = send_from_directory(str(DATA_DIR), filename)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


# ── 启动 ──────────────────────────────────────────────

if __name__ == "__main__":
    if not ARK_API_KEY:
        print("⚠️  未设置 ARK_API_KEY 环境变量！")
        print("   请在终端执行: export ARK_API_KEY='你的key'")
        print("   或写入 .env 文件，或用 export 加载")
    else:
        print(f"✅ ARK API 已配置")
        print(f"   模型: {ARK_MODEL}")
        print(f"   数据目录: {DATA_DIR}")

    print(f"\n🚀 启动服务: http://0.0.0.0:5001")
    print(f"   手机访问: http://<本机IP>:5001")
    app.run(host="0.0.0.0", port=5001, debug=True)
