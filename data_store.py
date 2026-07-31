"""每日绘 Craft · 数据层

数据持久化（记录/画像/社区/埋点）+ 业务辅助逻辑
（里程碑、连胜、推荐、主题库、大师知识库解析）。
"""
import json
import random
import re
from datetime import datetime, date, timedelta
from pathlib import Path

from config import (
    DATA_DIR,
    IMAGES_DIR,
    RECORDS_FILE,
    USER_PROFILE_FILE,
    TRACKING_FILE,
    KB_DIR,
    MASTER_DIR,
)

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


