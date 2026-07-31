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
      // 分享成功不关闭预览弹窗，仅弹 toast（toast z-index 400 高于弹窗，可见）
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
    // 若 Flask 返回 304（无 body），blob() 会拿到空 Blob。
    const imgUrl = `${API_BASE}/data/${record.image}`;
    const imgResp = await fetch(imgUrl, { cache: 'no-store' });
    if (!imgResp.ok) throw new Error(`图片加载失败 ${imgResp.status}`);
    const imgBlob = await imgResp.blob();
    imgEl.src = await blobToDataUrl(imgBlob);

    // 显式等待像素解码完成（data URL 下 complete 同步 true，但解码异步，移动端尤其慢）
    await waitImageDecoded(imgEl);
    if (!imgEl.naturalWidth) throw new Error('图片解码失败');

    feedbackEl.textContent = extractFeedbackSummary(record);

    // 记录当前分享对应的记录 ID，供「分享到社区」使用
    currentShareRecordId = record.id;

    // 原生 Canvas 合成分享图。
    // 弃用 html-to-image：其移动端（iOS Safari / 微信 WebView）绘制 <img> 不可靠——
    // 内部强制 crossOrigin 再加载 data URL，在 WebView 里图片静默加载失败 → 分享图图片区空白。
    const dataUrl = await renderShareCardNative(imgEl);

    currentShareDataUrl = dataUrl;

    // 上传分享图换真实 http 地址：微信 WebView 长按图片需要真实 URL 才能弹
    // "发送给朋友/保存"菜单，data URL 长按无效。上传失败则回退 data URL。
    let displayUrl = dataUrl;
    try {
      const resp = await fetch(`${API_BASE}/api/share-image`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({data_url: dataUrl}),
      });
      const data = await resp.json();
      if (data.url) displayUrl = data.url;
    } catch (e) {
      console.warn('分享图上传失败，回退 data URL:', e);
    }

    document.getElementById('sharePreviewImg').src = displayUrl;

    document.getElementById('sharePreviewOverlay').classList.add('visible');
    document.body.style.overflow = 'hidden';

  } catch (e) {
    console.error('生成分享图失败:', e);
    showToast('生成分享图失败，请重试', 'error');
  }
}

// ─── 原生 Canvas 合成分享图 ───
// 布局与 .share-card CSS 保持一致；颜色从 DOM 计算样式读取，不在 JS 里硬编码。
function renderShareCardNative(paintingImg) {
  return new Promise((resolve, reject) => {
    try {
      const card = document.getElementById('shareCard');
      const logoEl = document.querySelector('.share-card-logo');
      const dateEl = document.getElementById('shareCardDate');
      const streakEl = document.getElementById('shareCardStreak');
      const streakDaysEl = document.getElementById('shareCardStreakDays');
      const feedbackEl = document.getElementById('shareCardFeedback');
      const footerEl = document.querySelector('.share-card-footer');

      const ready = (document.fonts && document.fonts.ready)
        ? document.fonts.ready
        : Promise.resolve();

      ready.then(() => {
        const W = 1080;
        const padTop = 60, padBottom = 50;
        const imgW = 711;                    // 图片区宽度（画作按比例缩小约 30%，居中留白）
        // 图片区高度按原图宽高比自适应 → 图片始终铺满图片区、无左右留白
        const iw0 = paintingImg.naturalWidth || 960, ih0 = paintingImg.naturalHeight || 960;
        let imgH = Math.round(imgW * ih0 / iw0);
        imgH = Math.max(400, Math.min(1100, imgH));  // clamp 防极端比例（超宽/超高图）
        const serif = '"Noto Serif SC","Songti SC",serif';
        const sans = '-apple-system,"PingFang SC","Noto Sans SC",sans-serif';

        // 颜色从计算样式读取（与 CSS 一致）
        const bgColor = getComputedStyle(card).backgroundColor;
        const logoColor = getComputedStyle(logoEl).color;
        const dateColor = getComputedStyle(dateEl).color;
        const feedbackColor = getComputedStyle(feedbackEl).color;
        const footerColor = getComputedStyle(footerEl).color;
        const imgWrapBg = getComputedStyle(document.querySelector('.share-card-image-wrap')).backgroundColor;

        const logoText = logoEl.textContent;
        const dateText = dateEl.textContent;
        const feedbackText = feedbackEl.textContent;
        const footerText = footerEl.textContent;
        const showStreak = streakEl.style.display !== 'none';
        const streakDays = streakDaysEl.textContent;

        // ── 布局测量（按 CSS 间距推算） ──
        const meas = document.createElement('canvas');
        const mctx = meas.getContext('2d');
        mctx.font = '500 26px ' + sans;
        const fbLines = wrapText(mctx, feedbackText, 880);
        const fbLineH = 26 * 1.7;

        let y = padTop;
        const logoTop = y; y += 60;          // logo 行
        y += 10 + 30;                        // 日期行（logo margin-bottom 10）
        y += 36;                             // brand 区 margin-bottom
        let streakTop = null;
        if (showStreak) { streakTop = y; y += 100 + 28; }  // pill + margin-bottom 28
        const imgTop = y; y += imgH;         // 图片区（高度自适应）
        const dividerTop = y + 36; y += 36 + 3 + 36;        // divider + 上下 margin
        const fbTop = y; y += fbLines.length * fbLineH;
        y += 36 + 26 + padBottom;            // footer + 底部
        const H = y;

        // ── 正式绘制 ──
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'middle';

        // 背景
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, W, H);

        // logo（手动居中：emoji 前缀与文字分开绘制，防 emoji 渲染度量偏差导致整体偏移）
        ctx.font = '700 42px ' + serif;
        ctx.fillStyle = logoColor;
        const logoEmoji = (logoText.match(/^\S+/) || [''])[0];
        const logoWords = logoText.slice(logoEmoji.length).trim();
        const emojiW = ctx.measureText(logoEmoji).width;
        const wordsW = ctx.measureText(logoWords).width;
        const logoStartX = W / 2 - (emojiW + wordsW) / 2;
        ctx.textAlign = 'left';
        ctx.fillText(logoEmoji, logoStartX, logoTop + 30);
        ctx.fillText(logoWords, logoStartX + emojiW, logoTop + 30);
        ctx.textAlign = 'center';  // 重置对齐，避免污染后续绘制（日期等仍按中心对齐）

        // 日期
        ctx.font = '500 22px ' + sans;
        ctx.fillStyle = dateColor;
        ctx.fillText(dateText, W / 2, logoTop + 60 + 25);

        // streak pill（渐变圆角胶囊，与 .share-card-streak 一致）
        if (streakTop !== null) {
          const pillH = 100, pillCy = streakTop + pillH / 2;
          mctx.font = '800 64px ' + sans;
          const daysW = mctx.measureText(streakDays).width;
          mctx.font = '600 28px ' + sans;
          const labelW = mctx.measureText('天').width;
          mctx.font = '48px ' + sans;
          const flameW = Math.max(60, mctx.measureText('🔥').width);
          const gap = 4;
          const contentW = flameW + gap + daysW + gap + labelW;
          const pillW = contentW + 36 * 2;
          const pillX = (W - pillW) / 2;
          // 渐变端点与 .share-card-streak background 一致
          roundRectPath(ctx, pillX, streakTop, pillW, pillH, pillH / 2);
          const grad = ctx.createLinearGradient(0, streakTop, 0, streakTop + pillH);
          grad.addColorStop(0, '#FF6B35');
          grad.addColorStop(1, '#F7931E');
          ctx.fillStyle = grad;
          ctx.fill();
          // 内容居中：🔥 + 天数 + 天
          let cx = pillX + 36 + flameW / 2;
          ctx.font = '48px ' + sans;
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.fillText('🔥', cx, pillCy);
          cx += flameW / 2 + gap + daysW / 2;
          ctx.font = '800 64px ' + sans;
          ctx.fillText(streakDays, cx, pillCy);
          cx += daysW / 2 + gap + labelW / 2;
          ctx.font = '600 28px ' + sans;
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.fillText('天', cx, pillCy);
        }

        // 图片区（白底圆角 + 阴影 + 图片按比例铺满）
        const imgX = (W - imgW) / 2;
        ctx.save();
        ctx.shadowColor = 'rgba(154,87,56,0.10)';
        ctx.shadowBlur = 40;
        ctx.shadowOffsetY = 8;
        roundRectPath(ctx, imgX, imgTop, imgW, imgH, 20);
        ctx.fillStyle = imgWrapBg;
        ctx.fill();
        ctx.restore();
        ctx.save();
        roundRectPath(ctx, imgX, imgTop, imgW, imgH, 20);
        ctx.clip();
        const iw = paintingImg.naturalWidth, ih = paintingImg.naturalHeight;
        const scale = Math.min(imgW / iw, imgH / ih);
        const dw = iw * scale, dh = ih * scale;
        ctx.drawImage(paintingImg, imgX + (imgW - dw) / 2, imgTop + (imgH - dh) / 2, dw, dh);
        ctx.restore();

        // 分割线
        roundRectPath(ctx, W / 2 - 30, dividerTop, 60, 3, 2);
        ctx.fillStyle = logoColor;
        ctx.fill();

        // 反馈文字（居中多行）
        ctx.font = '500 26px ' + sans;
        ctx.fillStyle = feedbackColor;
        ctx.textAlign = 'center';
        fbLines.forEach((line, i) => {
          ctx.fillText(line, W / 2, fbTop + i * fbLineH + fbLineH / 2);
        });

        // footer
        ctx.font = '400 18px ' + sans;
        ctx.fillStyle = footerColor;
        ctx.fillText(footerText, W / 2, H - padBottom - 13);

        resolve(canvas.toDataURL('image/png'));
      }).catch(reject);
    } catch (e) { reject(e); }
  });
}

// canvas 文本自动换行
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// 手写圆角矩形路径（兼容不支持 roundRect 的老 WebView）
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// 等待图片像素真正解码完成（decode() 返回的 promise 保证可被 canvas 绘制）
function waitImageDecoded(img) {
  if (typeof img.decode === 'function') {
    return img.decode().catch(() => new Promise(resolve => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
      if (img.complete) resolve();
    }));
  }
  return new Promise(resolve => {
    img.onload = () => resolve();
    img.onerror = () => resolve();
    if (img.complete) resolve();
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


