// ─── State ───
const API_BASE = '';
let records = [];
let currentGlossaryContext = {};  // 当前反馈的术语上下文（反馈增强 v3.1）
let waitingTimer = null;
let currentDrawingSubject = '这次';  // 当前画作主题，用于反思提示文案
let currentRecordId = null;  // 当前反馈的记录 ID，用于保存反思文字

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
  popup.style.top = '';
  popup.classList.add('visible');
  if (achievementTimer) clearTimeout(achievementTimer);
  achievementTimer = setTimeout(() => {
    popup.classList.remove('visible');
    // 延迟重置 top 到完全隐藏位置，等过渡动画完成
    setTimeout(() => { popup.style.top = '-200px'; }, 600);
  }, 4000);
}

// ─── Onboarding Data ───
// v3.1：引导增强 — 情感化文案 + 实时预览 + 按钮状态联动
const OB_STEPS = [
  {
    title: '你好呀，我是小绘',
    sub: '你叫什么名字？这样我能用心称呼你',
    render: (d) => `
      <h2 class="brand-name">你好呀，我是<span class="highlight">小绘</span> 🎨</h2>
      <div class="sub warm">你叫什么名字？这样我能用心称呼你</div>
      <input class="ob-input" id="obName" type="text" placeholder="输入你的名字" value="${d.name || ''}" maxlength="8" autofocus>
      <div class="ob-greeting-preview" id="obPreview"></div>
      <button class="ob-btn primary" id="obNext1" disabled onclick="obNext()">准备好了 →</button>
    `,
    validate: (d) => {
      const name = document.getElementById('obName').value.trim();
      if (name.length > 8) return null;
      return name.length > 0 ? {name} : null;
    },
    onMount: () => {
      const inp = document.getElementById('obName');
      const preview = document.getElementById('obPreview');
      const btn = document.getElementById('obNext1');
      if (inp) {
        inp.focus();
        const updatePreview = () => {
          const name = inp.value.trim();
          if (preview) {
            preview.textContent = name ? `${name}，准备好开始了吗？ ✨` : '';
          }
          if (btn) {
            btn.disabled = !name || name.length > 8;
          }
          if (name.length > 8) {
            inp.classList.add('shake');
            showToast('姓名不能超过 8 个字 😅');
            setTimeout(() => inp.classList.remove('shake'), 600);
          }
        };
        inp.addEventListener('input', updatePreview);
        // 初始触发一次
        updatePreview();
      }
    }
  }
];

// ─── Onboarding State ───
let obStep = 0;
let obData = {name: ''};

// ─── Init ───
document.addEventListener('DOMContentLoaded', () => {
  // 首次进入强制滚动到顶部
  window.scrollTo(0, 0);
  loadProfile();
  loadStats(true);   // 初始化时显示欢迎回来
  loadTimeline();
  loadTodayTheme();
  loadThemeLibrary();
  // 安全兜底：3 秒后强制移除 booting 状态，避免 API 异常时卡在空白页
  setTimeout(() => document.body.classList.remove('booting'), 3000);
  // 注册 Service Worker（PWA）+ 监听更新
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // 监听 SW 更新消息（由 SW postMessage 触发，非 controllerchange）
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'SW_UPDATED') {
          console.log('[SW] 新版本已激活:', event.data.version);
          // 延迟刷新，避免打断当前交互
          setTimeout(() => window.location.reload(), 300);
        }
      });
    }).catch(() => {});
  }
});

// ─── Onboarding ───
function startOnboarding() {
  obStep = 0;
  obData = {name: ''};
  document.getElementById('onboardingOverlay').classList.add('visible');
  document.body.style.overflow = 'hidden';
  renderObStep();
}

function renderObStep() {
  const step = OB_STEPS[obStep];
  document.getElementById('obContent').innerHTML = step.render(obData);
  if (step.onMount) setTimeout(step.onMount, 50);
}

function obSelect(el, field) {
  el.parentElement.querySelectorAll('.ob-option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  obData[field] = el.dataset.value;

  const btn = el.closest('.onboarding').querySelector('.ob-btn');
  if (btn) btn.disabled = false;
}

function obNext() {
  const step = OB_STEPS[obStep];
  const result = step.validate(obData);
  if (!result) return;
  obData = {...obData, ...result};

  // 名字页提前存一下
  if (obStep === 0 && result.name) {
    fetch(`${API_BASE}/api/onboarding`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: result.name})
    }).catch(() => {});
  }

  obStep++;
  if (obStep >= OB_STEPS.length) {
    obComplete();
    return;
  }
  renderObStep();
}

async function obComplete() {
  try {
    await fetch(`${API_BASE}/api/onboarding`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(obData)
    });
  } catch(e) {}

  // 关闭 onboarding
  document.getElementById('onboardingOverlay').classList.remove('visible');
  // 移除 booting 状态
  document.body.classList.remove('booting');

  // 显示过渡仪式
  const ritual = document.getElementById('ritualOverlay');
  const ritualIcon = document.getElementById('ritualIcon');
  const ritualTitle = document.getElementById('ritualTitle');
  const ritualDesc = document.getElementById('ritualDesc');

  if (obData.name) userName = obData.name;
  ritualTitle.textContent = `${userName}，准备好了！`;
  ritualDesc.textContent = '小绘正在为你准备今日主题...';
  ritualIcon.textContent = '🎨';
  ritual.classList.add('visible');

  // 预加载今日主题
  loadTodayTheme();

  // 1.5 秒后关闭仪式，进入首页
  setTimeout(() => {
    ritual.classList.remove('visible');
    document.body.style.overflow = '';

    updateGreeting();

    // 添加首页迎接动画
    document.body.classList.add('welcome-animate');
    // 动画完成后移除 class
    setTimeout(() => document.body.classList.remove('welcome-animate'), 1200);

    // 确保页面从顶部开始（显示 logo）
    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      document.getElementById('page-home').scrollTop = 0;
    });
  }, 1500);
}

// ─── Greeting ───
function updateGreeting() {
  const hour = new Date().getHours();
  let greet;
  if (hour < 6) greet = '夜深了';
  else if (hour < 12) greet = '早上好';
  else if (hour < 14) greet = '中午好';
  else if (hour < 18) greet = '下午好';
  else greet = '晚上好';

  document.getElementById('greetingText').textContent = greet;
  document.getElementById('greetingName').textContent = userName;
}

// ─── Profile ───
let userName = '小伙伴';
let onboardingDone = false;

// ─── 点击用户名修改昵称（自定义弹窗） ───
async function setName() {
  // 构建自定义输入弹窗
  const overlay = document.getElementById('confirmOverlay');
  const dialog = overlay.querySelector('.confirm-dialog');
  dialog.innerHTML = `
    <div class="confirm-icon">✏️</div>
    <div class="confirm-title">修改名字</div>
    <div class="confirm-desc">小绘该怎么称呼你呢？</div>
    <input class="ob-input" id="setNameInput" type="text" placeholder="输入你的名字" value="${userName}" maxlength="8" style="margin-bottom:20px;text-align:center;">
    <div class="confirm-actions">
      <button class="btn btn-md btn-cancel" onclick="closeConfirm()">取消</button>
      <button class="btn btn-md btn-primary" id="setNameOkBtn">保存</button>
    </div>
  `;
  overlay.classList.add('visible');

  const input = document.getElementById('setNameInput');
  input.focus();
  input.select();

  const okBtn = document.getElementById('setNameOkBtn');
  // 输入时检测超长
  input.addEventListener('input', () => {
    if (input.value.trim().length > 8) {
      input.classList.add('shake');
      showToast('姓名不能超过 8 个字 😅');
      setTimeout(() => input.classList.remove('shake'), 600);
    }
  });
  okBtn.onclick = async () => {
    const newName = input.value.trim();
    if (newName.length > 8) {
      input.classList.add('shake');
      showToast('姓名不能超过 8 个字 😅');
      setTimeout(() => input.classList.remove('shake'), 600);
      return;
    }
    if (!newName || newName === userName) {
      closeConfirm();
      // 恢复弹窗结构
      restoreConfirmDialog();
      return;
    }
    try {
      await fetch('/api/profile', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: newName.slice(0, 8)}),
      });
      userName = newName.slice(0, 8);
      updateGreeting();
      loadStats(false);
      closeConfirm();
      restoreConfirmDialog();
    } catch (e) {
      // 显示错误
      dialog.innerHTML = `
        <div class="confirm-icon">❌</div>
        <div class="confirm-title">改名失败</div>
        <div class="confirm-desc">请检查网络后重试</div>
        <div class="confirm-actions">
          <button class="btn btn-md btn-primary" onclick="closeConfirm();restoreConfirmDialog();">知道了</button>
        </div>
      `;
    }
  };
}

// 恢复确认弹窗的默认结构
function restoreConfirmDialog() {
  const overlay = document.getElementById('confirmOverlay');
  const dialog = overlay.querySelector('.confirm-dialog');
  dialog.innerHTML = `
    <div class="confirm-icon" id="confirmIcon">⚠️</div>
    <div class="confirm-title" id="confirmTitle">确认操作</div>
    <div class="confirm-desc" id="confirmDesc"></div>
    <div class="confirm-actions">
      <button class="btn btn-md btn-cancel" onclick="closeConfirm()">取消</button>
      <button class="btn btn-md btn-danger" id="confirmOkBtn">确定</button>
    </div>
  `;
  // 重新绑定确认按钮事件
  document.getElementById('confirmOkBtn').addEventListener('click', () => {
    const cb = confirmCallback;
    closeConfirm();
    if (cb) cb();
  });
}

async function loadProfile() {
  try {
    const res = await fetch(`${API_BASE}/api/profile`);
    const data = await res.json();
    if (data.profile && data.profile.name) {
      userName = data.profile.name;
    }
    const nameEl = document.getElementById('aiName');
    if (nameEl) nameEl.textContent = '小绘';
  } catch(e) {}
  // 移除自动弹出 setName 的定时器 — onboarding 已处理命名
  // 如果是老用户（没做 onboarding 但名字不是默认值），也不用弹
}

// ─── Stats & Onboarding Check ───
// 标记：是否已显示过欢迎回来（页面生命周期内只显示一次）
let welcomeBackShown = false;

async function loadStats(showWelcomeBack = false) {
  let data = null;
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    data = await res.json();
    const el = document.getElementById('streakBadge');

    if (data.profile && data.profile.onboarding_done) {
      onboardingDone = true;
    }

    // 徽章逻辑（确保总是有值，不会消失）
    if (data.streak >= 3) {
      el.textContent = '🔥 坚持了 ' + data.streak + ' 天';
      el.className = 'streak-badge streak-active';
    } else if (data.streak === 2) {
      el.textContent = '🌱 第 2 天';
      el.className = 'streak-badge streak-new';
    } else if (data.streak === 1) {
      el.textContent = '✨ 好的开始！';
      el.className = 'streak-badge streak-new';
    } else if (data.total >= 1) {
      el.textContent = '🎨 已画 ' + data.total + ' 张';
      el.className = 'streak-badge streak-new';
    } else {
      // 没有画作时也显示一个友好的提示，而不是隐藏
      el.textContent = '🌟 开始第一张画';
      el.className = 'streak-badge streak-new';
    }

    updateGreeting();
  } catch (e) {
    console.error('loadStats error:', e);
    // 即使失败也要移除 booting 状态，避免卡在空白页
  }

  // 移除 booting 状态（首页可见）
  document.body.classList.remove('booting');

  // 未完成 onboarding → 立即弹出引导（不延迟）
  if (!onboardingDone) {
    startOnboarding();
    return;
  }

  // 已完成 onboarding → 老用户首页迎接动画 + 欢迎回来页面（仅首次且显式请求）
  if (showWelcomeBack && !welcomeBackShown && onboardingDone) {
    welcomeBackShown = true;
    document.body.classList.add('welcome-animate');
    setTimeout(() => document.body.classList.remove('welcome-animate'), 1200);
    // API 成功用返回数据，失败用本地兜底
    const statsData = data || { total: records.length, streak: 0 };
    showWelcomeBack(statsData);
  }
}

// ─── 欢迎回来独立页面 ───
function showWelcomeBack(statsData) {
  const page = document.getElementById('welcomeBackPage');
  if (!page) return;

  const total = statsData.total || 0;
  const streak = statsData.streak || 0;

  // 根据用户状态选择欢迎语
  let title = `欢迎回来，${userName}`;
  let icon = '🎨';
  if (streak >= 3) {
    title = `${userName}，你已经坚持 ${streak} 天了`;
    icon = '🔥';
  } else if (total >= 10) {
    title = `${userName}，又来画了`;
    icon = '✏️';
  } else if (total >= 1) {
    title = `欢迎回来，${userName}`;
    icon = '🎨';
  } else {
    title = `${userName}，开始你的第一张画吧`;
    icon = '🌟';
  }

  // 鼓励语 / 名人名言池
  const quotes = [
    '「画画不是画所见，而是画所感。」 — 克里姆特',
    '「每一笔都是一次冒险。」 — 毕加索',
    '「我画我所知道的，不是我所看到的。」 — 大卫·霍克尼',
    '「线条是行走的点。」 — 保罗·克利',
    '「画画让人学会真正地看。」 — 金姆·诺布尔',
    '「艺术是谎言，但这谎言让我们认识真理。」 — 毕加索',
    '「先学会规则，然后打破它们。」 — 鲍勃·罗斯',
    '「不需要画得完美，只需要画得真实。」',
    '「每一张画都是和自己的一次对话。」',
    '「画100张烂画，第101张就是好画。」',
    '「今天多画一笔，明天少一分遗憾。」',
    '「手在动，心就静了。」',
  ];
  const quote = quotes[Math.floor(Math.random() * quotes.length)];

  document.getElementById('wbpTitle').textContent = title;
  document.getElementById('wbpQuote').textContent = quote;
  document.getElementById('wbpIcon').textContent = icon;

  // 移除 booting 状态，确保欢迎回来页面可见（它在 #page-home 内部，booting 会隐藏父元素）
  document.body.classList.remove('booting');

  page.classList.add('visible');
  document.body.style.overflow = 'hidden';

  // 3 秒后自动消失（无需点击）
  if (page._autoDismissTimer) clearTimeout(page._autoDismissTimer);
  page._autoDismissTimer = setTimeout(() => {
    dismissWelcomeBack();
  }, 3000);
}

function dismissWelcomeBack() {
  const page = document.getElementById('welcomeBackPage');
  if (!page) return;
  if (page._autoDismissTimer) {
    clearTimeout(page._autoDismissTimer);
    page._autoDismissTimer = null;
  }
  page.classList.add('exiting');
  setTimeout(() => {
    page.classList.remove('visible');
    page.classList.remove('exiting');
    document.body.style.overflow = '';
    // 滚动到顶部
    window.scrollTo(0, 0);
  }, 400);
}

// ─── 今日主题 ───
let currentThemeId = '';

async function loadTodayTheme() {
  try {
    const res = await fetch(`${API_BASE}/api/today-theme`);
    const data = await res.json();
    if (data.theme) {
      updateThemeCard(data.theme);
      currentThemeId = data.theme.id || '';
    }
    // 引导文字始终显示（方便新用户查看拍摄提示）
    const guide = document.getElementById('guideText');
    if (guide) {
      guide.classList.remove('hidden');
    }
  } catch(e) {
    // 静默失败
  }
}

function updateThemeCard(theme) {
  const diffMap = {beginner: 'easy', intermediate: 'mid', advanced: 'hard'};
  const diffLabel = theme.difficulty_label || (theme.difficulty === 'beginner' ? '入门' : theme.difficulty === 'intermediate' ? '进阶' : '挑战');
  const diffClass = diffMap[theme.difficulty] || 'easy';

  const iconEl = document.getElementById('themeTodayIcon');
  const titleEl = document.getElementById('themeTodayTitle');
  const hintEl = document.getElementById('themeTodayHint');
  const tagsEl = document.getElementById('themeTodayTags');

  if (iconEl) iconEl.textContent = theme.icon || '🎨';
  if (titleEl) titleEl.textContent = theme.title || '画你想画的';
  if (hintEl) hintEl.textContent = theme.hint || '随便画就好，小绘不评价好坏';
  if (tagsEl) {
    tagsEl.innerHTML = `<span class="theme-tag ${diffClass}">${diffLabel}</span><span class="theme-tag cat">${theme.category || ''}</span>`;
  }
}

// ─── 主题库（难度分级 + 选择）───
let themeLibrary = [];
let currentThemeTab = 'beginner';

async function loadThemeLibrary() {
  try {
    const res = await fetch(`${API_BASE}/api/themes`);
    const data = await res.json();
    themeLibrary = data.themes || [];
    renderThemeTab('beginner');
  } catch(e) {
    // 静默失败，不影响主流程
  }
}

function switchThemeTab(difficulty) {
  currentThemeTab = difficulty;
  renderThemeTab(difficulty);
  // 更新 Tab 高亮
  document.querySelectorAll('.theme-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.diff === difficulty);
  });
}

function renderThemeTab(difficulty) {
  const themes = themeLibrary.filter(t => t.difficulty === difficulty);
  const container = document.getElementById('themeGrid');
  if (!container) return;

  if (themes.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--color-text-tertiary);padding:20px;font-size:14px;">暂无主题</div>';
    return;
  }

  container.innerHTML = themes.map(t => `
    <div class="theme-pick-card ${t.difficulty}" onclick="selectTheme('${t.id}')">
      <div class="theme-pick-title">${escapeHtml(t.title)}</div>
      <div class="theme-pick-tags">
        <span class="theme-diff-tag ${t.difficulty}">${t.difficulty_label || ''}</span>
        <span class="theme-cat-tag">${escapeHtml(t.category || '')}</span>
      </div>
      <div class="theme-pick-hint">${escapeHtml(t.hint || '')}</div>
    </div>
  `).join('');
}

function selectTheme(themeId) {
  const theme = themeLibrary.find(t => t.id === themeId);
  if (!theme) return;
  updateThemeCard(theme);
  currentThemeId = theme.id || '';

  // 卡片淡入动画
  const card = document.getElementById('themeToday');
  if (card) {
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = 'fadeUp .4s var(--ease-out)';
  }

  // 滚动到顶部今日推荐卡片
  setTimeout(() => {
    const targetY = card ? card.getBoundingClientRect().top + window.pageYOffset - 60 : 0;
    smoothScrollTo(targetY, 500);
  }, 100);

  // 显示轻提示
  showToast(`已切换到「${theme.title}」，点击上方开始画吧`);
}

async function changeTodayTheme() {
  const btn = document.getElementById('themeChangeBtn');
  if (btn) {
    btn.classList.add('spinning');
    setTimeout(() => btn.classList.remove('spinning'), 400);
  }
  try {
    const res = await fetch(`${API_BASE}/api/today-theme?random=true&exclude=${currentThemeId}`);
    const data = await res.json();
    if (data.theme) {
      updateThemeCard(data.theme);
      currentThemeId = data.theme.id || '';
      // 卡片淡入动画
      const card = document.getElementById('themeToday');
      if (card) {
        card.style.animation = 'none';
        void card.offsetWidth;
        card.style.animation = 'fadeUp .4s var(--ease-out)';
      }
    }
  } catch(e) {}
}

// Growth path module removed in v3.0 (Phase 2, hidden for MVP)

// switchPath / masterDetail removed in v3.0 (Phase 2)

// ─── Tab switching ───
function switchTab(tab) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.remove('active'));
  document.getElementById(`page-${tab}`).classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');
  // 切换页面时滚动到顶部
  window.scrollTo(0, 0);
  if (tab === 'timeline') {
    track('timeline_viewed', {});
    renderTimeline();
  } else if (tab === 'community') {
    track('community_viewed', {});
    renderCommunityFeed();
  }
}

// ─── Preview + Notes Flow ───
let pendingFile = null;

// ─── 应用内相机（getUserMedia） ───
let cameraStream = null;
let cameraFacing = 'environment';
let cameraBusy = false;

function openCamera() {
  track('camera_opened', {source: 'creation'});
  // 尝试使用应用内相机
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    startInAppCamera();
  } else {
    // 不支持 getUserMedia，回退到系统相机
    document.getElementById('cameraInput').click();
  }
}

async function startInAppCamera() {
  const overlay = document.getElementById('cameraOverlay');
  const shootView = document.getElementById('cameraShootView');
  const previewView = document.getElementById('cameraPreviewView');
  const errorView = document.getElementById('cameraErrorView');
  const video = document.getElementById('cameraVideo');

  // 重置视图
  shootView.style.display = '';
  previewView.style.display = 'none';
  errorView.style.display = 'none';

  overlay.classList.add('visible');
  document.body.style.overflow = 'hidden';

  try {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacing, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    video.srcObject = cameraStream;
  } catch (err) {
    console.warn('Camera access failed:', err);
    // 显示错误视图，提供回退
    shootView.style.display = 'none';
    errorView.style.display = '';
  }
}

function capturePhoto() {
  if (cameraBusy || !cameraStream) return;
  cameraBusy = true;

  const video = document.getElementById('cameraVideo');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);

  canvas.toBlob(blob => {
    if (!blob) {
      cameraBusy = false;
      return;
    }
    const url = URL.createObjectURL(blob);
    document.getElementById('cameraPreviewImg').src = url;
    // 切换到预览视图
    document.getElementById('cameraShootView').style.display = 'none';
    document.getElementById('cameraPreviewView').style.display = '';
    // 保存 blob 供确认使用
    pendingCameraBlob = blob;
    cameraBusy = false;
  }, 'image/jpeg', 0.92);
}

let pendingCameraBlob = null;

function retakePhoto() {
  // 回到拍摄模式
  document.getElementById('cameraShootView').style.display = '';
  document.getElementById('cameraPreviewView').style.display = 'none';
  pendingCameraBlob = null;
}

function confirmPhoto() {
  if (!pendingCameraBlob) return;
  // 将 blob 转为 File 对象
  const file = new File([pendingCameraBlob], 'camera_photo.jpg', { type: 'image/jpeg' });
  closeCamera();
  showPreview(file);
}

function closeCamera() {
  const overlay = document.getElementById('cameraOverlay');
  overlay.classList.remove('visible');
  document.body.style.overflow = '';
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  pendingCameraBlob = null;
  cameraBusy = false;
}

function switchCamera() {
  cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
  // 重新启动相机
  startInAppCamera();
}

function fallbackToUpload() {
  closeCamera();
  document.getElementById('uploadInput').click();
}

function openUpload() {
  document.getElementById('uploadInput').click();
}

// 已提交图片指纹集（name+size+lastModified），防止重复上传
const uploadedFileFingerprints = new Set();

function fileFingerprint(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function handleFileSelect(e) {
  if (!e.target.files.length) return;
  const file = e.target.files[0];
  const fp = fileFingerprint(file);
  if (uploadedFileFingerprints.has(fp)) {
    showToast('这张图已经上传过了 📸');
    e.target.value = '';
    return;
  }
  showPreview(file);
}

// 相册上传才检查重复（相机每次拍的都是新照片，不拦截）
document.getElementById('uploadInput').addEventListener('change', handleFileSelect);
// 相机拍照直接放行
document.getElementById('cameraInput').addEventListener('change', e => {
  if (e.target.files.length) showPreview(e.target.files[0]);
});

function resetPreviewUI() {
  const actions = document.querySelector('.preview-confirm-actions');
  if (actions) actions.style.display = 'flex';
  const tag = document.querySelector('.preview-confirm-tag');
  if (tag) tag.textContent = '✓ 拍到了';
  const hint = document.querySelector('.preview-confirm-hint');
  if (hint) hint.textContent = '确认提交后，小绘会仔细看看这幅画';
}

function showPreview(file) {
  resetPreviewUI();
  pendingFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('previewImg').src = e.target.result;
    document.getElementById('previewSection').classList.remove('hidden');
    document.getElementById('previewSection').scrollIntoView({ behavior: 'smooth' });
  };
  reader.readAsDataURL(file);
}

function cancelPreview() {
  pendingFile = null;
  document.getElementById('previewSection').classList.add('hidden');
  document.getElementById('cameraInput').value = '';
  document.getElementById('uploadInput').value = '';
}

function submitDrawing() {
  if (!pendingFile) return;

  // 记录已提交指纹，下次选同一张图会提示已上传
  const fp = fileFingerprint(pendingFile);
  uploadedFileFingerprints.add(fp);

  // 预览区不隐藏也不跳全屏——照片保持在原位
  document.querySelector('.preview-confirm-actions').style.display = 'none';
  document.querySelector('.preview-confirm-tag').textContent = '🔍 分析中';
  document.querySelector('.preview-confirm-hint').textContent = 'AI 正在看你的画...';

  // 为保存/分享功能保留图片数据（保持隐藏）
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('submittedPhotoImg').src = e.target.result;
  };
  reader.readAsDataURL(pendingFile);

  uploadImage(pendingFile);
}

// ─── 客户端图片压缩 ───
function compressImage(file, maxWidth = 1200, quality = 0.8) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
          } else {
            resolve(file); // 压缩失败则用原图
          }
        }, 'image/jpeg', quality);
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

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
        } else if (data.type === 'error') {
          stopSimpleWaiting();
          showError(data.message || '分析失败');
          return;
        }
      }
    }

    // 流结束 → 处理 complete 事件
    if (receivedLayers.length > 0) {
      if (completeData) {
        try {
          finalizeStreamingFeedback(completeData, receivedLayers);
        } catch (e) {
          console.error('finalizeStreamingFeedback error:', e);
          ensurePostFeedbackUI(completeData.record);
        }
        try { await loadStats(false); } catch (e) {}   // 上传后静默刷新，不显示欢迎回来
        try { await loadTimeline(); } catch (e) {}
        try { await loadTodayTheme(); } catch (e) {}
      }
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
    }, 1000);
  } catch (e) {
    console.error('ensurePostFeedbackUI error:', e);
  }
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
  // loading 内容由后续 first_impression 或 layer 替换，此处只需清除
  document.getElementById('fbLayersContainer').innerHTML = '';
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
    {icon: '📸', cls: 'i-primary', title: '再画一张', desc: '有了新想法，再来一张', action: 'openCamera()'},
    {icon: '📖', cls: 'i-green', title: '查看记录', desc: '回顾一下绘画旅程', action: "switchTab('timeline')"},
    {icon: '🌍', cls: 'i-orange', title: '分享到社区', desc: '让大家看到你的画', action: `shareToCommunity('${rid}')`},
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
            if (data.type === 'done') return;
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

// ─── HTML 转义 ───
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ─── Timeline ───
async function loadTimeline() {
  try {
    const res = await fetch(`${API_BASE}/api/timeline`);
    const data = await res.json();
    records = data.records || [];
    updateHomepage();
    const active = document.querySelector('.page.active');
    if (active) {
      const id = active.id.replace('page-', '');
      if (id === 'timeline') renderTimeline();
    }
  } catch (e) {}
}

function updateHomepage() {
  // 引导文字始终显示（方便新用户查看拍摄提示）
  const guide = document.getElementById('guideText');
  if (guide) {
    guide.classList.remove('hidden');
  }
}

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
          ${post.theme ? `<div style="font-size:13px;color:var(--color-text-secondary);margin-bottom:8px;">主题：${escapeHtml(post.theme)}</div>` : ''}
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
              ${comments.length > 0 ? comments.map(c => `
                <div class="community-comment-item">
                  <div class="community-comment-author">${escapeHtml(c.author || '小伙伴')}</div>
                  <div class="community-comment-content">${escapeHtml(c.content)}</div>
                  <div class="community-comment-time">${formatDate(c.timestamp)}</div>
                </div>
              `).join('') : '<div class="community-comment-empty">还没有评论，来说两句吧~</div>'}
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

function shareCurrentRecord() {
  if (!currentRecordId) return;
  shareToCommunity(currentRecordId);
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

// ─── 记录页增强：搜索 + 视图切换 ───
let timelineSearchQuery = '';
let timelineGroupMode = 'grid'; // 'grid' | 'list'

function renderTimeline() {
  const list = document.getElementById('timelineList');

  if (!records || records.length === 0) {
    list.innerHTML = `
      <div class="card" style="margin-top: 24px;">
        <div class="empty-state">
          <div class="empty-icon">🎨</div>
          <div class="empty-title">还没有画作</div>
          <div class="empty-desc">画完第一张上传吧，小绘会<br>看着你的进步陪你走下去。</div>
          <button class="btn btn-primary btn-md" onclick="switchTab('home')">📸 开始画</button>
        </div>
      </div>`;
    return;
  }

  // 搜索栏 + 视图切换
  let toolbarHtml = `
    <div class="tl-toolbar">
      <input class="tl-search" type="text" placeholder="🔍 搜索画作反馈..." value="${escapeHtml(timelineSearchQuery)}"
        oninput="onTimelineSearch(this.value)">
      <div class="tl-group-toggle">
        <button class="tl-group-btn ${timelineGroupMode === 'grid' ? 'active' : ''}" onclick="setTimelineGroup('grid')">平铺</button>
        <button class="tl-group-btn ${timelineGroupMode === 'list' ? 'active' : ''}" onclick="setTimelineGroup('list')">时间线</button>
      </div>
    </div>`;

  // 过滤
  let filtered = [...records].reverse();
  if (timelineSearchQuery.trim()) {
    const q = timelineSearchQuery.toLowerCase();
    filtered = filtered.filter(r =>
      (r.feedback || '').toLowerCase().includes(q)
    );
  }

  if (filtered.length === 0) {
    list.innerHTML = toolbarHtml + `
      <div class="card" style="margin-top:16px;text-align:center;padding:30px;">
        <div style="font-size:14px;color:var(--color-text-tertiary);">没有找到匹配的画作</div>
      </div>`;
    return;
  }

  if (timelineGroupMode === 'list') {
    // 时间线模式 — 按日期分组，56×56 缩略图 + 反馈摘要
    const grouped = groupRecordsByDate(filtered);
    let html = toolbarHtml;
    for (const [dateLabel, items] of Object.entries(grouped)) {
      html += `<div class="tl-date-group"><div class="tl-date-header">${dateLabel}</div>`;
      html += items.map(r => {
        const recordIndex = records.indexOf(r);
        return renderTimelineListItem(r, recordIndex);
      }).join('');
      html += '</div>';
    }
    list.innerHTML = html;
  } else {
    // 平铺模式 — 3 列图片网格
    list.innerHTML = toolbarHtml + '<div class="tl-grid">' + filtered.map(r => {
      const recordIndex = records.indexOf(r);
      return renderTimelineItem(r, recordIndex);
    }).join('') + '</div>';
  }
}

// 按日期分组记录
function groupRecordsByDate(filteredRecords) {
  const groups = {};
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const r of filteredRecords) {
    let label;
    try {
      const d = new Date(r.timestamp);
      const dDate = new Date(d);
      dDate.setHours(0, 0, 0, 0);
      if (dDate.getTime() === today.getTime()) {
        label = '今天';
      } else if (dDate.getTime() === yesterday.getTime()) {
        label = '昨天';
      } else {
        label = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
      }
    } catch(e) {
      label = '未知日期';
    }
    if (!groups[label]) groups[label] = [];
    groups[label].push(r);
  }
  return groups;
}

function renderTimelineItem(r, recordIndex) {
  const safeIdx = recordIndex >= 0 ? recordIndex : 0;
  return `
    <div class="tl-grid-item" onclick="openModal(records[${safeIdx}])">
      <img src="${API_BASE}/data/${r.image}" alt="画作" loading="lazy">
    </div>`;
}

function renderTimelineListItem(r, recordIndex) {
  const safeIdx = recordIndex >= 0 ? recordIndex : 0;
  return `
    <div class="timeline-item" onclick="openModal(records[${safeIdx}])" style="cursor:pointer;">
      <div class="thumb"><img src="${API_BASE}/data/${r.image}" alt="第${records.length - safeIdx}张"></div>
      <div class="info">
        <div class="preview">${(r.feedback || '').replace(/\n/g, ' · ').slice(0, 80)}</div>
        <div class="time">第 ${records.length - safeIdx} 张 · ${formatTime(r.timestamp)}</div>
      </div>
    </div>`;
}

function onTimelineSearch(query) {
  timelineSearchQuery = query;
  renderTimeline();
  // 保持焦点
  setTimeout(() => {
    const input = document.querySelector('.tl-search');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, 0);
}

function setTimelineGroup(mode) {
  timelineGroupMode = mode;
  renderTimeline();
}

// ─── 构图引导 ───
function showCompositionGuide() {
  let overlay = document.getElementById('compositionOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'compositionOverlay';
    overlay.className = 'composition-overlay';
    overlay.innerHTML = `
      <div class="comp-card">
        <div class="comp-title">📸 拍照构图小贴士</div>
        <div class="comp-grid-demo">
          <div class="comp-grid-lines">
            <div class="comp-h-line" style="top:33.3%"></div>
            <div class="comp-h-line" style="top:66.6%"></div>
            <div class="comp-v-line" style="left:33.3%"></div>
            <div class="comp-v-line" style="left:66.6%"></div>
            <div class="comp-dot" style="top:33.3%;left:33.3%"></div>
            <div class="comp-dot" style="top:33.3%;left:66.6%"></div>
            <div class="comp-dot" style="top:66.6%;left:33.3%"></div>
            <div class="comp-dot" style="top:66.6%;left:66.6%"></div>
          </div>
        </div>
        <div class="comp-tips">
          <div>• 把画纸放在四个交叉点附近，不要偏到一边</div>
          <div>• 手机从正上方平行对准纸面，避免透视变形</div>
          <div>• 光线充足，不要让手或影子挡住画面</div>
          <div>• 画作尽量占满取景框</div>
        </div>
        <button class="btn btn-primary btn-md" style="width:100%;" onclick="closeCompositionGuide()">明白了，去拍照</button>
      </div>`;
    document.body.appendChild(overlay);
  }
  overlay.classList.add('visible');
}

function closeCompositionGuide() {
  const overlay = document.getElementById('compositionOverlay');
  if (overlay) overlay.classList.remove('visible');
}

// ─── Glossary ───
const GLOSSARY = {
  '灰面/中间调': ' 亮面和暗面之间的过渡区域，像"傍晚的天色"',
  '饱和度/纯度': ' 颜色有多"正"，越鲜艳饱和度越高，越灰越低',
  '明暗交界线': ' 物体亮面和暗面交接的那条暗带，不是细线',
  '三角形构图': ' 画面主体形成三角形的稳定结构',
  '五大调子': ' 高光、灰面、明暗交界线、反光、投影，五个亮度层次',
  '虚实边界': ' 有些地方边缘清楚（实），有些地方模糊（虚）',
  '一点透视': ' 所有横线都往一个消失点跑，正对物体的感觉',
  '两点透视': ' 横线往左一个点跑、往右一个点跑，像站在街角看',
  '三点透视': ' 除了左右，竖线也往天上或地下跑，像仰视高楼',
  '鱼眼透视': ' 线条往中间弯，像透过玻璃球看世界',
  '空气透视': ' 远处的物体颜色偏灰偏蓝，像被空气挡住',
  '视觉中心': ' 观众第一眼看到的地方，通常是画面最重要的位置',
  '黄金分割': ' 约等于三分法，比例大约是 1:1.618',
  '三庭五眼': ' 脸长分三等份（发际到眉、眉到鼻底、鼻底到下巴），脸宽约五只眼宽',
  '肌肉走向': ' 肌肉生长的方向，画线条要顺着这个方向',
  '手部比例': ' 手的长度约等于脸长，手掌和手指各占一半',
  '脚部简化': ' 把脚看成梯形+三角形的组合，不要一开始就画脚趾',
  '面部朝向': ' 脸是正面、侧面还是四分之三侧，决定五官怎么排',
  '颈肩关系': ' 脖子不是直直插在肩膀上的，有斜方肌的过渡',
  '四肢比例': ' 手臂下垂时肘关节在腰附近，腕关节在大腿根附近',
  '轮廓线': ' 物体最外圈的那根线，像剪影的边缘',
  '辅助线': ' 用来帮助定位的线，画完通常会擦掉',
  '结构线': ' 表现物体内部结构的线，比如杯子的圆柱轴线',
  '疏密线': ' 线条有疏有密，密的地方暗，疏的地方亮',
  '轻重线': ' 线条有粗有细、有深有浅，重线压下去，轻线提起来',
  '黑白灰': ' 画面中最亮、中间、最暗三个大色调',
  '互补色': ' 色环上面对面的颜色，红绿、蓝橙、黄紫',
  '类似色': ' 色环上挨着的颜色，红黄橙、蓝绿青',
  '对比色': ' 差别很大的颜色放一起，视觉冲击力很强',
  '环境色': ' 周围物体反射到你画的对象上的颜色',
  '固有色': ' 物体本身的颜色，比如香蕉是黄的',
  '光源色': ' 照在物体上的光本身带的颜色，比如夕阳是橙红的',
  '透明感': ' 颜色薄而透，能看到底下的纸或底色',
  '消失点': ' 线条向远方延伸，最后在视线高度交汇的那个点',
  '视平线': ' 和你眼睛一样高的那条水平线，所有消失点都在上面',
  '三分法': ' 画面横竖各分三等份，重要的东西放在交叉点上',
  '对角线': ' 从左下角到右上角（或反过来）的斜线，让画面有动感',
  '框架式': ' 用门窗、树枝等把主体"框"在中间，像画框里套画',
  '引导线': ' 画面中的线条指向主体，把观众视线带过去',
  '正负形': ' 主体是"正形"，主体以外的空白形状是"负形"',
  '头身比': ' 身高是头长的几倍，动漫常 7-9 头身，真人约 7.5',
  '动态线': ' 一条想象中的线，从头顶贯穿全身，抓住人物动作的核心',
  '骨骼点': ' 皮肤下面能摸到的骨头凸起，比如锁骨、膝盖骨、肘尖',
  '眉眼距': ' 眉毛到眼睛的距离，太大像惊讶，太小像皱眉',
  '鼻唇距': ' 鼻子底部到上嘴唇的距离，影响年龄感',
  '下颌角': ' 下巴两侧的拐角，方脸拐角低，尖脸拐角高',
  '指关节': ' 手指能弯曲的地方，三个关节把手指分成四段',
  '干画法': ' 颜料或铅笔干燥地画，笔触清晰，适合细节',
  '湿画法': ' 颜料加水画，颜色互相渗开，适合渐变',
  '排线': ' 用一组平行线填充面积或表现明暗，线越密颜色越深',
  '勾线': ' 用一条连续的线勾出物体轮廓，讲究干净利落',
  '运笔': ' 你拿笔的方式和笔在纸上移动的动作',
  '笔触': ' 笔尖留在纸上的痕迹，能看出你怎么画的',
  '断线': ' 画到一半停下来的线，速写里很常见',
  '长线': ' 一笔画出的长距离线条，用来抓大形',
  '短线': ' 短促的线条，用来排明暗或画细节',
  '弧线': ' 弯曲的线，画圆形物体时离不开它',
  '折线': ' 有棱有角的线，像画立方体边缘',
  '曲线': ' 流畅柔软的画线，和弧线差不多但更自由',
  '直线': ' 不弯的线，听起来简单其实最难画准',
  '切线': ' 用短直线去"切"出圆形或弧形的轮廓',
  '复线': ' 好几条线叠在一起画，速写里用来找形',
  '高光': ' 物体上最亮的那个点，光直接反射进你眼睛的地方',
  '反光': ' 暗部里悄悄亮起来的地方，是周围光线反射上去的',
  '投影': ' 物体挡住光后在地上留下的影子，让物体"落地"',
  '亮面': ' 被光直接照到的部分，物体最亮的区域',
  '暗面': ' 背对光源的那一面，但不要画成死黑',
  '黑度': ' 你画面里最暗的地方够不够暗',
  '明度': ' 一个颜色有多亮或多暗，大白话就是"亮度"',
  '暗部': ' 画面里所有偏暗的区域统称',
  '亮部': ' 画面里所有偏亮的区域统称',
  '硬边': ' 明暗交界很锐利，像刀切的一样',
  '软边': ' 明暗过渡很柔和，像晕开的一样',
  '色相': ' 颜色的名字，红橙黄绿青蓝紫，这叫色相',
  '冷暖': ' 颜色给人的温度感，红橙暖、蓝绿冷',
  '色调': ' 整张画的颜色倾向，偏暖、偏冷、偏灰',
  '色温': ' 颜色的冷暖程度，和色调差不多意思',
  '色块': ' 一块一块的颜色，像拼图一样拼成画面',
  '叠色': ' 一层颜色盖在另一层上，透出底下的颜色',
  '混色': ' 两种颜色混在一起，调出新的颜色',
  '厚涂': ' 颜料堆得很厚，能看出笔触和肌理',
  '薄涂': ' 颜料薄薄一层，像水彩那样透',
  '灰度': ' 去掉颜色只看明暗，从白到黑的阶梯',
  '色阶': ' 颜色从深到浅的层次，像楼梯一样',
  '仰视': ' 从下往上看，物体的底面看得到，顶面看不到',
  '俯视': ' 从上往下看，物体的顶面看得到，底面看不到',
  '平视': ' 和你眼睛一样高看过去，最舒服自然的角度',
  '缩短': ' 物体离你近的一头大、远的一头小，长度被"压缩"',
  '重叠': ' 一个物体挡在另一个前面，这是最简单的空间感',
  '对称': ' 左右两边差不多一样，给人稳定、庄重的感觉',
  '平衡': ' 左边重右边轻就加个小东西补一下，整体不歪',
  '留白': ' 画面故意不画满，空白也是一种"内容"',
  '裁切': ' 画面边缘切掉一部分，让主体更突出',
  '节奏': ' 画面元素有规律地重复或变化，像音乐的节拍',
  '重复': ' 同样的形状或颜色在画面中出现多次，形成统一感',
  '重心': ' 身体重量的支撑点，站立时通常在两脚之间',
  '体块': ' 把人体想成几个积木（头、胸、骨盆、四肢），先搭积木再细化',
  '转折': ' 身体从朝前变成朝侧面的那个"拐角"，比如肩膀到手臂',
  '关节': ' 手臂和腿都能弯曲的地方：肩、肘、腕、髋、膝、踝',
  '光滑': ' 表面平整，反光强烈且集中，比如玻璃、金属',
  '粗糙': ' 表面不平，反光是散的，比如石头、树皮',
  '柔软': ' 边缘柔和、起伏平缓，像布料、棉花',
  '坚硬': ' 边缘锐利、棱角分明，像石头、金属',
  '透明': ' 能看透的，比如玻璃杯、水、冰块',
  '反射': ' 光滑表面上能看到周围物体的倒影',
  '纹理': ' 物体表面的花纹，木纹、布纹、皮肤毛孔都算',
  '哑光': ' 不反光的表面，像水泥墙、未上釉的陶罐',
  '光泽': ' 表面有柔和的光亮，像皮肤、绸缎',
  '触感': ' 画面让人看了觉得"摸起来应该是什么感觉"',
  '擦笔': ' 用纸巾或擦笔把画好的线条揉开，制造柔和效果',
  '揉擦': ' 用手指或工具把色调抹匀，过渡更自然',
  '刮刀': ' 用油画刀刮颜料，制造肌理或去除多余颜色',
  '弹笔': ' 用笔弹洒颜料，制造星星点点的纹理',
  '点画': ' 用点组成画面，像修拉那样，近看是点远看是形',
  '平涂': ' 一块颜色均匀地平铺，没有渐变',
  '渐变': ' 颜色从深到浅或从一种色到另一种色慢慢过渡',
  '晕染': ' 边缘用水或干笔揉开，像水墨画那样自然扩散',
  '罩染': ' 薄薄一层透明色盖在底色上，让颜色变深变丰富',
  '提亮': ' 在暗部或中间调上加浅色，让那部分"亮起来"',
  '加深': ' 在亮部或中间调上加重色，增加立体感',
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\$&');
}

function enrichText(text) {
  let result = escapeHtml(text);

  // Step 1: Handle markdown bold **text** (从 LLM 输出的 **重点** 转为 strong 标签)
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Step 2: Handle glossary terms (绘画术语 → 深蓝可点击)
  const terms = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);
  for (const term of terms) {
    const safeTerm = escapeRegex(term);
    const regex = new RegExp(`(${safeTerm})`, 'g');
    result = result.replace(regex, `<span class="glossary-term" onclick="showGlossaryTip(event,'${escapeRegex(term)}')">$1</span>`);
  }

  return result.replace(/\n/g, '<br>');
}

function showGlossaryTip(event, term) {
  event.stopPropagation();
  const existing = document.querySelector('.glossary-tip.visible');
  if (existing) existing.classList.remove('visible');

  let tip = document.getElementById('glossaryTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'glossaryTip';
    tip.className = 'glossary-tip';
    tip.onclick = () => tip.classList.remove('visible');
    document.body.appendChild(tip);
  }

  // 基础定义
  let html = `<span class="tip-word">${term}</span>${GLOSSARY[term] || '暂无解释'}`;

  // 画作关联语境（增强版）
  const ctx = window.currentGlossaryContext || {};
  const contextLine = ctx[term];
  if (contextLine) {
    html += `<div class="tip-context visible">
      <span class="ctx-label">🎯 在你这幅画里：</span>${contextLine}
    </div>`;
  }

  tip.innerHTML = html;
  tip.classList.add('visible');

  const rect = event.target.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - 130;
  let top = rect.bottom + 8;
  if (left < 10) left = 10;
  if (top + 200 > window.innerHeight) top = rect.top - 140;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.glossary-term')) {
    const tip = document.getElementById('glossaryTip');
    if (tip) tip.classList.remove('visible');
  }
});

// ─── Calendar ───
let calYear, calMonth;

function renderCalendar() {
  const now = new Date();
  calYear = calYear || now.getFullYear();
  calMonth = calMonth !== undefined ? calMonth : now.getMonth();

  document.getElementById('calTitle').textContent = `${calYear} 年 ${calMonth + 1} 月`;
  document.getElementById('calPrev').onclick = () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); };
  document.getElementById('calNext').onclick = () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); };

  const drawDates = new Set();
  const dayRecords = {};
  for (const r of records) {
    try {
      const d = new Date(r.timestamp);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      drawDates.add(key);
      if (!dayRecords[key]) dayRecords[key] = [];
      dayRecords[key].push(r);
    } catch(e) {}
  }

  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const today = new Date();
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;

  let html = '<div class="cal-grid">';
  html += weekdays.map(w => `<div class="cal-weekday">${w}</div>`).join('');

  const prevMonthDays = new Date(calYear, calMonth, 0).getDate();
  for (let i = firstDay - 1; i >= 0; i--) {
    html += `<div class="cal-day other-month">${prevMonthDays - i}</div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${calYear}-${calMonth}-${d}`;
    const isToday = key === todayKey;
    const hasDrawing = drawDates.has(key);
    let cls = 'cal-day';
    if (hasDrawing) cls += ' has-drawing';
    if (isToday) cls += ' today';
    html += `<div class="${cls}" onclick="showCalDay('${key}')">${d}${hasDrawing ? '<span class="cal-dot"></span>' : ''}</div>`;
  }

  const totalCells = firstDay + daysInMonth;
  const remaining = (7 - totalCells % 7) % 7;
  for (let d = 1; d <= remaining; d++) {
    html += `<div class="cal-day other-month">${d}</div>`;
  }

  html += '</div>';
  document.getElementById('calendarGrid').innerHTML = html;
  document.getElementById('calDayDetail').classList.remove('visible');
}

function showCalDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  const detail = document.getElementById('calDayDetail');
  const title = document.getElementById('calDayTitle');
  const list = document.getElementById('calDayDrawings');

  title.textContent = `${y} 年 ${m + 1} 月 ${d} 日`;

  const dayItems = records.filter(r => {
    try {
      const rd = new Date(r.timestamp);
      return rd.getFullYear() === y && rd.getMonth() === m && rd.getDate() === d;
    } catch(e) { return false; }
  });

  if (dayItems.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:#aaa;padding:20px;font-size:14px;">这天没有画作记录</div>';
  } else {
    list.innerHTML = dayItems.map(r => {
      const idx = records.findIndex(x => x.id === r.id);
      return `
        <div class="cal-day-detail-item" onclick="openModal(records[${idx >= 0 ? idx : 0}])">
          <div class="thumb"><img src="${API_BASE}/data/${r.image}" alt=""></div>
          <div class="preview">${r.feedback ? r.feedback.replace(/\n/g,' · ').slice(0,60) : '无反馈'}</div>
        </div>`;
    }).join('');
  }

  detail.classList.add('visible');
}

// renderGrowth / drawRadarChart removed in v3.0 (growth page hidden for MVP)
// ─── Modal ───
function openModal(record) {
  const modal = document.getElementById('modal');
  document.getElementById('modalImg').src = `${API_BASE}/data/${record.image}`;
  currentRecordId = record.id;  // 保存当前记录 ID，用于删除

  // 查找记录索引（用于显示"第 N 张"）
  const recordIndex = records.findIndex(r => r.id === record.id);
  const drawingNum = recordIndex >= 0 ? records.length - recordIndex : '';

  // 构建头部信息
  const headerEl = document.getElementById('modalHeader');
  if (headerEl) {
    let headerHtml = '';
    if (drawingNum) {
      headerHtml += `<span class="modal-badge">第 ${drawingNum} 张</span>`;
    }
    headerHtml += `<span class="modal-date">${formatTime(record.timestamp)}</span>`;
    headerEl.innerHTML = headerHtml;
  }

  // 构建反馈内容 — 优先使用 5 层结构，否则按段落格式化
  const feedbackEl = document.getElementById('modalFeedback');
  if (record.feedback_json && record.feedback_json.layers && record.feedback_json.layers.length >= 4) {
    // 时空穿梭风格：精致分层标签
    const LAYER_LABELS = {identify: '认出', observe: '观察', progress: '进步', suggestion: '建议', encourage: '期待'};
    const LAYER_COLORS = {identify: 'rec', observe: 'obs', progress: 'prog', suggestion: 'sugg', encourage: 'enc'};
    let html = '<div class="tt-ai-section">';
    html += '<div class="tt-ai-header"><span class="tt-ai-avatar">🤖</span><span class="tt-ai-name">小绘 · 当时的反馈</span></div>';
    for (const layer of record.feedback_json.layers) {
      const type = layer.type;
      const color = LAYER_COLORS[type] || '';
      const label = LAYER_LABELS[type] || type;
      html += `<div class="tt-ai-layer"><span class="tt-ai-tag ${color}">${label}</span>${enrichText(layer.content)}</div>`;
      if (type === 'suggestion' && layer.tip && layer.tip.trim()) {
        html += `<div class="tt-ai-tip">💡 ${enrichText(layer.tip)}</div>`;
      }
    }
    html += '</div>';
    feedbackEl.innerHTML = html;
  } else {
    // 普通版：按段落格式化
    const lines = (record.feedback || '').split('\n').filter(l => l.trim());
    let html = '<div class="tt-ai-section">';
    html += '<div class="tt-ai-header"><span class="tt-ai-avatar">🤖</span><span class="tt-ai-name">小绘 · 当时的反馈</span></div>';
    lines.forEach(line => {
      const cleanLine = line.trim().replace(/^[\d]+[)）.、:：]?\s*/, '');
      if (!cleanLine) return;
      html += `<div class="tt-ai-layer">${enrichText(cleanLine)}</div>`;
    });
    html += '</div>';
    feedbackEl.innerHTML = html || '<p style="color:var(--color-text-tertiary);">暂无反馈</p>';
  }

  // 里程碑（如果有）
  const milestoneEl = document.getElementById('modalMilestone');
  if (milestoneEl) {
    if (record.milestone) {
      const m = record.milestone;
      const mClass = `milestone-icon ${m.number <= 50 ? 'm' + m.number : 'm50'}`;
      const cardClass = `milestone-card ${m.number <= 50 ? 'm' + m.number : 'm50'}`;
      milestoneEl.innerHTML = `
        <div class="${cardClass}">
          <div class="${mClass}">${m.icon}</div>
          <div class="milestone-body">
            <div class="milestone-title">${escapeHtml(m.title)}</div>
            <div class="milestone-desc">${escapeHtml(m.message)}</div>
          </div>
        </div>`;
      milestoneEl.style.display = 'block';
    } else {
      milestoneEl.innerHTML = '';
      milestoneEl.style.display = 'none';
    }
  }

  // 时空穿梭：展示用户当时写下的反思文字
  const reflectionEl = document.getElementById('modalReflection');
  if (reflectionEl) {
    const reflection = getReflection(record.id);
    if (reflection && reflection.text) {
      const timeAgo = getTimeAgo(reflection.timestamp);
      reflectionEl.innerHTML = `
        <div class="modal-reflection-block">
          <div class="modal-reflection-label">✍️ 你当时写道</div>
          <div class="modal-reflection-text">${escapeHtml(reflection.text)}</div>
          <div class="modal-reflection-meta">— ${timeAgo}写下的</div>
        </div>`;
      reflectionEl.style.display = 'block';
      // 高亮脉冲动画
      reflectionEl.classList.add('pulse-highlight');
      setTimeout(() => reflectionEl.classList.remove('pulse-highlight'), 2000);
    } else {
      // 空态：引导用户下次写感受
      reflectionEl.innerHTML = `
        <div class="modal-reflection-empty">
          <div class="modal-reflection-empty-text">那天你没有留下文字</div>
          <div class="modal-reflection-empty-hint">下次画完试试写两句？</div>
        </div>`;
      reflectionEl.style.display = 'block';
    }
  }

  // "现在的你看" 区块 — AI 回顾性对比
  const nowReviewEl = document.getElementById('modalNowReview');
  if (nowReviewEl) {
    const recordIndex = records.findIndex(r => r.id === record.id);
    const totalDrawings = records.length;
    const drawingNum = recordIndex >= 0 ? records.length - recordIndex : 1;
    const timeAgo = getTimeAgo(record.timestamp);

    // 生成回顾性文字
    let reviewText = '';
    if (drawingNum === 1) {
      reviewText = `这是你的第一张画。一切的起点，都从这一笔开始。`;
    } else if (drawingNum < 7) {
      reviewText = `这是你第 ${drawingNum} 张画。${timeAgo}你还在摸索，现在你已经画了 ${totalDrawings} 张了。`;
    } else if (drawingNum < 30) {
      reviewText = `这是你第 ${drawingNum} 张画。${timeAgo}画下的这一笔，是你成长路上的一块基石。到现在你已经画了 ${totalDrawings} 张。`;
    } else {
      reviewText = `这是你第 ${drawingNum} 张画。回看${timeAgo}的这幅画，你能看到自己走过的路。${totalDrawings} 张画，每一张都算数。`;
    }

    nowReviewEl.innerHTML = `
      <div class="modal-now-review-block">
        <div class="modal-now-review-label">🕰️ 现在的你看</div>
        <div class="modal-now-review-text">${escapeHtml(reviewText)}</div>
      </div>`;
    nowReviewEl.style.display = 'block';
  }

  modal.classList.add('visible');
  // 禁止底层页面滚动，防止穿透
  document.body.style.overflow = 'hidden';

  // 记录详情滚动收缩：用户向下滑动文字区时，图片缩小到 3:7 比例
  const modalInfo = modal.querySelector('.modal-info');
  if (modalInfo) {
    modalInfo.scrollTop = 0;
    modalInfo.style.overscrollBehavior = 'contain';
    const handleModalScroll = () => {
      if (modalInfo.scrollTop > 30) {
        modal.querySelector('.modal').classList.add('img-collapsed');
      } else {
        modal.querySelector('.modal').classList.remove('img-collapsed');
      }
    };
    modalInfo.addEventListener('scroll', handleModalScroll, { passive: true });
    // 存储引用以便关闭时移除
    modal._scrollHandler = handleModalScroll;
    modal._scrollTarget = modalInfo;
  }
}

function closeModal() {
  const modal = document.getElementById('modal');
  // 移除滚动监听
  if (modal._scrollHandler && modal._scrollTarget) {
    modal._scrollTarget.removeEventListener('scroll', modal._scrollHandler);
    modal._scrollHandler = null;
    modal._scrollTarget = null;
  }
  // 重置图片收缩状态
  const modalInner = modal.querySelector('.modal');
  if (modalInner) modalInner.classList.remove('img-collapsed');
  modal.classList.remove('visible');
  // 恢复底层页面滚动
  document.body.style.overflow = '';
}

function confirmDeleteRecord() {
  if (!currentRecordId) return;
  showConfirm({
    icon: '🗑️',
    title: '删除画作',
    desc: '删除后无法恢复，确定要删除这张画吗？',
    okText: '删除',
    okClass: 'btn-danger',
    onOk: async () => {
      try {
        const res = await fetch(`${API_BASE}/api/record/${currentRecordId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          showToast('已删除', 'success');
          closeModal();
          await loadTimeline();
          await loadStats(false);
        } else {
          showToast(data.error || '删除失败', 'error');
        }
      } catch (e) {
        showToast('网络错误', 'error');
      }
    }
  });
}

// ── 点击遮罩关闭弹窗（事件委托，避免 inline onclick 在移动端失效）──
document.addEventListener('DOMContentLoaded', function() {
  const overlay = document.getElementById('modal');
  if (overlay) {
    overlay.addEventListener('click', function(e) {
      // 仅当点击的是遮罩本身（非内部 .modal）时关闭
      if (e.target === overlay) {
        closeModal();
      }
    });
    // 移动端 touch 也支持
    overlay.addEventListener('touchstart', function(e) {
      if (e.target === overlay) {
        closeModal();
      }
    }, { passive: true });
  }
});

function formatTime(ts) {
  try {
    const d = new Date(ts);
    return `${d.getMonth()+1}月${d.getDate()}日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  } catch(e) {
    return ts;
  }
}

// ─── 保存照片 ───
function savePhoto() {
  const photoSrc = document.getElementById('submittedPhotoImg').src;
  if (!photoSrc) {
    showError('没有可保存的照片');
    return;
  }
  const link = document.createElement('a');
  link.download = `每日绘-${new Date().toISOString().slice(0,10)}.jpg`;
  link.href = photoSrc;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { document.body.removeChild(link); }, 1000);
}

// ─── Share Image ───
async function generateShareImage() {
  if (records.length < 1) return;

  const canvas = document.getElementById('shareCanvas');
  const ctx = canvas.getContext('2d');

  const W = 800, H = 1000;
  canvas.width = W;
  canvas.height = H;

  const loadImg = async (url) => {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return new Promise((ok, no) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = no;
      img.src = URL.createObjectURL(blob);
    });
  };

  const firstUrl = `${API_BASE}/data/${records[records.length - 1].image}`;
  const lastUrl = `${API_BASE}/data/${records[0].image}`;

  try {
    const [firstImg, lastImg] = await Promise.all([loadImg(firstUrl), loadImg(lastUrl)]);

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#faf8f5');
    grad.addColorStop(1, '#efeae2');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#2c2c2c';
    ctx.font = 'bold 36px -apple-system,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✏️ 每日绘 Craft', W / 2, 60);

    const streakEl = document.getElementById('streakBadge');
    ctx.font = '18px -apple-system,sans-serif';
    ctx.fillStyle = '#5b7a6e';
    ctx.fillText(streakEl.textContent || `共 ${records.length} 张画作`, W / 2, 92);

    ctx.strokeStyle = '#ddd7ce';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, 112);
    ctx.lineTo(W - 40, 112);
    ctx.stroke();

    const imgW = 340, imgH = 340;
    const gapX = 40;
    const topY = 140;

    ctx.font = 'bold 20px -apple-system,sans-serif';
    ctx.fillStyle = '#8a8a8a';
    ctx.textAlign = 'center';
    ctx.fillText('🎬 第 1 天', gapX + imgW / 2, topY - 12);

    ctx.save();
    ctx.beginPath();
    ctx.rect(gapX, topY, imgW, imgH);
    ctx.clip();
    ctx.drawImage(firstImg, gapX, topY, imgW, imgH);
    ctx.restore();

    ctx.strokeStyle = '#ddd7ce';
    ctx.lineWidth = 1;
    ctx.strokeRect(gapX, topY, imgW, imgH);

    ctx.font = '40px -apple-system,sans-serif';
    ctx.fillStyle = '#bbb';
    ctx.textAlign = 'center';
    ctx.fillText('→', W / 2, topY + imgH / 2 + 14);

    const lastLabel = records.length > 1 ? `🎨 第 ${records.length} 天` : '🎨 今天';
    ctx.font = 'bold 20px -apple-system,sans-serif';
    ctx.fillStyle = '#5b7a6e';
    ctx.textAlign = 'center';
    ctx.fillText(lastLabel, W - gapX - imgW / 2, topY - 12);

    const lastX = W - gapX - imgW;
    ctx.save();
    ctx.beginPath();
    ctx.rect(lastX, topY, imgW, imgH);
    ctx.clip();
    ctx.drawImage(lastImg, lastX, topY, imgW, imgH);
    ctx.restore();

    ctx.strokeStyle = '#5b7a6e';
    ctx.lineWidth = 2;
    ctx.strokeRect(lastX, topY, imgW, imgH);

    ctx.font = '14px -apple-system,sans-serif';
    ctx.fillStyle = '#9a9a9a';
    ctx.textAlign = 'center';
    ctx.fillText('手机 + 纸 + 笔 + AI 陪伴 · 每天画一点', W / 2, H - 60);

    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `每日绘-第${records.length}天.png`;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 1000);
    }, 'image/png');

  } catch (e) {
    showError('生成分享图失败，图片加载出错');
  }
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
