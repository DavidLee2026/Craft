"""每日绘 Craft · 社区 API（Blueprint）"""
import uuid
from datetime import datetime

from flask import Blueprint, request, jsonify

from data_store import (
    load_records,
    load_profile,
    load_community_posts,
    save_community_posts,
    log_event,
)

community_bp = Blueprint("community", __name__)

@community_bp.route("/api/community")
def api_community():
    """获取社区画作列表（按时间倒序）。"""
    posts = load_community_posts()
    posts.sort(key=lambda p: p.get("timestamp", ""), reverse=True)
    return jsonify({"posts": posts})


@community_bp.route("/api/community/share", methods=["POST"])
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


@community_bp.route("/api/community/like/<post_id>", methods=["POST"])
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


@community_bp.route("/api/community/comment/<post_id>", methods=["POST"])
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
        "liked_by": [],
        "likes": 0,
    }
    post["comments"] = post.get("comments", [])
    post["comments"].append(comment)
    save_community_posts(posts)
    return jsonify({"ok": True, "comment": comment, "total": len(post["comments"])})


@community_bp.route("/api/community/comment/like/<post_id>/<comment_id>", methods=["POST"])
def api_community_comment_like(post_id, comment_id):
    """点赞社区评论（每个用户只能点一次）。"""
    profile = load_profile()
    user_name = profile.get("name", "小伙伴")

    posts = load_community_posts()
    post = next((p for p in posts if p.get("id") == post_id), None)
    if not post:
        return jsonify({"error": "找不到该帖子"}), 404

    comments = post.get("comments", [])
    comment = next((c for c in comments if c.get("id") == comment_id), None)
    if not comment:
        return jsonify({"error": "找不到该评论"}), 404

    liked_by = comment.get("liked_by", [])
    if user_name in liked_by:
        return jsonify({"error": "你已经点过赞了", "already_liked": True, "likes": comment.get("likes", 0)}), 409

    liked_by.append(user_name)
    comment["liked_by"] = liked_by
    comment["likes"] = comment.get("likes", 0) + 1
    save_community_posts(posts)
    return jsonify({"ok": True, "likes": comment["likes"], "already_liked": False})
