'use strict';

const API = '';  // same origin

// ── Client identity ────────────────────────────────────────────────────────
// Generates a persistent UUID per browser so each user has their own recipe library.
const _clientId = (() => {
  const KEY = 'rr_client_id';
  let id = localStorage.getItem(KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
  return id;
})();

// ── Auth state ─────────────────────────────────────────────────────────────

let _authUser   = null;   // { id, email, name, plan, status } | null
let _authToken  = null;   // access JWT | null
let _refreshTok = null;   // refresh JWT | null

function _saveTokens(access, refresh) {
  _authToken  = access;
  _refreshTok = refresh || _refreshTok;
  if (access)  localStorage.setItem('rr_access_token',  access);
  else         localStorage.removeItem('rr_access_token');
  if (refresh) localStorage.setItem('rr_refresh_token', refresh);
}

function _clearTokens() {
  _authToken = _refreshTok = _authUser = null;
  localStorage.removeItem('rr_access_token');
  localStorage.removeItem('rr_refresh_token');
}

async function _tryRefresh() {
  if (!_refreshTok) return false;
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: _refreshTok }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    _saveTokens(data.access_token, null);
    return true;
  } catch { return false; }
}

async function _loadAuthUser() {
  const res = await fetch('/api/auth/me', {
    headers: { 'Authorization': `Bearer ${_authToken}` },
  });
  if (!res.ok) throw new Error('Not authenticated');
  _authUser = await res.json();
  _renderAuthSlot();
}

async function _initAuth() {
  _authToken  = localStorage.getItem('rr_access_token');
  _refreshTok = localStorage.getItem('rr_refresh_token');
  if (!_authToken) return;
  try {
    await _loadAuthUser();
  } catch {
    // Access token expired — try refresh
    const ok = await _tryRefresh();
    if (ok) {
      try { await _loadAuthUser(); } catch { _clearTokens(); }
    } else {
      _clearTokens();
    }
  }
}

// ── Auth UI ────────────────────────────────────────────────────────────────

function _renderAuthSlot() {
  const slot = document.getElementById('auth-slot');
  if (!slot) return;

  // Show/hide admin tab based on is_admin
  document.querySelectorAll('.admin-tab').forEach(el => {
    el.classList.toggle('hidden', !(_authUser?.is_admin));
  });

  if (_authUser) {
    const initial = (_authUser.name || _authUser.email)[0].toUpperCase();
    const isAdmin = _authUser.is_admin;
    const plan    = isAdmin ? 'Admin' : (_authUser.plan === 'pro' ? 'Pro' : 'Free');
    const planCls = isAdmin ? 'plan-badge admin' : (_authUser.plan === 'pro' ? 'plan-badge pro' : 'plan-badge free');
    const avatarInner = _authUser.avatar_url
      ? `<img src="${escHtml(_authUser.avatar_url)}" alt="${initial}" />`
      : initial;
    slot.innerHTML = `
      <button class="account-btn" onclick="toggleAccountDropdown(event)">
        <div class="account-avatar">${avatarInner}</div>
        <span class="account-name">${escHtml(_authUser.name || _authUser.email.split('@')[0])}</span>
        <span class="${planCls}">${plan}</span>
      </button>`;
    const dd = document.getElementById('account-dropdown');
    if (dd) {
      document.getElementById('account-dropdown-email').textContent = _authUser.email;
      document.getElementById('account-dropdown-plan').textContent  = isAdmin ? 'Administrator' : `Plan: ${plan}`;
    }
  } else {
    slot.innerHTML = `<button class="btn btn-primary btn-sm" onclick="openAuthModal('login')">Sign In</button>`;
  }
}

function toggleAccountDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('account-dropdown');
  if (!dd) return;
  dd.classList.toggle('hidden');
  const btn = document.querySelector('.account-btn');
  if (btn) {
    const rect = btn.getBoundingClientRect();
    dd.style.top   = (rect.bottom + 8) + 'px';
    dd.style.right = (window.innerWidth - rect.right) + 'px';
  }
}
document.addEventListener('click', () => {
  document.getElementById('account-dropdown')?.classList.add('hidden');
});

function openAuthModal(tab = 'login') {
  document.getElementById('auth-modal').classList.remove('hidden');
  switchAuthTab(tab);
}
function closeAuthModal(e) {
  if (e && e.target !== e.currentTarget && e.type !== 'click') return;
  if (e && e.currentTarget && e.target !== e.currentTarget) return;
  document.getElementById('auth-modal').classList.add('hidden');
}
function switchAuthTab(tab) {
  document.getElementById('auth-login-pane').classList.toggle('hidden',    tab !== 'login');
  document.getElementById('auth-register-pane').classList.toggle('hidden', tab !== 'register');
  document.getElementById('auth-tab-login').classList.toggle('active',    tab === 'login');
  document.getElementById('auth-tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('login-error').classList.add('hidden');
  document.getElementById('register-error').classList.add('hidden');
}

function _authBtnLoading(btnId, loading, label) {
  const btn = document.getElementById(btnId);
  btn.disabled = loading;
  btn.innerHTML = loading ? '<span class="spinner"></span>' : label;
}

async function _afterAuth(data) {
  _saveTokens(data.access_token, data.refresh_token);
  _authUser = data.user;
  _renderAuthSlot();
  document.getElementById('auth-modal').classList.add('hidden');
  // Claim any anonymous recipes into the new account
  try {
    const claimed = await api('/api/auth/claim-anonymous', {
      method: 'POST',
      body: JSON.stringify({ client_id: _clientId }),
    });
    if (claimed?.claimed > 0) showToast(`${claimed.claimed} recipe${claimed.claimed > 1 ? 's' : ''} moved to your account.`);
  } catch {}
  loadLibrary();
}

async function submitLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  errEl.classList.add('hidden');
  if (!email || !password) { errEl.textContent = 'Enter your email and password.'; errEl.classList.remove('hidden'); return; }
  _authBtnLoading('login-btn', true, 'Sign In');
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    await _afterAuth(data);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    _authBtnLoading('login-btn', false, 'Sign In');
  }
}

async function submitRegister() {
  const name     = document.getElementById('reg-name').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const errEl    = document.getElementById('register-error');
  errEl.classList.add('hidden');
  if (!email || !password) { errEl.textContent = 'Email and password are required.'; errEl.classList.remove('hidden'); return; }
  _authBtnLoading('register-btn', true, 'Create Account');
  try {
    const data = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) });
    await _afterAuth(data);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    _authBtnLoading('register-btn', false, 'Create Account');
  }
}

function signOut() {
  _clearTokens();
  _renderAuthSlot();
  document.getElementById('account-dropdown')?.classList.add('hidden');
  loadLibrary();
}

function openEditAccount() {
  document.getElementById('account-dropdown')?.classList.add('hidden');
  document.getElementById('ea-name').value  = _authUser?.name  ?? '';
  document.getElementById('ea-email').value = _authUser?.email ?? '';
  document.getElementById('ea-error').classList.add('hidden');
  document.getElementById('ea-pw-error').classList.add('hidden');
  document.getElementById('ea-cur-pw').value = '';
  document.getElementById('ea-new-pw').value = '';
  document.getElementById('ea-confirm-pw').value = '';
  // Populate avatar preview
  const prev = document.getElementById('ea-avatar-preview');
  if (prev) {
    const initial = (_authUser?.name || _authUser?.email || '?')[0].toUpperCase();
    prev.innerHTML = _authUser?.avatar_url
      ? `<img src="${escHtml(_authUser.avatar_url)}" alt="${initial}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
      : initial;
  }
  document.getElementById('edit-account-modal').classList.remove('hidden');
}

const _EYE_OPEN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const _EYE_OFF  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function togglePwReveal(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  const revealing = inp.type === 'password';
  inp.type = revealing ? 'text' : 'password';
  btn.innerHTML = revealing ? _EYE_OFF : _EYE_OPEN;
}

async function uploadAvatar(input) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  const formData = new FormData();
  formData.append('file', file);
  const prev = document.getElementById('ea-avatar-preview');
  if (prev) prev.style.opacity = '0.4';
  try {
    const res = await fetch('/api/auth/avatar', {
      method: 'POST',
      headers: _authToken ? { 'Authorization': `Bearer ${_authToken}` } : {},
      body: formData,
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Upload failed'); }
    const updated = await res.json();
    _authUser = { ..._authUser, ...updated };
    _renderAuthSlot();
    if (prev) {
      const initial = (_authUser.name || _authUser.email)[0].toUpperCase();
      prev.innerHTML = `<img src="${escHtml(_authUser.avatar_url)}" alt="${initial}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      prev.style.opacity = '1';
    }
    showToast('Avatar updated.');
  } catch (e) {
    if (prev) prev.style.opacity = '1';
    showToast('Avatar upload failed: ' + e.message);
  }
  input.value = '';
}
function closeEditAccount() {
  document.getElementById('edit-account-modal').classList.add('hidden');
}

async function submitEditAccount() {
  const name  = document.getElementById('ea-name').value.trim();
  const email = document.getElementById('ea-email').value.trim();
  const errEl = document.getElementById('ea-error');
  errEl.classList.add('hidden');
  if (!name || !email) { errEl.textContent = 'Name and email are required.'; errEl.classList.remove('hidden'); return; }

  const body = {};
  if (name  !== _authUser.name)  body.name  = name;
  if (email !== _authUser.email) body.email = email;
  if (!Object.keys(body).length) { closeEditAccount(); return; }

  const btn = document.getElementById('ea-save-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const updated = await api('/api/auth/me', { method: 'PATCH', body: JSON.stringify(body) });
    _authUser = { ..._authUser, ...updated };
    _renderAuthSlot();
    closeEditAccount();
    showToast('Account updated.');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Changes';
  }
}

async function submitChangePassword() {
  const cur     = document.getElementById('ea-cur-pw').value;
  const newPw   = document.getElementById('ea-new-pw').value;
  const confirm = document.getElementById('ea-confirm-pw').value;
  const errEl   = document.getElementById('ea-pw-error');
  errEl.classList.add('hidden');
  if (!cur || !newPw) { errEl.textContent = 'Enter your current and new password.'; errEl.classList.remove('hidden'); return; }
  if (newPw !== confirm) { errEl.textContent = 'New passwords do not match.'; errEl.classList.remove('hidden'); return; }

  const btn = document.getElementById('ea-pw-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: cur, new_password: newPw }) });
    document.getElementById('ea-cur-pw').value = '';
    document.getElementById('ea-new-pw').value = '';
    document.getElementById('ea-confirm-pw').value = '';
    showToast('Password changed successfully.');
    closeEditAccount();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Change Password';
  }
}

// Simple toast notification
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast-show'));
  setTimeout(() => { t.classList.remove('toast-show'); setTimeout(() => t.remove(), 300); }, 3500);
}

// ── State ──────────────────────────────────────────────────────────────────
let allRecipes   = [];
let mealPlan     = null;
let shoppingLists = [];
let activeDiet   = null;
let activeListId = null;
let pollInterval = null;

// Picker state (for adding meals to plan)
let pickerTarget = null;   // { dayIndex, slot }

// ── Helpers ────────────────────────────────────────────────────────────────

// Returns the right auth header for direct fetch() calls (non-JSON, e.g. FormData)
function _authHeaders() {
  if (_authToken) return { 'Authorization': `Bearer ${_authToken}` };
  return { 'X-Client-ID': _clientId };
}

async function api(path, opts = {}, _retry = false) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (_authToken) {
    headers['Authorization'] = `Bearer ${_authToken}`;
  } else {
    headers['X-Client-ID'] = _clientId;
  }
  const res = await fetch(API + path, { headers, ...opts });

  // On 401, attempt a token refresh once then retry
  if (res.status === 401 && _authToken && !_retry && path !== '/api/auth/refresh') {
    const ok = await _tryRefresh();
    if (ok) return api(path, opts, true);
    _clearTokens();
    _renderAuthSlot();
    openAuthModal('login');
    throw new Error('Session expired — please sign in again.');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Request failed');
  }
  if (res.status === 204) return null;
  return res.json();
}

function thumbUrl(path) {
  if (!path) return null;
  const m = path.replace(/\\/g, '/').match(/uploads\/.+/);
  if (m) return '/' + m[0];
  if (path.startsWith('http')) return path;
  return null;
}

function macroLine(m) {
  const parts = [];
  if (m?.calories != null) parts.push(`${Math.round(m.calories)} cal`);
  if (m?.protein_g != null) parts.push(`${Math.round(m.protein_g)}g P`);
  return parts.join(' · ');
}

function formatMealType(t) {
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Gradient palettes for food image placeholders (matches design tokens)
const FOOD_PALETTES = [
  ['#F59E0B','#DC2626','#7C2D12'],
  ['#10B981','#059669','#064E3B'],
  ['#F472B6','#9333EA','#3B0764'],
  ['#FBBF24','#F97316','#7C2D12'],
  ['#60A5FA','#1E3A8A','#0C1A4F'],
  ['#FB923C','#B45309','#451A03'],
];
function foodGradient(seed) {
  let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) | 0;
  const [a, b, c] = FOOD_PALETTES[Math.abs(h) % FOOD_PALETTES.length];
  return `radial-gradient(circle at 30% 20%, ${a} 0%, ${b} 45%, ${c} 100%)`;
}

function slotPill(mealType) {
  if (!mealType) return '';
  return `<span class="slot-pill ${mealType}">${formatMealType(mealType)}</span>`;
}

function macroChips(m) {
  if (!m) return '';
  const parts = [];
  if (m.calories  != null) parts.push(`<span class="macro-item" style="color:var(--macro-cal)">${Math.round(m.calories)}<span class="macro-unit"> cal</span></span>`);
  if (m.protein_g != null) parts.push(`<span class="macro-item" style="color:var(--macro-protein)">${Math.round(m.protein_g)}g<span class="macro-unit"> P</span></span>`);
  if (m.carbs_g   != null) parts.push(`<span class="macro-item" style="color:var(--macro-carbs)">${Math.round(m.carbs_g)}g<span class="macro-unit"> C</span></span>`);
  return parts.length ? `<div class="recipe-macros">${parts.join('')}</div>` : '';
}

// ── Tab Navigation ─────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (btn) btn.classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
  // Keep mobile dropdown in sync
  const mobileNav = document.getElementById('mobile-nav');
  if (mobileNav) mobileNav.value = tab;
  if (tab === 'library')  loadLibrary();
  if (tab === 'planner')  loadPlanner();
  if (tab === 'shopping') { loadShoppingLists(); loadDietPlan(); }
  if (tab === 'diet')     loadDietPlan();
  if (tab === 'import')   checkBulkStatus();
  if (tab === 'discover') loadDiscover();
  if (tab === 'admin')    loadAdminStats();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── LIBRARY ────────────────────────────────────────────────────────────────

async function loadLibrary(search = '', mealType = '') {
  const grid = document.getElementById('recipe-grid');
  grid.innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading recipes…</div>';
  try {
    const params = new URLSearchParams();
    if (search)   params.set('search', search);
    if (mealType) params.set('meal_type', mealType);
    const q = params.size ? '?' + params : '';
    allRecipes = await api('/api/recipes' + q);
    renderGrid(sortedRecipes(allRecipes));
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Failed to load</div><div class="empty-sub">${e.message}</div></div>`;
  }
}

function renderGrid(recipes) {
  const grid = document.getElementById('recipe-grid');
  document.getElementById('recipe-count').textContent = `${recipes.length} recipe${recipes.length !== 1 ? 's' : ''}`;
  if (!recipes.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🍳</div><div class="empty-title">No recipes yet</div><div class="empty-sub">Import a cooking reel to get started.</div></div>`;
    return;
  }
  grid.innerHTML = recipes.map(r => {
    const thumb = thumbUrl(r.thumbnail_url);
    const thumbHtml = thumb
      ? `<img src="${thumb}" class="recipe-thumb" alt="${escHtml(r.title)}" loading="lazy"
           onerror="this.outerHTML='<div class=\\'recipe-thumb-placeholder\\'style=\\'background:${foodGradient(r.id)}\\'><div class=\\'recipe-thumb-overlay\\'></div></div>'">`
      : `<div class="recipe-thumb-placeholder" style="background:${foodGradient(r.id)}"><div class="recipe-thumb-overlay"></div></div>`;
    return `
      <div class="recipe-card" onclick="openRecipe(${r.id})">
        ${thumbHtml}
        <div class="recipe-card-body">
          <div class="recipe-card-title">${escHtml(r.title)}</div>
          <div class="recipe-card-meta">
            ${slotPill(r.meal_type)}
            ${r.cuisine ? `<span style="color:var(--text3);font-size:11.5px;font-weight:500">${escHtml(r.cuisine)}</span>` : ''}
          </div>
          ${macroChips(r.macros_per_serving)}
        </div>
      </div>`;
  }).join('');
}

function sortedRecipes(recipes) {
  const sort = document.getElementById('sort-select')?.value || 'newest';
  const arr = [...recipes];
  if (sort === 'newest') arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  else if (sort === 'oldest') arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  else if (sort === 'alpha') arr.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === 'protein') arr.sort((a, b) => (b.macros_per_serving?.protein_g ?? -1) - (a.macros_per_serving?.protein_g ?? -1));
  return arr;
}

function applySortAndRender() {
  renderGrid(sortedRecipes(allRecipes));
}

// Search & filter
let searchTimeout;
document.getElementById('search-input').addEventListener('input', e => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => loadLibrary(e.target.value, activeChip()), 350);
});

document.getElementById('meal-type-filters').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  document.querySelectorAll('#meal-type-filters .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  loadLibrary(document.getElementById('search-input').value, chip.dataset.type);
});

function activeChip() {
  return document.querySelector('#meal-type-filters .chip.active')?.dataset.type || '';
}

// ── RECIPE MODAL ───────────────────────────────────────────────────────────

const CATEGORY_COLORS = {
  produce:  '#34D399', protein: '#F87171', dairy:    '#60A5FA',
  pantry:   '#FBBF24', frozen:  '#A78BFA', spice:    '#F472B6',
  beverage: '#22D3EE', grain:   '#D6A86B', other:    '#94A3B8',
};
const CATEGORY_BG = {
  produce:  'rgba(52,211,153,0.12)',  protein: 'rgba(248,113,113,0.12)',
  dairy:    'rgba(96,165,250,0.12)',  pantry:  'rgba(251,191,36,0.12)',
  frozen:   'rgba(167,139,250,0.12)', spice:   'rgba(244,114,182,0.12)',
  beverage: 'rgba(34,211,238,0.12)', grain:   'rgba(214,168,107,0.12)',
  other:    'rgba(148,163,184,0.12)',
};
const CATEGORY_EMOJI = {
  produce: '🥬', protein: '🥩', dairy: '🥛', pantry: '📦',
  frozen: '❄️', spice: '🌶️', beverage: '🥤', grain: '🌾', other: '•',
};

async function openRecipe(id) {
  const overlay = document.getElementById('recipe-modal');
  const content = document.getElementById('modal-content');
  overlay.classList.remove('hidden');
  content.innerHTML = '<div class="loading-state"><span class="spinner"></span></div>';
  try {
    const r = await api(`/api/recipes/${id}`);
    const thumb = thumbUrl(r.thumbnail_url);
    const heroHtml = `<div class="modal-hero-wrap" style="position:relative">
      ${thumb ? `<img src="${thumb}" class="modal-hero" alt="${escHtml(r.title)}" id="modal-hero-img">` : `<div class="modal-hero-placeholder" id="modal-hero-img">🍽️</div>`}
      <button onclick="openCoverEditor(${r.id})" title="Change cover photo" style="
        position:absolute;bottom:10px;right:10px;
        background:rgba(0,0,0,.55);color:#fff;border:none;border-radius:99px;
        padding:6px 12px;font-size:12px;cursor:pointer;backdrop-filter:blur(4px);
        display:flex;align-items:center;gap:5px;
      ">📷 Change cover</button>
      <div id="cover-editor-${r.id}" class="hidden" data-source-type="${escHtml(r.source_type || '')}" style="
        position:absolute;inset:0;background:rgba(0,0,0,.78);
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
        backdrop-filter:blur(6px);border-radius:inherit;padding:16px;overflow-y:auto;
      "></div>
    </div>`;
    const totalTime = (r.prep_time_minutes || 0) + (r.cook_time_minutes || 0);
    const pills = [
      r.meal_type ? `<span class="meta-pill meal-badge ${r.meal_type}">${formatMealType(r.meal_type)}</span>` : '',
      r.cuisine   ? `<span class="meta-pill">🌍 ${escHtml(r.cuisine)}</span>` : '',
      totalTime   ? `<span class="meta-pill">⏱ ${totalTime} min</span>` : '',
      r.servings  ? `<span class="meta-pill">🍽 Serves ${r.servings}</span>` : '',
    ].filter(Boolean).join('');

    const m = r.macros_per_serving;
    const macroHtml = m?.calories != null ? `
      <div style="background:var(--bg);border-radius:14px;padding:16px;border:1px solid var(--border)">
        <div class="modal-section-title">Per Serving</div>
        <div class="macro-grid">
          <div class="macro-tile"><div class="macro-value" style="color:var(--macro-cal)">${Math.round(m.calories)}</div><div class="macro-label">Cal</div></div>
          ${m.protein_g != null ? `<div class="macro-tile"><div class="macro-value" style="color:var(--macro-protein)">${Math.round(m.protein_g)}g</div><div class="macro-label">Protein</div></div>` : ''}
          ${m.carbs_g   != null ? `<div class="macro-tile"><div class="macro-value" style="color:var(--macro-carbs)">${Math.round(m.carbs_g)}g</div><div class="macro-label">Carbs</div></div>` : ''}
          ${m.fat_g     != null ? `<div class="macro-tile"><div class="macro-value" style="color:var(--macro-fat)">${Math.round(m.fat_g)}g</div><div class="macro-label">Fat</div></div>` : ''}
        </div>
      </div>` : '';

    const ingredients = r.ingredients.map(ing => {
      const cat = ing.category || 'other';
      const fg  = CATEGORY_COLORS[cat] || CATEGORY_COLORS.other;
      const bg  = CATEGORY_BG[cat]     || CATEGORY_BG.other;
      const em  = CATEGORY_EMOJI[cat]  || '•';
      return `
        <div class="ingredient-row">
          <div class="ingredient-icon" style="background:${bg};color:${fg}">${em}</div>
          <div class="ingredient-text">${escHtml(ing.raw_text || ing.name)}</div>
        </div>`;
    }).join('');

    const steps = r.steps.map((s, i) => `
      <div class="step-row">
        <div class="step-circle${i === 0 ? ' step-first' : ''}">${i + 1}</div>
        <div class="step-text">${escHtml(s)}</div>
      </div>`).join('');

    const tags = r.tags?.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${r.tags.map(t => `<span class="restriction-tag">#${escHtml(t)}</span>`).join('')}</div>` : '';

    const ratingHtml = _authUser ? (() => {
      const cur = r.user_rating || '';
      return `
        <div class="rating-row" id="rating-row-${r.id}" data-current="${escHtml(cur)}">
          <span class="rating-label">Rate</span>
          <button class="rating-btn${cur === 'dislike' ? ' active-dislike' : ''}" data-rating="dislike" onclick="rateRecipe(${r.id},'dislike')">👎 Dislike</button>
          <button class="rating-btn${cur === 'like'    ? ' active-like'    : ''}" data-rating="like"    onclick="rateRecipe(${r.id},'like')">👍 Like</button>
          <button class="rating-btn${cur === 'love'    ? ' active-love'    : ''}" data-rating="love"    onclick="rateRecipe(${r.id},'love')">❤️ Love</button>
        </div>`;
    })() : '';

    content.innerHTML = `
      ${heroHtml}
      <div class="modal-body">
        <div>
          <div class="modal-title">${escHtml(r.title)}</div>
          ${r.description ? `<div class="modal-desc" style="margin-top:6px">${escHtml(r.description)}</div>` : ''}
        </div>
        <div class="modal-meta">${pills}</div>
        ${ratingHtml}
        ${macroHtml}
        <div>
          <div class="modal-section-title">Ingredients</div>
          ${ingredients || '<div style="color:var(--text3)">No ingredients extracted</div>'}
        </div>
        <div>
          <div class="modal-section-title">Instructions</div>
          ${steps || '<div style="color:var(--text3)">No steps extracted</div>'}
        </div>
        ${tags}
        ${r.source_url ? `<a href="${r.source_url}" target="_blank" style="color:var(--accent);font-size:13px">View original reel ↗</a>` : ''}
        <button class="btn btn-danger btn-sm" onclick="deleteRecipe(${r.id})" style="align-self:flex-start">🗑 Delete Recipe</button>
      </div>`;
  } catch (e) {
    content.innerHTML = `<div class="modal-body"><div style="color:var(--red)">${e.message}</div></div>`;
  }
}

// ── Cover photo editor ─────────────────────────────────────────────────────

function openCoverEditor(recipeId) {
  const editor = document.getElementById(`cover-editor-${recipeId}`);
  const isReel = editor.dataset.sourceType === 'instagram_reel';
  editor.innerHTML = `
    <div style="color:#fff;font-weight:600;font-size:13px;letter-spacing:.03em;opacity:.85">CHANGE COVER PHOTO</div>
    ${isReel ? `
    <button onclick="extractReelThumbnail(${recipeId}, this)" style="
      background:#e1306c;color:#fff;border:none;border-radius:8px;
      padding:8px 18px;cursor:pointer;font-size:13px;font-weight:600;
    ">📹 Extract from Reel</button>
    <div style="color:rgba(255,255,255,.4);font-size:11px">— or —</div>` : ''}
    <label style="
      background:var(--accent);color:#fff;padding:8px 18px;border-radius:8px;
      cursor:pointer;font-size:13px;font-weight:600;
    ">📤 Upload Photo<input type="file" accept="image/*" style="display:none" onchange="uploadCoverPhoto(${recipeId}, this)"></label>
    <div style="color:rgba(255,255,255,.4);font-size:11px">— or —</div>
    <div style="display:flex;gap:6px">
      <input id="cover-url-${recipeId}" type="url" placeholder="Paste image URL…" style="
        width:180px;padding:7px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);
        background:rgba(255,255,255,.1);color:#fff;font-size:12px;
      ">
      <button onclick="saveCoverUrl(${recipeId})" style="
        background:var(--accent);color:#fff;border:none;border-radius:8px;
        padding:7px 14px;cursor:pointer;font-size:12px;font-weight:600;
      ">Save</button>
    </div>
    <button onclick="closeCoverEditor(${recipeId})" style="
      color:rgba(255,255,255,.45);background:none;border:none;cursor:pointer;font-size:12px;
    ">Cancel</button>`;
  editor.classList.remove('hidden');
}
function closeCoverEditor(recipeId) {
  document.getElementById(`cover-editor-${recipeId}`).classList.add('hidden');
}

async function extractReelThumbnail(recipeId, btn) {
  const editor = document.getElementById(`cover-editor-${recipeId}`);
  btn.disabled = true;
  btn.textContent = '⏳ Downloading & extracting…';
  try {
    const data = await api(`/api/recipes/${recipeId}/thumbnail/from-reel`, { method: 'POST' });
    const t = Date.now();

    const frameCard = (url, label) => url ? `
      <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
        <div style="color:rgba(255,255,255,.6);font-size:11px;font-weight:600;letter-spacing:.05em">${label}</div>
        <img src="${url}?t=${t}" style="
          width:120px;height:90px;object-fit:cover;border-radius:8px;
          box-shadow:0 4px 14px rgba(0,0,0,.5);
        ">
        <button onclick="confirmReelThumbnail(${recipeId}, '${url}')" style="
          background:#22c55e;color:#fff;border:none;border-radius:7px;
          padding:6px 14px;cursor:pointer;font-size:12px;font-weight:600;
        ">Use This</button>
      </div>` : '';

    editor.innerHTML = `
      <div style="color:#fff;font-weight:600;font-size:13px;letter-spacing:.03em;opacity:.85">PICK A FRAME</div>
      <div style="display:flex;gap:16px;align-items:flex-start">
        ${frameCard(data.preview_45, '45% through')}
        ${frameCard(data.preview_95, '95% through')}
      </div>
      <div style="width:100%;height:1px;background:rgba(255,255,255,.15);margin:2px 0"></div>
      <button onclick="openCoverEditor(${recipeId})" style="
        background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:8px;
        padding:7px 16px;cursor:pointer;font-size:12px;
      ">Use another format</button>
      <button onclick="closeCoverEditor(${recipeId})" style="
        color:rgba(255,255,255,.4);background:none;border:none;cursor:pointer;font-size:11px;
      ">Cancel</button>`;
  } catch (e) {
    alert('Could not extract frames: ' + e.message);
    btn.disabled = false;
    btn.textContent = '📹 Extract from Reel';
  }
}

async function confirmReelThumbnail(recipeId, previewUrl) {
  const fd = new FormData();
  fd.append('url', previewUrl);
  try {
    const res = await fetch(`/api/recipes/${recipeId}/thumbnail`, { method: 'PATCH', body: fd, headers: _authHeaders() });
    if (!res.ok) { const e = await res.json(); throw new Error(e.detail); }
    const data = await res.json();
    _refreshModalHero(data.thumbnail_url);
    closeCoverEditor(recipeId);
    loadLibrary();
  } catch (e) { alert('Failed to save cover: ' + e.message); }
}

async function uploadCoverPhoto(recipeId, input) {
  const file = input.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch(`/api/recipes/${recipeId}/thumbnail`, { method: 'PATCH', body: fd, headers: _authHeaders() });
    if (!res.ok) { const e = await res.json(); throw new Error(e.detail); }
    const data = await res.json();
    _refreshModalHero(data.thumbnail_url);
    closeCoverEditor(recipeId);
    loadLibrary();
  } catch (e) { alert('Failed to update cover: ' + e.message); }
}

async function saveCoverUrl(recipeId) {
  const url = document.getElementById(`cover-url-${recipeId}`).value.trim();
  if (!url) return;
  const fd = new FormData();
  fd.append('url', url);
  try {
    const res = await fetch(`/api/recipes/${recipeId}/thumbnail`, { method: 'PATCH', body: fd, headers: _authHeaders() });
    if (!res.ok) { const e = await res.json(); throw new Error(e.detail); }
    const data = await res.json();
    _refreshModalHero(data.thumbnail_url);
    closeCoverEditor(recipeId);
    loadLibrary();
  } catch (e) { alert('Failed to update cover: ' + e.message); }
}

function _refreshModalHero(newUrl) {
  const wrap = document.querySelector('.modal-hero-wrap');
  if (!wrap) return;
  const img = wrap.querySelector('#modal-hero-img');
  if (!img) return;
  if (newUrl) {
    const freshUrl = newUrl + '?t=' + Date.now(); // bust cache
    if (img.tagName === 'IMG') {
      img.src = freshUrl;
    } else {
      // Was a placeholder div — replace with img
      const newImg = document.createElement('img');
      newImg.id = 'modal-hero-img';
      newImg.className = 'modal-hero';
      newImg.src = freshUrl;
      img.replaceWith(newImg);
    }
  }
}

function closeModal(e) {
  if (e.target === e.currentTarget) closeRecipeModal();
}
function closeRecipeModal() {
  document.getElementById('recipe-modal').classList.add('hidden');
}

async function deleteRecipe(id) {
  if (!confirm('Delete this recipe permanently?')) return;
  await api(`/api/recipes/${id}`, { method: 'DELETE' });
  closeRecipeModal();
  loadLibrary(document.getElementById('search-input').value, activeChip());
}

async function rateRecipe(recipeId, rating) {
  const row = document.getElementById(`rating-row-${recipeId}`);
  if (!row) return;
  const current = row.dataset.current;
  try {
    if (current === rating) {
      // Toggle off — unrate
      await api(`/api/recipes/${recipeId}/rate`, { method: 'DELETE' });
      row.dataset.current = '';
    } else {
      const res = await api(`/api/recipes/${recipeId}/rate`, {
        method: 'POST',
        body: JSON.stringify({ rating }),
      });
      row.dataset.current = res.user_rating;
    }
    _updateRatingButtons(row);
  } catch (e) {
    if (e.message.includes('Sign in')) openAuthModal('login');
    else showToast('Could not save rating: ' + e.message);
  }
}

function _updateRatingButtons(row) {
  const current = row.dataset.current;
  row.querySelectorAll('.rating-btn').forEach(btn => {
    const r = btn.dataset.rating;
    btn.className = 'rating-btn' + (current === r ? ` active-${r}` : '');
  });
}

// ── SINGLE REEL IMPORT ─────────────────────────────────────────────────────

async function importSingleReel() {
  const url = document.getElementById('reel-url-input').value.trim();
  const btn = document.getElementById('import-reel-btn');
  const status = document.getElementById('single-import-status');
  if (!url) { showStatus(status, 'error', 'Please paste a reel URL first.'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Importing…';
  const stopTimer = startImportTimer(status, [
    { msg: '📥 Downloading reel from Instagram…',       duration: 12 },
    { msg: '🎙 Transcribing audio…',                    duration: 20 },
    { msg: '🤖 Extracting recipe with Claude…',         duration: 20 },
    { msg: '💾 Almost done, saving to your library…',   duration: 999 },
  ]);

  try {
    const recipe = await api('/api/reels/process', { method: 'POST', body: JSON.stringify({ url }) });
    await stopTimer();
    showStatus(status, 'success', `✅ "${recipe.title}" saved successfully!`);
    document.getElementById('reel-url-input').value = '';
    loadLibrary();
  } catch (e) {
    await stopTimer();
    showStatus(status, 'error', `❌ ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">✨</span> Import & Extract Recipe';
  }
}

// Allow Enter key in URL input
document.getElementById('reel-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') importSingleReel();
});

// ── WEB RECIPE IMPORT ──────────────────────────────────────────────────────

async function importWebRecipe() {
  const url = document.getElementById('web-url-input').value.trim();
  const btn = document.getElementById('import-web-btn');
  const status = document.getElementById('web-import-status');
  if (!url) { showStatus(status, 'error', 'Please paste a recipe URL first.'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Importing…';
  const stopTimer = startImportTimer(status, [
    { msg: '🌐 Fetching recipe page…',              duration: 8 },
    { msg: '🔍 Parsing recipe content…',            duration: 8 },
    { msg: '🤖 Extracting recipe with Claude…',     duration: 999 },
  ]);

  try {
    const recipe = await api('/api/reels/import-web', { method: 'POST', body: JSON.stringify({ url }) });
    await stopTimer();
    showStatus(status, 'success', `✅ "${recipe.title}" saved successfully!`);
    document.getElementById('web-url-input').value = '';
    loadLibrary();
  } catch (e) {
    await stopTimer();
    showStatus(status, 'error', `❌ ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">✨</span> Import Recipe';
  }
}

document.getElementById('web-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') importWebRecipe();
});

// ── PHOTO IMPORT ───────────────────────────────────────────────────────────

async function importPhotoRecipe(event) {
  const file = event.target.files[0];
  if (!file) return;
  const status = document.getElementById('photo-import-status');
  const zone = document.getElementById('photo-drop-zone');

  zone.innerHTML = `<div class="upload-icon"><span class="spinner"></span></div><div class="upload-text">Analyzing recipe…</div>`;
  const stopTimer = startImportTimer(status, [
    { msg: '📤 Uploading photo…',                        duration: 5 },
    { msg: '👁 Analyzing image with Claude Vision…',     duration: 999 },
  ]);

  const formData = new FormData();
  formData.append('file', file);

  try {
    const resp = await fetch('/api/reels/import-photo', { method: 'POST', body: formData, headers: _authHeaders() });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || resp.statusText);
    }
    const recipe = await resp.json();
    await stopTimer();
    showStatus(status, 'success', `✅ "${recipe.title}" saved successfully!`);
    loadLibrary();
  } catch (e) {
    await stopTimer();
    showStatus(status, 'error', `❌ ${e.message}`);
  } finally {
    zone.innerHTML = `<div class="upload-icon">📸</div><div class="upload-text">Click to choose a photo</div><div class="upload-hint">JPEG, PNG, or WebP — up to 20 MB</div>`;
    event.target.value = '';
  }
}

// ── PAGE SCANNER ───────────────────────────────────────────────────────────

let _scannedRecipes = [];
let _selectedScanIds = new Set();

async function scanRecipePage() {
  const url = document.getElementById('scan-url-input').value.trim();
  const btn = document.getElementById('scan-page-btn');
  const status = document.getElementById('scan-status');
  if (!url) { showStatus(status, 'error', 'Please paste a page URL first.'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning…';
  showStatus(status, 'loading', '⏳ Scanning page for recipe links…');

  try {
    const data = await api('/api/reels/scan-page', { method: 'POST', body: JSON.stringify({ url }) });
    _scannedRecipes = data.recipes;
    _selectedScanIds = new Set();
    showStatus(status, 'success', `Found ${_scannedRecipes.length} recipe link(s).`);
    openPageScanModal();
  } catch (e) {
    showStatus(status, 'error', `❌ ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">🔍</span> Find Recipes on Page';
  }
}

function openPageScanModal() {
  document.getElementById('page-scan-modal').classList.remove('hidden');
  document.getElementById('page-scan-subtitle').textContent =
    `${_scannedRecipes.length} recipe${_scannedRecipes.length === 1 ? '' : 's'} found — select which to import`;
  document.getElementById('page-scan-progress').classList.add('hidden');
  renderScanList(_scannedRecipes);
}

function closePageScanModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('page-scan-modal').classList.add('hidden');
}

function renderScanList(items) {
  const container = document.getElementById('page-scan-list');
  container.innerHTML = items.map((r, idx) => {
    const selected = _selectedScanIds.has(r.url);
    return `<div class="shop-recipe-row ${selected ? 'selected' : ''}" onclick="toggleScanRecipe(${JSON.stringify(r.url)})">
      <div class="shop-recipe-check">${selected ? '✓' : ''}</div>
      <div class="shop-recipe-info">
        <div class="shop-recipe-title">${escHtml(r.title || r.url)}</div>
        <div style="color:var(--text3);font-size:11px;margin-top:2px">${escHtml(r.url)}</div>
      </div>
    </div>`;
  }).join('');
  updateScanCount();
}

function toggleScanRecipe(url) {
  _selectedScanIds.has(url) ? _selectedScanIds.delete(url) : _selectedScanIds.add(url);
  renderScanList(_scannedRecipes.filter(r =>
    r.title.toLowerCase().includes((document.getElementById('page-scan-search').value || '').toLowerCase())
  ));
}

function filterScanResults(q) {
  const filtered = _scannedRecipes.filter(r =>
    (r.title + r.url).toLowerCase().includes(q.toLowerCase())
  );
  renderScanList(filtered);
}

function selectAllScanResults() {
  _scannedRecipes.forEach(r => _selectedScanIds.add(r.url));
  renderScanList(_scannedRecipes);
}

function updateScanCount() {
  document.getElementById('page-scan-count').textContent =
    _selectedScanIds.size > 0 ? `${_selectedScanIds.size} selected` : '0 selected';
}

async function importSelectedScanned() {
  const urls = [..._selectedScanIds];
  if (!urls.length) return;

  const progress = document.getElementById('page-scan-progress');
  const bar = document.getElementById('page-scan-bar');
  const log = document.getElementById('page-scan-log');
  progress.classList.remove('hidden');
  log.innerHTML = '';

  let done = 0, succeeded = 0, failed = 0;

  for (const url of urls) {
    const title = (_scannedRecipes.find(r => r.url === url) || {}).title || url;
    log.innerHTML += `<div>⏳ Importing: ${escHtml(title)}</div>`;
    log.scrollTop = log.scrollHeight;
    try {
      const recipe = await api('/api/reels/import-web', { method: 'POST', body: JSON.stringify({ url }) });
      log.innerHTML += `<div style="color:var(--green)">✅ ${escHtml(recipe.title)}</div>`;
      succeeded++;
    } catch (e) {
      log.innerHTML += `<div style="color:var(--red)">❌ ${escHtml(title)}: ${escHtml(e.message)}</div>`;
      failed++;
    }
    done++;
    bar.style.width = Math.round((done / urls.length) * 100) + '%';
    log.scrollTop = log.scrollHeight;
  }

  log.innerHTML += `<div style="margin-top:8px;font-weight:600">${succeeded} imported, ${failed} failed.</div>`;
  loadLibrary();
}

// ── BULK IMPORT ────────────────────────────────────────────────────────────

function togglePassword() {
  const inp = document.getElementById('bulk-password');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

async function startBulkImport() {
  const username      = document.getElementById('bulk-username').value.trim();
  const password      = document.getElementById('bulk-password').value.trim();
  const collectionUrl = document.getElementById('bulk-collection-url').value.trim() || null;
  const limitVal      = document.getElementById('bulk-limit').value.trim();
  const limit         = limitVal ? parseInt(limitVal) : null;

  if (!username || !password) {
    alert('Enter your Instagram username and password.'); return;
  }
  const scope = collectionUrl
    ? `the collection at:\n${collectionUrl}`
    : 'all your saved posts';
  if (!confirm(`Start bulk import from @${username}?\n\nThis will scan ${scope} and import cooking reels as recipes. It may take several minutes.`)) return;

  const btn = document.getElementById('bulk-import-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Starting…';

  try {
    await api('/api/instagram/bulk-import', { method: 'POST', body: JSON.stringify({ username, password, collection_url: collectionUrl, limit }) });
    showBulkProgress();
    startBulkPoll();
  } catch (e) {
    alert('Could not start import: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">☁️</span> Start Bulk Import';
  }
}

function showBulkProgress() {
  document.getElementById('bulk-progress').classList.remove('hidden');
}

function startBulkPoll() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    try {
      const s = await api('/api/instagram/bulk-import/status');
      updateBulkUI(s);
      if (s.status !== 'running' && s.status !== 'awaiting_2fa') {
        clearInterval(pollInterval);
        pollInterval = null;
        document.getElementById('bulk-import-btn').disabled = false;
        document.getElementById('bulk-import-btn').innerHTML = '<span class="btn-icon">☁️</span> Start Bulk Import';
      }
    } catch (_) {}
  }, 2000);
}

function updateBulkUI(s) {
  const pct = s.total > 0 ? Math.round((s.processed / s.total) * 100) : 0;
  const bar = document.getElementById('bulk-progress-bar');
  bar.style.width = pct + '%';
  bar.className = 'progress-bar-fill ' + (s.status === 'running' ? 'running' : s.status === 'done' ? 'done' : '');

  const badge = document.getElementById('bulk-status-badge');
  badge.textContent = s.status === 'awaiting_2fa' ? '2FA' : s.status.toUpperCase();
  badge.className   = 'status-badge ' + s.status;

  const label = document.getElementById('bulk-status-label');
  if (s.status === 'running') label.textContent = `Processing ${s.processed} of ${s.total}…`;
  else if (s.status === 'awaiting_2fa') label.textContent = 'Waiting for verification code…';
  else if (s.status === 'done') label.textContent = 'Import complete';
  else if (s.status === 'error') label.textContent = 'Import failed';
  else label.textContent = 'Ready';

  // Show/hide 2FA prompt
  const twofa = document.getElementById('bulk-2fa-prompt');
  if (s.status === 'awaiting_2fa') {
    twofa.classList.remove('hidden');
    document.getElementById('bulk-2fa-input').focus();
  } else {
    twofa.classList.add('hidden');
  }

  if (s.total > 0) {
    const stats = document.getElementById('bulk-stats');
    stats.classList.remove('hidden');
    stats.innerHTML = `
      <div class="stat-item"><div class="stat-value" style="color:var(--green)">${s.imported}</div><div class="stat-label">Imported</div></div>
      <div class="stat-item"><div class="stat-value" style="color:var(--text3)">${s.skipped}</div><div class="stat-label">Skipped</div></div>
      <div class="stat-item"><div class="stat-value" style="color:var(--red)">${s.failed}</div><div class="stat-label">Failed</div></div>
      <div class="stat-item"><div class="stat-value" style="color:var(--accent)">${s.total}</div><div class="stat-label">Total</div></div>`;
  }

  if (s.current) document.getElementById('bulk-current').textContent = 'Processing: ' + s.current;
  else document.getElementById('bulk-current').textContent = '';

  const logBox = document.getElementById('bulk-log');
  if (s.log?.length) {
    logBox.innerHTML = s.log.map(l => `<div class="log-line">${escHtml(l)}</div>`).join('');
    logBox.scrollTop = logBox.scrollHeight;
  }

  const stopAction = document.getElementById('bulk-stop-action');
  if (s.status === 'running') stopAction.classList.remove('hidden');
  else stopAction.classList.add('hidden');

  const doneActions = document.getElementById('bulk-done-actions');
  if (s.status === 'done' || s.status === 'error') doneActions.classList.remove('hidden');
  else doneActions.classList.add('hidden');
}

async function checkBulkStatus() {
  try {
    const s = await api('/api/instagram/bulk-import/status');
    if (s.status !== 'idle') {
      showBulkProgress();
      updateBulkUI(s);
      if (s.status === 'running' || s.status === 'awaiting_2fa') startBulkPoll();
    }
  } catch (_) {}
}

async function submit2fa() {
  const code = document.getElementById('bulk-2fa-input').value.trim();
  const errEl = document.getElementById('bulk-2fa-error');
  const btn = document.querySelector('#bulk-2fa-prompt .btn-primary');
  errEl.classList.add('hidden');
  if (code.length !== 6 || !/^\d+$/.test(code)) {
    errEl.textContent = 'Enter a 6-digit numeric code.';
    errEl.classList.remove('hidden');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    await api('/api/instagram/bulk-import/2fa', { method: 'POST', body: JSON.stringify({ code }) });
    // Resume polling so the UI picks up the result
    startBulkPoll();
  } catch (e) {
    errEl.textContent = 'Could not submit code — try again.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify';
  }
}

async function stopBulkImport() {
  const btn = document.querySelector('#bulk-stop-action .btn-danger');
  btn.disabled = true;
  btn.textContent = 'Stopping…';
  try {
    await api('/api/instagram/bulk-import/cancel', { method: 'POST' });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '⏹ Stop Import';
  }
}

async function resetBulkImport() {
  await api('/api/instagram/bulk-import', { method: 'DELETE' });
  document.getElementById('bulk-progress').classList.add('hidden');
  document.getElementById('bulk-import-btn').disabled = false;
}

function goToLibrary() {
  document.querySelector('.tab-btn[data-tab="library"]').click();
}

// ── MEAL PLANNER ───────────────────────────────────────────────────────────

const DAYS  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const SLOTS = ['breakfast','lunch','dinner','snack'];
const SLOT_ICONS = { breakfast:'🌅', lunch:'☀️', dinner:'🌙', snack:'🍎' };

async function loadPlanner() {
  const grid = document.getElementById('planner-grid');
  grid.innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading plan…</div>';
  try {
    const plans = await api('/api/meal-plan');
    if (!plans.length) {
      const monday = getMonday();
      mealPlan = await api('/api/meal-plan', { method: 'POST', body: JSON.stringify({ name: 'This Week', week_start: monday }) });
    } else {
      mealPlan = plans[0];
    }
    renderPlanner();
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${e.message}</div></div>`;
  }
}

function renderPlanner() {
  const grid = document.getElementById('planner-grid');
  if (!mealPlan) { grid.innerHTML = ''; return; }
  grid.innerHTML = DAYS.map((day, di) => {
    const dayData = mealPlan.calendar[di] || { meals: {} };
    const slotsHtml = SLOTS.map(slot => {
      const entries = dayData.meals[slot] || [];
      const entriesHtml = entries.map(e => `
        <div class="slot-entry">
          <span class="slot-entry-title" title="${escHtml(e.recipe.title)}">${escHtml(e.recipe.title)}</span>
          ${e.recipe.macros_per_serving?.calories ? `<span class="slot-entry-cal">${Math.round(e.recipe.macros_per_serving.calories)}</span>` : ''}
          <button class="slot-remove" onclick="removeEntry(${mealPlan.id}, ${e.id})" title="Remove">✕</button>
        </div>`).join('');
      return `
        <div class="planner-slot">
          <div class="slot-label">${SLOT_ICONS[slot]} ${slot}</div>
          ${entriesHtml}
          <button class="slot-add" onclick="openPicker(${di}, '${slot}')" title="Add recipe">+</button>
        </div>`;
    }).join('');
    return `
      <div class="planner-day">
        <div class="planner-day-header">${day}</div>
        <div class="planner-slots">${slotsHtml}</div>
      </div>`;
  }).join('');
}

function getMonday() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d.setDate(diff));
  return mon.toISOString().split('T')[0];
}

async function removeEntry(planId, entryId) {
  await api(`/api/meal-plan/${planId}/entries/${entryId}`, { method: 'DELETE' });
  mealPlan = await api(`/api/meal-plan/${planId}`);
  renderPlanner();
}

function openPicker(dayIndex, slot) {
  pickerTarget = { dayIndex, slot };
  const list = document.getElementById('picker-list');
  list.innerHTML = allRecipes.length
    ? allRecipes.map(r => `
        <div class="picker-item" onclick="pickRecipe(${r.id})">
          <div class="picker-item-title">${escHtml(r.title)}</div>
          <div class="picker-item-meta">${formatMealType(r.meal_type) || '—'} · ${macroLine(r.macros_per_serving)}</div>
        </div>`).join('')
    : '<div style="color:var(--text3);padding:16px">No recipes in library yet.</div>';
  document.getElementById('picker-modal').classList.remove('hidden');
}

async function pickRecipe(recipeId) {
  closePickerModal();
  if (!pickerTarget || !mealPlan) return;
  await api(`/api/meal-plan/${mealPlan.id}/entries`, {
    method: 'POST',
    body: JSON.stringify({ recipe_id: recipeId, day_of_week: pickerTarget.dayIndex, meal_slot: pickerTarget.slot, servings: 1 }),
  });
  mealPlan = await api(`/api/meal-plan/${mealPlan.id}`);
  renderPlanner();
}

function closePickerModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('picker-modal').classList.add('hidden');
}

async function aiAlignPlan() {
  if (!mealPlan) { alert('No meal plan loaded.'); return; }
  let diet;
  try { diet = await api('/api/diet/active'); } catch (_) {
    alert('No diet plan set. Go to Diet Goals tab first.'); return;
  }
  if (!confirm('Claude will fill your week with recipes that best match your diet goals. Current entries will be replaced.')) return;
  const btn = document.querySelector('.btn-purple');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Aligning…';
  try {
    mealPlan = await api('/api/meal-plan/ai-align', {
      method: 'POST',
      body: JSON.stringify({ meal_plan_id: mealPlan.id, diet_plan_id: diet.id }),
    });
    renderPlanner();
  } catch (e) { alert('AI align failed: ' + e.message); }
  finally { btn.disabled = false; btn.innerHTML = '✨ AI Align to Diet'; }
}

async function generateShoppingList() {
  if (!mealPlan) { alert('No meal plan loaded.'); return; }
  try {
    const lists = await api('/api/shopping-lists/generate-from-plan', {
      method: 'POST',
      body: JSON.stringify({ meal_plan_id: mealPlan.id, name: 'Weekly Shopping', grocery_runs: 1 }),
    });
    alert(`✅ Shopping list created with ${lists[0].total_items} items.`);
    // Switch to shopping tab
    document.querySelector('.tab-btn[data-tab="shopping"]').click();
  } catch (e) { alert('Failed: ' + e.message); }
}

// ── RECIPE PICKER FOR SHOPPING LIST ───────────────────────────────────────

let shopSelectedIds = new Set();

let _shopPickerMode = 'new'; // 'new' | 'add'

async function openRecipePicker() {
  _shopPickerMode = 'new';
  document.querySelector('#recipe-shop-modal h2').textContent = 'Choose Recipes';
  document.getElementById('shop-list-name').closest('div').style.display = '';
  await _openShopModal();
}

async function openAddToListPicker() {
  if (!activeListId) return;
  _shopPickerMode = 'add';
  document.querySelector('#recipe-shop-modal h2').textContent = 'Add Recipes to List';
  document.getElementById('shop-list-name').closest('div').style.display = 'none';
  await _openShopModal();
}

async function _openShopModal() {
  shopSelectedIds.clear();
  const modal = document.getElementById('recipe-shop-modal');
  modal.classList.remove('hidden');
  document.getElementById('shop-recipe-search').value = '';
  const listEl = document.getElementById('shop-recipe-list');
  listEl.innerHTML = '<div class="loading-state"><span class="spinner"></span></div>';

  try {
    const recipes = await api('/api/recipes');
    allRecipes = recipes;
    renderShopRecipeList(recipes);
  } catch (e) {
    listEl.innerHTML = `<div style="color:var(--red);padding:8px">${e.message}</div>`;
  }
}

function renderShopRecipeList(recipes) {
  const listEl = document.getElementById('shop-recipe-list');
  if (!recipes.length) {
    listEl.innerHTML = '<div class="empty-state" style="padding:24px">No recipes found.</div>';
    return;
  }
  listEl.innerHTML = recipes.map(r => `
    <div class="shop-recipe-row ${shopSelectedIds.has(r.id) ? 'selected' : ''}" onclick="toggleShopRecipe(${r.id}, this)">
      <div class="shop-recipe-check">${shopSelectedIds.has(r.id) ? '✓' : ''}</div>
      <div class="shop-recipe-info">
        <div class="shop-recipe-title">${escHtml(r.title)}</div>
        ${r.meal_type ? `<span class="meal-badge ${r.meal_type}" style="font-size:11px">${r.meal_type}</span>` : ''}
      </div>
    </div>`).join('');
  updateShopCount();
}

function toggleShopRecipe(id, el) {
  if (shopSelectedIds.has(id)) {
    shopSelectedIds.delete(id);
    el.classList.remove('selected');
    el.querySelector('.shop-recipe-check').textContent = '';
  } else {
    shopSelectedIds.add(id);
    el.classList.add('selected');
    el.querySelector('.shop-recipe-check').textContent = '✓';
  }
  updateShopCount();
}

function updateShopCount() {
  const n = shopSelectedIds.size;
  document.getElementById('shop-selected-count').textContent =
    n === 0 ? '0 selected' : `${n} recipe${n !== 1 ? 's' : ''} selected`;
}

function filterShopRecipes(q) {
  const filtered = allRecipes.filter(r => r.title.toLowerCase().includes(q.toLowerCase()));
  renderShopRecipeList(filtered);
}

function closeRecipeShopModal(e) {
  if (e && e.target !== document.getElementById('recipe-shop-modal')) return;
  document.getElementById('recipe-shop-modal').classList.add('hidden');
}

async function generateFromSelectedRecipes() {
  if (!shopSelectedIds.size) { alert('Select at least one recipe.'); return; }
  try {
    if (_shopPickerMode === 'add' && activeListId) {
      await api(`/api/shopping-lists/${activeListId}/add-recipes`, {
        method: 'POST',
        body: JSON.stringify({ recipe_ids: [...shopSelectedIds] }),
      });
      document.getElementById('recipe-shop-modal').classList.add('hidden');
      await selectList(activeListId);
    } else {
      const name = document.getElementById('shop-list-name').value.trim() || 'My Shopping List';
      await api('/api/shopping-lists/generate-from-recipes', {
        method: 'POST',
        body: JSON.stringify({ recipe_ids: [...shopSelectedIds], name }),
      });
      document.getElementById('recipe-shop-modal').classList.add('hidden');
      document.querySelector('.tab-btn[data-tab="shopping"]').click();
    }
  } catch (e) { alert('Failed: ' + e.message); }
}

// ── SHOPPING ───────────────────────────────────────────────────────────────

const CAT_ICONS  = { produce:'🥦', protein:'🥩', dairy:'🥛', pantry:'🥫', frozen:'🧊', spice:'🌶️', beverage:'🧃', other:'📦' };
const CAT_COLORS = { produce:'#16a34a', protein:'#dc2626', dairy:'#2563eb', pantry:'#d97706', frozen:'#7c3aed', spice:'#db2777', beverage:'#0891b2', other:'#475569' };

async function loadShoppingLists() {
  try {
    shoppingLists = await api('/api/shopping-lists');
    renderListTabs();
    if (shoppingLists.length) {
      await selectList(shoppingLists[0].id);
    } else {
      document.getElementById('shopping-list-content').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🛒</div>
          <div class="empty-title">No shopping lists yet</div>
          <div class="empty-sub">Build a meal plan and generate a list.</div>
        </div>`;
    }
  } catch (e) { console.error(e); }
}

function renderListTabs() {
  const tabs = document.getElementById('shopping-list-tabs');
  const tabBtns = shoppingLists.map(l => `
    <button class="list-tab-btn ${l.id === activeListId ? 'active' : ''}" onclick="selectList(${l.id})">
      ${escHtml(l.name)}
    </button>`).join('');
  const clearBtn = activeListId
    ? `<button class="btn btn-ghost btn-sm" style="margin-left:auto;color:var(--red)" onclick="clearShoppingList(${activeListId})">🗑 Clear List</button>`
    : '';
  tabs.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${tabBtns}${clearBtn}</div>`;

  // Show/hide the header-level "Add Recipes" button
  const addBtn = document.getElementById('btn-add-to-list');
  if (addBtn) addBtn.classList.toggle('hidden', !activeListId);
}

async function clearShoppingList(id) {
  if (!confirm('Remove this shopping list? This cannot be undone.')) return;
  try {
    await api(`/api/shopping-lists/${id}`, { method: 'DELETE' });
    activeListId = null;
    await loadShoppingLists();
  } catch (e) { alert('Failed to delete list: ' + e.message); }
}

async function selectList(id) {
  activeListId = id;
  renderListTabs();
  try {
    const list = await api(`/api/shopping-lists/${id}`);
    renderShoppingList(list);
  } catch (e) { console.error(e); }
}

function renderShoppingList(list) {
  const total   = list.total_items;
  const checked = list.checked_count;
  const pct     = total > 0 ? Math.round((checked / total) * 100) : 0;

  let html = `
    <div class="list-progress-bar"><div class="list-progress-fill" style="width:${pct}%"></div></div>
    <div class="list-progress-text">${checked} of ${total} items checked</div>`;

  const cats = list.items_by_category || {};
  for (const [cat, items] of Object.entries(cats)) {
    const icon  = CAT_ICONS[cat]  || '📦';
    const color = CAT_COLORS[cat] || '#475569';
    const itemsHtml = items.map(item => `
      <div class="list-item" onclick="toggleItem(${list.id}, ${item.id}, ${!item.is_checked})">
        <div class="item-checkbox ${item.is_checked ? 'checked' : ''}">${item.is_checked ? '✓' : ''}</div>
        <div class="item-text ${item.is_checked ? 'checked' : ''}">${escHtml(item.display_text)}</div>
      </div>`).join('');
    html += `
      <div class="category-block">
        <div class="category-header">
          <span class="category-icon">${icon}</span>
          <span class="category-name" style="color:${color}">${cat.charAt(0).toUpperCase() + cat.slice(1)}</span>
          <span class="category-count">${items.length}</span>
        </div>
        <div class="category-items">${itemsHtml}</div>
      </div>`;
  }

  document.getElementById('shopping-list-content').innerHTML = html;
}

async function toggleItem(listId, itemId, newState) {
  try {
    await api(`/api/shopping-lists/${listId}/items/${itemId}/toggle`, {
      method: 'PATCH',
      body: JSON.stringify({ is_checked: newState }),
    });
    await selectList(listId);
  } catch (e) { console.error(e); }
}

// ── DIET CHAT (in Shopping sidebar) ───────────────────────────────────────

async function submitDietChat() {
  const input  = document.getElementById('diet-chat-input');
  const msgs   = document.getElementById('diet-chat-messages');
  const status = document.getElementById('diet-chat-status');
  const text   = input.value.trim();
  if (!text) return;

  // Show user bubble
  msgs.innerHTML += `<div class="chat-bubble user">${escHtml(text)}</div>`;
  msgs.scrollTop = msgs.scrollHeight;
  input.value = '';

  showStatus(status, 'loading', '⏳ Analyzing your diet goals…');

  try {
    const plan = await api('/api/diet/from-text', {
      method: 'POST',
      body: JSON.stringify({ description: text }),
    });
    activeDiet = plan;
    status.classList.add('hidden');
    msgs.innerHTML += `
      <div class="chat-bubble response">
        ✅ <strong>Diet plan saved!</strong><br>
        ${plan.daily_targets.calories ? `🔥 ${Math.round(plan.daily_targets.calories)} cal/day` : ''}
        ${plan.daily_targets.protein_g ? `· 💪 ${Math.round(plan.daily_targets.protein_g)}g protein` : ''}<br>
        <em>${plan.goals || ''}</em>
      </div>`;
    msgs.scrollTop = msgs.scrollHeight;
    renderDietDisplay(plan);
  } catch (e) {
    showStatus(status, 'error', '❌ ' + e.message);
  }
}

// Allow Cmd/Ctrl+Enter to submit
document.getElementById('diet-chat-input').addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitDietChat();
});

async function uploadDietPdf(event) {
  const file = event.target.files[0];
  if (!file) return;
  const msgs   = document.getElementById('diet-chat-messages');
  const status = document.getElementById('diet-chat-status');
  msgs.innerHTML += `<div class="chat-bubble user">📎 Uploading: ${escHtml(file.name)}</div>`;
  msgs.scrollTop = msgs.scrollHeight;
  showStatus(status, 'loading', '⏳ Reading PDF and analyzing diet plan…');
  const form = new FormData();
  form.append('file', file);
  form.append('name', file.name.replace('.pdf',''));
  try {
    const res = await fetch(API + '/api/diet/from-pdf', { method: 'POST', body: form });
    if (!res.ok) throw new Error((await res.json()).detail);
    const plan = await res.json();
    activeDiet = plan;
    status.classList.add('hidden');
    msgs.innerHTML += `<div class="chat-bubble response">✅ <strong>Diet plan extracted from PDF!</strong><br>${plan.goals || ''}</div>`;
    msgs.scrollTop = msgs.scrollHeight;
    renderDietDisplay(plan);
  } catch (e) {
    showStatus(status, 'error', '❌ ' + e.message);
  }
  event.target.value = '';
}

// ── DIET GOALS TAB ─────────────────────────────────────────────────────────

async function loadDietPlan() {
  try {
    activeDiet = await api('/api/diet/active');
    renderDietDisplay(activeDiet);
  } catch (_) {
    document.getElementById('diet-plan-display').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🥗</div>
        <div class="empty-title">No diet plan set</div>
        <div class="empty-sub">Use the form on the right to configure your goals.</div>
      </div>`;
  }
}

function renderDietDisplay(plan) {
  const el = document.getElementById('diet-plan-display');
  if (!plan) return;
  const mt = plan.meal_targets || {};
  const mealRows = Object.entries(mt).map(([slot, t]) => `
    <tr>
      <td>${formatMealType(slot)}</td>
      <td>${t.calories != null ? Math.round(t.calories) : '—'}</td>
      <td>${t.protein_g != null ? Math.round(t.protein_g) + 'g' : '—'}</td>
      <td>${t.carbs_g != null ? Math.round(t.carbs_g) + 'g' : '—'}</td>
      <td>${t.fat_g != null ? Math.round(t.fat_g) + 'g' : '—'}</td>
    </tr>`).join('');

  const restrictions = plan.restrictions?.length
    ? `<div class="restrictions-row">${plan.restrictions.map(r => `<span class="restriction-tag">${escHtml(r)}</span>`).join('')}</div>` : '';

  el.innerHTML = `
    <div class="diet-plan-card">
      <div class="diet-plan-title">${escHtml(plan.name)}</div>
      ${plan.diet_type ? `<div class="diet-plan-type">${escHtml(plan.diet_type)}</div>` : ''}
      ${plan.goals ? `<p style="color:var(--text2);font-size:14px;line-height:1.6;margin-bottom:16px">${escHtml(plan.goals)}</p>` : ''}
      <div class="macro-grid">
        ${plan.daily_targets.calories != null ? `<div class="macro-tile"><div class="macro-value" style="color:var(--macro-cal)">${Math.round(plan.daily_targets.calories)}</div><div class="macro-label">Cal/day</div></div>` : ''}
        ${plan.daily_targets.protein_g != null ? `<div class="macro-tile"><div class="macro-value" style="color:var(--macro-protein)">${Math.round(plan.daily_targets.protein_g)}g</div><div class="macro-label">Protein</div></div>` : ''}
        ${plan.daily_targets.carbs_g   != null ? `<div class="macro-tile"><div class="macro-value" style="color:var(--macro-carbs)">${Math.round(plan.daily_targets.carbs_g)}g</div><div class="macro-label">Carbs</div></div>` : ''}
        ${plan.daily_targets.fat_g     != null ? `<div class="macro-tile"><div class="macro-value" style="color:var(--macro-fat)">${Math.round(plan.daily_targets.fat_g)}g</div><div class="macro-label">Fat</div></div>` : ''}
      </div>
      ${mealRows ? `
        <div class="modal-section-title" style="margin-top:8px">Per-Meal Targets</div>
        <table class="meal-targets-table">
          <thead><tr><th>Meal</th><th>Cal</th><th>Protein</th><th>Carbs</th><th>Fat</th></tr></thead>
          <tbody>${mealRows}</tbody>
        </table>` : ''}
      ${restrictions}
      ${plan.analysis ? `<details style="margin-top:12px"><summary style="cursor:pointer;color:var(--text3);font-size:13px">Full Analysis</summary><p style="color:var(--text2);font-size:13px;line-height:1.6;margin-top:8px">${escHtml(plan.analysis)}</p></details>` : ''}
      <button class="btn btn-danger btn-sm" style="margin-top:16px" onclick="deleteDietPlan(${plan.id})">🗑 Remove Plan</button>
    </div>`;
}

function setDietMode(mode) {
  document.querySelectorAll('#diet-mode-toggle .mode-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`#diet-mode-toggle .mode-btn[data-mode="${mode}"]`).classList.add('active');
  document.getElementById('diet-text-mode').classList.toggle('hidden', mode !== 'text');
  document.getElementById('diet-pdf-mode').classList.toggle('hidden', mode !== 'pdf');
}

async function analyzeDietText() {
  const text = document.getElementById('diet-goals-text').value.trim();
  const name = document.getElementById('diet-plan-name').value.trim() || 'My Diet Plan';
  const status = document.getElementById('diet-analyze-status');
  if (!text) { showStatus(status, 'error', 'Please describe your goals first.'); return; }

  const btn = document.querySelector('#diet-text-mode .btn-primary');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Analyzing…';
  showStatus(status, 'loading', '⏳ Analyzing your diet goals…');

  try {
    activeDiet = await api('/api/diet/from-text', { method: 'POST', body: JSON.stringify({ description: text, name }) });
    showStatus(status, 'success', `✅ Diet plan "${activeDiet.name}" saved.`);
    renderDietDisplay(activeDiet);
  } catch (e) {
    showStatus(status, 'error', '❌ ' + e.message);
  } finally {
    btn.disabled = false; btn.innerHTML = '✨ Analyze & Save';
  }
}

async function analyzeDietPdf(event) {
  const file = event.target.files[0];
  const name = document.getElementById('diet-plan-name').value.trim() || file.name.replace('.pdf','');
  const status = document.getElementById('diet-analyze-status');
  if (!file) return;
  showStatus(status, 'loading', `⏳ Reading "${file.name}"…`);
  const form = new FormData();
  form.append('file', file);
  form.append('name', name);
  try {
    const res = await fetch(API + '/api/diet/from-pdf', { method: 'POST', body: form });
    if (!res.ok) throw new Error((await res.json()).detail);
    activeDiet = await res.json();
    showStatus(status, 'success', `✅ Diet plan extracted from PDF.`);
    renderDietDisplay(activeDiet);
  } catch (e) {
    showStatus(status, 'error', '❌ ' + e.message);
  }
  event.target.value = '';
}

async function deleteDietPlan(id) {
  if (!confirm('Delete this diet plan?')) return;
  await api(`/api/diet/${id}`, { method: 'DELETE' });
  activeDiet = null;
  loadDietPlan();
}

// ── Utility ────────────────────────────────────────────────────────────────

function showStatus(el, type, msg) {
  el.className = 'import-status ' + type;
  el.textContent = msg;
  el.classList.remove('hidden');
}

/**
 * Show an animated import status with progress bar, percentage, step messages, and elapsed timer.
 * steps: [{msg, duration}] — duration is seconds before advancing; last step should use 999.
 * Progress caps at 95% until stop() is called, then animates to 100%.
 * Returns a stop() function to call when the request completes.
 */
function startImportTimer(el, steps) {
  el.classList.remove('hidden');
  el.className = 'import-status loading';
  el.style.cssText = 'padding:14px 16px;line-height:1.5';

  const totalExpected = steps.reduce((s, x) => s + (x.duration < 999 ? x.duration : 0), 0) || 30;

  let stepIdx = 0;
  let elapsed = 0;
  let stepElapsed = 0;
  let pct = 0;

  function calcPct() {
    let completedSecs = 0;
    for (let i = 0; i < stepIdx; i++) completedSecs += steps[i].duration < 999 ? steps[i].duration : 0;
    const cur = steps[stepIdx];
    const curDur = cur.duration < 999 ? cur.duration : totalExpected * 0.25;
    const withinStep = Math.min(stepElapsed, curDur);
    const raw = ((completedSecs + withinStep) / totalExpected) * 100;
    return Math.min(raw, 95);
  }

  function render(overridePct) {
    pct = overridePct !== undefined ? overridePct : calcPct();
    const step = steps[stepIdx];
    const barColor = pct < 50
      ? `linear-gradient(90deg, #f59e0b, #f97316)`
      : pct < 85
        ? `linear-gradient(90deg, #f97316, #a855f7)`
        : `linear-gradient(90deg, #a855f7, #6366f1)`;
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:13px;font-weight:500">${step.msg}</span>
        <span style="font-size:11px;opacity:.55;font-variant-numeric:tabular-nums">${elapsed}s elapsed</span>
      </div>
      <div style="background:var(--border);border-radius:99px;height:8px;overflow:hidden;margin-bottom:6px">
        <div style="
          height:100%;width:${pct.toFixed(1)}%;
          background:${barColor};border-radius:99px;
          transition:width .7s cubic-bezier(.4,0,.2,1);
          box-shadow:0 0 8px rgba(168,85,247,.4);
        "></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:11px;opacity:.45">${steps.map((s, i) => i === stepIdx
          ? `<b style="opacity:1;color:var(--accent)">${s.msg.split(' ').slice(1).join(' ')}</b>`
          : `<span style="opacity:.4">${s.msg.split(' ').slice(1).join(' ')}</span>`).join(' → ')}</span>
        <span style="font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--accent)">${Math.round(pct)}%</span>
      </div>`;
  }

  render();

  const interval = setInterval(() => {
    elapsed++;
    stepElapsed++;
    if (stepElapsed >= steps[stepIdx].duration && stepIdx < steps.length - 1) {
      stepIdx++;
      stepElapsed = 0;
    }
    render();
  }, 1000);

  /**
   * Call when the API responds. Fast-forwards through any unvisited steps
   * (700 ms each), then animates to 100% and resolves the returned Promise.
   * Await this before showing the success message so the bar always completes.
   */
  function complete() {
    clearInterval(interval);
    return new Promise(resolve => {
      // Step through any remaining steps quickly
      function advance() {
        if (stepIdx < steps.length - 1) {
          stepIdx++;
          stepElapsed = 0;
          render();
          setTimeout(advance, 700);
        } else {
          // On last step — show it briefly then go to 100%
          setTimeout(() => {
            el.innerHTML = `
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <span style="font-size:13px;font-weight:500">✅ Done!</span>
                <span style="font-size:11px;opacity:.55;font-variant-numeric:tabular-nums">${elapsed}s elapsed</span>
              </div>
              <div style="background:var(--border);border-radius:99px;height:8px;overflow:hidden;margin-bottom:6px">
                <div style="
                  height:100%;width:100%;
                  background:linear-gradient(90deg,#22c55e,#16a34a);
                  border-radius:99px;transition:width .5s ease;
                  box-shadow:0 0 8px rgba(34,197,94,.4);
                "></div>
              </div>
              <div style="display:flex;justify-content:flex-end">
                <span style="font-size:13px;font-weight:700;color:#22c55e">100%</span>
              </div>`;
            setTimeout(resolve, 400);
          }, 600);
        }
      }
      advance();
    });
  }

  return complete;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── DISCOVER (public library) ──────────────────────────────────────────────

let _discoverAll = [];
let _discoverMealFilter = '';

async function loadDiscover() {
  const grid = document.getElementById('discover-grid');
  const count = document.getElementById('discover-count');
  const forYouSection = document.getElementById('discover-for-you');
  grid.innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading public recipes…</div>';

  try {
    // Load personalized recommendations and full library in parallel
    const [recs, allData] = await Promise.all([
      _authUser ? api('/api/public/recommended').catch(() => null) : Promise.resolve(null),
      api('/api/public/recipes'),
    ]);
    _discoverAll = allData.recipes || [];
    count.textContent = `${_discoverAll.length} recipes`;

    // Show "For You" section if we have personalized picks
    if (forYouSection && recs?.personalized && recs.recipes?.length) {
      forYouSection.innerHTML = `
        <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);font-weight:600;margin-bottom:10px">
          ✨ For You
        </div>
        <div class="recipe-grid" style="margin-bottom:0">${
          recs.recipes.map(r => {
            const thumb = thumbUrl(r.thumbnail_url);
            const thumbHtml = thumb
              ? `<img class="recipe-thumb" src="${thumb}" alt="${escHtml(r.title)}" loading="lazy" />`
              : `<div class="recipe-thumb-placeholder" style="background:${foodGradient(r.id || r.title)}"><div class="recipe-thumb-overlay"></div></div>`;
            return `<div class="public-recipe-card" onclick="viewPublicRecipe('${escHtml(r.id)}')" style="cursor:pointer">
              ${thumbHtml}
              <div class="recipe-card-body">
                <div class="recipe-card-title">${escHtml(r.title)}</div>
                <div class="recipe-card-meta">${slotPill(r.meal_type)}${r.cuisine ? `<span style="color:var(--text3);font-size:11.5px;font-weight:500">${escHtml(r.cuisine)}</span>` : ''}</div>
              </div>
              <div class="public-card-footer" onclick="event.stopPropagation()">
                <button class="btn btn-primary btn-sm btn-full" onclick="savePublicRecipe('${escHtml(r.id)}', this)">+ Save to My Library</button>
              </div>
            </div>`;
          }).join('')
        }</div>
        <div style="height:1px;background:var(--border);margin:20px 0 4px"></div>
        <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);font-weight:600;margin-bottom:10px">
          All Recipes
        </div>`;
      forYouSection.classList.remove('hidden');
    } else if (forYouSection) {
      forYouSection.classList.add('hidden');
    }

    renderDiscover(_discoverAll);
  } catch (e) {
    grid.innerHTML = `<div class="loading-state" style="color:var(--red)">Could not load public recipes.</div>`;
  }
}

function renderDiscover(recipes) {
  const grid = document.getElementById('discover-grid');
  if (!recipes.length) {
    grid.innerHTML = '<div class="loading-state">No recipes found.</div>';
    return;
  }
  grid.innerHTML = recipes.map(r => {
    const thumb = thumbUrl(r.thumbnail_url);
    const thumbHtml = thumb
      ? `<img class="recipe-thumb" src="${thumb}" alt="${escHtml(r.title)}" loading="lazy" />`
      : `<div class="recipe-thumb-placeholder" style="background:${foodGradient(r.id || r.title)}"><div class="recipe-thumb-overlay"></div></div>`;
    const pubMacros = r.calories
      ? `<div class="recipe-macros">
           <span class="macro-item" style="color:var(--macro-cal)">${Math.round(r.calories)}<span class="macro-unit"> cal</span></span>
           ${r.protein_g ? `<span class="macro-item" style="color:var(--macro-protein)">${Math.round(r.protein_g)}g<span class="macro-unit"> P</span></span>` : ''}
         </div>` : '';
    return `<div class="public-recipe-card" onclick="viewPublicRecipe('${escHtml(r.id)}')" style="cursor:pointer">
      ${thumbHtml}
      <div class="recipe-card-body">
        <div class="recipe-card-title">${escHtml(r.title)}</div>
        <div class="recipe-card-meta">
          ${slotPill(r.meal_type)}
          ${r.cuisine ? `<span style="color:var(--text3);font-size:11.5px;font-weight:500">${escHtml(r.cuisine)}</span>` : ''}
        </div>
        ${pubMacros}
      </div>
      <div class="public-card-footer" onclick="event.stopPropagation()">
        <button class="btn btn-primary btn-sm btn-full" data-pub-id="${escHtml(r.id)}" onclick="savePublicRecipe('${escHtml(r.id)}', this)">
          + Save to My Library
        </button>
      </div>
    </div>`;
  }).join('');
}

function viewPublicRecipe(pubId) {
  const r = _discoverAll.find(x => x.id === pubId);
  if (!r) return;
  const overlay = document.getElementById('recipe-modal');
  const content = document.getElementById('modal-content');
  overlay.classList.remove('hidden');

  const thumb = thumbUrl(r.thumbnail_url);
  const heroHtml = thumb
    ? `<img src="${thumb}" class="modal-hero" alt="${escHtml(r.title)}">`
    : `<div class="modal-hero-placeholder">🍽️</div>`;
  const totalTime = (r.prep_time_minutes || 0) + (r.cook_time_minutes || 0);
  const pills = [
    r.meal_type ? `<span class="meta-pill meal-badge ${r.meal_type}">${formatMealType(r.meal_type)}</span>` : '',
    r.cuisine   ? `<span class="meta-pill">🌍 ${escHtml(r.cuisine)}</span>` : '',
    totalTime   ? `<span class="meta-pill">⏱ ${totalTime} min</span>` : '',
    r.servings  ? `<span class="meta-pill">🍽 Serves ${r.servings}</span>` : '',
  ].filter(Boolean).join('');

  const macroHtml = r.calories != null ? `
    <div style="background:var(--bg);border-radius:14px;padding:16px;border:1px solid var(--border)">
      <div class="modal-section-title">Per Serving</div>
      <div class="macro-grid">
        <div class="macro-tile"><div class="macro-value" style="color:var(--macro-cal)">${Math.round(r.calories)}</div><div class="macro-label">Cal</div></div>
        ${r.protein_g != null ? `<div class="macro-tile"><div class="macro-value" style="color:var(--macro-protein)">${Math.round(r.protein_g)}g</div><div class="macro-label">Protein</div></div>` : ''}
        ${r.carbs_g   != null ? `<div class="macro-tile"><div class="macro-value" style="color:var(--macro-carbs)">${Math.round(r.carbs_g)}g</div><div class="macro-label">Carbs</div></div>` : ''}
        ${r.fat_g     != null ? `<div class="macro-tile"><div class="macro-value" style="color:var(--macro-fat)">${Math.round(r.fat_g)}g</div><div class="macro-label">Fat</div></div>` : ''}
      </div>
    </div>` : '';

  const ingredients = (r.ingredients || []).map(ing => {
    const cat = ing.category || 'other';
    const fg  = CATEGORY_COLORS[cat] || CATEGORY_COLORS.other;
    const bg  = CATEGORY_BG[cat]     || CATEGORY_BG.other;
    const em  = CATEGORY_EMOJI[cat]  || '•';
    return `
      <div class="ingredient-row">
        <div class="ingredient-icon" style="background:${bg};color:${fg}">${em}</div>
        <div class="ingredient-text">${escHtml(ing.raw_text || ing.name)}</div>
      </div>`;
  }).join('');

  const steps = (r.steps || []).map((s, i) => `
    <div class="step-row">
      <div class="step-circle${i === 0 ? ' step-first' : ''}">${i + 1}</div>
      <div class="step-text">${escHtml(s)}</div>
    </div>`).join('');

  const tags = r.tags?.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${r.tags.map(t => `<span class="restriction-tag">#${escHtml(t)}</span>`).join('')}</div>`
    : '';

  const pubThumb = thumbUrl(r.thumbnail_url);
  const pubHero = pubThumb
    ? `<img src="${pubThumb}" class="modal-hero" alt="${escHtml(r.title)}">`
    : `<div class="modal-hero-placeholder">🍽️</div>`;

  content.innerHTML = `
    ${pubHero}
    <div class="modal-body">
      <div>
        <div class="modal-title">${escHtml(r.title)}</div>
        ${r.description ? `<div class="modal-desc" style="margin-top:6px">${escHtml(r.description)}</div>` : ''}
      </div>
      <div class="modal-meta">${pills}</div>
      ${macroHtml}
      <div>
        <div class="modal-section-title">Ingredients</div>
        ${ingredients || '<div style="color:var(--text3)">No ingredients listed</div>'}
      </div>
      <div>
        <div class="modal-section-title">Instructions</div>
        ${steps || '<div style="color:var(--text3)">No steps listed</div>'}
      </div>
      ${tags}
      <button id="pub-modal-save-${escHtml(pubId)}" class="btn btn-primary" style="align-self:flex-start"
        onclick="savePublicRecipeFromModal('${escHtml(pubId)}', this)">
        + Save to My Library
      </button>
    </div>`;
}

async function savePublicRecipeFromModal(pubId, btn) {
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await api(`/api/public/recipes/${pubId}/save`, { method: 'POST' });
    btn.textContent = '✓ Saved!';
    btn.style.background = 'var(--green)';
    loadLibrary();
    // Mirror the state on the grid card
    const gridBtn = document.querySelector(`.public-recipe-card [data-pub-id="${pubId}"]`);
    if (gridBtn) { gridBtn.textContent = '✓ Saved'; gridBtn.disabled = true; gridBtn.style.background = 'var(--green)'; }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '+ Save to My Library';
    let errEl = btn.nextElementSibling;
    if (!errEl || !errEl.classList.contains('pub-modal-err')) {
      errEl = document.createElement('div');
      errEl.className = 'pub-modal-err';
      errEl.style.cssText = 'font-size:12px;color:var(--red);margin-top:6px';
      btn.after(errEl);
    }
    errEl.textContent = e.message;
  }
}

function filterDiscover() {
  const q = document.getElementById('discover-search').value.toLowerCase();
  const filtered = _discoverAll.filter(r => {
    const matchType = !_discoverMealFilter || r.meal_type === _discoverMealFilter;
    const matchQ = !q || (r.title + ' ' + (r.cuisine || '') + ' ' + (r.tags || []).join(' ')).toLowerCase().includes(q);
    return matchType && matchQ;
  });
  renderDiscover(filtered);
}

function setDiscoverFilter(el, type) {
  _discoverMealFilter = type;
  document.querySelectorAll('#discover-meal-filters .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  filterDiscover();
}

async function savePublicRecipe(pubId, btn) {
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const result = await api(`/api/public/recipes/${pubId}/save`, { method: 'POST' });
    btn.textContent = '✓ Saved!';
    btn.style.background = 'var(--green)';
    loadLibrary();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '+ Save to My Library';
    // Show the duplicate message or other error inline
    const card = btn.closest('.public-recipe-card');
    let errEl = card.querySelector('.discover-err');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'discover-err';
      errEl.style.cssText = 'font-size:11px;color:var(--red);padding:4px 12px 8px;line-height:1.4';
      card.appendChild(errEl);
    }
    errEl.textContent = e.message;
  }
}

// ── ADMIN DASHBOARD ────────────────────────────────────────────────────────

async function loadAdminStats() {
  const el = document.getElementById('admin-content');
  if (!el) return;
  el.innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading stats…</div>';
  try {
    const d = await api('/api/admin/stats');
    document.getElementById('admin-last-updated').textContent =
      'Updated ' + new Date().toLocaleTimeString();
    el.innerHTML = _renderAdminDashboard(d);
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${e.message}</div></div>`;
  }
}

function _adminStatCard(label, value, sub = '') {
  return `<div class="admin-stat-card">
    <div class="admin-stat-value">${value}</div>
    <div class="admin-stat-label">${label}</div>
    ${sub ? `<div class="admin-stat-sub">${sub}</div>` : ''}
  </div>`;
}

function _adminBar(label, count, total, color = 'var(--accent)') {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return `<div class="admin-bar-row">
    <div class="admin-bar-label">${escHtml(label)}</div>
    <div class="admin-bar-track">
      <div class="admin-bar-fill" style="width:${pct}%;background:${color}"></div>
    </div>
    <div class="admin-bar-count">${count}</div>
  </div>`;
}

function _renderAdminDashboard(d) {
  const u = d.users;
  const r = d.recipes;

  const thumbPct = r.total > 0 ? Math.round((r.with_thumbnail / r.total) * 100) : 0;
  const activePct = u.total > 0 ? Math.round((u.active / u.total) * 100) : 0;

  // Source type colours
  const srcColors = {
    instagram_reel:  '#e1306c',
    web_recipe:      '#2563eb',
    photo:           '#7c3aed',
    public_library:  '#16a34a',
    unknown:         '#64748b',
  };

  const srcTotal = Object.values(r.by_source).reduce((a, b) => a + b, 0);
  const srcBars  = Object.entries(r.by_source)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => _adminBar(k.replace('_', ' '), v, srcTotal, srcColors[k] || 'var(--accent)'))
    .join('');

  const mealTotal = Object.values(r.by_meal_type).reduce((a, b) => a + b, 0);
  const mealColors = { breakfast: '#f59e0b', lunch: '#3b82f6', dinner: '#8b5cf6', snack: '#10b981' };
  const mealBars = Object.entries(r.by_meal_type)
    .map(([k, v]) => _adminBar(k, v, mealTotal, mealColors[k] || 'var(--accent)'))
    .join('');

  const cuisineBars = r.top_cuisines.length
    ? r.top_cuisines.map(c => _adminBar(c.name, c.count, r.top_cuisines[0].count, '#0891b2')).join('')
    : '<div style="color:var(--text3);font-size:13px">No data yet</div>';

  const planTotal = Object.values(u.by_plan).reduce((a, b) => a + b, 0);
  const planBars  = Object.entries(u.by_plan)
    .map(([k, v]) => _adminBar(k, v, planTotal, k === 'pro' ? 'var(--accent)' : 'var(--text3)'))
    .join('');

  const fmtDate = iso => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const recentSignups = d.recent_signups.map(s => `
    <div class="admin-activity-row">
      <div class="admin-activity-avatar">${(s.name || s.email)[0].toUpperCase()}</div>
      <div>
        <div class="admin-activity-title">${escHtml(s.name || s.email.split('@')[0])}</div>
        <div class="admin-activity-sub">${escHtml(s.email)}</div>
      </div>
      <div class="admin-activity-time">${fmtDate(s.joined)}</div>
    </div>`).join('') || '<div style="color:var(--text3);font-size:13px">No signups yet</div>';

  const sourceIcon = { instagram_reel: '📹', web_recipe: '🌐', photo: '📸', public_library: '🌍' };
  const recentRecipes = d.recent_recipes.map(r => `
    <div class="admin-activity-row">
      <div class="admin-activity-icon">${sourceIcon[r.source] || '📄'}</div>
      <div style="flex:1;min-width:0">
        <div class="admin-activity-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.title)}</div>
        <div class="admin-activity-sub">${(r.source || '').replace('_', ' ')}</div>
      </div>
      <div class="admin-activity-time">${fmtDate(r.added)}</div>
    </div>`).join('') || '<div style="color:var(--text3);font-size:13px">No recipes yet</div>';

  return `
  <!-- Top stat cards -->
  <div class="admin-stat-grid">
    ${_adminStatCard('Total Users', u.total, `${u.new_7d} this week · ${u.new_30d} this month`)}
    ${_adminStatCard('Active Users', u.active, `${activePct}% have recipes`)}
    ${_adminStatCard('Total Recipes', r.total, `${r.new_7d} this week · ${r.new_30d} this month`)}
    ${_adminStatCard('Public Library', d.public_library.total, 'Federated across all users')}
    ${_adminStatCard('Avg Recipes / User', r.avg_per_active_user, 'Among users with recipes')}
    ${_adminStatCard('Thumbnails', `${thumbPct}%`, `${r.with_thumbnail} of ${r.total} recipes`)}
  </div>

  <!-- Three-column breakdown -->
  <div class="admin-panels">
    <div class="admin-panel">
      <div class="admin-panel-title">Recipe Source</div>
      ${srcBars || '<div style="color:var(--text3);font-size:13px">No data yet</div>'}
    </div>
    <div class="admin-panel">
      <div class="admin-panel-title">Meal Types</div>
      ${mealBars || '<div style="color:var(--text3);font-size:13px">No data yet</div>'}
    </div>
    <div class="admin-panel">
      <div class="admin-panel-title">Top Cuisines</div>
      ${cuisineBars}
    </div>
  </div>

  <!-- Ownership + plans -->
  <div class="admin-panels">
    <div class="admin-panel">
      <div class="admin-panel-title">Ownership</div>
      ${_adminBar('Authenticated', r.auth_owned, r.total, '#16a34a')}
      ${_adminBar('Anonymous', r.anon_owned, r.total, '#64748b')}
    </div>
    <div class="admin-panel">
      <div class="admin-panel-title">Plans</div>
      ${planBars || '<div style="color:var(--text3);font-size:13px">No memberships yet</div>'}
    </div>
    <div class="admin-panel" style="grid-column:span 1"></div>
  </div>

  <!-- Recent activity -->
  <div class="admin-panels" style="grid-template-columns:1fr 1fr">
    <div class="admin-panel">
      <div class="admin-panel-title">Recent Sign-ups</div>
      ${recentSignups}
    </div>
    <div class="admin-panel">
      <div class="admin-panel-title">Recent Recipes Added</div>
      ${recentRecipes}
    </div>
  </div>`;
}

// ── Init ───────────────────────────────────────────────────────────────────

_initAuth().then(() => {
  loadLibrary();
  loadDietPlan();
  checkBulkStatus();
  // Pre-load recipes for meal planner picker
  api('/api/recipes').then(r => { allRecipes = r; }).catch(() => {});
});
