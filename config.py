"""每日绘 Craft · 配置与基础设施

路径常量、模型配置、OpenAI client。所有模块从这里取配置。
"""
import os
from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI

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
# TRAE-01 百科知识库路径
KB_DIR = BASE_DIR.parent / "百科知识库"
MASTER_DIR = KB_DIR / "大师"

ARK_API_KEY = os.environ.get("ARK_API_KEY", "")
ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
ARK_MODEL = "doubao-seed-2-0-mini-260428"  # 轻量快速视觉模型，分析反馈专用（之前: seed-2-1-turbo）
client = OpenAI(api_key=ARK_API_KEY, base_url=ARK_BASE_URL)
COMMUNITY_FILE = DATA_DIR / "community.json"
