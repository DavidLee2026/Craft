// ─── themes.js · 今日主题 + 主题库 ───────────────
// 依赖：state.js（track / showToast）
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


