// ─── feedback.js · AI 流式反馈 / 反思交互 / 操作按钮 ───
// 依赖：state.js；运行时调用 camera.js / share.js / timeline.js 的函数
// ─── Upload → Analyze（流式 SSE）───
async function uploadImage(file) {
  document.getElementById('spinner').classList.remove('active');
  document.getElementById('feedback').classList.remove('visible');
  document.getElementById('feedbackEnhanced').classList.remove('visible');
  document.getElementById('nextRec').classList.remove('visible');
  document.getElementById('reflectionArea').classList.remove('visible');
  document.getElementById('reflectionResponse').classList.remove('visible');
  const customRowEl = document.getElementById('reflectionCustomRow');
  if (customRowEl) customRowEl.style.display = 'none';
  document.querySelectorAll('.r-quick-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('fbActions').classList.remove('visible');
  document.getElementById('error').classList.remove('visible');

  // 简洁等待提示（流式反馈会逐步替代）
  showSimpleWaiting();

  // 滚动到反馈区域，确保完全可见
  setTimeout(() => {
    const fb = document.getElementById('feedbackEnhanced');
    if (fb) {
      const rect = fb.getBoundingClientRect();
      const scrollTop = window.pageYOffset + rect.bottom - window.innerHeight + 24;
      window.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });
    }
  }, 80);

  // 客户端压缩
  const compressedFile = await compressImage(file);

  const formData = new FormData();
  formData.append('image', compressedFile);
  // 附带当前主题信息
  const themeTitle = document.getElementById('themeTodayTitle')?.textContent || '';
  if (themeTitle) formData.append('theme', themeTitle);

  try {
    const response = await fetch(`${API_BASE}/api/analyze/stream`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      stopSimpleWaiting();
      const errData = await response.json().catch(() => ({}));
      showError(errData.error || '分析失败，请重试');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const receivedLayers = [];   // 实时渲染，不再缓存
    let completeData = null;
    let containerReady = false;

    // 确保反馈容器已准备好（仅第一次调用时初始化）
    function ensureContainerReady() {
      if (containerReady) return;
      containerReady = true;
      stopSimpleWaiting();
      const container = document.getElementById('feedbackEnhanced');
      container.classList.add('visible');
      document.getElementById('aiNameEnhanced').textContent = '小绘';
      setAiSubtitle();
      document.getElementById('milestoneSlot').innerHTML = '';
      document.getElementById('fbDepthLayer').innerHTML = '';
      document.getElementById('fbLayersContainer').innerHTML = '';
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop(); // 保留不完整的 chunk

      for (const evt of events) {
        if (!evt.startsWith('data: ')) continue;
        let data;
        try { data = JSON.parse(evt.slice(6)); } catch (e) { continue; }

        if (data.type === 'first_impression') {
          // ── 首层秒出：立即显示第一印象，不用干等 ──
          stopSimpleWaiting();
          const container = document.getElementById('feedbackEnhanced');
          container.classList.add('visible');
          document.getElementById('aiNameEnhanced').textContent = '小绘';
          setAiSubtitle();
          document.getElementById('milestoneSlot').innerHTML = '';
          document.getElementById('fbDepthLayer').innerHTML = '';
          document.getElementById('fbLayersContainer').innerHTML = `
            <div class="first-impression">
              <div class="first-impression-dots">
                <span></span><span></span><span></span>
              </div>
              <div class="first-impression-text">${data.message}</div>
            </div>`;
          containerReady = false;  // 不标记为 ready，让首个 layer 的 ensureContainerReady 清除第一印象
        } else if (data.type === 'layer') {
          // ✅ 真流式：收到 layer 立即渲染，不等其他层
          ensureContainerReady();
          receivedLayers.push(data.layer);
          renderStreamingLayer(data.layer, receivedLayers.length);
        } else if (data.type === 'complete') {
          completeData = data;
          console.log('[SSE] complete 事件收到', data.milestone ? `里程碑: ${data.milestone.number}` : '无里程碑');
        } else if (data.type === 'error') {
          stopSimpleWaiting();
          showError(data.message || '分析失败');
          return;
        }
      }
    }

    // 流结束 → 处理 complete 事件
    if (receivedLayers.length > 0) {
      try {
        if (completeData) {
          finalizeStreamingFeedback(completeData, receivedLayers);
        } else {
          // 有反馈但没收到 complete（后端可能中途故障）——降级收尾，不卡死
          console.warn('[SSE] 有 layers 但未收到 complete，降级收尾');
          stopSimpleWaiting();
          ensurePostFeedbackUI({id: 'fallback_' + Date.now()});
        }
      } catch (e) {
        console.error('finalizeStreamingFeedback error:', e);
        ensurePostFeedbackUI(completeData && completeData.record);
      }
      // 无论是否收到 complete，都刷新记录/统计/主题，让后端已保存的数据及时同步
      try { await loadStats(false); } catch (e) {}   // 上传后静默刷新，不显示欢迎回来
      try { await loadTimeline(); } catch (e) {}
      try { await loadTodayTheme(); } catch (e) {}
    } else if (completeData) {
      // 没收到 layer 但收到了 complete — 用 record 数据渲染
      stopSimpleWaiting();
      try {
        finalizeStreamingFeedback(completeData, []);
      } catch (e) {
        console.error('finalizeStreamingFeedback error:', e);
        ensurePostFeedbackUI(completeData.record);
      }
      try { await loadStats(false); } catch (e) {}   // 上传后静默刷新
      try { await loadTimeline(); } catch (e) {}
      try { await loadTodayTheme(); } catch (e) {}
    } else {
      // 没收到任何 layer 也没收到 complete
      stopSimpleWaiting();
      showError('分析超时，请重试');
      ensurePostFeedbackUI({id: 'fallback_' + Date.now()});
    }

  } catch (err) {
    stopSimpleWaiting();
    showError('网络错误，请检查服务器是否在运行');
  } finally {
    stopSimpleWaiting();
    document.getElementById('cameraInput').value = '';
    document.getElementById('uploadInput').value = '';
  }
}

// ─── 流式逐层渲染 ───
function renderStreamingLayer(layer, layerCount) {
  const LAYER_TAGS   = {identify: 'l-identify', observe: 'l-observe', progress: 'l-progress', suggestion: 'l-suggest', encourage: 'l-encourage'};
  const LAYER_LABELS = {identify: '🎯 认出', observe: '🔍 观察', progress: '📈 进步', suggestion: '💡 建议', encourage: '✨ 期待'};
  // 每层配对的表情图标（用于强调区域）
  const LAYER_EMOJI  = {identify: '👀', observe: '✍️', progress: '👏', suggestion: '💪', encourage: '🎉'};

  // 更新深度指示器
  const dotsHtml = Array.from({length: 5}, (_, i) =>
    `<div class="dot d${i+1} ${i < layerCount ? 'active' : ''}"></div>`
  ).join('');
  document.getElementById('fbDepthLayer').innerHTML = `
    <div class="fb-depth">
      ${dotsHtml}
      <span class="fb-depth-label">${layerCount} 层反馈深度</span>
    </div>`;

  // 提取绘画主题
  if (layer.type === 'identify' && layer.content) {
    const match = layer.content.match(/画的是(?:一个|一只|一幅)?(.+?)[对吧呢？\?]/);
    if (match && match[1]) {
      currentDrawingSubject = match[1].trim();
    }
  }

  const type = layer.type;
  const tagClass = LAYER_TAGS[type] || '';
  const label = LAYER_LABELS[type] || type;
  const emoji = LAYER_EMOJI[type] || '';

  const div = document.createElement('div');
  div.className = 'streaming-layer';

  if (type === 'progress') {
    div.innerHTML = `
      <div class="fb-progress-box">
        <span class="p-icon">📈</span>
        <span class="p-text">${enrichText(layer.content)} 👏</span>
      </div>`;
  } else if (type === 'encourage') {
    // 鼓励层：加鼓掌和点赞图标
    let html = `<span class="layer-tag ${tagClass}">${label}</span>
      <div class="layer-text">${enrichText(layer.content)} 🎉👍</div>`;
    div.innerHTML = html;
  } else if (type === 'identify') {
    // 认出层：加眼睛图标
    let html = `<span class="layer-tag ${tagClass}">${label}</span>
      <div class="layer-text">${enrichText(layer.content)} 👀</div>`;
    div.innerHTML = html;
  } else if (type === 'observe') {
    // 观察层：加点赞图标强调细节
    let html = `<span class="layer-tag ${tagClass}">${label}</span>
      <div class="layer-text">${enrichText(layer.content)} 👍</div>`;
    if (layer.tip && layer.tip.trim()) {
      html += `<div class="fb-tip-box"><strong>💡 小技巧</strong>：${enrichText(layer.tip)}</div>`;
    }
    div.innerHTML = html;
  } else {
    let html = `<span class="layer-tag ${tagClass}">${label}</span>
      <div class="layer-text">${enrichText(layer.content)}</div>`;
    if (type === 'suggestion' && layer.tip && layer.tip.trim()) {
      html += `<div class="fb-tip-box"><strong>💡 小技巧</strong>：${enrichText(layer.tip)} 💪</div>`;
    }
    div.innerHTML = html;
  }

  document.getElementById('fbLayersContainer').appendChild(div);

  // 仅在第一层时平滑滚动到反馈区（锚点固定，不跟随每层文字移动）
  if (layerCount === 1) {
    setTimeout(() => {
      const container = document.getElementById('feedbackEnhanced');
      if (container) {
        const rect = container.getBoundingClientRect();
        const targetY = window.pageYOffset + rect.top - 12;
        smoothScrollTo(targetY, 700);
      }
    }, 150);
  }

  // 更新全局术语上下文
  if (layer.glossary_context) {
    currentGlossaryContext = { ...currentGlossaryContext, ...layer.glossary_context };
  }
}

// ── 安全兜底：确保反思区和操作按钮一定显示 ──
function ensurePostFeedbackUI(record) {
  if (!record) return;
  try {
    currentRecordId = record.id;
    // 操作按钮
    startActionButtonsDelay(record);
    // 反思区
    setTimeout(() => {
      const ra = document.getElementById('reflectionArea');
      if (ra) ra.classList.add('visible');
      resetReflectionUI();
      // 异步加载 AI 生成的反思快选标签
      setTimeout(() => loadReflectionTags(), 200);
    }, 1000);
  } catch (e) {
    console.error('ensurePostFeedbackUI error:', e);
  }
}

// ─── AI 生成反思快选标签 ───
function loadReflectionTags() {
  const subject = document.getElementById('themeTodayTitle')?.textContent || '';
  const layers = document.querySelectorAll('#fbLayersContainer .layer-text');
  let snippet = '';
  layers.forEach((el, i) => {
    if (i < 3) snippet += el.textContent.slice(0, 80) + ' ';
  });
  snippet = snippet.trim().slice(0, 200);
  console.log(`[reflection-tags] 请求 subject='${subject}' layers=${layers.length} snippet_len=${snippet.length}`);

  fetch('/api/reflection-tags', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({subject, feedback_snippet: snippet}),
    signal: AbortSignal.timeout(15000),
  })
    .then(r => r.json())
    .then(data => {
      if (!data.tags || data.tags.length === 0) return;
      console.log(`[reflection-tags] 收到 ${data.tags.length} 个 AI 标签`, data.tags);
      const container = document.getElementById('reflectionQuickOptions');
      if (!container) return;
      // 保留"自己写"按钮
      const customBtn = container.querySelector('.r-quick-custom');
      container.innerHTML = data.tags.map(t =>
        `<button class="r-quick-btn" onclick="selectQuickReflection(this, '${escapeHtml(t.text)}')">${t.emoji || '🏷️'} ${escapeHtml(t.text)}</button>`
      ).join('');
      if (customBtn) container.appendChild(customBtn);
    })
    .catch(() => {
      console.warn('[reflection-tags] API 超时/失败，保留硬编码标签');
    });
}

// ─── 流式完成后的收尾 ───
function finalizeStreamingFeedback(completeData, receivedLayers) {
  const record = completeData.record || {id: 'fallback_' + Date.now()};

  // 如果没有收到任何 layer（流式提取失败），用 record 的完整数据渲染
  if (receivedLayers.length === 0 && record.feedback_json && record.feedback_json.layers) {
    stopSimpleWaiting();
    showFeedback(record);
    if (completeData.next_recommendation) {
      document.getElementById('nextRecText').textContent = completeData.next_recommendation.title;
      document.getElementById('nextRec').classList.add('visible');
    }
    return;
  }

  // 补全可能遗漏的层（流式正则可能漏掉最后一层的 tip 等字段）
  if (record.feedback_json && record.feedback_json.layers) {
    const fullLayers = record.feedback_json.layers;
    const container = document.getElementById('fbLayersContainer');
    // 比较已渲染层数和完整层数
    if (fullLayers.length > receivedLayers.length) {
      for (let i = receivedLayers.length; i < fullLayers.length; i++) {
        renderStreamingLayer(fullLayers[i], i + 1);
      }
    }
  }

  // 显示耗时
  if (record.elapsed_s) {
    const s = record.elapsed_s;
    document.getElementById('elapsedBadgeEnhanced').textContent = s < 10 ? `${s}s` : `${Math.round(s)}s`;
  }

  // ── 安全兜底：确保标题恢复（防止 showSimpleWaiting 的 "AI 正在看你的画…" 未覆盖）──
  const subEl = document.getElementById('aiSubtitleEnhanced');
  if (subEl && subEl.textContent === 'AI 正在看你的画…') {
    setAiSubtitle();
  }
  // ── 恢复预览区标签 ──
  const tagEl = document.querySelector('.preview-confirm-tag');
  if (tagEl && tagEl.textContent === '🔍 分析中') {
    tagEl.textContent = '✓ 已分析';
  }
  const hintEl = document.querySelector('.preview-confirm-hint');
  if (hintEl && hintEl.textContent === 'AI 正在看你的画...') {
    hintEl.textContent = '画作已分析完成';
  }

  // 里程碑卡片
  document.getElementById('milestoneSlot').innerHTML = '';
  if (completeData.milestone || record.milestone) {
    const m = completeData.milestone || record.milestone;
    const mClass = `milestone-icon ${m.number <= 50 ? 'm' + m.number : 'm50'}`;
    const cardClass = `milestone-card ${m.number <= 50 ? 'm' + m.number : 'm50'}`;
    document.getElementById('milestoneSlot').innerHTML = `
      <div class="${cardClass}">
        <div class="${mClass}">${m.icon}</div>
        <div class="milestone-body">
          <div class="milestone-title">${escapeHtml(m.title)}</div>
          <div class="milestone-desc">${escapeHtml(m.message)}</div>
        </div>
      </div>`;
    // 触发顶部成就弹窗
    showAchievementPopup(m);
  }

  // 下一幅推荐
  if (completeData.next_recommendation) {
    document.getElementById('nextRecText').textContent = completeData.next_recommendation.title;
    document.getElementById('nextRec').classList.add('visible');
  }

  // 操作按钮
  currentRecordId = record.id;
  track('ai_feedback_viewed', {record_id: record.id});
  startActionButtonsDelay(record);

  // 反思交互区
  setTimeout(() => {
    document.getElementById('reflectionArea').classList.add('visible');
    resetReflectionUI();
    loadReflectionTags();
    if (currentDrawingSubject === '这次') {
      const themeTitle = document.getElementById('themeTitle')?.textContent || '';
      if (themeTitle && themeTitle !== '画你想画的') {
        currentDrawingSubject = themeTitle.replace(/^画一个?/, '');
      }
    }
    const input = document.getElementById('reflectionInput');
    if (input) input.placeholder = `比如：${currentDrawingSubject}的形状这次画准了`;
  }, 1000);

  // 用户名标签保持隐藏
}

// ─── Show Feedback ───
function showFeedback(record) {
  track('ai_feedback_viewed', {record_id: record.id});
  currentRecordId = record.id;  // 保存当前记录 ID 用于反思保存

  // 用户名标签保持隐藏

  // 有 feedback_json → 渲染陪伴模式流式反馈
  if (record.feedback_json && record.feedback_json.layers && record.feedback_json.layers.length >= 4) {
    renderEnhancedFeedback(record);
    return;
  }

  // 无 feedback_json → 渲染旧版文本（向后兼容）
  const container = document.getElementById('feedback');
  const content = document.getElementById('feedbackContent');
  const badge = document.getElementById('elapsedBadge');
  container.classList.add('visible');

  // 里程碑卡片（普通反馈也显示）
  const milestoneSlot = document.getElementById('milestoneSlotLegacy');
  if (milestoneSlot) {
    milestoneSlot.innerHTML = '';
    if (record.milestone) {
      const m = record.milestone;
      const mClass = `milestone-icon ${m.number <= 50 ? 'm' + m.number : 'm50'}`;
      const cardClass = `milestone-card ${m.number <= 50 ? 'm' + m.number : 'm50'}`;
      milestoneSlot.innerHTML = `
        <div class="${cardClass}">
          <div class="${mClass}">${m.icon}</div>
          <div class="milestone-body">
            <div class="milestone-title">${escapeHtml(m.title)}</div>
            <div class="milestone-desc">${escapeHtml(m.message)}</div>
          </div>
        </div>`;
      showAchievementPopup(m);
    }
  }

  if (record.elapsed_s) {
    const s = record.elapsed_s;
    badge.textContent = s < 10 ? `${s}s` : `${Math.round(s)}s`;
  }

  const lines = record.feedback.split('\n').filter(l => l.trim());
  let html = '';
  lines.forEach(line => {
    const cleanLine = line.trim().replace(/^[\d]+[)）.、:：]?\s*/, '');
    if (!cleanLine) return;
    html += `<p style="margin-bottom:6px;">${enrichText(cleanLine)}</p>`;
  });
  content.innerHTML = html;

  // 滚动到反馈区顶部
  setTimeout(() => {
    const rect = container.getBoundingClientRect();
    const scrollTop = window.pageYOffset + rect.top - 12;
    window.scrollTo({ top: scrollTop, behavior: 'smooth' });
  }, 100);

  // 延迟显示操作按钮
  startActionButtonsDelay(record);

  // 显示反思交互区
  setTimeout(() => {
    document.getElementById('reflectionArea').classList.add('visible');
    resetReflectionUI();
    const input = document.getElementById('reflectionInput');
    if (input) input.placeholder = `比如：${currentDrawingSubject}的形状这次画准了`;
  }, 1000);
}


// ═══ 反馈增强 v3.1 新功能 ═══════════════════════════════

// ─── 简洁等待提示（流式反馈逐步替代） ───
function showSimpleWaiting() {
  // loading 态直接放在反馈容器中，不单独占区域
  const container = document.getElementById('feedbackEnhanced');
  container.classList.add('visible');
  document.getElementById('aiNameEnhanced').textContent = '小绘';
  document.getElementById('aiSubtitleEnhanced').textContent = 'AI 正在看你的画…';
  document.getElementById('milestoneSlot').innerHTML = '';
  document.getElementById('fbDepthLayer').innerHTML = '';
  document.getElementById('fbLayersContainer').innerHTML = `
    <div class="simple-waiting">
      <div class="simple-waiting-dots">
        <span></span><span></span><span></span>
      </div>
    </div>`;
}

function stopSimpleWaiting() {
  // loading 内容由 SSE first_impression / layer 事件自然替换，
  // 这里不做任何 DOM 清理。避免 finally 块误清已渲染的反馈层。
}

// ─── 5层增强反馈渲染 ───
function renderEnhancedFeedback(record) {
  const fbJson = record.feedback_json;
  const userName = document.getElementById('greetingName').textContent || '小伙伴';

  // 更新全局术语上下文（用于弹窗增强）
  currentGlossaryContext = (fbJson && fbJson.glossary_context) || {};

  // 显示增强容器
  const container = document.getElementById('feedbackEnhanced');
  container.classList.add('visible');

  // 设置头部
  document.getElementById('aiNameEnhanced').textContent = '小绘';
  setAiSubtitle();
  if (record.elapsed_s) {
    const s = record.elapsed_s;
    document.getElementById('elapsedBadgeEnhanced').textContent = s < 10 ? `${s}s` : `${Math.round(s)}s`;
  }

  // 里程碑卡片
  document.getElementById('milestoneSlot').innerHTML = '';
  if (record.milestone) {
    const m = record.milestone;
    const mClass = `milestone-icon ${m.number <= 50 ? 'm' + m.number : 'm50'}`;
    const cardClass = `milestone-card ${m.number <= 50 ? 'm' + m.number : 'm50'}`;
    document.getElementById('milestoneSlot').innerHTML = `
      <div class="${cardClass}">
        <div class="${mClass}">${m.icon}</div>
        <div class="milestone-body">
          <div class="milestone-title">${escapeHtml(m.title)}</div>
          <div class="milestone-desc">${escapeHtml(m.message)}</div>
        </div>
      </div>`;
  }

  // 深度指示器
  const layers = fbJson.layers || [];
  const LABELS = {identify: '认出内容', observe: '具体观察', progress: '进步连接', suggestion: '技巧建议', encourage: '鼓励期待'};
  document.getElementById('fbDepthLayer').innerHTML = `
    <div class="fb-depth">
      ${layers.map((l, i) => `<div class="dot d${i+1}" title="${LABELS[l.type] || l.type}"></div>`).join('')}
      <span class="fb-depth-label">${layers.length} 层反馈深度</span>
    </div>`;

  // 渲染 5 层
  const layersEl = document.getElementById('fbLayersContainer');
  layersEl.innerHTML = '';

  // 提取绘画主题（用于反思提示文案）
  const identifyLayer = layers.find(l => l.type === 'identify');
  if (identifyLayer && identifyLayer.content) {
    // 尝试从识别层内容中提取主题词
    const match = identifyLayer.content.match(/画的是(?:一个|一只|一幅)?(.+?)[对吧呢？\?]/);
    if (match && match[1]) {
      currentDrawingSubject = match[1].trim();
    }
  }
  // 如果没提取到，用今日主题
  if (currentDrawingSubject === '这次') {
    const themeTitle = document.getElementById('themeTitle')?.textContent || '';
    if (themeTitle && themeTitle !== '画你想画的') {
      currentDrawingSubject = themeTitle.replace(/^画一个?/, '');
    }
  }

  const LAYER_TAGS   = {identify: 'l-identify', observe: 'l-observe', progress: 'l-progress', suggestion: 'l-suggest', encourage: 'l-encourage'};
  const LAYER_LABELS = {identify: '🎯 认出', observe: '🔍 观察', progress: '📈 进步', suggestion: '💡 建议', encourage: '✨ 期待'};

  layers.forEach(layer => {
    const type = layer.type;
    const tagClass = LAYER_TAGS[type] || '';
    const label = LAYER_LABELS[type] || type;
    const div = document.createElement('div');
    div.className = 'fb-layer';

    if (type === 'progress') {
      div.innerHTML = `
        <div class="fb-progress-box">
          <span class="p-icon">📈</span>
          <span class="p-text">${enrichText(layer.content)}</span>
        </div>`;
    } else {
      let html = `<span class="layer-tag ${tagClass}">${label}</span>
        <div class="layer-text">${enrichText(layer.content)}</div>`;
      if (type === 'suggestion' && layer.tip && layer.tip.trim()) {
        html += `<div class="fb-tip-box"><strong>💡 小技巧</strong>：${enrichText(layer.tip)}</div>`;
      }
      div.innerHTML = html;
    }
    layersEl.appendChild(div);
  });

  // 滚动到反馈区顶部（延迟等 DOM 渲染完成）
  setTimeout(() => {
    const rect = container.getBoundingClientRect();
    const scrollTop = window.pageYOffset + rect.top - 12;
    window.scrollTo({ top: scrollTop, behavior: 'smooth' });
  }, 200);

  // 延迟 2 秒显示操作按钮
  startActionButtonsDelay(record);

  // 显示反思交互区
  setTimeout(() => {
    document.getElementById('reflectionArea').classList.add('visible');
    resetReflectionUI();
    const input = document.getElementById('reflectionInput');
    if (input) input.placeholder = `比如：${currentDrawingSubject}的形状这次画准了`;
  }, 1000);
}

// ─── 精简模式反馈 ───

// ─── 操作按钮 ───
function renderActionButtons(record) {
  const container = document.getElementById('actionBtnsContainer');
  const rid = (record && record.id) || currentRecordId || '';
  const btns = [
    {icon: '📸', cls: 'i-primary', title: '拍一张', desc: '拿起画笔再画一张，拍下来', action: 'openCamera()'},
    {icon: '📖', cls: 'i-green', title: '查看记录', desc: '回顾一下绘画旅程', action: "switchTab('timeline')"},
    {icon: '🎨', cls: 'i-orange', title: '分享我的画', desc: '生成分享图，发朋友圈', action: `shareMyPainting('${rid}')`},
  ];
  container.innerHTML = btns.map(b =>
    `<button class="action-btn" onclick="${b.action}">
      <span class="ab-icon ${b.cls}">${b.icon}</span>
      <div class="ab-body">
        <div class="ab-title">${b.title}</div>
        <div class="ab-desc">${b.desc}</div>
      </div>
    </button>`
  ).join('');
}

function startActionButtonsDelay(record) {
  const actions = document.getElementById('fbActions');
  actions.classList.remove('visible');
  renderActionButtons(record);
  setTimeout(() => { actions.classList.add('visible'); }, 2000);
}

// ─── 反思交互 ───
let selectedReflectionText = '';

function selectQuickReflection(btn, text) {
  // 切换选中（允许改选其他标签）
  document.querySelectorAll('.r-quick-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  selectedReflectionText = text;
  // 显示确认发送条
  document.getElementById('rConfirmText').textContent = `已选：${btn.textContent.replace(/^[^\s]+\s/, '')}`;
  document.getElementById('reflectionConfirm').style.display = 'flex';
}

function confirmReflection() {
  if (!selectedReflectionText) return;
  // 锁定所有标签，不可再点
  document.querySelectorAll('.r-quick-btn').forEach(b => b.style.pointerEvents = 'none');
  document.getElementById('reflectionConfirm').style.display = 'none';
  sendReflection(selectedReflectionText);
}

function showCustomReflection() {
  // 隐藏标签确认条（切换到文字输入模式）
  document.getElementById('reflectionConfirm').style.display = 'none';
  document.querySelectorAll('.r-quick-btn').forEach(b => b.classList.remove('selected'));
  selectedReflectionText = '';
  // 显示自定义输入
  const row = document.getElementById('reflectionCustomRow');
  if (row) {
    row.style.display = 'flex';
    const input = document.getElementById('reflectionInput');
    if (input) setTimeout(() => input.focus(), 100);
  }
}

// 重置反思区 UI（每次新反馈前调用）
function resetReflectionUI() {
  const input = document.getElementById('reflectionInput');
  if (input) {
    input.value = '';
    input.style.borderColor = '';
  }
  const customRow = document.getElementById('reflectionCustomRow');
  if (customRow) customRow.style.display = 'none';
  document.querySelectorAll('.r-quick-btn').forEach(b => {
    b.classList.remove('selected');
    b.style.pointerEvents = '';
  });
  const confirmBar = document.getElementById('reflectionConfirm');
  if (confirmBar) confirmBar.style.display = 'none';
  selectedReflectionText = '';
  const responseEl = document.getElementById('reflectionResponse');
  if (responseEl) responseEl.classList.remove('visible');
}

function sendReflection(presetText) {
  const input = document.getElementById('reflectionInput');
  const text = (presetText || input.value || '').trim();
  if (!text) {
    if (input) {
      input.placeholder = '随便说说也行～';
      input.style.borderColor = 'var(--color-primary-light)';
    }
    return;
  }

  // 保存反思文字到 localStorage（用于弹窗时空穿梭展示）
  if (currentRecordId) {
    try {
      const key = `reflection_${currentRecordId}`;
      localStorage.setItem(key, JSON.stringify({
        text: text,
        timestamp: Date.now()
      }));
    } catch(e) {}
  }

  // ═══ SSE 流式获取反思回复（逐字显示，不干等）═══
  const replyEl = document.getElementById('reflectionReply');
  const responseEl = document.getElementById('reflectionResponse');
  responseEl.classList.add('visible');
  replyEl.innerHTML = `
    <div class="chat-meta user">你</div>
    <div class="chat-bubble chat-user">${escapeHtml(text)}</div>
    <div class="chat-meta ai">小绘</div>
    <div class="chat-bubble chat-ai"></div>
  `;
  const bubble = replyEl.querySelector('.chat-bubble.chat-ai');
  bubble.textContent = '…';

  fetch('/api/reflection', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({text: text, subject: currentDrawingSubject}),
  })
    .then(r => {
      if (!r.ok) throw new Error('reflection SSE failed');
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      function readStream() {
        reader.read().then(({ done, value }) => {
          if (done) {
            if (bubble.textContent === '…') bubble.textContent = '每次进步都值得记下来 ☺️';
            return;
          }
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            let data;
            try { data = JSON.parse(part.slice(6)); } catch (e) { continue; }
            if (data.type === 'done') {
              if (data.elapsed_s) {
                const meta = replyEl.querySelector('.chat-meta.ai');
                if (meta) meta.textContent += `  ${data.elapsed_s}s`;
                console.log(`[reflection] SSE 完成，耗时 ${data.elapsed_s}s`);
              }
              return;
            }
            if (data.type === 'fallback') {
              bubble.textContent = data.text;
              return;
            }
            if (data.token) {
              if (bubble.textContent === '…') bubble.textContent = '';
              bubble.textContent += data.token;
            }
          }
          readStream();
        }).catch(() => {
          if (bubble.textContent === '…') bubble.textContent = '每次进步都值得记下来 ☺️';
        });
      }
      readStream();
    })
    .catch(() => {
      if (bubble.textContent === '…') bubble.textContent = '每次进步都值得记下来 ☺️';
    });

  // 平滑滚动到回应区域
  setTimeout(() => {
    responseEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);

  // 重置输入区（但保留回应）
  if (input) {
    input.value = '';
    input.style.borderColor = '';
  }
  const customRow = document.getElementById('reflectionCustomRow');
  if (customRow) customRow.style.display = 'none';
}

// ─── 读取反思文字（用于弹窗展示） ───
function getReflection(recordId) {
  try {
    const key = `reflection_${recordId}`;
    const data = localStorage.getItem(key);
    if (data) {
      return JSON.parse(data);
    }
  } catch(e) {}
  return null;
}

// ─── 计算时间差描述 ───
function getTimeAgo(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 100) return `${Math.floor(days / 30)} 个月前`;
  return '很久以前';
}

// ─── 记录感受（简易版） ───
function recordFeeling() {
  const input = document.getElementById('reflectionInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) {
    input.focus();
    input.placeholder = '写下此刻的想法...';
    return;
  }
  // 简单确认
  input.value = '';
  input.placeholder = '已记录 ✅';
  setTimeout(() => { input.placeholder = `比如：${currentDrawingSubject}的形状这次画准了`; }, 2000);
}


