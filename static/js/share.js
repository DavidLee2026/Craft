// ─── share.js · 画作分享图（生成分享卡 + 预览弹窗）───
// 依赖：state.js；运行时调用 community.js 的 shareToCommunity
// 当前分享图数据（预览弹窗用）
let currentShareDataUrl = null;

function shareCurrentRecord() {
  if (!currentRecordId) return;
  const record = records.find(r => r.id === currentRecordId);
  if (!record) return;
  generateShareCard(record);
}

// 首页反馈后「分享我的画」入口
function shareMyPainting(recordId) {
  const record = records.find(r => r.id === recordId);
  if (!record) return;
  generateShareCard(record);
}

async function shareToCommunity(recordId) {
  try {
    const res = await fetch(`${API_BASE}/api/community/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_id: recordId }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('✅ 已分享到社区', 'success');
    } else {
      showToast(data.error || '分享失败', 'error');
    }
  } catch (e) {
    showToast('网络错误，请重试', 'error');
  }
}

// ─── 画作分享图生成 ───
async function generateShareCard(record) {
  try {
    const dateEl = document.getElementById('shareCardDate');
    const imgEl = document.getElementById('shareCardImg');
    const feedbackEl = document.getElementById('shareCardFeedback');
    const streakEl = document.getElementById('shareCardStreak');
    const streakDaysEl = document.getElementById('shareCardStreakDays');

    const d = new Date(record.timestamp || record.created_at);
    dateEl.textContent = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;

    // 填入 streak（连续画画天数），像多邻国那样重点展示
    if (currentStreak >= 1) {
      streakDaysEl.textContent = currentStreak;
      streakEl.style.display = 'inline-flex';
    } else {
      streakEl.style.display = 'none';
    }

    // cache:'no-store'：图片之前可能被 <img> 加载过并缓存，
    // 若 Flask 返回 304（无 body），blob() 会拿到空 Blob 导致分享图生成失败。
    // 用 data URL 而非 blob URL：html-to-image 无法绘制 blob URL 图片（内部 fetch blob 报错），data URL 稳定。
    const imgUrl = `${API_BASE}/data/${record.image}`;
    const imgResp = await fetch(imgUrl, { cache: 'no-store' });
    const imgBlob = await imgResp.blob();
    imgEl.src = await blobToDataUrl(imgBlob);

    await new Promise((resolve, reject) => {
      imgEl.onload = resolve;
      imgEl.onerror = reject;
      if (imgEl.complete) resolve();
    });

    feedbackEl.textContent = extractFeedbackSummary(record);

    // 记录当前分享对应的记录 ID，供「分享到社区」使用
    currentShareRecordId = record.id;

    const cardEl = document.getElementById('shareCard');
    const dataUrl = await htmlToImage.toPng(cardEl, {
      quality: 0.95,
      pixelRatio: 1,
      cacheBust: true,
    });

    currentShareDataUrl = dataUrl;

    document.getElementById('sharePreviewImg').src = dataUrl;
    const canShare = navigator.share && navigator.canShare && navigator.canShare({ files: [] });
    document.getElementById('shareSystemBtn').style.display = canShare ? 'flex' : 'none';

    document.getElementById('sharePreviewOverlay').classList.add('visible');
    document.body.style.overflow = 'hidden';

  } catch (e) {
    console.error('生成分享图失败:', e);
    showToast('生成分享图失败，请重试', 'error');
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function extractFeedbackSummary(record) {
  const fb = record.feedback_json;
  if (fb && Array.isArray(fb.layers)) {
    const identify = fb.layers.find(l => l.type === 'identify');
    if (identify && identify.content) return identify.content.slice(0, 80);
    const observe = fb.layers.find(l => l.type === 'observe');
    if (observe && observe.content) return observe.content.slice(0, 80);
    if (fb.layers[0] && fb.layers[0].content) return fb.layers[0].content.slice(0, 80);
  }
  if (record.feedback) return record.feedback.replace(/\n/g, ' ').slice(0, 80);
  return '小绘认真看了你的画，觉得你画得很用心 ✨';
}

function closeSharePreview() {
  document.getElementById('sharePreviewOverlay').classList.remove('visible');
  document.body.style.overflow = '';
  currentShareDataUrl = null;
  currentShareRecordId = null;
}

// 从分享预览弹窗分享到社区
async function shareToCommunityFromPreview() {
  if (!currentShareRecordId) {
    showToast('没有可分享的画作', 'error');
    return;
  }
  await shareToCommunity(currentShareRecordId);
}

async function shareViaSystem() {
  if (!currentShareDataUrl) return;
  try {
    const resp = await fetch(currentShareDataUrl);
    const blob = await resp.blob();
    const file = new File([blob], `每日绘-${new Date().toISOString().slice(0,10)}.png`, { type: 'image/png' });
    await navigator.share({ files: [file], title: '我的每日绘分享', text: '来看看我画的画！' });
  } catch (e) {
    if (e.name !== 'AbortError') showToast('分享失败，请尝试保存到相册', 'error');
  }
}

function downloadShareImage() {
  if (!currentShareDataUrl) return;
  const link = document.createElement('a');
  link.download = `每日绘-${new Date().toISOString().slice(0,10)}.png`;
  link.href = currentShareDataUrl;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    showToast('已保存到相册', 'success');
  }, 500);
}

