// ─── onboarding.js · 引导 / 画像 / 统计 / 欢迎回来 + 应用初始化 ───
// 依赖：state.js（showToast / escapeHtml / track）
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

async function loadStats(showWelcome = false) {
  let data = null;
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    data = await res.json();
    const el = document.getElementById('streakBadge');

    if (data.profile && data.profile.onboarding_done) {
      onboardingDone = true;
    }

    // 保存 streak 到全局，供分享卡使用
    currentStreak = data.streak || 0;

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
  if (showWelcome && !welcomeBackShown && onboardingDone) {
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

