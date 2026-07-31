// ─── community.js · 社区 ─────────────────────────
// 依赖：state.js；运行时调用 timeline.js 的 openModal
// ─── 社区 ──────────────────────────────────────────

async function renderCommunityFeed() {
  const feed = document.getElementById('communityFeed');
  feed.innerHTML = `
    <div class="community-loading">
      <div class="simple-waiting-dots"><span></span><span></span><span></span></div>
      <div style="font-size:13px;color:var(--color-text-tertiary);margin-top:8px;">加载中…</div>
    </div>`;

  try {
    const res = await fetch(`${API_BASE}/api/community`);
    const data = await res.json();
    const posts = data.posts || [];

    if (posts.length === 0) {
      feed.innerHTML = `
        <div class="community-empty">
          <div class="community-empty-icon">🌍</div>
          <div class="community-empty-title">社区还没有画作</div>
          <div class="community-empty-desc">画完一张后，在反馈页点击「分享到社区」<br>让大家看到你的作品</div>
        </div>`;
      return;
    }

    // Instagram 风格 3 列网格
    feed.innerHTML = posts.map(post => `
      <div class="community-item" onclick="openCommunityPost('${post.id}')">
        <img src="${API_BASE}/data/${post.image}" alt="${escapeHtml(post.author || '')}的画" loading="lazy"
             onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22120%22 height=%22120%22%3E%3Crect fill=%22%23f0e6e0%22 width=%22120%22 height=%22120%22/%3E%3Ctext x=%2260%22 y=%2265%22 text-anchor=%22middle%22 fill=%22%23C97D5B%22 font-size=%2228%22%3E🎨%3C/text%3E%3C/svg%3E'">
        ${post.likes > 0 ? `<div class="community-likes">❤️ ${post.likes}</div>` : ''}
      </div>
    `).join('');
  } catch (e) {
    feed.innerHTML = `
      <div class="community-empty">
        <div class="community-empty-icon">📡</div>
        <div class="community-empty-title">无法加载社区</div>
        <div class="community-empty-desc">请检查网络连接</div>
      </div>`;
  }
}

function closeCommunityModal() {
  const modal = document.getElementById('communityModal');
  if (!modal) return;
  // 移除滚动监听
  if (modal._scrollHandler && modal._scrollTarget) {
    modal._scrollTarget.removeEventListener('scroll', modal._scrollHandler);
    modal._scrollHandler = null;
    modal._scrollTarget = null;
  }
  // 重置图片收缩状态
  const modalInner = modal.querySelector('.modal');
  if (modalInner) modalInner.classList.remove('img-collapsed');
  modal.style.display = 'none';
  document.body.style.overflow = '';
}

function openCommunityPost(postId) {
  // 简单放大查看
  const feed = document.getElementById('communityFeed');
  const item = feed.querySelector(`[onclick*="${postId}"]`);
  if (!item) return;
  const img = item.querySelector('img');
  if (!img) return;

  let modal = document.getElementById('communityModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'communityModal';
    modal.className = 'modal-overlay';
    modal.onclick = function(e) { if (e.target === modal) closeCommunityModal(); };
    document.body.appendChild(modal);
  }
  // 关闭旧监听（如果有）
  if (modal._scrollHandler && modal._scrollTarget) {
    modal._scrollTarget.removeEventListener('scroll', modal._scrollHandler);
  }
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  modal.innerHTML = `
    <div class="modal community-modal" onclick="event.stopPropagation()">
      <button class="btn-close" onclick="closeCommunityModal()">✕</button>
      <img src="${img.src}" alt="画作">
      <div class="modal-info" style="padding:16px;">
        <div id="communityModalInfo">加载中…</div>
      </div>
    </div>`;

  // 社区弹窗：图片固定高度，仅 info 区域滚动，不使用动态收缩（避免滚动反馈循环）
  const modalInfo = modal.querySelector('.modal-info');
  if (modalInfo) {
    modalInfo.scrollTop = 0;
  }

  // 加载详细信息
  fetch(`${API_BASE}/api/community`)
    .then(r => r.json())
    .then(data => {
      const post = (data.posts || []).find(p => p.id === postId);
      if (post) {
        const comments = post.comments || [];
        const isLiked = (post.liked_by || []).includes(userName);
        const likeBtnClass = isLiked ? 'btn-secondary' : 'btn-primary';
        const likeText = isLiked ? '已赞' : '赞';
        const likeIcon = isLiked ? '❤️' : '🤍';
        // 去除 markdown 加粗标记
        const cleanSummary = (post.feedback_summary || '').replace(/\*\*(.+?)\*\*/g, '$1');

        document.getElementById('communityModalInfo').innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
            <span class="avatar" style="font-size:20px;">🎨</span>
            <div>
              <div style="font-weight:600;font-size:15px;">${escapeHtml(post.author || '小伙伴')}</div>
              <div style="font-size:12px;color:var(--color-text-tertiary);">${formatDate(post.timestamp)}</div>
            </div>
          </div>
          ${cleanSummary ? `<div style="font-size:13px;color:var(--color-text-secondary);line-height:1.6;background:var(--color-bg-card);padding:10px 12px;border-radius:8px;border-left:3px solid var(--color-primary);margin-bottom:12px;">💬 ${escapeHtml(cleanSummary)}</div>` : ''}

          <!-- 点赞按钮 -->
          <button class="btn ${likeBtnClass} btn-sm" id="communityLikeBtn_${post.id}" style="width:100%;margin-bottom:12px;" onclick="likeCommunityPost('${post.id}', this)" ${isLiked ? 'disabled' : ''}>
            ${likeIcon} ${post.likes || 0} ${likeText}
          </button>

          <!-- 评论区 -->
          <div class="community-comments-section">
            <div class="community-comments-header">
              <span>💬 评论 (${comments.length})</span>
            </div>
            <div class="community-comments-list" id="communityComments_${post.id}">
              ${comments.length > 0 ? comments.map(c => {
                const cLiked = (c.liked_by || []).includes(userName);
                return `
                <div class="community-comment-item">
                  <div class="community-comment-body">
                    <div class="community-comment-author">${escapeHtml(c.author || '小伙伴')}</div>
                    <div class="community-comment-content">${escapeHtml(c.content)}</div>
                    <div class="community-comment-time">${formatDate(c.timestamp)}</div>
                  </div>
                  <button class="comment-like-btn ${cLiked ? 'liked' : ''}"
                    onclick="likeCommunityComment('${post.id}','${c.id}', this)"
                    ${cLiked ? 'disabled' : ''}>
                    ${cLiked ? '❤️' : '🤍'}${c.likes ? ' ' + c.likes : ''}
                  </button>
                </div>`;
              }).join('') : '<div class="community-comment-empty">还没有评论，来说两句吧~</div>'}
            </div>
            <div class="community-comment-input-row">
              <input type="text" class="community-comment-input" id="communityCommentInput_${post.id}" placeholder="写下你的评论..." maxlength="200">
              <button class="community-comment-send" onclick="addCommunityComment('${post.id}')">发送</button>
            </div>
          </div>`;
      }
    });
}

function likeCommunityPost(postId, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  fetch(`${API_BASE}/api/community/like/${postId}`, { method: 'POST' })
    .then(r => {
      if (r.status === 409) {
        return r.json().then(data => ({ alreadyLiked: true, ...data }));
      }
      return r.json();
    })
    .then(data => {
      if (data.ok) {
        btn.innerHTML = `❤️ ${data.likes} 已赞`;
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
        btn.disabled = true;
        showToast('点赞成功！', 'success');
      } else if (data.already_liked) {
        btn.innerHTML = `❤️ ${data.likes} 已赞`;
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
        btn.disabled = true;
        showToast('你已经点过赞了', 'info');
      } else {
        btn.disabled = false;
      }
    })
    .catch(() => {
      btn.disabled = false;
    });
}

// ─── 评论点赞 ───
function likeCommunityComment(postId, commentId, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  fetch(`${API_BASE}/api/community/comment/like/${postId}/${commentId}`, { method: 'POST' })
    .then(r => {
      if (r.status === 409) return r.json().then(d => ({ alreadyLiked: true, ...d }));
      return r.json();
    })
    .then(data => {
      if (data.ok) {
        btn.innerHTML = `❤️${data.likes ? ' ' + data.likes : ''}`;
        btn.classList.add('liked');
        btn.disabled = true;
      } else if (data.already_liked) {
        btn.innerHTML = `❤️${data.likes ? ' ' + data.likes : ''}`;
        btn.classList.add('liked');
        btn.disabled = true;
      } else {
        btn.disabled = false;
      }
    })
    .catch(() => { btn.disabled = false; });
}

async function addCommunityComment(postId) {
  const input = document.getElementById(`communityCommentInput_${postId}`);
  const content = input.value.trim();
  if (!content) {
    showToast('评论内容不能为空', 'error');
    return;
  }

  const sendBtn = input.nextElementSibling;
  sendBtn.disabled = true;
  sendBtn.textContent = '发送中...';

  try {
    const res = await fetch(`${API_BASE}/api/community/comment/${postId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (data.ok) {
      input.value = '';
      showToast('评论已发布', 'success');
      // 刷新评论区
      const commentsList = document.getElementById(`communityComments_${postId}`);
      const emptyMsg = commentsList.querySelector('.community-comment-empty');
      if (emptyMsg) emptyMsg.remove();

      const commentDiv = document.createElement('div');
      commentDiv.className = 'community-comment-item';
      commentDiv.innerHTML = `
        <div class="community-comment-author">${escapeHtml(data.comment.author || '小伙伴')}</div>
        <div class="community-comment-content">${escapeHtml(data.comment.content)}</div>
        <div class="community-comment-time">刚刚</div>
      `;
      commentsList.appendChild(commentDiv);
      commentsList.scrollTop = commentsList.scrollHeight;

      // 更新评论数
      const header = commentsList.previousElementSibling;
      if (header) {
        header.innerHTML = `<span>💬 评论 (${data.total})</span>`;
      }
    } else {
      showToast(data.error || '评论失败', 'error');
    }
  } catch (e) {
    showToast('网络错误，请重试', 'error');
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = '发送';
  }
}


