"""
每日绘 Craft · 后端服务 v2.0
Flask + Doubao-1.5-vision-pro (ARK API)

v2.0 变更：
  - 新增 Onboarding 引导系统
  - 新增 今日推荐/参考系统
  - 首页改为绘画入口（非上传工具）
"""

import os
import json
import base64
import uuid
import random
import re
from datetime import datetime, date, timedelta
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS
from openai import OpenAI
from dotenv import load_dotenv

# growth_stages import removed in v3.0 (Phase 2, hidden for MVP)

# ── 配置 ──────────────────────────────────────────────

BASE_DIR = Path(__file__).parent

dotenv_path = BASE_DIR / ".env"
if dotenv_path.exists():
    load_dotenv(dotenv_path)

DATA_DIR = BASE_DIR / "data"
IMAGES_DIR = DATA_DIR / "images"
RECORDS_FILE = DATA_DIR / "records.json"
USER_PROFILE_FILE = DATA_DIR / "profile.json"

IMAGES_DIR.mkdir(parents=True, exist_ok=True)

# ── 埋点系统 ──────────────────────────────────────────
TRACKING_FILE = DATA_DIR / "tracking.json"


def log_event(event: str, metadata: dict = None):
    """记录用户行为事件"""
    events = []
    if TRACKING_FILE.exists():
        try:
            events = json.loads(TRACKING_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    events.append({
        "event": event,
        "ts": datetime.now().isoformat(),
        "metadata": metadata or {},
    })
    TRACKING_FILE.write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")


def get_funnel_stats() -> dict:
    """计算各步骤的漏斗数据"""
    events = []
    if TRACKING_FILE.exists():
        try:
            events = json.loads(TRACKING_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass

    # 完整用户旅程漏斗定义
    funnel_sequence = [
        ("onboarding_start",       "① 看到引导页"),
        ("onboarding_complete",    "② 完成引导"),
        ("page_home",              "③ 看到首页"),
        ("recommendation_viewed",  "④ 看到今日推荐"),
        ("growth_entry_clicked",   "⑤ 点击进入成长"),
        ("page_growth",            "⑥ 进入成长页面"),
        ("stage_detail_viewed",    "⑦ 查看关卡详情"),
        ("camera_opened",          "⑧ 打开相机"),
        ("image_uploaded",         "⑨ 上传画作"),
        ("ai_feedback_viewed",     "⑩ 看到 AI 反馈"),
    ]

    total_users = 1  # 至少1个用户
    funnel = []
    prev_count = None
    for event_key, event_label in funnel_sequence:
        count = sum(1 for e in events if e["event"] == event_key)
        if prev_count is not None and prev_count > 0:
            drop_rate = round((1 - count / prev_count) * 100, 1)
        else:
            drop_rate = 0
        if prev_count is None:
            total_users = count
        funnel.append({
            "step": event_label,
            "event": event_key,
            "count": count,
            "drop_rate": drop_rate,
        })
        prev_count = count

    return {
        "funnel": funnel,
        "total_events": len(events),
        "total_users": total_users,
    }


# TRAE-01 百科知识库路径
KB_DIR = BASE_DIR.parent / "百科知识库"
MASTER_DIR = KB_DIR / "大师"

ARK_API_KEY = os.environ.get("ARK_API_KEY", "")
ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
ARK_MODEL = "doubao-seed-2-1-turbo-260628"

# ── 练习参考图（TRAE-06 下载）────
RECOMMENDATION_IMAGES = {}
_rec_img_file = DATA_DIR / "recommendation_images.json"
if _rec_img_file.exists():
    try:
        RECOMMENDATION_IMAGES = json.loads(_rec_img_file.read_text(encoding="utf-8"))
    except Exception:
        pass

# ── 大师知识库（从 TRAE-01 MD 文件解析）────


# ── 大师图片本地化映射 ─────────────────────────────────
# 如果 data/master_image_mapping.json 存在，将 Wikimedia URL 替换为本地路径
MASTER_IMG_MAP = {}
_master_mapping_file = DATA_DIR / "master_image_mapping.json"
if _master_mapping_file.exists():
    try:
        MASTER_IMG_MAP = json.loads(_master_mapping_file.read_text(encoding="utf-8"))
    except Exception:
        pass


def _localize_url(url: str) -> str:
    """将 Wikimedia 外链替换为本地路径（如果本地缓存存在）"""
    if url in MASTER_IMG_MAP:
        return "/data/master_images/" + MASTER_IMG_MAP[url]
    return url


def parse_trae_master_files() -> dict:
    """
    读取百科知识库/大师/ 下的 MD 文件，返回 {master_name: {...}} 索引

    返回结构：
    {
        "达芬奇": {
            "name": "达芬奇",
            "period": "1452-1519",
            "tagline": "全能天才...",
            "bio": "...",
            "learn_points": ["...", "..."],
            "works": [
                {"title": "蒙娜丽莎", "url": "/data/master_images/xxx.jpg", "description": "重点看..."},
            ],
            "source_file": "22-古典大师.md"
        },
        ...
    }
    """
    masters = {}
    if not MASTER_DIR.exists():
        return masters

    for fpath in sorted(MASTER_DIR.glob("*.md")):
        text = fpath.read_text(encoding="utf-8")

        # 按 ## 分割每个大师区块
        sections = re.split(r"\n## ", text)
        for sec in sections[1:]:  # 跳过文件标题
            sec = "## " + sec
            # 提取大师名
            name_match = re.match(r"## ([^(]+?)\s*(?:\([^)]*\))?\s*$", sec.split("\n")[0])
            if not name_match:
                continue
            name = name_match.group(1).strip().rstrip("，,")

            # 提取年代
            period_match = re.search(r"\(([^)]*)\)", sec.split("\n")[0])
            period = period_match.group(1) if period_match else ""

            # 提取一句话标签
            tag_match = re.search(r"\*\*一句话标签\*\*[：:]\s*(.+)", sec)
            tagline = tag_match.group(1).strip() if tag_match else ""

            # 提取简介
            bio_match = re.search(r"\*\*简介\*\*[：:]\s*(.+?)(?:\n\n|\n\*\*)", sec, re.DOTALL)
            bio = bio_match.group(1).strip() if bio_match else ""

            # 提取临摹学什么
            learn_points = []
            lp_section = re.search(r"\*\*临摹学什么\*\*[：:]\n((?:\s*[-•]\s*.+\n?)+)", sec)
            if lp_section:
                learn_points = [
                    re.sub(r"^[-•]\s*", "", l).strip()
                    for l in lp_section.group(1).split("\n")
                    if l.strip() and not l.strip().startswith("**")
                ]

            # 提取代表作
            works = []
            work_lines = re.findall(
                r"!\[([^\]]*)\]\(([^)]+)\)\s*[—–-]+\s*(.+)",
                sec,
            )
            for title, url, desc in work_lines:
                works.append({
                    "title": title.strip(),
                    "url": _localize_url(url.strip()),
                    "description": desc.strip(),
                })

            if name:
                masters[name] = {
                    "name": name,
                    "period": period,
                    "tagline": tagline,
                    "bio": bio,
                    "learn_points": learn_points,
                    "works": works,
                    "source_file": fpath.name,
                }
    return masters


# 全局缓存：启动时解析一次
MASTER_INDEX = parse_trae_master_files()
MASTER_TO_REC = {}  # master_name → 第一条作品的图片 URL
for m_name, m_data in MASTER_INDEX.items():
    if m_data["works"]:
        MASTER_TO_REC[m_name] = m_data["works"][0]["url"]

app = Flask(__name__)
CORS(app)
client = OpenAI(api_key=ARK_API_KEY, base_url=ARK_BASE_URL)

# ── 内置推荐知识库（待 TRAE 生成百科后替换为文件查询）────

RECOMMENDATION_POOL = [
    # ── Lv.1 新手 ──
    {
        "id": "cup",
        "title": "画一个杯子 🥤",
        "summary": "从最简单的圆柱体开始练习",
        "description": "杯子是圆柱体 + 弧线把手的组合，是学画最经典的起步练习。先画杯口椭圆（长轴和短轴决定视角），再画杯身垂直线，最后加把手。",
        "min_level": 1, "max_level": 2,
        "interests": ["*", "daily", "food"],
        "master": "莫兰迪",
        "master_work": "静物（瓶罐系列）",
        "learn_point": "看莫兰迪怎么用最少的形状变化画出丰富的画面——你画杯子不需要细节，形状对了就成功了一半",
        "difficulty": 1,
    },
    {
        "id": "apple",
        "title": "画一个苹果 🍎",
        "summary": "第一次给物体加上明暗",
        "description": "找一个有侧面光源的苹果，画出五大调子——亮面、灰面、明暗交界线、反光、投影。明暗交界线是最暗的，反光比投影亮一点。",
        "min_level": 1, "max_level": 2,
        "interests": ["*", "daily"],
        "master": "塞尚",
        "master_work": "《静物苹果篮子》",
        "learn_point": "塞尚的苹果不是画「红色的圆」——他用冷暖色块的交界来表现苹果的立体感，而不是用明暗渐变",
        "difficulty": 1,
    },
    {
        "id": "tree",
        "title": "画一棵树 🌳",
        "summary": "练习用简单形状概括复杂自然物",
        "description": "树干是圆柱，树冠是大球体/锥体。先画基本形状，再往里分叉和加小细节。不要一上来画每片叶子——先抓整体。",
        "min_level": 1, "max_level": 2,
        "interests": ["flower"],
        "master": "门采尔",
        "master_work": "风景速写",
        "learn_point": "门采尔的树不是画叶子——他画的是树冠的剪影形状和树干的空间姿态",
        "difficulty": 1,
    },
    {
        "id": "hand",
        "title": "画自己的手 🖐️",
        "summary": "练习观察轮廓和比例",
        "description": "把手放在纸上，先看整体剪影——不要一根根画手指，先画整体形状再加手指分界线。注意手指之间的缝隙（负形）。",
        "min_level": 1, "max_level": 2,
        "interests": ["portrait"],
        "master": "荷尔拜因",
        "master_work": "肖像手部习作",
        "learn_point": "荷尔拜因画手的时候也是先定手腕和手掌的大形状——手指的细节不是在轮廓上添加的，而是在大形里切分出来的",
        "difficulty": 1,
    },
    {
        "id": "silhouette",
        "title": "窗外风景剪影 🪟",
        "summary": "剪影观察法练习",
        "description": "看窗外，把所有东西想象成纯黑剪影。只画外轮廓——建筑、树、电线杆的剪影。如果轮廓对了，画面就成功了 80%。",
        "min_level": 1, "max_level": 2,
        "interests": ["flower"],
        "master": "霍克尼",
        "master_work": "风景速写系列",
        "learn_point": "霍克尼用最简洁的形状概括复杂的风景——先看大色块，再看细节",
        "difficulty": 1,
    },
    # ── Lv.2-Lv.3 基础→进阶 ──
    {
        "id": "sphere",
        "title": "画一个球（完整五大调子）⚪",
        "summary": "精确练习五大调子",
        "description": "找一个球（篮球/苹果/橘子），放在台灯下。五大调子中，明暗交界线是最暗的弧线——它跟着球的弧度走，不是随意的一条线。",
        "min_level": 2, "max_level": 3,
        "interests": ["*"],
        "master": "伦勃朗",
        "master_work": "《自画像》系列",
        "learn_point": "看伦勃朗怎么用光的包络面来塑造立体感——他的脸不是一条条线画出来的，是一个个面的转折",
        "difficulty": 2,
    },
    {
        "id": "eye",
        "title": "画自己的眼睛 👁️",
        "summary": "人脸局部——培养观察精度",
        "description": "对着镜子画自己一只眼睛。记住：眼睛是球体嵌在眼窝里，不是平的。上眼睑有厚度（会受光），虹膜有放射状纹理。",
        "min_level": 2, "max_level": 3,
        "interests": ["portrait"],
        "master": "达芬奇",
        "master_work": "《蒙娜丽莎》局部",
        "learn_point": "达芬奇画眼睛时，眼角的阴影不是黑色——是最深的暖棕色，和周围的肤色有微妙过渡",
        "difficulty": 2,
    },
    {
        "id": "perspective",
        "title": "画一个房间角落 🏠",
        "summary": "一点透视练习",
        "description": "坐在房间角落，画你看到的墙线。注意：所有向远方延伸的线都汇聚到一个消失点。加上门、窗、家具的简化形状。",
        "min_level": 2, "max_level": 3,
        "interests": ["flower"],
        "master": "维米尔",
        "master_work": "《倒牛奶的女仆》",
        "learn_point": "维米尔画室内空间时，地砖的透视线是最明显的消失点指示——你看他画的地砖线是怎么指向同一个点的",
        "difficulty": 2,
    },
    {
        "id": "cat",
        "title": "画一只猫或狗 🐱",
        "summary": "动态线练习",
        "description": "动物不会乖乖站着，但照片可以。先找一张参考，找出脊椎的动态线——这是决定姿势是否生动的关键。动态线对了，身体其他部分往上「挂」。",
        "min_level": 2, "max_level": 3,
        "interests": ["animal"],
        "master": "德加",
        "master_work": "赛马系列",
        "learn_point": "德加画马奔跑时，背部的动态线是一条连贯的弧线——不是四个腿各管各的，而是整个身体有一个统一的动作趋势",
        "difficulty": 2,
    },
    {
        "id": "flower",
        "title": "画一朵花 🌸",
        "summary": "观察自然形态的细节",
        "description": "找一朵真花或照片。花瓣的排列有规律（螺旋/对称/放射），先看出规律再画。不要一瓣一瓣描——先画花蕊的中心位置，再围绕它画花瓣。",
        "min_level": 2, "max_level": 3,
        "interests": ["*", "flower"],
        "master": "梵高",
        "master_work": "《向日葵》",
        "learn_point": "梵高的向日葵每一朵花的朝向都不一样——他在安排构图时，让每朵花都「看向」不同的方向，画面就有了生命力",
        "difficulty": 2,
    },
    {
        "id": "still-life",
        "title": "画一瓶花（静物组合）💐",
        "summary": "第一次画多物体的组合",
        "description": "花瓶是圆柱体，花是球体/锥体。先画所有物体的大形状和位置关系（构图），再加明暗。注意花瓶和花的比例。",
        "min_level": 2, "max_level": 4,
        "interests": ["*"],
        "master": "塞尚",
        "master_work": "《静物苹果篮子》",
        "learn_point": "塞尚画静物时打破了单一视点——瓶口是俯视的、瓶身是平视的。他不是不会画透视，而是用不同的视点让画面更有「真实感」",
        "difficulty": 3,
    },
    # ── Lv.3-Lv.5 进阶→创作 ──
    {
        "id": "monet",
        "title": "临摹莫奈《日出·印象》🎨",
        "summary": "第一次临摹大师——学习用色",
        "description": "选莫奈的《日出·印象》，不求像，但求理解他的用色。注意：画中的颜色和你「以为」的颜色可能完全不一样。",
        "min_level": 3, "max_level": 5,
        "interests": ["*"],
        "master": "莫奈",
        "master_work": "《日出·印象》",
        "learn_point": "莫奈画日出时，太阳的橙色和水面的蓝色不是两个分开的颜色——它们互相映照，水面的蓝色里掺着橙色倒影",
        "difficulty": 3,
    },
    {
        "id": "portrait",
        "title": "画自己的正脸（肖像入门）👤",
        "summary": "第一次画完整的人脸",
        "description": "对着镜子画自己的正脸。三庭五眼：眼睛在头高的一半、鼻底在眼睛到下颏的一半、嘴在鼻子到下颏的一半。先画位置，再画细节。",
        "min_level": 3, "max_level": 4,
        "interests": ["portrait"],
        "master": "伦勃朗",
        "master_work": "自画像系列",
        "learn_point": "伦勃朗的自画像不是画五官——他是先画出光从哪里来，让光决定哪些部分亮、哪些在阴影里",
        "difficulty": 3,
    },
    {
        "id": "street",
        "title": "画一条街道（两点透视）🏛️",
        "summary": "练习两点透视",
        "description": "找有建筑的街道照片。左右两排建筑的线分别消失于两个消失点。加上行人（简化）、路灯、路牌。",
        "min_level": 3, "max_level": 4,
        "interests": ["flower"],
        "master": "萨金特",
        "master_work": "威尼斯街景系列",
        "learn_point": "萨金特画街景时，建筑的透视线巧妙地引导目光穿过画面——透视不只是「画准」，而是引导观众的视线走向",
        "difficulty": 3,
    },
    {
        "id": "van-gogh",
        "title": "临摹梵高《星夜》🌌",
        "summary": "学习笔触的表现力",
        "description": "选梵高的《星夜》或《向日葵》，重点观察他的笔触方向和长短。他不是涂色——每一笔都有方向、有力量。",
        "min_level": 3, "max_level": 5,
        "interests": ["*"],
        "master": "梵高",
        "master_work": "《星夜》",
        "learn_point": "梵高的《星夜》里，天空的笔触不是随机旋转的——它们沿着一个大的漩涡方向走，让整片天空在动",
        "difficulty": 3,
    },
    {
        "id": "figure",
        "title": "画一个路人（户外速写）🚶",
        "summary": "真实世界中的人",
        "description": "去咖啡馆或坐在窗边画路人。人会动所以必须快速捕捉——先画动态线和大形状，人走了凭记忆补细节。",
        "min_level": 3, "max_level": 5,
        "interests": ["portrait"],
        "master": "门采尔",
        "master_work": "生活速写集",
        "learn_point": "门采尔画人在街上走路时，经常只画了动态线和外轮廓——因为人已经走过去了，但他抓住了最核心的姿态",
        "difficulty": 3,
    },
    {
        "id": "schiele",
        "title": "临摹席勒自画像 🎭",
        "summary": "学习线条的情绪和张力",
        "description": "选席勒的一幅自画像，模仿他「紧张而扭曲」的线条。用线条表达情绪——你的线条是紧张的还是放松的？不是画得像，是画得有感觉。",
        "min_level": 4, "max_level": 5,
        "interests": ["portrait"],
        "master": "席勒",
        "master_work": "自画像",
        "learn_point": "席勒的线条为什么有张力？因为他不是画「身体的轮廓」——他在画「身体在空间中的边界感」，线条是断的、扭的，但位置准确",
        "difficulty": 4,
    },
    {
        "id": "morandi",
        "title": "像莫兰迪一样画静物 🏺",
        "summary": "低饱和度配色的魅力",
        "description": "找几个瓶瓶罐罐摆一组静物。尝试用低饱和度的灰色调来画——每个颜色里都掺一点灰，画面就会「安静」下来。",
        "min_level": 4, "max_level": 5,
        "interests": ["*"],
        "master": "莫兰迪",
        "master_work": "静物系列",
        "learn_point": "莫兰迪的颜色之所以高级，不是因为颜色本身——是因为每个颜色的明度（亮度）控制得刚刚好，瓶子和背景的明度差很小",
        "difficulty": 4,
    },
    {
        "id": "free-create",
        "title": "自由创作日 🎨",
        "summary": "画任何你想画的东西",
        "description": "今天没有规则。画你想画的任何东西——一幅完整的画、一张速写、甚至是涂鸦。画了就算赢，享受画画本身。",
        "min_level": 1, "max_level": 5,
        "interests": ["*"],
        "master": "",
        "master_work": "",
        "learn_point": "今天不做比较。你画出的每一笔，都是昨天之前的你做不到的。留住这张画，下周再看。",
        "difficulty": 1,
    },
]

MAX_VISIBLE_LEVEL = 5


# ── 主题库（按难度分级）──────────────────────────────────
# 供 /api/themes 与 /api/today-theme 使用，与 RECOMMENDATION_POOL 互补：
# RECOMMENDATION_POOL 偏「大师关联 + 长描述」，THEME_LIBRARY 偏「纯主题 + 难度筛选」。
THEME_LIBRARY = [
    # 入门 - 基础几何形状 + 日常物品（精简到 4 个）
    {"id": "cup", "title": "画一个杯子", "difficulty": "beginner", "category": "日常物品", "hint": "圆柱体加弧线把手", "icon": "☕"},
    {"id": "apple", "title": "画一个苹果", "difficulty": "beginner", "category": "日常物品", "hint": "球体加凹陷的顶部", "icon": "🍎"},
    {"id": "ball", "title": "画一个球", "difficulty": "beginner", "category": "几何形体", "hint": "圆形加明暗过渡", "icon": "⚪"},
    {"id": "leaf", "title": "画一片树叶", "difficulty": "beginner", "category": "自然", "hint": "叶脉的对称线条", "icon": "🍃"},

    # 进阶 - 结构组合 + 自然形态（精简到 4 个）
    {"id": "hand", "title": "画一只手", "difficulty": "intermediate", "category": "人体", "hint": "手掌的几何概括和手指关节", "icon": "✋"},
    {"id": "chair", "title": "画一把椅子", "difficulty": "intermediate", "category": "家具", "hint": "透视和结构线", "icon": "🪑"},
    {"id": "flower", "title": "画一朵花", "difficulty": "intermediate", "category": "自然", "hint": "花瓣的层叠和旋转", "icon": "🌸"},
    {"id": "tree", "title": "画一棵树", "difficulty": "intermediate", "category": "自然", "hint": "树干结构和树冠体积", "icon": "🌳"},

    # 挑战 - 完整场景 + 人体（精简到 4 个）
    {"id": "building", "title": "画一栋建筑", "difficulty": "advanced", "category": "建筑", "hint": "两点透视和细节取舍", "icon": "🏠"},
    {"id": "portrait", "title": "画一张人脸", "difficulty": "advanced", "category": "人体", "hint": "三庭五眼比例", "icon": "👤"},
    {"id": "landscape", "title": "画一处风景", "difficulty": "advanced", "category": "风景", "hint": "近中远三景层次", "icon": "🏞️"},
    {"id": "animal", "title": "画一只动物", "difficulty": "advanced", "category": "动物", "hint": "骨骼结构和毛发质感", "icon": "🐱"},
]

# 难度 → 中文标签
DIFFICULTY_LABELS = {
    "beginner": "入门",
    "intermediate": "进阶",
    "advanced": "挑战",
}


# ── 辅助函数 ──────────────────────────────────────────


def load_records() -> list[dict]:
    if RECORDS_FILE.exists():
        with open(RECORDS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_records(records: list[dict]):
    with open(RECORDS_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)


# ── 社区数据管理 ──
COMMUNITY_FILE = DATA_DIR / "community.json"


def load_community_posts() -> list[dict]:
    if COMMUNITY_FILE.exists():
        try:
            with open(COMMUNITY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []
    return []


def save_community_posts(posts: list[dict]):
    with open(COMMUNITY_FILE, "w", encoding="utf-8") as f:
        json.dump(posts, f, ensure_ascii=False, indent=2)


def load_profile() -> dict:
    if USER_PROFILE_FILE.exists():
        with open(USER_PROFILE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            # 兼容旧版 profile（不覆盖已有字段）
            defaults = {
                "name": "小伙伴",
                "level": None,
                "interest": None,
                "goal": None,
                "onboarding_done": False,
                "onboarding_at": None,
                "recommendation_index": 0,
                "path": "creation",
            }
            for k, v in defaults.items():
                data.setdefault(k, v)
            return data
    return {
        "name": "小伙伴",
        "level": None,
        "interest": None,
        "goal": None,
        "onboarding_done": False,
        "onboarding_at": None,
        "recommendation_index": 0,
        "path": "creation",
    }


def save_profile(profile: dict):
    with open(USER_PROFILE_FILE, "w", encoding="utf-8") as f:
        json.dump(profile, f, ensure_ascii=False, indent=2)


def get_drawing_stage(count: int) -> str:
    """根据累计画作数返回当前阶段（5 级自适应分级）。

    分级与对应的反馈深度策略见 ``analyze_drawing`` / ``_build_analyze_prompt``
    中的 ``stage_prompts``：
      - 1-5 张   → 新手期（生活化语言，禁用术语，重点鼓励）
      - 6-15 张  → 入门期（可用 1-2 个基础术语，必须解释）
      - 16-30 张 → 成长期（可用术语并简要解释，给可操作建议）
      - 31-50 张 → 进阶期（术语不需解释，深入分析构图光影）
      - 50+ 张   → 熟练期（可引用大师作品对比，挑战性建议）
    """
    if count <= 5:
        return "新手期"
    elif count <= 15:
        return "入门期"
    elif count <= 30:
        return "成长期"
    elif count <= 50:
        return "进阶期"
    else:
        return "熟练期"


def get_milestone(total: int) -> dict | None:
    """根据总画作数，决定是否显示里程碑卡片"""
    milestones = {
        1:  {"icon": "🎉", "title": "第一张画",
             "message": "记住这一刻——再伟大的画家也是从第一根线开始的。"},
        5:  {"icon": "🔥", "title": "坚持 5 张",
             "message": "大多数人在第 3 张就放弃了，你已经超过了 70% 的人。"},
        10: {"icon": "👑", "title": "10 张里程碑",
             "message": "翻看第一张和今天的对比——进步是真实存在的。"},
        25: {"icon": "💪", "title": "25 张·习惯成自然",
             "message": "你已经在不知不觉中养成了绘画习惯，这是最有价值的一步。"},
        50: {"icon": "🌟", "title": "50 张·质变",
             "message": "从'画出形状'到'画得像'，这 50 张见证了你的蜕变。"},
    }
    m = milestones.get(total)
    if m:
        return {"number": total, **m}
    if total > 50 and total % 50 == 0:
        return {
            "number": total,
            "icon": "🌟",
            "title": f"{total} 张",
            "message": f"你已经画了 {total} 张了！回看最初的线条和现在的对比，变化是看得见的。",
        }
    return None


def _layers_to_text(layers: list[dict], user_name: str) -> str:
    """将 5 层结构化反馈转为可读文本（用于 backward compat：timeline / modal）"""
    labels = {
        "identify": f"🎯 认出内容",
        "observe": f"🔍 具体观察",
        "progress": f"📈 进步连接",
        "suggestion": f"💡 技巧建议",
        "encourage": f"✨ 鼓励期待",
    }
    lines = []
    for layer in layers:
        t = layer.get("type", "")
        label = labels.get(t, t)
        content = (layer.get("content") or "").strip()
        lines.append(f"{label}")
        lines.append(content)
        tip = (layer.get("tip") or "").strip()
        if tip:
            lines.append(f"💡 {tip}")
        lines.append("")
    return "\n".join(lines).strip()


def _record_date(r: dict) -> date | None:
    """提取记录中的日期"""
    try:
        return datetime.fromisoformat(r["timestamp"]).date()
    except (ValueError, KeyError):
        return None


def calc_streak(records: list[dict]) -> int:
    if not records:
        return 0
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


def calc_max_streak(records: list[dict]) -> int:
    """计算历史最长连胜天数"""
    draw_dates = set()
    for r in records:
        try:
            d = datetime.fromisoformat(r["timestamp"]).date()
            draw_dates.add(d)
        except (ValueError, KeyError):
            continue
    if not draw_dates:
        return 0
    sorted_dates = sorted(draw_dates)
    max_s = 1
    cur = 1
    for i in range(1, len(sorted_dates)):
        if (sorted_dates[i] - sorted_dates[i - 1]).days == 1:
            cur += 1
            max_s = max(max_s, cur)
        else:
            cur = 1
    return max_s


def get_recommendation(profile: dict, total_drawings: int) -> dict:
    """根据绘画数量，返回一条合适的今日主题"""
    # 1. 计算等级
    if total_drawings <= 5:
        user_level = 1
    elif total_drawings <= 20:
        user_level = 2
    else:
        user_level = max(2, min(5, total_drawings // 15 + 2))

    # 2. 按等级筛选
    candidates = [
        r for r in RECOMMENDATION_POOL
        if r["min_level"] <= user_level <= r["max_level"]
    ]
    if not candidates:
        candidates = RECOMMENDATION_POOL

    # 3. 轮转
    idx = profile.get("recommendation_index", 0) % len(candidates)
    rec = dict(candidates[idx])

    # 4. 添加图片URL（优先用练习参考图，没有则回退到大师作品）
    rec_id = rec.get("id", "")
    if rec_id in RECOMMENDATION_IMAGES:
        rec["image_url"] = RECOMMENDATION_IMAGES[rec_id]
    elif rec.get("master") and rec["master"] in MASTER_TO_REC:
        rec["image_url"] = MASTER_TO_REC[rec["master"]]
    elif rec.get("master"):
        for m_name in MASTER_TO_REC:
            if rec["master"] in m_name or m_name in rec["master"]:
                rec["image_url"] = MASTER_TO_REC[m_name]
                break

    # 5. 更新索引
    profile["recommendation_index"] = idx + 1
    save_profile(profile)

    rec["level_label"] = {
        1: "新手 · 从零开始",
        2: "基础 · 打好根基",
        3: "进阶 · 挑战自己",
        4: "高阶 · 精进技艺",
        5: "创作 · 自由发挥",
    }.get(rec["difficulty"], "进阶")

    return rec


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
        max_tokens=800,
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
        f'      "content": "先认出画的是什么（物体/人物/场景），表现出你看懂了。然后真诚地夸一个具体的亮点（线条、构图、造型、用笔等，不要虚构\'观察\'）。可以补充你对这幅画的第一印象或感受。称呼用户为{user_name}。2-3句话，写得有细节有温度，不要干巴巴。必须用 **加粗** 强调关键技巧或优点，如 **排线**、**透视**、**间距控制得很好**。每层最多1处加粗。",\n'
        '    },\n'
        '    {\n'
        '      "type": "observe",\n'
        "      \"content\": \"再指出你在画里注意到的具体细节（某个局部的处理方式、线条走向、比例关系、用笔特点等），让用户感觉到你真的很仔细看了。可以多指出1-2个具体细节，让用户感受到你真的仔细看了。2-3句话，具体不空洞。注意：不要说'你观察到了XX'——用户可能是凭记忆/想象画的，说'我注意到你的XX处理很特别'。\",\n"
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
        '      "content": "以真诚的鼓励收尾，并自然地引出下次可以尝试的方向（如\'下次可以试试画XX，会有新的发现\'）。语气成熟自然，像朋友间的建议，不要用哄小孩的语气。可以结合用户这次画的内容，给出更有个性化的鼓励和期待。2-3句话。"\n'
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
        "- 每层 content 2-3 句话，写得有细节有温度，不要太简短\n"
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


def _sse_event(data: dict) -> str:
    """把 dict 序列化为一条 SSE 事件字符串（`data: {...}\\n\\n`）。"""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


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
            max_tokens=800,
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
    milestone = get_milestone(total_drawings)

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
    resp = Response(generate(), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
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


# ── 社区 API ──────────────────────────────────────────

@app.route("/api/community")
def api_community():
    """获取社区画作列表（按时间倒序）。"""
    posts = load_community_posts()
    posts.sort(key=lambda p: p.get("timestamp", ""), reverse=True)
    return jsonify({"posts": posts})


@app.route("/api/community/share", methods=["POST"])
def api_community_share():
    """将自己的画作分享到社区。

    接收 record_id，从用户记录中找到对应画作，复制到社区列表。
    """
    record_id = request.json.get("record_id", "").strip()
    if not record_id:
        return jsonify({"error": "缺少 record_id"}), 400

    records = load_records()
    record = next((r for r in records if r.get("id") == record_id), None)
    if not record:
        return jsonify({"error": "找不到该画作记录"}), 404

    profile = load_profile()
    posts = load_community_posts()

    # 避免重复分享
    if any(p.get("source_record_id") == record_id for p in posts):
        return jsonify({"error": "这幅画已经分享过了"}), 409

    # 提取反馈摘要（取第一层或前 60 字）
    feedback_summary = ""
    if record.get("feedback_json") and record["feedback_json"].get("layers"):
        first_layer = record["feedback_json"]["layers"][0]
        feedback_summary = (first_layer.get("content") or "")[:80]
    elif record.get("feedback"):
        feedback_summary = record["feedback"][:80]

    post = {
        "id": str(uuid.uuid4())[:8],
        "source_record_id": record_id,
        "image": record.get("image", ""),
        "author": profile.get("name", "小伙伴"),
        "theme": record.get("theme", ""),
        "feedback_summary": feedback_summary,
        "timestamp": datetime.now().isoformat(),
        "likes": 0,
        "liked_by": [],
        "comments": [],
    }
    posts.append(post)
    save_community_posts(posts)
    log_event("community_share", {"record_id": record_id, "post_id": post["id"]})
    return jsonify({"ok": True, "post": post})


@app.route("/api/community/like/<post_id>", methods=["POST"])
def api_community_like(post_id):
    """点赞社区画作（每个用户只能点一次）。"""
    profile = load_profile()
    user_name = profile.get("name", "小伙伴")

    posts = load_community_posts()
    post = next((p for p in posts if p.get("id") == post_id), None)
    if not post:
        return jsonify({"error": "找不到该帖子"}), 404

    liked_by = post.get("liked_by", [])
    if user_name in liked_by:
        return jsonify({"error": "你已经点过赞了", "already_liked": True, "likes": post["likes"]}), 409

    liked_by.append(user_name)
    post["liked_by"] = liked_by
    post["likes"] = post.get("likes", 0) + 1
    save_community_posts(posts)
    return jsonify({"ok": True, "likes": post["likes"], "already_liked": False})


@app.route("/api/community/comment/<post_id>", methods=["POST"])
def api_community_comment(post_id):
    """评论社区画作。"""
    profile = load_profile()
    user_name = profile.get("name", "小伙伴")
    content = request.json.get("content", "").strip()

    if not content:
        return jsonify({"error": "评论内容不能为空"}), 400
    if len(content) > 500:
        return jsonify({"error": "评论内容过长，最多500字"}), 400

    posts = load_community_posts()
    post = next((p for p in posts if p.get("id") == post_id), None)
    if not post:
        return jsonify({"error": "找不到该帖子"}), 404

    comment = {
        "id": str(uuid.uuid4())[:8],
        "author": user_name,
        "content": content,
        "timestamp": datetime.now().isoformat(),
    }
    post["comments"] = post.get("comments", [])
    post["comments"].append(comment)
    save_community_posts(posts)
    return jsonify({"ok": True, "comment": comment, "total": len(post["comments"])})


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
        try:
            stream = client.chat.completions.create(
                model=ARK_MODEL,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "你是小绘，一个温和耐心的绘画陪伴者。用户刚画完画写了句反思，"
                            "你用简短的一句话回应 ta——针对具体内容、语气自然、不加 emoji、不问问题。"
                        ),
                    },
                    {
                        "role": "user",
                        "content": f"主题：{subject}\n用户说：「{user_text}」",
                    },
                ],
                max_tokens=50,
                temperature=0.8,
                stream=True,
            )
            for chunk in stream:
                token = chunk.choices[0].delta.content or ""
                if token:
                    yield f"data: {json.dumps({'token': token})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'fallback', 'text': '嗯，我听到了。每次进步都值得记下来 ☺️'})}\n\n"

    resp = Response(generate(), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"
    return resp


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
