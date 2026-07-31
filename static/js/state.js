// ─── state.js · 全局状态 + 通用工具 ──────────────
// 最先加载：其他模块都依赖这里的全局变量与工具函数
// ─── State ───
const API_BASE = '';
let records = [];
let currentGlossaryContext = {};  // 当前反馈的术语上下文（反馈增强 v3.1）
let waitingTimer = null;
let currentDrawingSubject = '这次';  // 当前画作主题，用于反思提示文案
let currentRecordId = null;  // 当前反馈的记录 ID，用于保存反思文字
let currentStreak = 0;  // 当前连续画画天数，用于分享卡
let currentShareRecordId = null;  // 当前预览弹窗对应的记录 ID

// 防止浏览器恢复滚动位置，确保每次进入都从顶部开始
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

// ─── 自定义平滑滚动（ease-in-out 缓动，比原生 scrollIntoView 更柔和）───
function smoothScrollTo(targetY, duration) {
  const startY = window.pageYOffset;
  const diff = targetY - startY;
  if (Math.abs(diff) < 2) return;
  const startT = performance.now();
  function step(now) {
    const elapsed = now - startT;
    const t = Math.min(1, elapsed / duration);
    // ease-out-cubic 缓动曲线
    const eased = 1 - Math.pow(1 - t, 3);
    window.scrollTo(0, startY + diff * eased);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ─── 埋点 ───
function track(event, metadata) {
  fetch('/api/track', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({event, metadata: metadata || {}}),
  }).catch(() => {});
}

// ─── 轻提示 Toast ───
let toastTimer = null;
function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// ─── AI 反馈头部副标题（随机变化，让小绘更有人情味） ───
const AI_SUBTITLES = [
  '仔细看了你的画，有些想说的',
  '看完了你的画，给到一些建议',
  '认真看完了，想和你聊聊这幅画',
  '你的画我看了好几遍，有发现',
  '看完啦，有些地方画得真不错',
  '仔细欣赏完了，来聊聊吧',
  '小绘看了你的画，想分享一些感受',
  '小绘仔细看完了每一个细节，给你一些反馈',
  '小绘认真看过了，有几个亮点想告诉你',
  '小绘盯着你的画看了好一会儿，有话想说',
];
function setAiSubtitle() {
  const el = document.getElementById('aiSubtitleEnhanced');
  if (el) {
    el.textContent = AI_SUBTITLES[Math.floor(Math.random() * AI_SUBTITLES.length)];
  }
}

// ─── 里程碑判定（与后端 app.py get_milestone 逻辑同步） ───
function getMilestone(total) {
  const milestones = {
    1:  { icon: '🎉', title: '第一张画', message: '记住这一刻——再伟大的画家也是从第一根线开始的。' },
    5:  { icon: '🔥', title: '坚持 5 张', message: '大多数人在第 3 张就放弃了，你已经超过了 70% 的人。' },
    10: { icon: '👑', title: '10 张里程碑', message: '翻看第一张和今天的对比——进步是真实存在的。' },
    25: { icon: '💪', title: '25 张·习惯成自然', message: '你已经在不知不觉中养成了绘画习惯，这是最有价值的一步。' },
    50: { icon: '🌟', title: '50 张·质变', message: "从'画出形状'到'画得像'，这 50 张见证了你的蜕变。" },
  };
  const m = milestones[total];
  if (m) {
    return { key: 'm' + total, number: total, desc: m.message, ...m };
  }
  if (total > 50 && total % 50 === 0) {
    return {
      key: 'm50', number: total, icon: '🌟',
      title: total + ' 张',
      desc: '你已经画了 ' + total + ' 张了！回看最初的线条和现在的对比，变化是看得见的。',
    };
  }
  return null;
}

// ─── 成就弹窗（里程碑触发，游戏成就风格） ───
let achievementTimer = null;
function showAchievementPopup(milestone) {
  let popup = document.getElementById('achievementPopup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'achievementPopup';
    popup.className = 'achievement-popup';
    document.body.appendChild(popup);
  }
  const shortCongrats = {
    1: '迈出了第一步，继续画下去！',
    5: '坚持就是胜利，保持节奏！',
    10: '习惯已养成，画技在积累！',
    25: '稳步提升中，每一张都算数！',
    50: '从量变到质变，你做到了！'
  };
  popup.innerHTML = `
    <div class="ach-icon">${milestone.icon || '🎉'}</div>
    <div class="ach-body">
      <div class="ach-title">${escapeHtml(milestone.title || '恭喜！')}</div>
      <div class="ach-desc">${escapeHtml(shortCongrats[milestone.number] || '继续保持！')}</div>
    </div>`;
  // 先强制渲染隐藏态（-200px 屏幕外），下一帧再切 visible 触发滑入过渡：
  // 首次创建的元素若直接加 visible，浏览器首次布局就在最终位置，transition 无从发生 → 通知条直接弹出没有动画。
  popup.style.top = '-200px';
  popup.classList.remove('visible');
  void popup.offsetHeight;  // 强制同步布局，确保 -200px 已生效
  popup.style.top = '';
  popup.classList.add('visible');
  // 滑入到位后放烟花庆祝
  setTimeout(() => burstConfetti(popup), 650);
  if (achievementTimer) clearTimeout(achievementTimer);
  achievementTimer = setTimeout(() => {
    popup.classList.remove('visible');
    // 延迟重置 top 到完全隐藏位置，等过渡动画完成
    setTimeout(() => { popup.style.top = '-200px'; }, 600);
  }, 4000);
}

// ─── 成就烟花：从通知条位置向外爆开彩纸粒子 ───
const CONFETTI_COLORS = [
  'var(--raw-clay-500)', 'var(--raw-sage-500)', 'var(--raw-ochre-500)',
  'var(--raw-sage-700)', 'var(--raw-ochre-300)', 'var(--raw-sage-300)'
];

function burstConfetti(origin) {
  const rect = origin.getBoundingClientRect();
  burstConfettiAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

// 从指定坐标爆开彩纸粒子（成就通知条 + 点击里程碑卡片共用）
function burstConfettiAt(x, y) {
  // 防连点堆积：粒子存活数超过上限则忽略本次，保流畅
  if (document.querySelectorAll('.confetti-piece').length > 120) return;
  for (let i = 0; i < 42; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    const dx = (Math.random() - 0.5) * 460;
    const dy = -(Math.random() * 200 + 40) + (Math.random() - 0.5) * 60;
    const rot = Math.random() * 760 - 380;
    const size = 6 + Math.random() * 6;
    p.style.cssText =
      `left:${x}px;top:${y}px;width:${size}px;height:${size * 0.6}px;` +
      `background:${CONFETTI_COLORS[i % CONFETTI_COLORS.length]};` +
      `transition-delay:${Math.random() * 0.15}s;`;
    document.body.appendChild(p);
    // 先渲染初始位置，下一帧再触发扩散动画
    requestAnimationFrame(() => requestAnimationFrame(() => {
      p.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
      p.style.opacity = '0';
    }));
    setTimeout(() => p.remove(), 1500);
  }
}

// ─── 点击里程碑卡片绽放烟花（可无限次点击） ───
// 事件委托：里程碑卡片由 JS 动态渲染（反馈页 + 记录详情弹窗），绑 document 一次全覆盖。
// 用 capture 阶段（第三个参数 true）：记录详情弹窗的 .modal 容器有
// onclick="event.stopPropagation()"，冒泡阶段会在 .modal 被截断到不了 document；
// capture 阶段最先执行、先于 stopPropagation，两种位置的卡片都能命中。
// 点哪里就从哪里爆开，每次点击独立触发，不设次数上限。
document.addEventListener('click', (e) => {
  const card = e.target.closest('.milestone-card');
  if (card) {
    burstConfettiAt(e.clientX, e.clientY);
  }
}, true);

// ─── HTML 转义 ───
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}


function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + ' 天前';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}


// ─── 自定义确认弹窗（替代系统 confirm） ───
let confirmCallback = null;

function showConfirm({icon = '⚠️', title = '确认操作', desc = '', okText = '确定', okClass = 'btn-danger', onOk = null}) {
  document.getElementById('confirmIcon').textContent = icon;
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmDesc').innerHTML = desc;
  const okBtn = document.getElementById('confirmOkBtn');
  okBtn.textContent = okText;
  okBtn.className = `btn btn-md ${okClass}`;
  confirmCallback = onOk;
  document.getElementById('confirmOverlay').classList.add('visible');
}

function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('visible');
  confirmCallback = null;
  // 延迟恢复默认结构，避免动画闪烁
  setTimeout(() => {
    const dialog = document.querySelector('#confirmOverlay .confirm-dialog');
    if (dialog && !document.getElementById('confirmIcon')) {
      restoreConfirmDialog();
    }
  }, 300);
}

document.getElementById('confirmOkBtn').addEventListener('click', () => {
  const cb = confirmCallback;
  closeConfirm();
  if (cb) cb();
});

// ─── Reset（使用自定义弹窗） ───
async function resetAllData() {
  showConfirm({
    icon: '🗑️',
    title: '清空所有数据？',
    desc: '画作记录、成长进度、埋点数据将<strong>全部删除</strong>，不可恢复。',
    okText: '确认清空',
    okClass: 'btn-danger',
    onOk: () => {
      // 二次确认
      showConfirm({
        icon: '⚠️',
        title: '最后确认',
        desc: '所有画作和进度都会消失，真的要继续吗？',
        okText: '是的，清空',
        okClass: 'btn-danger',
        onOk: async () => {
          try {
            const res = await fetch(`${API_BASE}/api/reset`, {method: 'POST'});
            const data = await res.json();
            if (data.ok) {
              showConfirm({
                icon: '✅',
                title: '数据已清空',
                desc: '页面即将刷新...',
                okText: '好的',
                okClass: 'btn-primary',
                onOk: () => location.reload()
              });
              // 3 秒后自动刷新
              setTimeout(() => location.reload(), 3000);
            } else {
              showConfirm({
                icon: '❌',
                title: '重置失败',
                desc: data.error || '未知错误',
                okText: '知道了',
                okClass: 'btn-primary'
              });
            }
          } catch(e) {
            showConfirm({
              icon: '❌',
              title: '重置失败',
              desc: '网络错误，请检查服务器是否在运行',
              okText: '知道了',
              okClass: 'btn-primary'
            });
          }
        }
      });
    }
  });
}

// ─── Error ───
function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.classList.add('visible');
  document.getElementById('spinner').classList.remove('active');
}

// ─── 防移动端双击缩放（JS 兜底） ───
// iOS Safari 10+ 忽略 viewport 的 user-scalable=no，双击仍会放大区域。
// 配合 CSS `touch-action: manipulation`，这里对老内核（微信 X5 等）兜底：
// 检测 320ms 内、25px 范围内的两次点击 → 阻止浏览器默认缩放。
let lastTapAt = 0;
let lastTapX = 0;
let lastTapY = 0;
document.addEventListener('touchend', (e) => {
  if (e.touches.length) return; // 多指（捏合）不处理
  const touch = e.changedTouches[0];
  if (!touch) return;
  const now = Date.now();
  const dx = touch.clientX - lastTapX;
  const dy = touch.clientY - lastTapY;
  if (now - lastTapAt < 320 && dx * dx + dy * dy < 2500) {
    e.preventDefault();
    lastTapAt = 0;
  } else {
    lastTapAt = now;
    lastTapX = touch.clientX;
    lastTapY = touch.clientY;
  }
}, { passive: false });

