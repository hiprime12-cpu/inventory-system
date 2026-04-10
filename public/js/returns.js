'use strict';
// ══════════════════════════════════════════════
//  반품/교환 관리 (returns.js)
// ══════════════════════════════════════════════

// ── 상태 ──
let _rtOrders         = [];
let _rtCurrentOrder   = null;
let _rtEditId         = null;
let _rtFormType       = 'return';
let _rtInventory      = [];
let _rtReturnRowCount = 0;
let _rtExRowCount     = 0;
let _rtDropdownItems  = [];
let _rtDropdownRow    = -1;
let _rtModelInputTimer= null;
let _rtLinkedOutbound = null;   // 연동된 출고건
let _rtLinkedItems    = [];     // 연동된 출고 품목 (체크박스용)
let _rtCurrentVendorId = null;  // 현재 선택된 거래처 ID (날짜 재조회용)
let _rtFpStart        = null;
let _rtFpEnd          = null;
let _rtFpDate         = null;
let _rtSearchTimer    = null;
let _rtActiveTab      = 'all';

// ── 상수 ──
const RT_STATUS_LABEL = {
  pending:          '접수대기',
  testing:          '테스트중',
  normal:           '정상확정',
  defective:        '불량확정',
  exchange_pending: '교환출고대기',
  exchange_done:    '교환완료',
};
const RT_STATUS_CLASS = {
  pending:          'rt-badge-pending',
  testing:          'rt-badge-testing',
  normal:           'rt-badge-normal',
  defective:        'rt-badge-defective',
  exchange_pending: 'rt-badge-exchange-pending',
  exchange_done:    'rt-badge-exchange-done',
};
const RT_REASON_LABEL = {
  change_of_mind:   '고객변심',
  wrong_delivery:   '오배송',
  defect_suspected: '불량의심',
  other:            '기타',
};

// ── 서브페이지 전환 ──────────────────────────
function rtShowSubpage(name) {
  ['list', 'form', 'detail'].forEach(p =>
    document.getElementById(`rt-${p}`)?.classList.toggle('hidden', p !== name)
  );
  document.getElementById('rt-model-dropdown')?.classList.add('hidden');
}

// ── 금액 포맷 ──────────────────────────────────
function rtFmt(v) {
  if (v === null || v === undefined || v === '') return '-';
  return Number(v).toLocaleString('ko-KR') + '원';
}

// ══════════════════════════════════════════════
//  목록 페이지
// ══════════════════════════════════════════════

async function loadReturnsList() {
  rtShowSubpage('list');
  try {
    const list = await API.get('/returns');
    _rtOrders = list;
    rtInitDatePickers();
    rtApplyFilter();
  } catch (err) { toast(err.message, 'error'); }
}

function rtInitDatePickers() {
  if (_rtFpStart) return; // 이미 초기화됨
  const rtToday = new Date().toISOString().slice(0, 10);
  const commonOpts = {
    locale: 'ko', dateFormat: 'Y-m-d',
    onChange: () => rtApplyFilter(),
  };
  _rtFpStart = flatpickr('#rt-date-start', { ...commonOpts, defaultDate: rtToday, placeholder: '시작일' });
  _rtFpEnd   = flatpickr('#rt-date-end',   { ...commonOpts, defaultDate: rtToday, placeholder: '종료일' });
  rtApplyFilter();

  document.querySelectorAll('[data-rtrange]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.rtrange;
      rtSetQuickRange(r);
    });
  });

  document.getElementById('rt-search')?.addEventListener('input', () => {
    clearTimeout(_rtSearchTimer);
    _rtSearchTimer = setTimeout(rtApplyFilter, 300);
  });

  document.querySelectorAll('[data-rttab]').forEach(btn => {
    btn.addEventListener('click', () => {
      _rtActiveTab = btn.dataset.rttab;
      document.querySelectorAll('[data-rttab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      rtApplyFilter();
    });
  });
}

function rtSetQuickRange(range) {
  const today = new Date();
  const fmt   = d => d.toISOString().slice(0, 10);
  if (range === 'clear') {
    _rtFpStart?.setDate('', true); _rtFpEnd?.setDate('', true);
  } else if (range === 'today') {
    _rtFpStart?.setDate(fmt(today), true); _rtFpEnd?.setDate(fmt(today), true);
  } else if (range === 'week') {
    const mon = new Date(today); mon.setDate(today.getDate() - today.getDay() + 1);
    const sun = new Date(mon);   sun.setDate(mon.getDate() + 6);
    _rtFpStart?.setDate(fmt(mon), true); _rtFpEnd?.setDate(fmt(sun), true);
  } else if (range === 'month') {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const last  = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    _rtFpStart?.setDate(fmt(first), true); _rtFpEnd?.setDate(fmt(last), true);
  }
  rtApplyFilter();
}

function rtApplyFilter() {
  const start = document.getElementById('rt-date-start')?.value || '';
  const end   = document.getElementById('rt-date-end')?.value   || '';
  const q     = (document.getElementById('rt-search')?.value || '').toLowerCase().trim();
  const tab   = _rtActiveTab;

  const counts = { all:0, return:0, exchange:0, pending:0, testing:0,
    normal:0, defective:0, exchange_pending:0, exchange_done:0 };

  const filtered = _rtOrders.filter(r => {
    counts.all++;
    counts[r.type]   = (counts[r.type]   || 0) + 1;
    counts[r.status] = (counts[r.status] || 0) + 1;

    const d = r.received_at || '';
    if (start && d < start) return false;
    if (end   && d > end)   return false;
    if (q) {
      const itemText = [...(r.return_items||[]), ...(r.exchange_items||[])].map(it =>
        [it.manufacturer, it.model_name, it.spec, it.category].map(v => (v||'').toLowerCase()).join(' ')
      ).join(' ');
      const text = [(r.vendor_name||''), itemText,
        RT_REASON_LABEL[r.reason]||''].join(' ').toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });

  // 탭 카운트 업데이트
  Object.keys(counts).forEach(k => {
    const el = document.getElementById(`rt-count-${k}`);
    if (el) el.textContent = counts[k];
  });

  const tabFiltered = tab === 'all' ? filtered : filtered.filter(r =>
    r.type === tab || r.status === tab
  );

  rtRenderCards(tabFiltered);
}

function rtRenderCards(list) {
  const wrap = document.getElementById('rt-cards');
  if (!wrap) return;

  document.getElementById('rt-list-title').textContent =
    `반품/교환 관리 (${list.length}건)`;

  if (!list.length) {
    wrap.innerHTML = '<div class="empty">내역이 없습니다.</div>';
    return;
  }

  wrap.innerHTML = list.map(r => {
    const typeLabel = r.type === 'return' ? '반품' : '교환';
    const typeClass = r.type === 'return' ? 'rt-type-return' : 'rt-type-exchange';
    const statusLabel = RT_STATUS_LABEL[r.status] || r.status;
    const statusClass = RT_STATUS_CLASS[r.status]  || '';
    const reasonLabel = RT_REASON_LABEL[r.reason]  || r.reason;

    const itemsSummary = (r.return_items || []).map(it =>
      `${it.manufacturer || ''} ${it.model_name || ''}`.trim()
    ).filter(Boolean).slice(0, 3).join(', ')
    + ((r.return_items || []).length > 3 ? ` 외 ${r.return_items.length - 3}건` : '');

    return `<div class="ib-card" onclick="rtShowDetail('${r.id}')">
      <div class="ib-card-top">
        <span class="ib-card-vendor">${escHtml(r.vendor_name || '(거래처 없음)')}</span>
        <span class="ib-card-date">${r.received_at || '-'}</span>
        <div class="ib-card-badges">
          <span class="rt-type-badge ${typeClass}">${typeLabel}</span>
          <span class="ib-badge ${statusClass}">${statusLabel}</span>
        </div>
      </div>
      <div class="ib-card-summary">${escHtml(itemsSummary || '품목 없음')}</div>
      <div class="ib-card-total">사유: <b>${escHtml(reasonLabel)}</b>
        ${r.notes ? ` · ${escHtml(r.notes)}` : ''}
        ${r.linked_outbound_id ? ' · 🔗 출고건연동' : ''}
      </div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════
//  상세 페이지
// ══════════════════════════════════════════════

async function rtShowDetail(id) {
  try {
    const order = await API.get(`/returns/${id}`);
    _rtCurrentOrder = order;
    rtShowSubpage('detail');
    rtRenderDetail(order);
  } catch (err) { toast(err.message, 'error'); }
}

function rtRenderDetail(order) {
  const content = document.getElementById('rt-detail-content');
  if (!content) return;

  const typeLabel   = order.type === 'return' ? '반품' : '교환';
  const typeClass   = order.type === 'return'  ? 'rt-type-return' : 'rt-type-exchange';
  const statusLabel = RT_STATUS_LABEL[order.status] || order.status;
  const statusClass = RT_STATUS_CLASS[order.status]  || '';
  const reasonLabel = RT_REASON_LABEL[order.reason]  || order.reason;

  // 반품 품목 테이블
  const returnItemsHtml = (order.return_items || []).map(it => `
    <tr>
      <td title="${escHtml(it.category || '-')}">${escHtml(it.category || '-')}</td>
      <td title="${escHtml(it.manufacturer)}">${escHtml(it.manufacturer)}</td>
      <td title="${escHtml(it.model_name)}">${escHtml(it.model_name)}</td>
      <td title="${escHtml(it.spec || '-')}">${escHtml(it.spec || '-')}</td>
      <td style="text-align:right">${it.quantity}</td>
      <td style="text-align:right">${it.sale_price != null && it.sale_price !== '' ? Number(it.sale_price).toLocaleString() : '-'}</td>
      <td title="${escHtml(it.notes || '-')}">${escHtml(it.notes || '-')}</td>
    </tr>`).join('') || `<tr><td colspan="7" class="empty">품목 없음</td></tr>`;

  // 교환 출고 품목 테이블
  let exchangeSection = '';
  if (order.type === 'exchange') {
    const exItemsHtml = (order.exchange_items || []).map(it => `
      <tr>
        <td title="${escHtml(it.category || '-')}">${escHtml(it.category || '-')}</td>
        <td title="${escHtml(it.manufacturer)}">${escHtml(it.manufacturer)}</td>
        <td title="${escHtml(it.model_name)}">${escHtml(it.model_name)}</td>
        <td title="${escHtml(it.spec || '-')}">${escHtml(it.spec || '-')}</td>
        <td style="text-align:right">${it.quantity}</td>
        <td style="text-align:right">${Number(it.sale_price).toLocaleString()}</td>
        <td style="text-align:right">${Number(it.total_price).toLocaleString()}</td>
        <td title="${escHtml(it.notes || '-')}">${escHtml(it.notes || '-')}</td>
      </tr>`).join('') || `<tr><td colspan="8" class="empty">품목 없음</td></tr>`;

    const exTotal      = (order.exchange_items || []).reduce((s,i) => s + (Number(i.total_price)||0), 0);
    const returnTotal  = (order.return_items   || []).reduce((s,i) => s + (Number(i.sale_price)||0) * (Number(i.quantity)||0), 0);
    const diff         = exTotal - returnTotal;
    const diffLabel    = diff < 0
      ? `<span style="color:#e03131">환불: ${Math.abs(diff).toLocaleString()}원</span>`
      : diff > 0
        ? `<span style="color:#1971c2">추가결제: ${diff.toLocaleString()}원</span>`
        : '';
    const totalLine    = diff !== 0
      ? `교환 합계: ${exTotal.toLocaleString()}원 &nbsp;|&nbsp; 출고 판매가: ${returnTotal.toLocaleString()}원 &nbsp;→&nbsp; ${diffLabel}`
      : `교환 합계: ${exTotal.toLocaleString()}원`;

    exchangeSection = `
      <div class="ib-header-card" style="margin-top:.75rem">
        <div class="rt-section-title">🔄 교환 출고 품목</div>
        <div class="table-wrap" style="overflow-x:auto">
          <table class="tbl rt-detail-tbl" style="min-width:820px">
            <colgroup>
              <col style="width:70px">
              <col style="width:80px">
              <col style="width:120px">
              <col style="width:150px">
              <col style="width:60px">
              <col style="width:90px">
              <col style="width:100px">
              <col style="width:150px">
            </colgroup>
            <thead><tr>
              <th>구분</th><th>브랜드</th><th>모델명</th><th>스펙</th>
              <th>수량</th><th>판매가</th><th>합계</th><th>비고</th>
            </tr></thead>
            <tbody>${exItemsHtml}</tbody>
          </table>
        </div>
        <div style="text-align:right;padding:.5rem .25rem;font-size:.88rem;font-weight:600">
          ${totalLine}
        </div>
      </div>`;
  }

  content.innerHTML = `
    <div class="ib-header-card">
      <div style="display:flex;gap:.75rem;align-items:center;margin-bottom:.75rem;flex-wrap:wrap">
        <span class="rt-type-badge ${typeClass}">${typeLabel}</span>
        <span class="ib-badge ${statusClass}">${statusLabel}</span>
        ${order.linked_outbound_id ? '<span style="font-size:.8rem;color:var(--gray-500)">🔗 출고건 연동</span>' : ''}
      </div>
      <div class="form-row-3">
        <div class="vdd-field"><div class="vdd-label">접수일</div><div class="vdd-value">${order.received_at || '-'}</div></div>
        <div class="vdd-field"><div class="vdd-label">거래처</div><div class="vdd-value">${escHtml(order.vendor_name || '-')}</div></div>
        <div class="vdd-field"><div class="vdd-label">사유</div><div class="vdd-value">${escHtml(reasonLabel)}</div></div>
      </div>
      <div class="form-row-2">
        <div class="vdd-field"><div class="vdd-label">접수자</div><div class="vdd-value">${escHtml(order.created_by_name || '-')}</div></div>
        <div class="vdd-field"><div class="vdd-label">접수일시</div><div class="vdd-value">${fmtDateTime(order.created_at)}</div></div>
      </div>
      ${order.notes ? `<div class="vdd-field"><div class="vdd-label">비고</div><div class="vdd-value">${escHtml(order.notes)}</div></div>` : ''}
      ${order.updated_by_name ? `<div class="vdd-meta" style="margin-top:.5rem"><span><span class="meta-label">최종수정</span>${fmtDateTime(order.updated_at)}</span> <span><span class="meta-label">수정자</span>${escHtml(order.updated_by_name)}</span></div>` : ''}
    </div>

    <div class="ib-header-card" style="margin-top:.75rem">
      <div class="rt-section-title">📦 반품 품목</div>
      <div class="table-wrap" style="overflow-x:auto">
        <table class="tbl rt-detail-tbl" style="min-width:720px">
          <colgroup>
            <col style="width:70px">
            <col style="width:80px">
            <col style="width:120px">
            <col style="width:150px">
            <col style="width:60px">
            <col style="width:90px">
            <col style="width:150px">
          </colgroup>
          <thead><tr>
            <th>구분</th><th>브랜드</th><th>모델명</th><th>스펙</th>
            <th>수량</th><th>판매가</th><th>비고</th>
          </tr></thead>
          <tbody>${returnItemsHtml}</tbody>
        </table>
      </div>
    </div>
    ${exchangeSection}`;

  // 상태 변경 버튼 렌더
  rtRenderStatusActions(order);

  // 수정/삭제 버튼 권한
  const role = currentUser?.role;
  const editBtn   = document.getElementById('btn-rt-edit');
  const deleteBtn = document.getElementById('btn-rt-delete');
  if (editBtn)   editBtn.classList.toggle('hidden', order.status !== 'pending' && role !== 'admin');
  if (deleteBtn) deleteBtn.classList.toggle('hidden', order.status !== 'pending' && role !== 'admin');
}

function rtRenderStatusActions(order) {
  const wrap = document.getElementById('rt-status-actions');
  if (!wrap) return;

  const role   = currentUser?.role;
  const status = order.status;
  const type   = order.type;

  let html = '';

  if (status === 'pending') {
    if (type === 'exchange') {
      html = `<button class="btn btn-primary" onclick="rtChangeStatus('${order.id}','exchange_pending')">🔄 교환출고대기</button>`;
    } else {
      html = `<button class="btn btn-primary" onclick="rtChangeStatus('${order.id}','testing')">테스트 시작</button>`;
    }
  } else if (status === 'testing') {
    if (type === 'return') {
      html = `
        <button class="btn btn-success" onclick="rtChangeStatus('${order.id}','normal')">✅ 정상확정</button>
        <button class="btn btn-danger"  onclick="rtChangeStatus('${order.id}','defective')">❌ 불량확정</button>`;
    } else {
      html = `
        <button class="btn btn-primary" onclick="rtChangeStatus('${order.id}','exchange_pending')">🔄 교환출고대기</button>
        <button class="btn btn-danger"  onclick="rtChangeStatus('${order.id}','defective')">❌ 불량확정</button>`;
    }
  } else if (status === 'exchange_pending') {
    html = `<button class="btn btn-success" onclick="rtChangeStatus('${order.id}','exchange_done')">✅ 교환완료</button>`;
  } else if (['normal','defective','exchange_done'].includes(status) && role === 'admin') {
    // admin 전용: 상태 되돌리기
    html = `<button class="btn btn-ghost btn-sm" onclick="rtAdminResetStatus('${order.id}','${status}')">⚙ 상태 변경 (관리자)</button>`;
  }

  wrap.innerHTML = html;
}

async function rtChangeStatus(id, status) {
  const labels = {
    testing:          '테스트 시작',
    normal:           '정상확정',
    defective:        '불량확정',
    exchange_pending: '교환출고대기',
    exchange_done:    '교환완료',
  };
  const msg = {
    normal:         '정상확정 처리하면 재고가 복구됩니다.',
    defective:      '불량확정 처리하면 불량재고가 증가합니다.',
    exchange_done:  '교환완료 처리하면 교환 출고가 자동 생성되고 재고가 차감됩니다.',
    exchange_pending: '교환출고대기로 변경합니다.',
    testing:        '테스트 시작으로 변경합니다.',
  };

  const confirmMsg = `[${labels[status] || status}]\n${msg[status] || ''}\n\n계속하시겠습니까?`;
  if (!confirm(confirmMsg)) return;

  try {
    const updated = await API.patch(`/returns/${id}/status`, { status });
    _rtCurrentOrder = updated;
    // 목록 캐시 업데이트
    const idx = _rtOrders.findIndex(o => o.id === id);
    if (idx >= 0) _rtOrders[idx] = { ..._rtOrders[idx], ...updated };
    rtRenderDetail(updated);
    toast(`상태가 "${RT_STATUS_LABEL[status]}"(으)로 변경되었습니다.`, 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function rtAdminResetStatus(id, currentStatus) {
  const all = ['pending','testing','normal','defective','exchange_pending','exchange_done'];
  const opts = all.filter(s => s !== currentStatus)
    .map(s => `${s} (${RT_STATUS_LABEL[s]})`).join('\n');
  const input = prompt(`새 상태를 입력하세요:\n${opts}`);
  if (!input) return;
  const newStatus = all.find(s => input.startsWith(s));
  if (!newStatus) { toast('유효하지 않은 상태입니다.', 'error'); return; }
  if (!confirm(`상태를 "${RT_STATUS_LABEL[newStatus]}"(으)로 변경하시겠습니까? (admin 강제 변경)`)) return;
  try {
    const updated = await API.patch(`/returns/${id}/status`, { status: newStatus });
    _rtCurrentOrder = updated;
    rtRenderDetail(updated);
    toast('상태 변경 완료', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function rtDeleteCurrent() {
  const order = _rtCurrentOrder;
  if (!order) return;
  const msg = order.status === 'pending'
    ? '이 접수건을 삭제하시겠습니까? pending_test 수량이 복구됩니다.'
    : '접수대기 이후 상태입니다. 삭제하면 재고 상태가 불일치할 수 있습니다.\n정말 삭제하시겠습니까? (관리자 권한)';
  if (!confirm(msg)) return;
  try {
    await API.del(`/returns/${order.id}`);
    _rtOrders = _rtOrders.filter(o => o.id !== order.id);
    toast('삭제되었습니다.', 'success');
    rtShowSubpage('list');
    rtApplyFilter();
  } catch (err) { toast(err.message, 'error'); }
}

// ══════════════════════════════════════════════
//  등록/수정 폼
// ══════════════════════════════════════════════

function rtShowForm(type, editId = null) {
  _rtFormType       = type;
  _rtEditId         = editId;
  _rtLinkedOutbound = null;
  _rtLinkedItems    = [];

  // 폼 리셋
  document.getElementById('rt-form-type').value    = type;
  document.getElementById('rt-form-id').value      = editId || '';
  document.getElementById('rt-form-title').textContent = editId
    ? `${type === 'return' ? '반품' : '교환'} 수정`
    : `${type === 'return' ? '반품' : '교환'} 등록`;
  document.getElementById('rt-type-display').value = type === 'return' ? '반품' : '교환';
  document.getElementById('rt-reason').value       = 'change_of_mind';
  document.getElementById('rt-notes').value        = '';
  document.getElementById('rt-vendor-input').value = '';
  document.getElementById('rt-vendor-id').value    = '';

  // 출고건 연동 초기화
  document.getElementById('rt-outbound-list')?.classList.add('hidden');
  document.getElementById('rt-linked-display')?.classList.add('hidden');

  // 교환 섹션 표시/숨김
  const exSection = document.getElementById('rt-exchange-section');
  if (exSection) exSection.classList.toggle('hidden', type !== 'exchange');

  // 날짜 피커 초기화
  if (_rtFpDate) _rtFpDate.destroy();
  _rtFpDate = flatpickr('#rt-received-at', {
    locale: 'ko', dateFormat: 'Y-m-d', defaultDate: 'today',
  });

  // 행 초기화
  rtSetReturnRows(1);
  if (type === 'exchange') rtSetExRows(1);

  // 거래처 캐시 없으면 미리 로드
  if (!allSalesVendors || allSalesVendors.length === 0) {
    API.get('/sales-vendors').then(list => { allSalesVendors = list; }).catch(() => {});
  }

  rtShowSubpage('form');

  // 수정 모드: 기존 데이터 채우기
  if (editId) rtFillForm(_rtCurrentOrder);
}

function rtFillForm(order) {
  if (!order) return;
  _rtFpDate?.setDate(order.received_at || '', true);
  document.getElementById('rt-reason').value = order.reason || 'change_of_mind';
  document.getElementById('rt-notes').value  = order.notes  || '';

  if (order.sales_vendor_id) {
    document.getElementById('rt-vendor-id').value    = order.sales_vendor_id;
    document.getElementById('rt-vendor-input').value = order.vendor_name || '';
  }

  // 반품 품목 채우기
  const rItems = order.return_items || [];
  rtSetReturnRows(rItems.length || 1, false);
  rItems.forEach((it, i) => rtFillReturnRow(i, it));

  // 교환 품목 채우기
  if (order.type === 'exchange') {
    const eItems = order.exchange_items || [];
    rtSetExRows(eItems.length || 1, false);
    eItems.forEach((it, i) => rtFillExRow(i, it));
  }
}

// ── 반품 품목 행 관리 ──────────────────────────

function rtSetReturnRows(n, reset = true) {
  const tbody = document.getElementById('rt-return-items-tbody');
  if (!tbody) return;
  if (reset) tbody.innerHTML = '';
  _rtReturnRowCount = reset ? 0 : _rtReturnRowCount;
  for (let i = 0; i < n; i++) rtAddReturnRow();
}

function rtAddReturnRow(linked = false) {
  const tbody = document.getElementById('rt-return-items-tbody');
  if (!tbody) return;
  const idx = _rtReturnRowCount++;
  const tr  = document.createElement('tr');
  tr.id = `rt-ri-${idx}`;
  tr.innerHTML = `
    <td style="text-align:center">
      ${linked ? `<input type="checkbox" class="rt-ri-chk" data-idx="${idx}" checked />` : ''}
    </td>
    <td><input class="ib-inp rt-ri-category" type="text" placeholder="구분" /></td>
    <td><input class="ib-inp rt-ri-mfr"      type="text" placeholder="브랜드" /></td>
    <td><input class="ib-inp rt-ri-model"    type="text" placeholder="모델명" /></td>
    <td><input class="ib-inp rt-ri-spec"     type="text" placeholder="스펙" /></td>
    <td><input class="ib-inp rt-ri-qty"      type="number" min="1" placeholder="0"
      style="width:60px" data-max="" oninput="rtCheckReturnQty(${idx})" /></td>
    <td><input class="ib-inp rt-ri-price"    type="number" min="0" placeholder="0"
      style="width:90px;text-align:right" oninput="rtCalcExFooter()" /></td>
    <td><input class="ib-inp rt-ri-notes"    type="text" placeholder="비고" /></td>
    <td>
      <button type="button" class="btn btn-sm btn-ghost"
        style="padding:.15rem .4rem;color:var(--gray-400)"
        onclick="document.getElementById('rt-ri-${idx}')?.remove()">✕</button>
    </td>`;
  tbody.appendChild(tr);
}

window.rtCheckReturnQty = function(idx) {
  const row = document.getElementById(`rt-ri-${idx}`);
  if (!row) return;
  const qtyEl = row.querySelector('.rt-ri-qty');
  const max   = Number(qtyEl?.dataset.max);
  const val   = Number(qtyEl?.value);
  if (max > 0 && val > max) {
    qtyEl.style.color       = '#e03131';
    qtyEl.style.borderColor = '#e03131';
    qtyEl.title = `출고 수량 초과 (최대 ${max}개)`;
  } else {
    qtyEl.style.color       = '';
    qtyEl.style.borderColor = '';
    qtyEl.title = '';
  }
};

function rtFillReturnRow(idx, it) {
  const row = document.getElementById(`rt-ri-${idx}`);
  if (!row) return;
  row.querySelector('.rt-ri-category').value = it.category     || '';
  row.querySelector('.rt-ri-mfr').value      = it.manufacturer || '';
  row.querySelector('.rt-ri-model').value    = it.model_name   || '';
  row.querySelector('.rt-ri-spec').value     = it.spec         || '';
  row.querySelector('.rt-ri-qty').value      = it.quantity     || '';
  row.querySelector('.rt-ri-price').value    = it.sale_price != null ? it.sale_price : '';
  row.querySelector('.rt-ri-notes').value    = it.notes        || '';
  if (it.outbound_qty) {
    row.querySelector('.rt-ri-qty').dataset.max = it.outbound_qty;
  }
  if (it.outbound_item_id) {
    row.dataset.outboundItemId = it.outbound_item_id;
  }
}

// ── 교환 출고 품목 행 관리 ────────────────────

function rtSetExRows(n, reset = true) {
  const tbody = document.getElementById('rt-exchange-items-tbody');
  if (!tbody) return;
  if (reset) tbody.innerHTML = '';
  _rtExRowCount = reset ? 0 : _rtExRowCount;
  for (let i = 0; i < n; i++) rtAddExRow();
}

function rtAddExRow() {
  const tbody = document.getElementById('rt-exchange-items-tbody');
  if (!tbody) return;
  const idx = _rtExRowCount++;
  const tr  = document.createElement('tr');
  tr.id = `rt-ex-${idx}`;
  tr.dataset.maxStock = '';
  tr.innerHTML = `
    <td><input class="ib-inp rt-ex-category" type="text" placeholder="구분" /></td>
    <td><input class="ib-inp rt-ex-mfr"      type="text" placeholder="브랜드" /></td>
    <td style="position:relative">
      <input class="ib-inp rt-ex-model" type="text" placeholder="모델명" autocomplete="off"
        oninput="rtModelInputChange(this,${idx})"
        onfocus="rtShowModelDropdown(this,${idx})"
        onblur="setTimeout(()=>document.getElementById('rt-model-dropdown')?.classList.add('hidden'),200)" />
    </td>
    <td><input class="ib-inp rt-ex-spec"  type="text" placeholder="스펙" /></td>
    <td><input class="ib-inp rt-ex-qty"   type="number" min="1" placeholder="0"
      style="width:60px" oninput="rtCalcExRow(${idx})" /></td>
    <td><input class="ib-inp rt-ex-price" type="number" min="0" placeholder="0"
      oninput="rtCalcExRow(${idx})" /></td>
    <td class="rt-ex-total" style="text-align:right;font-weight:600">0</td>
    <td><input class="ib-inp rt-ex-notes" type="text" placeholder="비고" /></td>
    <td>
      <button type="button" class="btn btn-sm btn-ghost"
        style="padding:.15rem .4rem;color:var(--gray-400)"
        onclick="document.getElementById('rt-ex-${idx}')?.remove();rtCalcExFooter()">✕</button>
    </td>`;
  tbody.appendChild(tr);
}

window.rtCalcExRow = function(idx) {
  const row = document.getElementById(`rt-ex-${idx}`);
  if (!row) return;
  const qty   = Number(row.querySelector('.rt-ex-qty')?.value)   || 0;
  const price = Number(row.querySelector('.rt-ex-price')?.value) || 0;
  const total = qty * price;
  const cell  = row.querySelector('.rt-ex-total');
  if (cell) cell.textContent = total.toLocaleString();

  // 재고 초과 경고
  const maxStock = row.dataset.maxStock;
  const qtyEl    = row.querySelector('.rt-ex-qty');
  if (qtyEl && maxStock !== '' && maxStock !== undefined && maxStock !== null) {
    const over = qty > Number(maxStock);
    qtyEl.style.color       = over ? '#e03131' : '';
    qtyEl.style.borderColor = over ? '#e03131' : '';
    qtyEl.title             = over ? `재고 부족 (최대 ${maxStock}개)` : '';
  }

  rtCalcExFooter();
};

function rtCalcExFooter() {
  const exRows = document.querySelectorAll('#rt-exchange-items-tbody tr');
  let exTotal = 0;
  exRows.forEach(row => {
    const qty   = Number(row.querySelector('.rt-ex-qty')?.value)   || 0;
    const price = Number(row.querySelector('.rt-ex-price')?.value) || 0;
    exTotal += qty * price;
  });

  // 반품 품목 판매가 합계
  let returnTotal = 0;
  document.querySelectorAll('#rt-return-items-tbody tr').forEach(row => {
    const qty   = Number(row.querySelector('.rt-ri-qty')?.value)   || 0;
    const price = Number(row.querySelector('.rt-ri-price')?.value) || 0;
    returnTotal += qty * price;
  });

  const diff = exTotal - returnTotal;
  const el = document.getElementById('rt-ex-total');
  if (!el) return;

  if (returnTotal > 0 && diff < 0) {
    el.innerHTML = `${exTotal.toLocaleString()}원 &nbsp;<span style="color:#e03131;font-weight:700">→ 환불: ${Math.abs(diff).toLocaleString()}원</span>`;
  } else if (returnTotal > 0 && diff > 0) {
    el.innerHTML = `${exTotal.toLocaleString()}원 &nbsp;<span style="color:#1971c2;font-weight:700">→ 추가결제: ${diff.toLocaleString()}원</span>`;
  } else {
    el.textContent = exTotal.toLocaleString() + '원';
  }
}

function rtFillExRow(idx, it) {
  const row = document.getElementById(`rt-ex-${idx}`);
  if (!row) return;
  row.querySelector('.rt-ex-category').value = it.category     || '';
  row.querySelector('.rt-ex-mfr').value      = it.manufacturer || '';
  row.querySelector('.rt-ex-model').value    = it.model_name   || '';
  row.querySelector('.rt-ex-spec').value     = it.spec         || '';
  row.querySelector('.rt-ex-qty').value      = it.quantity     || '';
  row.querySelector('.rt-ex-price').value    = it.sale_price   || '';
  row.querySelector('.rt-ex-notes').value    = it.notes        || '';
  rtCalcExRow(idx);
}

// ── 모델명 드롭다운 (교환 출고용) ───────────────

window.rtModelInputChange = function(inputEl, rowIdx) {
  clearTimeout(_rtModelInputTimer);
  _rtModelInputTimer = setTimeout(() => rtShowModelDropdown(inputEl, rowIdx), 300);
};

window.rtShowModelDropdown = function(inputEl, rowIdx) {
  _rtDropdownRow = rowIdx;
  const q      = (inputEl.value || '').toLowerCase().trim();
  const row    = document.getElementById(`rt-ex-${rowIdx}`);
  const catVal = (row?.querySelector('.rt-ex-category')?.value || '').toLowerCase().trim();
  const mfrVal = (row?.querySelector('.rt-ex-mfr')?.value      || '').toLowerCase().trim();

  let pool = _rtInventory;
  let hint = '';

  if (catVal && mfrVal) {
    pool = pool.filter(inv =>
      (inv.category||'').toLowerCase() === catVal &&
      (inv.manufacturer||'').toLowerCase() === mfrVal
    );
  } else if (catVal) {
    pool = pool.filter(inv => (inv.category||'').toLowerCase() === catVal);
  } else if (mfrVal) {
    pool = pool.filter(inv => (inv.manufacturer||'').toLowerCase() === mfrVal);
  } else {
    hint = '더 정확한 검색을 위해 구분 또는 브랜드를 먼저 입력하세요.';
  }

  const matches = q
    ? pool.filter(inv => (inv.model_name||'').toLowerCase().includes(q))
    : pool;

  const limited    = matches.slice(0, 20);
  _rtDropdownItems = limited;

  const dd = document.getElementById('rt-model-dropdown');
  if (!dd) return;
  const rect = inputEl.getBoundingClientRect();
  dd.style.top      = (rect.bottom + window.scrollY) + 'px';
  dd.style.left     = rect.left + 'px';
  dd.style.minWidth = '560px';

  const tbody = document.getElementById('rt-model-dropdown-tbody');
  if (!tbody) return;

  let rows = '';
  if (!limited.length) {
    rows = `<tr><td colspan="6" class="empty" style="padding:.5rem">검색 결과 없음</td></tr>`;
  } else {
    rows = limited.map((inv, i) => {
      const noStock = inv.current_stock <= 0;
      const warn    = inv.pending_test > 0 ? ' ⚠' : '';
      const ct      = inv.condition_type || 'normal';
      const ctLabel = ct === 'defective' ? '불량' : ct === 'disposal' ? '폐기' : '정상';
      const ctCls   = ct === 'defective' ? 'ob-cond-defective' : ct === 'disposal' ? 'ob-cond-disposal' : 'ob-cond-normal';
      return `<tr class="ob-model-row${noStock ? ' ob-row-nostock' : ''}"
        ${noStock ? '' : `onmousedown="rtSelectModelByIdx(${i})"`}>
        <td>${escHtml(inv.category||'-')}</td>
        <td>${escHtml(inv.manufacturer||'-')}</td>
        <td>${escHtml(inv.model_name)}</td>
        <td>${escHtml(inv.spec||'-')}</td>
        <td><span class="ob-cond-badge ${ctCls}">${ctLabel}</span></td>
        <td class="${noStock ? 'ob-stock-zero' : ''}">${inv.current_stock}개${warn}</td>
      </tr>`;
    }).join('');
  }

  const hintRow = hint
    ? `<tr><td colspan="6" style="padding:.35rem .6rem;font-size:.8rem;color:var(--gray-500);background:#fafafa">${hint}</td></tr>`
    : '';
  const moreRow = matches.length > 20
    ? `<tr><td colspan="6" style="padding:.35rem .6rem;font-size:.8rem;color:var(--gray-500);background:#fafafa">... 외 ${matches.length-20}개 더 있습니다.</td></tr>`
    : '';

  tbody.innerHTML = hintRow + rows + moreRow;
  dd.classList.remove('hidden');
};

window.rtSelectModelByIdx = function(i) {
  const inv = _rtDropdownItems[i];
  if (!inv) return;
  const row = document.getElementById(`rt-ex-${_rtDropdownRow}`);
  if (!row) return;
  row.querySelector('.rt-ex-category').value = inv.category    || '';
  row.querySelector('.rt-ex-mfr').value      = inv.manufacturer;
  row.querySelector('.rt-ex-model').value    = inv.model_name;
  row.querySelector('.rt-ex-spec').value     = inv.spec        || '';
  row.dataset.maxStock = inv.current_stock;
  rtCalcExRow(_rtDropdownRow);
  document.getElementById('rt-model-dropdown')?.classList.add('hidden');
};

// ── 거래처 드롭다운 ──────────────────────────────

window.rtFilterVendors = function(q) {
  const dd = document.getElementById('rt-vendor-dropdown');
  if (!dd) return;
  if (!q) { dd.classList.add('hidden'); return; }

  const matches = (allSalesVendors || []).filter(v =>
    (v.company_name || '').toLowerCase().includes(q.toLowerCase())
  ).slice(0, 10);

  const unregOption = `<div class="ob-vendor-item ob-vendor-unreg" onmousedown="rtSelectVendor('novendor:${escHtml(q)}','${escHtml(q)}')">
    🔍 "<b>${escHtml(q)}</b>" 미등록 거래처 출고건 검색
  </div>`;

  if (matches.length) {
    dd.innerHTML = matches.map(v =>
      `<div class="ob-vendor-item" onmousedown="rtSelectVendor('${v.id}','${escHtml(v.company_name)}')">
        ${escHtml(v.company_name)}${v.name ? ` (${escHtml(v.name)})` : ''}
       </div>`
    ).join('') + unregOption;
    dd.classList.remove('hidden');
  } else {
    dd.innerHTML = unregOption;
    dd.classList.remove('hidden');
  }
};

window.rtSelectVendor = function(id, name) {
  document.getElementById('rt-vendor-input').value = name;
  document.getElementById('rt-vendor-id').value    = id;
  document.getElementById('rt-vendor-dropdown')?.classList.add('hidden');
  _rtCurrentVendorId = id;
  // 해당 거래처의 출고건 조회 (날짜 필터 초기화)
  rtLoadOutboundByVendor(id, '', '');
};

// ── 출고건 연동 ──────────────────────────────────

async function rtLoadOutboundByVendor(vendorId, from, to) {
  const listBox = document.getElementById('rt-outbound-list');
  if (!listBox) return;

  // 날짜 값이 undefined이면 현재 입력 값 유지, 빈 문자열이면 초기화
  const fromVal = from !== undefined ? from : (document.getElementById('rt-ob-from')?.value || '');
  const toVal   = to   !== undefined ? to   : (document.getElementById('rt-ob-to')?.value   || '');

  listBox.classList.remove('hidden');

  // 날짜 필터 바 항상 렌더 (조회 결과 위에)
  const filterBar = `
    <div class="rt-ob-filter-bar">
      <span class="rt-ob-filter-label">날짜 범위</span>
      <input type="date" id="rt-ob-from" class="rt-ob-date-inp" value="${fromVal}" placeholder="시작일" />
      <span style="color:var(--gray-400)">~</span>
      <input type="date" id="rt-ob-to"   class="rt-ob-date-inp" value="${toVal}"   placeholder="종료일" />
      <button class="btn btn-sm btn-primary" onclick="rtReloadOutbound()">조회</button>
      <button class="btn btn-sm btn-ghost"   onclick="rtReloadOutbound('clear')">전체</button>
    </div>`;

  listBox.innerHTML = filterBar + '<div class="rt-ob-loading">조회 중...</div>';

  let apiUrl;
  if (vendorId.startsWith('novendor:')) {
    const name = vendorId.slice(9);
    const qs = new URLSearchParams({ name: name });
    if (fromVal) qs.set('from', fromVal);
    if (toVal)   qs.set('to',   toVal);
    apiUrl = `/returns/outbound-by-vendor/novendor?${qs}`;
  } else {
    const qs = new URLSearchParams();
    if (fromVal) qs.set('from', fromVal);
    if (toVal)   qs.set('to',   toVal);
    apiUrl = `/returns/outbound-by-vendor/${vendorId}?${qs}`;
  }

  try {
    const orders = await API.get(apiUrl);
    const filterBarEl = listBox.querySelector('.rt-ob-filter-bar');
    const filterHtml  = filterBarEl ? filterBarEl.outerHTML : filterBar;

    if (!orders.length) {
      listBox.innerHTML = filterHtml +
        '<div style="padding:.5rem;font-size:.85rem;color:var(--gray-500)">해당 기간에 출고건이 없습니다.</div>';
      return;
    }

    listBox.innerHTML = filterHtml + `
      <div style="font-size:.82rem;color:var(--gray-500);padding:.35rem 0 .4rem">
        출고건을 선택하면 품목이 자동으로 채워집니다. (${orders.length}건)
      </div>
      ${orders.map(o => {
        const summary = (o.items || []).map(it =>
          `${it.manufacturer||''} ${it.model_name||''}`.trim()
        ).slice(0, 3).join(', ');
        return `<div class="rt-ob-item" onclick="rtLinkOutbound(${JSON.stringify(o).replace(/"/g,'&quot;')})">
          <span class="rt-ob-date">${o.order_date}</span>
          <span class="rt-ob-summary">${escHtml(summary)}${(o.items||[]).length > 3 ? ` 외 ${o.items.length-3}건` : ''}</span>
          <span class="rt-ob-total">${Number(o.total_price||0).toLocaleString()}원</span>
        </div>`;
      }).join('')}`;
  } catch (err) {
    listBox.innerHTML = filterBar + `<div style="padding:.5rem;color:var(--danger);font-size:.85rem">${err.message}</div>`;
  }
}

window.rtReloadOutbound = function(action) {
  if (!_rtCurrentVendorId) return;
  if (action === 'clear') {
    rtLoadOutboundByVendor(_rtCurrentVendorId, '', '');
  } else {
    const from = document.getElementById('rt-ob-from')?.value || '';
    const to   = document.getElementById('rt-ob-to')?.value   || '';
    rtLoadOutboundByVendor(_rtCurrentVendorId, from, to);
  }
};

function rtLinkOutbound(order) {
  _rtLinkedOutbound = order;
  _rtLinkedItems    = order.items || [];

  // 출고건 목록 숨기고 연동 표시
  const listBox    = document.getElementById('rt-outbound-list');
  const linkedDisp = document.getElementById('rt-linked-display');
  if (listBox)    listBox.classList.add('hidden');

  const itemSummary = _rtLinkedItems.map(it =>
    `${it.manufacturer||''} ${it.model_name||''}`.trim()
  ).slice(0, 3).join(', ');

  if (linkedDisp) {
    linkedDisp.innerHTML = `
      <div class="rt-linked-info">
        🔗 연동: <b>${order.order_date}</b>
        ${escHtml(itemSummary)}${_rtLinkedItems.length > 3 ? ` 외 ${_rtLinkedItems.length-3}건` : ''}
      </div>`;
    linkedDisp.classList.remove('hidden');
  }

  // 반품 품목을 출고 품목으로 채우기 (체크박스 있음)
  const tbody = document.getElementById('rt-return-items-tbody');
  if (tbody) tbody.innerHTML = '';
  _rtReturnRowCount = 0;

  // 행 수 입력 컨트롤 숨기기 (연동 시 자동 생성)
  const ctrl = document.getElementById('rt-direct-row-ctrl');
  if (ctrl) ctrl.style.display = 'none';

  // 컬럼 헤더에 체크박스 표시
  const chkTh = document.getElementById('rt-ri-chk-th');
  if (chkTh) chkTh.innerHTML = '<input type="checkbox" id="rt-ri-chk-all" onchange="rtToggleAllChk(this.checked)" title="전체 선택" />';

  _rtLinkedItems.forEach((it, i) => {
    rtAddReturnRow(true);
    rtFillReturnRow(i, {
      category:    it.category    || '',
      manufacturer:it.manufacturer|| '',
      model_name:  it.model_name  || '',
      spec:        it.spec        || '',
      quantity:    it.quantity    || 0,
      outbound_qty:it.quantity    || 0,
      sale_price:  it.sale_price  ?? '',
      notes:       '',
      outbound_item_id: it.id,
    });
  });
}

function rtClearLinkedOutbound() {
  _rtLinkedOutbound = null;
  _rtLinkedItems    = [];

  const listBox    = document.getElementById('rt-outbound-list');
  const linkedDisp = document.getElementById('rt-linked-display');
  if (listBox)    listBox.classList.add('hidden');
  if (linkedDisp) linkedDisp.classList.add('hidden');

  const ctrl = document.getElementById('rt-direct-row-ctrl');
  if (ctrl) ctrl.style.display = '';

  const chkTh = document.getElementById('rt-ri-chk-th');
  if (chkTh) chkTh.innerHTML = '';

  rtSetReturnRows(1);
}

window.rtToggleAllChk = function(checked) {
  document.querySelectorAll('.rt-ri-chk').forEach(c => c.checked = checked);
};

// ── 저장 ─────────────────────────────────────

async function rtSave() {
  const type       = document.getElementById('rt-form-type').value;
  const editId     = document.getElementById('rt-form-id').value;
  const receivedAt = document.getElementById('rt-received-at')?.value?.trim();
  const reason     = document.getElementById('rt-reason')?.value;
  const notes      = document.getElementById('rt-notes')?.value?.trim() || null;
  const vendorId   = document.getElementById('rt-vendor-id')?.value?.trim()    || null;
  const vendorName = document.getElementById('rt-vendor-input')?.value?.trim() || null;

  if (!receivedAt) { toast('접수일을 선택하세요.', 'error'); return; }

  // 반품 품목 수집
  const returnItems = [];
  document.querySelectorAll('#rt-return-items-tbody tr').forEach(row => {
    // 연동 시 체크박스 확인
    const chk = row.querySelector('.rt-ri-chk');
    if (chk && !chk.checked) return;

    const mfr   = row.querySelector('.rt-ri-mfr')?.value?.trim()   || '';
    const model = row.querySelector('.rt-ri-model')?.value?.trim() || '';
    const qty   = Number(row.querySelector('.rt-ri-qty')?.value)   || 0;
    if (!mfr && !model && !qty) return;
    if (!mfr || !model || qty < 1) {
      toast('반품 품목의 브랜드, 모델명, 수량(1 이상)을 입력하세요.', 'error');
      throw new Error('validation');
    }
    returnItems.push({
      category:    row.querySelector('.rt-ri-category')?.value?.trim() || null,
      manufacturer:mfr,
      model_name:  model,
      spec:        row.querySelector('.rt-ri-spec')?.value?.trim()    || '',
      quantity:    qty,
      sale_price:  Number(row.querySelector('.rt-ri-price')?.value)   || 0,
      notes:       row.querySelector('.rt-ri-notes')?.value?.trim()   || null,
      outbound_item_id: row.dataset.outboundItemId || null,
    });
  });

  if (!returnItems.length) { toast('반품 품목을 1개 이상 입력하세요.', 'error'); return; }

  // 교환 출고 품목 수집
  const exchangeItems = [];
  if (type === 'exchange') {
    document.querySelectorAll('#rt-exchange-items-tbody tr').forEach(row => {
      const mfr   = row.querySelector('.rt-ex-mfr')?.value?.trim()   || '';
      const model = row.querySelector('.rt-ex-model')?.value?.trim() || '';
      const qty   = Number(row.querySelector('.rt-ex-qty')?.value)   || 0;
      if (!mfr && !model && !qty) return;
      if (!mfr || !model || qty < 1) {
        toast('교환 출고 품목의 브랜드, 모델명, 수량(1 이상)을 입력하세요.', 'error');
        throw new Error('validation');
      }
      exchangeItems.push({
        category:    row.querySelector('.rt-ex-category')?.value?.trim() || null,
        manufacturer:mfr,
        model_name:  model,
        spec:        row.querySelector('.rt-ex-spec')?.value?.trim()    || '',
        quantity:    qty,
        sale_price:  Number(row.querySelector('.rt-ex-price')?.value)   || 0,
        notes:       row.querySelector('.rt-ex-notes')?.value?.trim()   || null,
      });
    });
  }

  const body = {
    type,
    received_at:        receivedAt,
    sales_vendor_id:    vendorId,
    vendor_name:        vendorName,
    linked_outbound_id: _rtLinkedOutbound?.id || null,
    reason,
    notes,
    return_items:   returnItems,
    exchange_items: exchangeItems,
  };

  const btn = document.getElementById('btn-rt-save');
  if (btn) btn.disabled = true;
  try {
    let result;
    if (editId) {
      result = await API.put(`/returns/${editId}`, body);
      const idx = _rtOrders.findIndex(o => o.id === editId);
      if (idx >= 0) _rtOrders[idx] = result;
      toast('수정되었습니다.', 'success');
    } else {
      result = await API.post('/returns', body);
      _rtOrders.unshift(result);
      toast('등록되었습니다.', 'success');
    }
    _rtCurrentOrder = result;
    rtShowSubpage('detail');
    rtRenderDetail(result);
    loadInventory();
  } catch (err) {
    if (err.message !== 'validation') toast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ══════════════════════════════════════════════
//  초기화 (DOMContentLoaded)
// ══════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // 반품 등록
  document.getElementById('btn-rt-new-return')?.addEventListener('click', async () => {
    await rtLoadInventory();
    rtShowForm('return');
  });

  // 교환 등록
  document.getElementById('btn-rt-new-exchange')?.addEventListener('click', async () => {
    await rtLoadInventory();
    rtShowForm('exchange');
  });

  // 저장
  document.getElementById('btn-rt-save')?.addEventListener('click', () => {
    try { rtSave(); } catch (e) { /* validation */ }
  });

  // 목록으로 (폼에서)
  document.getElementById('btn-rt-back-form')?.addEventListener('click', () => {
    rtShowSubpage('list');
    rtApplyFilter();
  });

  // 목록으로 (상세에서)
  document.getElementById('btn-rt-back-detail')?.addEventListener('click', () => {
    _rtCurrentOrder = null;
    rtShowSubpage('list');
    rtApplyFilter();
  });

  // 수정
  document.getElementById('btn-rt-edit')?.addEventListener('click', async () => {
    if (!_rtCurrentOrder) return;
    await rtLoadInventory();
    rtShowForm(_rtCurrentOrder.type, _rtCurrentOrder.id);
  });

  // 삭제
  document.getElementById('btn-rt-delete')?.addEventListener('click', () => rtDeleteCurrent());

  // 행 수 확인 (반품 품목)
  document.getElementById('btn-rt-add-rows')?.addEventListener('click', () => {
    const n = Math.max(1, Math.min(50, parseInt(document.getElementById('rt-row-count')?.value) || 1));
    rtSetReturnRows(n);
  });

  // 행 수 확인 (교환 출고 품목)
  document.getElementById('btn-rt-add-ex-rows')?.addEventListener('click', () => {
    const n = Math.max(1, Math.min(50, parseInt(document.getElementById('rt-ex-row-count')?.value) || 1));
    rtSetExRows(n);
  });
});

// ── 재고 로드 (폼 열 때) ──────────────────────────
async function rtLoadInventory() {
  if (_rtInventory.length) return;
  try {
    const rows = await API.get('/inventory');
    _rtInventory = Array.isArray(rows) ? rows : [];
  } catch (e) { console.warn('[returns] inventory load failed', e); }
}
