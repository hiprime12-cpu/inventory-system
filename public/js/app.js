'use strict';

// ══════════════════════════════════════════════
//  상수
// ══════════════════════════════════════════════
const ROLE_LABELS = {
  pending: '승인대기',
  viewer:  '보기만',
  editor:  '등록및수정',
  admin:   '관리자',
};

const ROLE_CLASS = {
  pending: 'role-pending',
  viewer:  'role-viewer',
  editor:  'role-editor',
  admin:   'role-admin',
};

// 역할별 접근 가능 페이지
const PAGE_ACCESS = {
  admin:  ['dashboard','inventory','inbound','outbound','returns','purchase-vendors','sales-vendors','sales','users','trash','audit-log','company','profile'],
  editor: ['dashboard','inventory','inbound','outbound','returns','purchase-vendors','sales-vendors','sales','company','profile'],
  viewer: ['dashboard','inventory','company','profile'],
};

// ══════════════════════════════════════════════
//  상태
// ══════════════════════════════════════════════
let currentUser = null;

// ══════════════════════════════════════════════
//  API 헬퍼
// ══════════════════════════════════════════════
const API = {
  base: '/api',
  token: () => localStorage.getItem('token'),

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token()) headers['Authorization'] = `Bearer ${this.token()}`;

    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({}));

    // 401 → 로그인 요청이 아닌 경우에만 자동 로그아웃
    if (res.status === 401 && !path.endsWith('/auth/login')) {
      logout();
      throw new Error('세션이 만료되었습니다. 다시 로그인하세요.');
    }

    if (!res.ok) throw new Error(data.error || `오류가 발생했습니다. (${res.status})`);
    return data;
  },

  get:   (path)       => API.request('GET',    path),
  post:  (path, body) => API.request('POST',   path, body),
  put:   (path, body) => API.request('PUT',    path, body),
  patch: (path, body) => API.request('PATCH',  path, body),
  del:   (path)       => API.request('DELETE', path),
};

// ══════════════════════════════════════════════
//  토스트 알림
// ══════════════════════════════════════════════
function toast(msg, type = 'info', duration = 3000) {
  const wrap = document.getElementById('toast-wrap');
  const el   = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ══════════════════════════════════════════════
//  화면 전환
// ══════════════════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showPage(name) {
  const role = currentUser?.role;
  const allowed = PAGE_ACCESS[role] || [];

  if (!allowed.includes(name)) {
    toast('해당 페이지에 접근 권한이 없습니다.', 'error');
    showPage(role === 'viewer' ? 'inventory' : 'dashboard');
    return;
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(a => a.classList.remove('active'));

  const page = document.getElementById(`page-${name}`);
  if (page) page.classList.add('active');

  const nav = document.querySelector(`.nav-link[data-page="${name}"]`);
  if (nav) nav.classList.add('active');

  // 페이지 타이틀 업데이트
  const titles = {
    dashboard: '대시보드', inventory: '재고 현황',
    inbound: '입고관리',
    outbound: '출고 관리', returns: '반품/불량',
    'purchase-vendors': '매입거래처 관리',
    'sales-vendors':    '출고거래처 관리',
    sales: '매출/수익', users: '사용자 관리',
    trash: '휴지통', 'audit-log': '감사로그',
    company: '회사 정보', profile: '내 정보',
  };
  document.getElementById('page-title').textContent = titles[name] || name;

  // 페이지 로드 함수 호출
  const loaders = {
    dashboard: loadDashboard,
    inventory: () => loadInventory(),
    users:     loadUsers,
    'purchase-vendors': () => loadVendors('purchase'),
    'sales-vendors':    () => loadVendors('sales'),
    inbound:            () => loadInboundList(),
    outbound:           () => loadOutboundList(),
    returns:            () => loadReturnsList(),
    sales:              () => loadSalesList(),
    company:            () => loadCompanyInfo(),
    profile:            loadProfile,
    trash:              () => loadTrash(),
    'audit-log':        () => loadAuditLog(),
  };
  if (loaders[name]) loaders[name]();
}

// ══════════════════════════════════════════════
//  메뉴 권한 렌더링
// ══════════════════════════════════════════════
function renderNav(role) {
  // viewer: inventory/dashboard만
  // editor: admin 메뉴 제외
  // admin:  전체
  document.querySelectorAll('.nav-editor').forEach(li => {
    li.style.display = (role === 'editor' || role === 'admin') ? '' : 'none';
  });
  document.querySelectorAll('.nav-admin').forEach(li => {
    li.style.display = role === 'admin' ? '' : 'none';
  });
}

// ══════════════════════════════════════════════
//  역할 뱃지 헬퍼
// ══════════════════════════════════════════════
function roleChip(role) {
  const label = ROLE_LABELS[role] || role;
  const cls   = ROLE_CLASS[role]  || '';
  return `<span class="role-chip ${cls}">${label}</span>`;
}

function fmtPhone(phone) {
  if (!phone) return '-';
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 11) return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;
  if (d.length === 10) {
    if (d.startsWith('02')) return `${d.slice(0,2)}-${d.slice(2,6)}-${d.slice(6)}`;
    return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
  }
  return d || '-';
}

function fmtBizNum(num) {
  if (!num) return '-';
  const d = String(num).replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,5)}-${d.slice(5)}`;
  return d || '-';
}

function fmtDate(str) {
  if (!str) return '-';
  return str.slice(0, 10);
}

function fmtAccountNumber(digits) {
  if (!digits) return '-';
  const d = String(digits).replace(/\D/g, '');
  if (!d) return '-';
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0,3)}-${d.slice(3)}`;
  return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
}

function fmtDateTime(str) {
  if (!str) return '-';
  return str.replace('T', ' ').slice(0, 16);
}

function truncate(str, max = 18) {
  if (!str) return '-';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ── 듀얼 스크롤바 연동 (상단↔하단 가로 스크롤 동기화) ──────────
function initDualScroll(wrapEl, topBarEl) {
  if (!wrapEl || !topBarEl) return;
  const inner = topBarEl.querySelector('.dual-scroll-inner');
  if (!inner) return;
  const syncWidth = () => { inner.style.width = wrapEl.scrollWidth + 'px'; };
  requestAnimationFrame(syncWidth);
  new ResizeObserver(syncWidth).observe(wrapEl);
  let syncTop = false, syncBot = false;
  topBarEl.addEventListener('scroll', () => {
    if (syncBot) return; syncTop = true;
    wrapEl.scrollLeft = topBarEl.scrollLeft;
    syncTop = false;
  });
  wrapEl.addEventListener('scroll', () => {
    if (syncTop) return; syncBot = true;
    topBarEl.scrollLeft = wrapEl.scrollLeft;
    syncBot = false;
  });
}

function licenseDisplayName(filename) {
  if (!filename) return null;
  const ext = filename.split('.').pop().toLowerCase();
  return `사업자등록증.${ext}`;
}

// ══════════════════════════════════════════════
//  로그인 화면
// ══════════════════════════════════════════════
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('login-err');
  errEl.classList.add('hidden');

  const identifier = document.getElementById('login-id').value.trim();
  const password   = document.getElementById('login-pw').value;

  try {
    const { token, user } = await API.post('/auth/login', { identifier, password });
    localStorage.setItem('token', token);
    localStorage.setItem('user',  JSON.stringify(user));
    currentUser = user;
    initApp(user);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('go-register').addEventListener('click', (e) => {
  e.preventDefault();
  showScreen('screen-register');
});

// ══════════════════════════════════════════════
//  회원가입 화면
// ══════════════════════════════════════════════
document.getElementById('go-login').addEventListener('click', (e) => {
  e.preventDefault();
  showScreen('screen-login');
});

// 비밀번호 확인 실시간 검사
document.getElementById('reg-pw2').addEventListener('input', () => {
  const pw  = document.getElementById('reg-pw').value;
  const pw2 = document.getElementById('reg-pw2').value;
  const err = document.getElementById('pw2-err');
  if (pw2 && pw !== pw2) {
    err.textContent = '비밀번호가 일치하지 않습니다.';
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }
});

document.getElementById('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msgEl = document.getElementById('reg-msg');
  msgEl.className = 'hidden';

  const name     = document.getElementById('reg-name').value.trim();
  const username = document.getElementById('reg-username').value.trim();
  const pw       = document.getElementById('reg-pw').value;
  const pw2      = document.getElementById('reg-pw2').value;

  // 클라이언트 유효성 검사
  if (username.length < 3) {
    document.getElementById('username-err').textContent = '아이디는 3자 이상이어야 합니다.';
    document.getElementById('username-err').classList.remove('hidden');
    return;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    document.getElementById('username-err').textContent = '영문, 숫자, 밑줄(_)만 사용 가능합니다.';
    document.getElementById('username-err').classList.remove('hidden');
    return;
  }
  document.getElementById('username-err').classList.add('hidden');
  if (pw !== pw2) {
    document.getElementById('pw2-err').textContent = '비밀번호가 일치하지 않습니다.';
    document.getElementById('pw2-err').classList.remove('hidden');
    return;
  }
  if (pw.length < 6) {
    toast('비밀번호는 6자 이상이어야 합니다.', 'error');
    return;
  }

  try {
    const data = await API.post('/auth/register', { name, username, password: pw });
    msgEl.textContent = data.message;
    msgEl.className   = 'msg-success';
    document.getElementById('form-register').reset();
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className   = 'msg-error';
  }
});

// ══════════════════════════════════════════════
//  앱 초기화
// ══════════════════════════════════════════════
function initApp(user) {
  currentUser = user;

  // 뷰어 권한: 매입가/순수익 숨김 모드
  document.body.classList.toggle('viewer-mode', user.role === 'viewer');

  // 헤더/사이드바 사용자 정보
  document.getElementById('sb-user-name').textContent = user.name;
  document.getElementById('sb-user-role').innerHTML   = roleChip(user.role);
  document.getElementById('hdr-user').textContent     = user.name;
  document.getElementById('hdr-role').innerHTML       = roleChip(user.role);

  renderNav(user.role);
  showScreen('screen-main');

  // 기본 페이지: viewer는 inventory, 나머지는 dashboard
  showPage(user.role === 'viewer' ? 'inventory' : 'dashboard');
}

// ── 로그아웃 ──
function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  currentUser = null;
  showScreen('screen-login');
}
document.getElementById('btn-logout').addEventListener('click', logout);

// ── 네비게이션 클릭 ──
document.getElementById('nav-list').addEventListener('click', (e) => {
  const link = e.target.closest('.nav-link[data-page]');
  if (!link) return;
  e.preventDefault();
  showPage(link.dataset.page);
});

// ── 탭 전환 ──
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;
    if (!tabName) return;   // data-tab 없는 버튼(입고 등 자체 탭)은 무시
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const target = document.getElementById(`tab-${tabName}`);
    if (target) target.classList.add('active');
  });
});

// ══════════════════════════════════════════════
//  대시보드
// ══════════════════════════════════════════════
async function loadDashboard() {
  if (typeof dbLoad === 'function') await dbLoad();
}

// ══════════════════════════════════════════════
//  사용자 관리 (관리자)
// ══════════════════════════════════════════════
async function loadUsers() {
  try {
    const users = await API.get('/auth/users');
    renderPendingTab(users.filter(u => u.role === 'pending'));
    renderAllTab(users.filter(u => u.role !== 'pending'));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderPendingTab(list) {
  const tbody = document.getElementById('tbody-pending');
  const badge = document.getElementById('badge-pending');
  badge.textContent = list.length;
  badge.style.display = list.length ? '' : 'none';

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">승인 대기 중인 회원이 없습니다.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(u => `
    <tr>
      <td>${escHtml(u.name)}</td>
      <td>${escHtml(u.username || u.phone || '-')}</td>
      <td>${fmtDate(u.created_at)}</td>
      <td>
        <button class="btn btn-sm btn-success" onclick="approveUser('${u.id}','viewer')">보기만</button>
        <button class="btn btn-sm btn-primary" style="margin-left:.3rem"
                onclick="approveUser('${u.id}','editor')">등록및수정</button>
      </td>
    </tr>
  `).join('');
}

function renderAllTab(list) {
  const tbody = document.getElementById('tbody-all');

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">사용자가 없습니다.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(u => {
    const isMe    = u.id === currentUser?.id;
    const isAdmin = u.role === 'admin';
    const roleOptions = ['viewer','editor','admin']
      .map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`)
      .join('');

    const roleCell = (isAdmin || isMe)
      ? `<td>${roleChip(u.role)} ${isMe ? '<small style="color:#888">(본인)</small>' : '(관리자)'}</td>`
      : `<td>
           <select class="role-select" id="sel-${u.id}">${roleOptions}</select>
           <button class="btn btn-xs btn-primary" onclick="changeRole('${u.id}')">변경</button>
         </td>`;

    const manageCell = (!isAdmin && !isMe)
      ? `<td style="white-space:nowrap">
           <button class="btn btn-xs btn-ghost" onclick="adminChangePw('${u.id}','${escHtml(u.name)}')">비밀번호 변경</button>
           <button class="btn btn-xs btn-danger" style="margin-left:.3rem" onclick="deleteUser('${u.id}','${escHtml(u.name)}')">삭제</button>
         </td>`
      : '<td></td>';

    return `
      <tr>
        <td>${escHtml(u.name)}</td>
        <td>${escHtml(u.username || u.phone || '-')}</td>
        <td>${roleChip(u.role)}</td>
        <td>${fmtDate(u.created_at)}</td>
        ${roleCell}
        ${manageCell}
      </tr>
    `;
  }).join('');
}

// 승인 (pending → role)
window.approveUser = async function(userId, role) {
  try {
    await API.patch(`/auth/users/${userId}/role`, { role });
    toast(`${ROLE_LABELS[role]} 권한으로 승인되었습니다.`, 'success');
    loadUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
};

// 관리자 비밀번호 강제 변경
let _adminPwTargetId = null;
window.adminChangePw = function(userId, userName) {
  _adminPwTargetId = userId;
  document.getElementById('admin-pw-modal-title').textContent = `${userName} 비밀번호 변경`;
  document.getElementById('admin-pw-new').value     = '';
  document.getElementById('admin-pw-confirm').value = '';
  document.getElementById('modal-admin-pw').classList.remove('hidden');
};

window.submitAdminPw = async function() {
  const pw  = document.getElementById('admin-pw-new').value;
  const pw2 = document.getElementById('admin-pw-confirm').value;
  if (!pw)       { toast('새 비밀번호를 입력하세요.', 'error'); return; }
  if (pw !== pw2) { toast('비밀번호가 일치하지 않습니다.', 'error'); return; }
  try {
    await API.put(`/auth/users/${_adminPwTargetId}/password`, { password: pw });
    document.getElementById('modal-admin-pw').classList.add('hidden');
    toast('비밀번호가 변경됐습니다.', 'success');
  } catch (err) { toast(err.message, 'error'); }
};

// 사용자 삭제
window.deleteUser = async function(userId, userName) {
  const ok = await confirmDialog(
    `${userName} 계정을 삭제하시겠습니까?\n삭제된 계정은 복구할 수 없습니다.`,
    '계정 삭제', '삭제', 'btn-danger'
  );
  if (!ok) return;
  try {
    await API.del(`/auth/users/${userId}`);
    toast('사용자가 삭제되었습니다.', 'success');
    loadUsers();
  } catch (err) { toast(err.message, 'error'); }
};

// 권한 변경
window.changeRole = async function(userId) {
  const sel  = document.getElementById(`sel-${userId}`);
  const role = sel?.value;
  if (!role) return;

  try {
    await API.patch(`/auth/users/${userId}/role`, { role });
    toast(`${ROLE_LABELS[role]}(으)로 권한이 변경되었습니다.`, 'success');
    loadUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
};

// ══════════════════════════════════════════════
//  내 정보 / 비밀번호 변경
// ══════════════════════════════════════════════
async function loadProfile() {
  try {
    const u = await API.get('/auth/profile');
    document.getElementById('profile-name').textContent    = u.name    || '-';
    document.getElementById('profile-username').textContent = u.username || u.phone || '-';
    document.getElementById('profile-role').textContent    = ROLE_LABELS[u.role] || u.role;
    document.getElementById('profile-created').textContent = fmtDate(u.created_at) || '-';
    ['profile-cur-pw','profile-new-pw','profile-confirm-pw'].forEach(id =>
      document.getElementById(id) && (document.getElementById(id).value = '')
    );
  } catch (err) { toast(err.message, 'error'); }
}

window.saveProfilePw = async function() {
  const cur = document.getElementById('profile-cur-pw').value;
  const nw  = document.getElementById('profile-new-pw').value;
  const nw2 = document.getElementById('profile-confirm-pw').value;
  if (!cur)        { toast('현재 비밀번호를 입력하세요.', 'error'); return; }
  if (!nw)         { toast('새 비밀번호를 입력하세요.', 'error'); return; }
  if (nw !== nw2)  { toast('새 비밀번호가 일치하지 않습니다.', 'error'); return; }
  try {
    await API.put('/auth/profile/password', { current_password: cur, new_password: nw });
    toast('비밀번호가 변경됐습니다. 다시 로그인해주세요.', 'success');
    setTimeout(() => { localStorage.removeItem('token'); location.reload(); }, 1500);
  } catch (err) { toast(err.message, 'error'); }
};

// ══════════════════════════════════════════════
//  공용 확인 다이얼로그
// ══════════════════════════════════════════════
function confirmDialog(message, title = '삭제 확인', okLabel = '삭제', okClass = 'btn-danger') {
  return new Promise((resolve) => {
    document.getElementById('confirm-title').textContent  = title;
    document.getElementById('confirm-msg').textContent    = message;
    const okBtn  = document.getElementById('btn-confirm-ok');
    okBtn.textContent = okLabel;
    okBtn.className   = `btn ${okClass}`;
    document.getElementById('modal-confirm').classList.remove('hidden');

    const ok     = () => { close(); resolve(true);  };
    const cancel = () => { close(); resolve(false); };
    function close() {
      document.getElementById('modal-confirm').classList.add('hidden');
      okBtn.removeEventListener('click', ok);
      document.getElementById('btn-confirm-cancel').removeEventListener('click', cancel);
    }
    okBtn.addEventListener('click', ok);
    document.getElementById('btn-confirm-cancel').addEventListener('click', cancel);
  });
}

// ══════════════════════════════════════════════
//  거래처 관리 (매입 / 출고 공용)
// ══════════════════════════════════════════════
let _currentVendorType  = 'purchase'; // 'purchase' | 'sales'
let allPurchaseVendors  = [];
let allSalesVendors     = [];
let _currentVendor      = null;
let _svendorFilter      = 'all';      // 'all' | 'important'
let _pvendorTypeFilter  = 'all';      // 'all' | 'individual' | 'company'

function vendorApiPath() {
  return _currentVendorType === 'purchase' ? '/purchase-vendors' : '/sales-vendors';
}
function vendorTbodyId() {
  return _currentVendorType === 'purchase' ? 'pvendor-tbody' : 'svendor-tbody';
}
function vendorSearchId() {
  return _currentVendorType === 'purchase' ? 'pvendor-search' : 'svendor-search';
}
function getVendorCache() {
  return _currentVendorType === 'purchase' ? allPurchaseVendors : allSalesVendors;
}
function setVendorCache(list) {
  if (_currentVendorType === 'purchase') allPurchaseVendors = list;
  else allSalesVendors = list;
}

async function loadVendors(type) {
  _currentVendorType = type;
  _svendorFilter = 'all';
  _pvendorTypeFilter = 'all';
  // 필터 버튼 리셋
  document.querySelectorAll('.svendor-filter-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.sfilter === 'all')
  );
  document.querySelectorAll('.pvendor-type-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.pvtype === 'all')
  );
  try {
    const list = await API.get(vendorApiPath());
    setVendorCache(list);
    if (type === 'sales') updateSvendorCounts(list);
    if (type === 'purchase') updatePvendorCounts(list);
    renderVendorTable(list);
  } catch (err) { toast(err.message, 'error'); }
}

function filterVendors() {
  const q = document.getElementById(vendorSearchId()).value.toLowerCase().trim();
  const list = getVendorCache();
  const digits = q.replace(/\D/g, '');
  let filtered = q
    ? list.filter(v => {
        const vt = v.vendor_type || 'company';
        const name = vt === 'individual' ? (v.individual_name || '') : (v.company_name || '');
        const phone = vt === 'individual' ? (v.individual_phone || '') : (v.phone || '');
        return name.toLowerCase().includes(q)             ||
               (v.company_name    || '').toLowerCase().includes(q) ||
               (v.individual_name || '').toLowerCase().includes(q) ||
               (v.business_number || '').includes(digits)          ||
               phone.replace(/\D/g,'').includes(digits);
      })
    : list;
  // 출고거래처: 중요 필터 적용
  if (_currentVendorType === 'sales' && _svendorFilter === 'important') {
    filtered = filtered.filter(v => v.is_important);
  }
  // 매입거래처: 유형 필터 적용
  if (_currentVendorType === 'purchase' && _pvendorTypeFilter !== 'all') {
    filtered = filtered.filter(v => (v.vendor_type || 'company') === _pvendorTypeFilter);
  }
  renderVendorTable(filtered);
}

function updateSvendorCounts(list) {
  const allCount  = list.length;
  const impCount  = list.filter(v => v.is_important).length;
  const allEl  = document.getElementById('svendor-count-all');
  const impEl  = document.getElementById('svendor-count-important');
  if (allEl)  allEl.textContent  = allCount;
  if (impEl)  impEl.textContent  = impCount;
}

function updatePvendorCounts(list) {
  const allEl  = document.getElementById('pvendor-type-count-all');
  const indEl  = document.getElementById('pvendor-type-count-individual');
  const compEl = document.getElementById('pvendor-type-count-company');
  if (allEl)  allEl.textContent  = list.length;
  if (indEl)  indEl.textContent  = list.filter(v => (v.vendor_type || 'company') === 'individual').length;
  if (compEl) compEl.textContent = list.filter(v => (v.vendor_type || 'company') === 'company').length;
}

function renderVendorTable(list) {
  const tbody = document.getElementById(vendorTbodyId());
  const isSales    = _currentVendorType === 'sales';
  const isPurchase = _currentVendorType === 'purchase';

  let sorted = isSales
    ? [...list].sort((a, b) => (b.is_important || 0) - (a.is_important || 0) || (a.company_name||'').localeCompare(b.company_name||''))
    : list;

  if (!sorted.length) {
    const colspan = isSales ? '14' : '10';
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="empty">등록된 거래처가 없습니다.</td></tr>`;
    return;
  }

  tbody.innerHTML = sorted.map(v => {
    if (isPurchase) {
      const vt       = v.vendor_type || 'company';
      const typeLabel = vt === 'individual' ? '개인' : '기업';
      const typeCls   = vt === 'individual' ? 'pv-type-individual' : 'pv-type-company';
      const displayName = vt === 'individual' ? (v.individual_name || '-') : (v.company_name || '-');
      const phone    = vt === 'individual'
        ? (v.individual_phone ? fmtPhone(v.individual_phone) : '-')
        : (v.phone ? fmtPhone(v.phone) : '-');
      const manager  = vt === 'company' ? escHtml(v.manager_name || '-') : '-';
      const notes    = vt === 'individual' ? escHtml(truncate(v.individual_notes)) : escHtml(truncate(v.notes));
      const licFile  = v.business_license_file;
      const licCell  = licFile
        ? `<td><a class="license-link" href="/license-viewer.html?id=${v.id}&type=purchase" target="_blank" onclick="event.stopPropagation()">${escHtml(licenseDisplayName(licFile))}</a></td>`
        : `<td class="cell-empty">-</td>`;
      return `
        <tr class="vendor-row" onclick="openVendorDetail('${v.id}')">
          <td><span class="pv-type-badge ${typeCls}">${typeLabel}</span></td>
          <td>${escHtml(displayName)}</td>
          <td>${phone}</td>
          <td>${manager}</td>
          <td class="cell-notes" title="${notes}">${notes}</td>
          ${licCell}
          <td>${escHtml(v.created_by_name || '-')}</td>
          <td class="cell-date">${fmtDateTime(v.created_at)}</td>
          <td>${escHtml(v.updated_by_name || '-')}</td>
          <td class="cell-date">${fmtDateTime(v.updated_at)}</td>
        </tr>
      `;
    }
    const starMark  = (isSales && v.is_important) ? '<span class="v-star-mark">★</span> ' : '';
    const nameCell  = isSales ? `<td>${escHtml(v.name || '-')}</td>` : '';
    const licFile   = v.business_license_file;
    const sLicCell  = licFile
      ? `<td><a class="license-link" href="/license-viewer.html?id=${v.id}&type=sales" target="_blank" onclick="event.stopPropagation()">${escHtml(licenseDisplayName(licFile))}</a></td>`
      : `<td class="cell-empty">-</td>`;
    return `
      <tr class="vendor-row" onclick="openVendorDetail('${v.id}')">
        <td>${starMark}${escHtml(v.company_name)}</td>
        ${nameCell}
        <td>${fmtBizNum(v.business_number)}</td>
        <td>${fmtPhone(v.phone)}</td>
        <td class="cell-addr" title="${escHtml(v.registered_address || '')}">${escHtml(truncate(v.registered_address))}</td>
        <td class="cell-notes" title="${escHtml(v.notes || '')}">${escHtml(truncate(v.notes))}</td>
        ${sLicCell}
        <td>${escHtml(v.bank_name || '-')}</td>
        <td>${v.account_number ? fmtAccountNumber(v.account_number) : '-'}</td>
        <td>${escHtml(v.account_holder || '-')}</td>
        <td>${escHtml(v.created_by_name || '-')}</td>
        <td class="cell-date">${fmtDateTime(v.created_at)}</td>
        <td>${escHtml(v.updated_by_name || '-')}</td>
        <td class="cell-date">${fmtDateTime(v.updated_at)}</td>
      </tr>
    `;
  }).join('');
}

// ── 등록 모달 열기 ──
window.openVendorModal = function(prefill) {
  document.getElementById('form-vendor').reset();
  document.getElementById('v-id').value = '';
  document.getElementById('v-del-addr').disabled = false;
  document.getElementById('v-is-important').value = '0';

  // 매입거래처 이전 상태로 숨겨진 공통 필드 복원 (출고거래처 열 때 필요)
  ['v-company','v-name','v-biz','v-phone-inp','v-reg-addr','v-del-addr','v-notes','v-remarks'].forEach(id =>
    document.getElementById(id)?.closest('.field')?.classList.remove('hidden')
  );
  document.getElementById('v-ind-section')?.classList.add('hidden');
  document.getElementById('v-comp-extra')?.classList.add('hidden');
  const _pLbl = document.querySelector('#v-phone-inp')?.closest('.field')?.querySelector('label');
  if (_pLbl) _pLbl.innerHTML = '전화번호 <span class="hint">숫자만 입력</span>';
  const _rLbl = document.querySelector('#v-reg-addr')?.closest('.field')?.querySelector('label');
  if (_rLbl) _rLbl.textContent = '사업자등록 주소';

  const isSales    = _currentVendorType === 'sales';
  const isPurchase = _currentVendorType === 'purchase';
  const label = isSales ? '출고거래처 등록' : '매입거래처 등록';
  document.getElementById('modal-vendor-title').textContent = label;

  // 출고거래처 전용 섹션
  document.getElementById('v-sales-section')?.classList.toggle('hidden', !isSales);
  const starBtn = document.getElementById('btn-v-star');
  if (starBtn) {
    starBtn.classList.toggle('hidden', !isSales);
    starBtn.textContent = '☆';
    starBtn.classList.remove('star-active');
  }

  // 매입거래처 전용 섹션
  const purchaseSection = document.getElementById('v-purchase-section');
  if (purchaseSection) purchaseSection.classList.toggle('hidden', !isPurchase);

  if (isPurchase) {
    // 초기 유형: 기업
    document.getElementById('v-vendor-type').value = prefill?.vendor_type || 'company';
    pvSetModalType(prefill?.vendor_type || 'company');
    if (prefill?.individual_name) document.getElementById('v-ind-name').value = prefill.individual_name;
  }

  document.getElementById('modal-vendor').classList.remove('hidden');
  if (isPurchase) {
    const focus = (document.getElementById('v-vendor-type')?.value === 'individual')
      ? document.getElementById('v-ind-name')
      : document.getElementById('v-company');
    focus?.focus();
  } else {
    document.getElementById('v-company')?.focus();
  }
};

function pvSetModalType(vt) {
  document.getElementById('v-vendor-type').value = vt;
  const isInd = vt === 'individual';
  document.getElementById('v-ind-section')?.classList.toggle('hidden', !isInd);
  document.getElementById('v-comp-extra')?.classList.toggle('hidden', isInd);

  // 상호명 필드: 개인이면 숨김
  const companyField = document.getElementById('v-company')?.closest('.field');
  if (companyField) companyField.classList.toggle('hidden', isInd);

  // 매입거래처에서 항상 숨길 공통 필드: 이름(대표자), 사업자번호, 배송주소, 특이사항, 비고
  ['v-name','v-biz','v-del-addr','v-notes','v-remarks'].forEach(id =>
    document.getElementById(id)?.closest('.field')?.classList.add('hidden')
  );

  // 전화번호·주소: 기업이면 표시(레이블 변경), 개인이면 숨김
  const phoneField   = document.getElementById('v-phone-inp')?.closest('.field');
  const regAddrField = document.getElementById('v-reg-addr')?.closest('.field');
  if (phoneField)   phoneField.classList.toggle('hidden', isInd);
  if (regAddrField) regAddrField.classList.toggle('hidden', isInd);
  if (!isInd) {
    const pLbl = phoneField?.querySelector('label');
    if (pLbl) pLbl.innerHTML = '회사전화번호';
    const rLbl = regAddrField?.querySelector('label');
    if (rLbl) rLbl.textContent = '주소';
  }

  document.querySelectorAll('#v-purchase-section .pv-type-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.vtype === vt)
  );
}

function pvSetEditType(vt) {
  document.getElementById('vde-vendor-type').value = vt;
  const isInd = vt === 'individual';
  document.getElementById('vde-ind-section')?.classList.toggle('hidden', !isInd);
  document.getElementById('vde-comp-extra')?.classList.toggle('hidden', isInd);
  document.querySelectorAll('#vde-purchase-section .pv-type-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.vtypeEdit === vt)
  );
}

// ── 상세 팝업 열기 ──
window.openVendorDetail = async function(id) {
  try {
    const v = await API.get(`${vendorApiPath()}/${id}`);
    _currentVendor = v;

    const isSales = _currentVendorType === 'sales';
    document.getElementById('vdd-title').textContent      = v.company_name;
    document.getElementById('vdd-name').textContent       = v.name    || '-';
    document.getElementById('vdd-company').textContent    = v.company_name || '-';
    document.getElementById('vdd-biz').textContent        = fmtBizNum(v.business_number) || '-';
    document.getElementById('vdd-phone').textContent      = fmtPhone(v.phone) || '-';
    document.getElementById('vdd-reg-addr').textContent   = v.registered_address || '-';
    document.getElementById('vdd-del-addr').textContent   = v.delivery_address   || '-';
    document.getElementById('vdd-notes').textContent      = v.notes   || '-';
    document.getElementById('vdd-remarks').textContent    = v.remarks || '-';
    document.getElementById('vdd-created-by').textContent = v.created_by_name || '-';
    document.getElementById('vdd-created-at').textContent = fmtDateTime(v.created_at);
    document.getElementById('vdd-updated-by').textContent = v.updated_by_name || '-';
    document.getElementById('vdd-updated-at').textContent = fmtDateTime(v.updated_at);

    // 출고거래처 전용: 중요 표시 행
    const vddStarRow = document.getElementById('vdd-star-row');
    if (vddStarRow) {
      vddStarRow.classList.toggle('hidden', !isSales);
      if (isSales) {
        const starIcon  = document.getElementById('vdd-star-icon');
        const starLabel = document.getElementById('vdd-star-label');
        if (v.is_important) {
          starIcon.textContent  = '★';
          starIcon.style.color  = '#f59f00';
          starLabel.textContent = '중요 거래처';
        } else {
          starIcon.textContent  = '☆';
          starIcon.style.color  = '';
          starLabel.textContent = '일반 거래처';
        }
      }
    }

    // 출고거래처 계좌 섹션
    const bankSection = document.getElementById('vdd-bank-section');
    if (bankSection) {
      bankSection.classList.toggle('hidden', !isSales);
      if (isSales) {
        document.getElementById('vdd-bank-name').textContent      = v.bank_name      || '-';
        document.getElementById('vdd-account-number').textContent = fmtAccountNumber(v.account_number);
        document.getElementById('vdd-account-holder').textContent = v.account_holder || '-';
      }
    }

    // 매입거래처 전용 섹션
    const isPurchase = _currentVendorType === 'purchase';
    const purchaseSection = document.getElementById('vdd-purchase-section');
    if (purchaseSection) {
      purchaseSection.classList.toggle('hidden', !isPurchase);
      if (isPurchase) {
        const vt = v.vendor_type || 'company';
        document.getElementById('vdd-vendor-type-label').innerHTML =
          vt === 'individual'
            ? '<span class="pv-type-badge pv-type-individual">일반소비자</span>'
            : '<span class="pv-type-badge pv-type-company">기업</span>';
        document.getElementById('vdd-pind-section')?.classList.toggle('hidden', vt !== 'individual');
        document.getElementById('vdd-pcomp-section')?.classList.toggle('hidden', vt !== 'company');
        if (vt === 'individual') {
          document.getElementById('vdd-ind-name').textContent    = v.individual_name  || '-';
          document.getElementById('vdd-ind-phone').textContent   = v.individual_phone ? fmtPhone(v.individual_phone) : '-';
          document.getElementById('vdd-ind-account').textContent = v.individual_account || '-';
          document.getElementById('vdd-ind-notes').textContent   = v.individual_notes  || '-';
        } else {
          document.getElementById('vdd-mgr-name').textContent  = v.manager_name  || '-';
          document.getElementById('vdd-mgr-phone').textContent = v.manager_phone ? fmtPhone(v.manager_phone) : '-';
        }
      }
    }

    document.getElementById('btn-vdd-delete').style.display =
      currentUser?.role === 'admin' ? '' : 'none';

    // 사업자등록증
    const licFile  = v.business_license_file;
    const licEl    = document.getElementById('vdd-license');
    const vType    = _currentVendorType; // 'sales' | 'purchase'
    if (licFile) {
      licEl.innerHTML = `<a class="license-link" href="/license-viewer.html?id=${v.id}&type=${vType}" target="_blank">${escHtml(licenseDisplayName(licFile))}</a>`;
    } else {
      licEl.textContent = '-';
    }
    const isEditor = currentUser?.role === 'editor' || currentUser?.role === 'admin';
    document.getElementById('btn-vdd-upload-license').style.display = isEditor ? '' : 'none';
    document.getElementById('btn-vdd-delete-license').style.display = (isEditor && licFile) ? '' : 'none';

    setDetailMode('view');
    document.getElementById('modal-vendor-detail').classList.remove('hidden');
  } catch (err) { toast(err.message, 'error'); }
};

// ── 상세 팝업 모드 전환 ──
function setDetailMode(mode) {
  const show = (id, visible) =>
    document.getElementById(id)?.classList.toggle('hidden', !visible);
  show('vdd-view',      mode === 'view');
  show('vdd-edit',      mode === 'edit');
  show('vdd-ft-view',   mode === 'view');
  show('vdd-ft-delete', mode === 'delete-confirm');
  show('vdd-ft-edit',   mode === 'edit');
  if (_currentVendor) {
    document.getElementById('vdd-title').textContent =
      mode === 'edit' ? '거래처 수정' : _currentVendor.company_name;
  }
}

function closeVendorDetail() {
  document.getElementById('modal-vendor-detail').classList.add('hidden');
  _currentVendor = null;
}

// ── 사업자등록증 업로드/삭제 ──
document.getElementById('btn-vdd-upload-license').addEventListener('click', () => {
  document.getElementById('vdd-license-input').click();
});

document.getElementById('vdd-license-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !_currentVendor) { e.target.value = ''; return; }
  const formData = new FormData();
  formData.append('license', file);
  const btn = document.getElementById('btn-vdd-upload-license');
  btn.disabled = true;
  btn.textContent = '업로드 중...';
  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api${vendorApiPath()}/${_currentVendor.id}/license`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || '업로드 실패', 'error'); return; }
    _currentVendor = data;
    const licFile = data.business_license_file;
    const licEl   = document.getElementById('vdd-license');
    licEl.innerHTML = `<a class="license-link" href="/license-viewer.html?id=${data.id}&type=${_currentVendorType}" target="_blank">${escHtml(licenseDisplayName(licFile))}</a>`;
    document.getElementById('btn-vdd-delete-license').style.display = '';
    toast('사업자등록증이 업로드되었습니다.', 'success');
    await loadVendors(_currentVendorType);
  } catch (err) { toast('업로드 중 오류가 발생했습니다.', 'error'); }
  finally { btn.disabled = false; btn.textContent = '업로드'; e.target.value = ''; }
});

document.getElementById('btn-vdd-delete-license').addEventListener('click', async () => {
  if (!_currentVendor) return;
  if (!confirm('사업자등록증을 삭제하시겠습니까?')) return;
  const btn = document.getElementById('btn-vdd-delete-license');
  btn.disabled = true;
  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api${vendorApiPath()}/${_currentVendor.id}/license`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || '삭제 실패', 'error'); return; }
    _currentVendor = data;
    document.getElementById('vdd-license').textContent = '-';
    document.getElementById('btn-vdd-delete-license').style.display = 'none';
    toast('사업자등록증이 삭제되었습니다.', 'success');
    await loadVendors(_currentVendorType);
  } catch (err) { toast('삭제 중 오류가 발생했습니다.', 'error'); }
  finally { btn.disabled = false; }
});

// ── 수정 모드 전환 (폼 채우기) ──
function openDetailEditMode() {
  const v = _currentVendor;
  if (!v) return;
  const bizFmt   = fmtBizNum(v.business_number);
  const phoneFmt = fmtPhone(v.phone);
  document.getElementById('vde-id').value          = v.id;
  document.getElementById('vde-company').value     = v.company_name || '';
  document.getElementById('vde-name').value        = v.name || '';
  document.getElementById('vde-biz').value         = bizFmt   === '-' ? '' : bizFmt;
  document.getElementById('vde-phone').value       = phoneFmt === '-' ? '' : phoneFmt;
  document.getElementById('vde-reg-addr').value    = v.registered_address || '';
  document.getElementById('vde-del-addr').value    = v.delivery_address   || '';
  document.getElementById('vde-same-addr').checked = !!v.same_address;
  document.getElementById('vde-del-addr').disabled = !!v.same_address;
  document.getElementById('vde-notes').value       = v.notes   || '';
  document.getElementById('vde-remarks').value     = v.remarks || '';

  // 출고거래처 전용
  const isSales = _currentVendorType === 'sales';
  document.getElementById('vde-sales-section')?.classList.toggle('hidden', !isSales);
  document.getElementById('vde-star-row')?.classList.toggle('hidden', !isSales);
  if (isSales) {
    document.getElementById('vde-is-important').value      = v.is_important ? '1' : '0';
    document.getElementById('vde-bank-name').value         = v.bank_name      || '';
    document.getElementById('vde-account-number').value    = v.account_number ? fmtAccountNumber(v.account_number) : '';
    document.getElementById('vde-account-holder').value    = v.account_holder || '';
    const starBtn = document.getElementById('btn-vde-star');
    if (starBtn) {
      starBtn.textContent = v.is_important ? '★' : '☆';
      starBtn.classList.toggle('star-active', !!v.is_important);
    }
  }

  // 매입거래처 전용
  const isPurchaseDet = _currentVendorType === 'purchase';
  document.getElementById('vde-purchase-section')?.classList.toggle('hidden', !isPurchaseDet);
  if (isPurchaseDet) {
    const vt = v.vendor_type || 'company';
    document.getElementById('vde-vendor-type').value = vt;
    pvSetEditType(vt);
    if (vt === 'individual') {
      document.getElementById('vde-ind-name').value    = v.individual_name  || '';
      document.getElementById('vde-ind-phone').value   = v.individual_phone ? fmtPhone(v.individual_phone) : '';
      document.getElementById('vde-ind-account').value = v.individual_account || '';
      document.getElementById('vde-ind-notes').value   = v.individual_notes  || '';
    } else {
      document.getElementById('vde-mgr-name').value  = v.manager_name  || '';
      document.getElementById('vde-mgr-phone').value = v.manager_phone ? fmtPhone(v.manager_phone) : '';
    }
  }

  setDetailMode('edit');
}

// ── 수정 저장 ──
async function saveVendorDetail() {
  const id       = document.getElementById('vde-id').value;
  const company  = document.getElementById('vde-company').value.trim();
  const bizRaw   = document.getElementById('vde-biz').value.replace(/\D/g, '');
  const phoneRaw = document.getElementById('vde-phone').value.replace(/\D/g, '');
  const sameAddr = document.getElementById('vde-same-addr').checked;
  const regAddr  = document.getElementById('vde-reg-addr').value.trim();
  const delAddr  = sameAddr ? regAddr : document.getElementById('vde-del-addr').value.trim();

  if (!company)  { toast('상호명을 입력하세요.', 'error'); return; }
  if (bizRaw   && bizRaw.length !== 10)                          { toast('사업자번호는 10자리여야 합니다.', 'error'); return; }
  if (phoneRaw && (phoneRaw.length < 10 || phoneRaw.length > 11)) { toast('전화번호는 10~11자리여야 합니다.', 'error'); return; }

  const body = {
    company_name: company, business_number: bizRaw || null, phone: phoneRaw || null,
    registered_address: regAddr || null, delivery_address: delAddr || null,
    same_address: sameAddr,
    notes:   document.getElementById('vde-notes').value.trim()   || null,
    remarks: document.getElementById('vde-remarks').value.trim() || null,
  };

  // 출고거래처 전용 필드
  if (_currentVendorType === 'sales') {
    body.name            = document.getElementById('vde-name').value.trim()  || null;
    body.is_important    = document.getElementById('vde-is-important').value === '1';
    body.bank_name       = document.getElementById('vde-bank-name').value    || null;
    body.account_number  = document.getElementById('vde-account-number').value.replace(/\D/g, '') || null;
    body.account_holder  = document.getElementById('vde-account-holder').value.trim() || null;
  }

  const btn = document.getElementById('btn-vdd-save');
  btn.disabled = true;

  // 매입거래처 전용 필드
  if (_currentVendorType === 'purchase') {
    const vt = document.getElementById('vde-vendor-type')?.value || 'company';
    body.vendor_type = vt;
    if (vt === 'individual') {
      const indName = document.getElementById('vde-ind-name')?.value.trim();
      if (!indName) { toast('이름을 입력하세요.', 'error'); btn.disabled = false; return; }
      body.individual_name    = indName;
      body.individual_phone   = document.getElementById('vde-ind-phone')?.value.replace(/\D/g,'') || null;
      body.individual_account = document.getElementById('vde-ind-account')?.value.replace(/\D/g,'') || null;
      body.individual_notes   = document.getElementById('vde-ind-notes')?.value.trim() || null;
    } else {
      body.manager_name  = document.getElementById('vde-mgr-name')?.value.trim() || null;
      body.manager_phone = document.getElementById('vde-mgr-phone')?.value.replace(/\D/g,'') || null;
    }
  }
  try {
    await API.put(`${vendorApiPath()}/${id}`, body);
    toast('거래처가 수정되었습니다.', 'success');
    closeVendorDetail();
    await loadVendors(_currentVendorType);
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; }
}

// ── 삭제 실행 ──
async function deleteCurrentVendor() {
  if (!_currentVendor) return;
  const { id, company_name } = _currentVendor;
  const type = _currentVendorType;
  try {
    await API.del(`${vendorApiPath()}/${id}`);
    toast(`'${company_name}' 거래처가 삭제(휴지통 이동)되었습니다.`, 'success');
    closeVendorDetail();
    await loadVendors(type);
  } catch (err) { toast(err.message, 'error'); }
}

function closeVendorModal() {
  document.getElementById('modal-vendor').classList.add('hidden');
}

// ── 신규 저장 ──
async function saveVendor() {
  const company  = document.getElementById('v-company').value.trim();
  const bizRaw   = document.getElementById('v-biz').value.replace(/\D/g, '');
  const phoneRaw = document.getElementById('v-phone-inp').value.replace(/\D/g, '');
  const sameAddr = document.getElementById('v-same-addr').checked;
  const regAddr  = document.getElementById('v-reg-addr').value.trim();
  const delAddr  = sameAddr ? regAddr : document.getElementById('v-del-addr').value.trim();

  const _isPurchaseIndividual = _currentVendorType === 'purchase' &&
    (document.getElementById('v-vendor-type')?.value || 'company') === 'individual';
  if (!company && !_isPurchaseIndividual) { toast('상호명을 입력해주세요.', 'error'); return; }
  if (bizRaw   && bizRaw.length   !== 10)                        { toast('사업자번호는 10자리여야 합니다.', 'error'); return; }
  if (phoneRaw && (phoneRaw.length < 10 || phoneRaw.length > 11)) { toast('전화번호는 10~11자리여야 합니다.', 'error'); return; }

  const body = {
    company_name: company, business_number: bizRaw || null, phone: phoneRaw || null,
    registered_address: regAddr || null, delivery_address: delAddr || null,
    same_address: sameAddr,
    notes:   document.getElementById('v-notes').value.trim()   || null,
    remarks: document.getElementById('v-remarks').value.trim() || null,
  };

  // 출고거래처 전용 필드
  if (_currentVendorType === 'sales') {
    body.name           = document.getElementById('v-name').value.trim()  || null;
    body.is_important   = document.getElementById('v-is-important').value === '1';
    body.bank_name      = document.getElementById('v-bank-name').value    || null;
    body.account_number = document.getElementById('v-account-number').value.replace(/\D/g, '') || null;
    body.account_holder = document.getElementById('v-account-holder').value.trim() || null;
  }

  const saveBtn = document.getElementById('btn-vendor-save');

  // 매입거래처 전용 필드
  if (_currentVendorType === 'purchase') {
    const vt = document.getElementById('v-vendor-type')?.value || 'company';
    body.vendor_type = vt;
    if (vt === 'individual') {
      const indName = document.getElementById('v-ind-name')?.value.trim();
      if (!indName) { toast('이름을 입력하세요.', 'error'); if(saveBtn) saveBtn.disabled=false; return; }
      body.company_name      = null;
      body.individual_name   = indName;
      body.individual_phone  = document.getElementById('v-ind-phone')?.value.replace(/\D/g,'') || null;
      body.individual_account= document.getElementById('v-ind-account')?.value.replace(/\D/g,'') || null;
      body.individual_notes  = document.getElementById('v-ind-notes')?.value.trim() || null;
    } else {
      if (!company) { toast('회사명을 입력하세요.', 'error'); if(saveBtn) saveBtn.disabled=false; return; }
      body.manager_name  = document.getElementById('v-mgr-name')?.value.trim() || null;
      body.manager_phone = document.getElementById('v-mgr-phone')?.value.replace(/\D/g,'') || null;
    }
  }
  saveBtn.disabled = true;
  try {
    await API.post(vendorApiPath(), body);
    toast('거래처가 등록되었습니다.', 'success');
    closeVendorModal();
    await loadVendors(_currentVendorType);
  } catch (err) { toast(err.message, 'error'); }
  finally { saveBtn.disabled = false; }
}

// ── 거래처 선택 팝업 (입고/출고에서 호출) ──
// openVendorPicker(callback, 'purchase') | openVendorPicker(callback, 'sales')
let _vendorPickerCb   = null;
let _pickerVendorType = 'purchase';

function openVendorPicker(callback, type) {
  _vendorPickerCb   = callback;
  _pickerVendorType = type || 'purchase';

  const title = _pickerVendorType === 'purchase' ? '매입거래처 선택' : '출고거래처 선택';
  document.getElementById('picker-modal-title').textContent = title;
  document.getElementById('picker-search').value = '';

  const cache = _pickerVendorType === 'purchase' ? allPurchaseVendors : allSalesVendors;
  renderPickerList(cache);
  document.getElementById('modal-vendor-picker').classList.remove('hidden');
  document.getElementById('picker-search').focus();

  if (!cache.length) {
    const path = _pickerVendorType === 'purchase' ? '/purchase-vendors' : '/sales-vendors';
    API.get(path).then(list => {
      if (_pickerVendorType === 'purchase') allPurchaseVendors = list;
      else allSalesVendors = list;
      renderPickerList(list);
    });
  }
}

function closeVendorPicker() {
  document.getElementById('modal-vendor-picker').classList.add('hidden');
  _vendorPickerCb = null;
}

function renderPickerList(list) {
  const q = document.getElementById('picker-search').value.toLowerCase();
  const filtered = q
    ? list.filter(v => (v.company_name || '').toLowerCase().includes(q))
    : list;
  document.getElementById('picker-tbody').innerHTML = filtered.length
    ? filtered.map(v => `
        <tr class="picker-row" onclick="selectPickedVendor(${JSON.stringify({ id: v.id, company_name: v.company_name })})">
          <td>${escHtml(v.company_name)}</td>
          <td>${fmtBizNum(v.business_number)}</td>
          <td>${fmtPhone(v.phone)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="3" class="empty">거래처가 없습니다.</td></tr>';
}

window.selectPickedVendor = function(vendor) {
  closeVendorPicker();
  if (_vendorPickerCb) { _vendorPickerCb(vendor); _vendorPickerCb = null; }
};

// ── 이벤트 바인딩 (DOMContentLoaded 후 실행) ──
document.addEventListener('DOMContentLoaded', () => {
  // 매입거래처 등록 버튼
  document.getElementById('btn-pvendor-add')?.addEventListener('click', () => {
    _currentVendorType = 'purchase';
    openVendorModal();
  });
  // 출고거래처 등록 버튼
  document.getElementById('btn-svendor-add')?.addEventListener('click', () => {
    _currentVendorType = 'sales';
    openVendorModal();
  });

  // 모달 닫기 버튼들
  document.getElementById('btn-modal-vendor-close')?.addEventListener('click', closeVendorModal);
  document.getElementById('btn-vendor-cancel')?.addEventListener('click', closeVendorModal);
  document.getElementById('btn-vendor-save')?.addEventListener('click', saveVendor);
  document.getElementById('btn-picker-close')?.addEventListener('click', closeVendorPicker);

  // 오버레이 클릭 시 모달 닫기
  document.getElementById('modal-vendor')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-vendor')) closeVendorModal();
  });
  document.getElementById('modal-vendor-detail')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-vendor-detail')) closeVendorDetail();
  });

  // ── 상세 팝업 이벤트 ──
  document.getElementById('btn-vdd-close')?.addEventListener('click', closeVendorDetail);
  document.getElementById('btn-vdd-close2')?.addEventListener('click', closeVendorDetail);

  // 수정 버튼 → 수정 모드
  document.getElementById('btn-vdd-to-edit')?.addEventListener('click', openDetailEditMode);

  // 삭제 버튼 → 삭제 확인 모드
  document.getElementById('btn-vdd-delete')?.addEventListener('click', () => setDetailMode('delete-confirm'));

  // 삭제 확인 취소 → 보기 모드
  document.getElementById('btn-vdd-del-cancel')?.addEventListener('click', () => setDetailMode('view'));

  // 삭제 확인 → 실행
  document.getElementById('btn-vdd-del-confirm')?.addEventListener('click', deleteCurrentVendor);

  // 수정 취소 → 보기 모드
  document.getElementById('btn-vdd-edit-cancel')?.addEventListener('click', () => setDetailMode('view'));

  // 저장
  document.getElementById('btn-vdd-save')?.addEventListener('click', saveVendorDetail);

  // 수정 폼 자동 포맷 (vde-)
  document.getElementById('vde-biz')?.addEventListener('input', function() {
    const d = this.value.replace(/\D/g, '').slice(0, 10);
    this.value = d.length > 5 ? `${d.slice(0,3)}-${d.slice(3,5)}-${d.slice(5)}`
               : d.length > 3 ? `${d.slice(0,3)}-${d.slice(3)}` : d;
  });
  document.getElementById('vde-phone')?.addEventListener('input', function() {
    const d = this.value.replace(/\D/g, '').slice(0, 11);
    if (d.length > 7) { const m = d.length === 11 ? 4 : 3; this.value = `${d.slice(0,3)}-${d.slice(3,3+m)}-${d.slice(3+m)}`; }
    else if (d.length > 3) { this.value = `${d.slice(0,3)}-${d.slice(3)}`; }
    else { this.value = d; }
  });
  document.getElementById('vde-same-addr')?.addEventListener('change', function() {
    const del = document.getElementById('vde-del-addr');
    if (this.checked) { del.value = document.getElementById('vde-reg-addr').value; del.disabled = true; }
    else { del.disabled = false; }
  });
  document.getElementById('vde-reg-addr')?.addEventListener('input', function() {
    if (document.getElementById('vde-same-addr')?.checked)
      document.getElementById('vde-del-addr').value = this.value;
  });

  // 검색 입력
  document.getElementById('pvendor-search')?.addEventListener('input', filterVendors);
  document.getElementById('svendor-search')?.addEventListener('input', filterVendors);

  // 매입거래처 유형 탭
  document.querySelectorAll('.pvendor-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _pvendorTypeFilter = btn.dataset.pvtype;
      document.querySelectorAll('.pvendor-type-btn').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      filterVendors();
    });
  });

  // 거래처 등록 모달: 매입 유형 토글
  document.querySelectorAll('#v-purchase-section .pv-type-btn').forEach(btn => {
    btn.addEventListener('click', () => pvSetModalType(btn.dataset.vtype));
  });

  // 거래처 수정 모달: 매입 유형 토글
  document.querySelectorAll('#vde-purchase-section .pv-type-btn').forEach(btn => {
    btn.addEventListener('click', () => pvSetEditType(btn.dataset.vtypeEdit));
  });

  // 출고거래처 중요 필터 버튼
  document.querySelectorAll('.svendor-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _svendorFilter = btn.dataset.sfilter;
      document.querySelectorAll('.svendor-filter-btn').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      filterVendors();
    });
  });

  // 계좌번호 복사 버튼
  document.getElementById('btn-vdd-copy-account')?.addEventListener('click', () => {
    const num = document.getElementById('vdd-account-number')?.textContent || '';
    if (!num || num === '-') { toast('계좌번호가 없습니다.', 'error'); return; }
    navigator.clipboard.writeText(num.replace(/-/g, '')).then(
      () => toast('계좌번호가 복사되었습니다.', 'success'),
      () => toast('복사에 실패했습니다.', 'error')
    );
  });

  // 등록 모달: 별 토글
  document.getElementById('btn-v-star')?.addEventListener('click', () => {
    const inp = document.getElementById('v-is-important');
    const btn = document.getElementById('btn-v-star');
    const isImp = inp.value === '1';
    inp.value = isImp ? '0' : '1';
    btn.textContent = isImp ? '☆' : '★';
    btn.classList.toggle('star-active', !isImp);
  });

  // 수정 폼: 별 토글
  document.getElementById('btn-vde-star')?.addEventListener('click', () => {
    const inp = document.getElementById('vde-is-important');
    const btn = document.getElementById('btn-vde-star');
    const isImp = inp.value === '1';
    inp.value = isImp ? '0' : '1';
    btn.textContent = isImp ? '☆' : '★';
    btn.classList.toggle('star-active', !isImp);
  });

  // 계좌번호 자동 포맷 (등록 모달)
  document.getElementById('v-account-number')?.addEventListener('input', function() {
    const d = this.value.replace(/\D/g, '').slice(0, 14);
    if (d.length <= 3) this.value = d;
    else if (d.length <= 6) this.value = `${d.slice(0,3)}-${d.slice(3)}`;
    else this.value = `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
  });

  // 계좌번호 자동 포맷 (수정 폼)
  document.getElementById('vde-account-number')?.addEventListener('input', function() {
    const d = this.value.replace(/\D/g, '').slice(0, 14);
    if (d.length <= 3) this.value = d;
    else if (d.length <= 6) this.value = `${d.slice(0,3)}-${d.slice(3)}`;
    else this.value = `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
  });

  // 거래처 선택 팝업 검색
  document.getElementById('picker-search')?.addEventListener('input', () => {
    const cache = _pickerVendorType === 'purchase' ? allPurchaseVendors : allSalesVendors;
    renderPickerList(cache);
  });

  // 사업자번호 자동 포맷 (000-00-00000)
  document.getElementById('v-biz')?.addEventListener('input', function () {
    const d = this.value.replace(/\D/g, '').slice(0, 10);
    this.value = d.length > 5
      ? `${d.slice(0,3)}-${d.slice(3,5)}-${d.slice(5)}`
      : d.length > 3 ? `${d.slice(0,3)}-${d.slice(3)}` : d;
  });

  // 전화번호 자동 포맷 (000-0000-0000)
  document.getElementById('v-phone-inp')?.addEventListener('input', function () {
    const d = this.value.replace(/\D/g, '').slice(0, 11);
    if (d.length > 7) {
      const mid = d.length === 11 ? 4 : 3;
      this.value = `${d.slice(0,3)}-${d.slice(3,3+mid)}-${d.slice(3+mid)}`;
    } else if (d.length > 3) {
      this.value = `${d.slice(0,3)}-${d.slice(3)}`;
    } else {
      this.value = d;
    }
  });

  // 배송주소 = 등록주소 체크박스
  document.getElementById('v-same-addr')?.addEventListener('change', function () {
    const delEl = document.getElementById('v-del-addr');
    if (this.checked) {
      delEl.value    = document.getElementById('v-reg-addr').value;
      delEl.disabled = true;
    } else {
      delEl.disabled = false;
    }
  });

  // 등록주소 변경 시 배송주소 자동 동기화
  document.getElementById('v-reg-addr')?.addEventListener('input', function () {
    if (document.getElementById('v-same-addr')?.checked) {
      document.getElementById('v-del-addr').value = this.value;
    }
  });

});

// ══════════════════════════════════════════════
//  XSS 방지
// ══════════════════════════════════════════════
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ══════════════════════════════════════════════
//  자동 로그인 (토큰 유효 시)
// ══════════════════════════════════════════════
(async () => {
  const token = localStorage.getItem('token');
  const saved = JSON.parse(localStorage.getItem('user') || 'null');

  if (token && saved) {
    try {
      await API.get('/auth/me');  // 토큰 유효성 확인
      initApp(saved);
    } catch {
      // 토큰 만료 → 로그인 화면
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      showScreen('screen-login');
    }
  } else {
    showScreen('screen-login');
  }
})();
