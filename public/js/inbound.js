'use strict';
// ══════════════════════════════════════════════
//  입고 관리 (inbound.js)
// ══════════════════════════════════════════════

// ── 상태 ──
let _ibOrders       = [];          // 전체 주문 캐시
let _currentOrder   = null;        // 현재 보고 있는 주문
let _editOrderId    = null;        // 수정 중인 주문 ID
let _ibFlatpickr    = null;        // 폼 날짜 flatpickr
let _ibFpStart      = null;        // 검색 시작일 flatpickr
let _ibFpEnd        = null;        // 검색 종료일 flatpickr
let _ibSearchTimer  = null;        // 디바운스 타이머
let _excelRows      = [];          // 파싱된 엑셀 행
let _excelBatchCount = 0;          // 엑셀 업로드 배치 카운터
let _ibEditItems       = [];       // 수정 시 기존 품목 (추가 업로드 구분용)
let _ibExcelAppendMode = false;    // 엑셀 추가 업로드 모드
let _directRowCount = 5;           // 직접입력 행 수
let _ibActiveTab    = 'all';       // 목록 탭: 'all'|'completed'|'pending'|'priority'
let _ibBulkStatus   = 'pending';   // 폼 상단 매입상태 버튼 상태
let _ibMemoSaving   = false;       // 메모 저장 중 플래그
let _ibVendorTimer  = null;        // 거래처 검색 디바운스

// ── 서브페이지 전환 ──────────────────────────
function ibShowSubpage(name, pushState = true) {
  ['list','detail','form'].forEach(p =>
    document.getElementById(`ib-${p}`)?.classList.toggle('hidden', p !== name)
  );
  if (!pushState) return;
  const base = '#/inbound';
  if      (name === 'form'   && _editOrderId)   history.pushState({ ib: name, id: _editOrderId }, '', `${base}/${_editOrderId}/edit`);
  else if (name === 'form')                      history.pushState({ ib: name }, '', `${base}/new`);
  else if (name === 'detail' && _currentOrder)  history.pushState({ ib: name, id: _currentOrder.id }, '', `${base}/${_currentOrder.id}`);
  else                                           history.pushState({ ib: 'list' }, '', base);
}

// ── 날짜 범위 검색 ───────────────────────────
function ibGetDateRange() {
  return {
    start: document.getElementById('ib-date-start')?.value || '',
    end:   document.getElementById('ib-date-end')?.value   || '',
  };
}

function ibMatchDate(orderDate, start, end) {
  if (!start && !end) return true;
  if (start && orderDate < start) return false;
  if (end   && orderDate > end)   return false;
  return true;
}

function ibSetQuickRange(range) {
  const today = new Date();
  const fmt = d => d.toISOString().slice(0, 10);

  let start = '', end = '';
  if (range === 'today') {
    start = end = fmt(today);
  } else if (range === 'week') {
    const day = today.getDay(); // 0=일
    const mon = new Date(today); mon.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
    const sun = new Date(mon);   sun.setDate(mon.getDate() + 6);
    start = fmt(mon); end = fmt(sun);
  } else if (range === 'month') {
    start = fmt(new Date(today.getFullYear(), today.getMonth(), 1));
    end   = fmt(new Date(today.getFullYear(), today.getMonth() + 1, 0));
  } else if (range === 'clear') {
    start = ''; end = '';
  }

  if (_ibFpStart) _ibFpStart.setDate(start ? new Date(start) : null, true);
  if (_ibFpEnd)   _ibFpEnd.setDate(end   ? new Date(end)   : null, true);
  ibApplyFilter();
}

// ── 탭 필터 ─────────────────────────────────
function ibFilterByTab(list) {
  if (_ibActiveTab === 'all') return list;
  return list.filter(o => o.statuses?.includes(_ibActiveTab));
}

function ibUpdateTabCounts() {
  const counts = {
    all:       _ibOrders.length,
    completed: _ibOrders.filter(o => o.statuses?.includes('completed')).length,
    pending:   _ibOrders.filter(o => o.statuses?.includes('pending')).length,
    priority:  _ibOrders.filter(o => o.statuses?.includes('priority')).length,
  };
  Object.entries(counts).forEach(([k, v]) => {
    const el = document.getElementById(`ib-stab-count-${k}`);
    if (el) el.textContent = v;
  });
}

function ibSetTab(tab) {
  _ibActiveTab = tab;
  document.querySelectorAll('.ib-stab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.stab === tab)
  );
  ibApplyFilter();
}

// ── 검색 + 날짜 복합 필터 적용 ──────────────
function ibApplyFilter() {
  const { start, end } = ibGetDateRange();
  const q = (document.getElementById('ib-search')?.value || '').toLowerCase().trim();

  let list = ibFilterByTab(_ibOrders);

  // 날짜 범위
  if (start || end) {
    list = list.filter(o => ibMatchDate(o.order_date, start, end));
  }

  // 키워드
  if (q) {
    list = list.filter(o => {
      const vn   = (o.vendor_name || '').toLowerCase();
      const date = (o.order_date  || '');
      const itemMatch = (o.items || []).some(it =>
        (it.model_name   || '').toLowerCase().includes(q) ||
        (it.manufacturer || '').toLowerCase().includes(q) ||
        (it.category     || '').toLowerCase().includes(q) ||
        (it.notes        || '').toLowerCase().includes(q)
      );
      return vn.includes(q) || date.includes(q) || itemMatch;
    });
  }

  renderIbCards(list);
}

function filterInbound() {
  clearTimeout(_ibSearchTimer);
  _ibSearchTimer = setTimeout(ibApplyFilter, 200);
}

// ── 목록 ────────────────────────────────────
async function loadInboundList() {
  const titleEl = document.getElementById('ib-list-title');
  if (titleEl) titleEl.textContent = '매입 목록';
  try {
    _ibOrders = await API.get('/inbound');
    ibUpdateTabCounts();
    ibApplyFilter();
  } catch (err) { toast(err.message, 'error'); }
}

function renderIbCards(list) {
  const container = document.getElementById('ib-cards');
  if (!list.length) {
    container.innerHTML = '<div class="empty" style="padding:3rem;text-align:center;color:var(--gray-600)">매입 내역이 없습니다.</div>';
    return;
  }
  container.innerHTML = list.map(o => {
    const summaryText = Object.entries(o.summary || {})
      .map(([k, v]) => `${escHtml(k)} ${v}개`).join(', ') || '품목 없음';
    const total = Number(o.total_price || 0).toLocaleString();
    const hasPriority  = o.statuses?.includes('priority');
    const hasCompleted = o.statuses?.includes('completed');
    const hasPending   = o.statuses?.includes('pending');
    const statusBadges = [
      hasCompleted && '<span class="ib-badge ib-badge-completed">매입완료</span>',
      hasPriority  && '<span class="ib-badge ib-badge-priority">⚠️우선등록</span>',
      hasPending   && '<span class="ib-badge ib-badge-pending">미완료</span>',
    ].filter(Boolean).join(' ');
    const ssIcon = o.has_smartstore ? '<span class="ib-ss-icon" title="스마트스토어 등록 품목 포함">🛒</span>' : '';

    return `
      <div class="ib-card" onclick="ibOpenDetail('${o.id}')">
        <div class="ib-card-top">
          <span class="ib-card-vendor">${escHtml(o.vendor_name || '-')}${ssIcon}</span>
          <span class="ib-card-date">${escHtml(o.order_date)}</span>
          <div class="ib-card-badges">${statusBadges}</div>
        </div>
        <div class="ib-card-summary">${summaryText}</div>
        <div class="ib-card-total"><span class="price-col">합계 <b>${total}원</b> &nbsp;·&nbsp;</span>${o.item_count}개 품목</div>
      </div>
    `;
  }).join('');
}

// ── 상세 ────────────────────────────────────
window.ibOpenDetail = async function(orderId) {
  try {
    _currentOrder = await API.get(`/inbound/${orderId}`);
    renderIbDetail(_currentOrder);
    ibLoadMemo(_currentOrder);
    ibShowSubpage('detail');
  } catch (err) { toast(err.message, 'error'); }
};

function renderIbDetail(order) {
  const totalPrice = (order.items || []).reduce((s, i) => s + i.total_price, 0);
  const condLabel  = { normal: '정상', defective: '불량', disposal: '폐기' };
  const isEditor = currentUser?.role === 'editor' || currentUser?.role === 'admin';
  const rows = (order.items || []).map(it => {
    const cond    = condLabel[it.condition_type] || it.condition_type || '정상';
    const condCls = it.condition_type === 'defective' ? 'ib-cond-defective'
                  : it.condition_type === 'disposal'  ? 'ib-cond-disposal' : '';
    const priorityCls = it.status === 'priority' ? ' ib-row-priority' : '';
    const statusCell  = isEditor
      ? `<select class="ib-inp ib-detail-status-sel" data-item-id="${it.id}" style="font-size:.78rem;padding:.2rem .3rem">
           <option value="pending"   ${it.status === 'pending'   ? 'selected' : ''}>매입미완료</option>
           <option value="completed" ${it.status === 'completed' ? 'selected' : ''}>매입완료</option>
           <option value="priority"  ${it.status === 'priority'  ? 'selected' : ''}>⚠️ 우선등록</option>
         </select>`
      : `<span class="ib-badge ${{ completed:'ib-badge-completed', pending:'ib-badge-pending', priority:'ib-badge-priority' }[it.status]||''}">${{ completed:'매입완료', pending:'매입미완료', priority:'⚠️우선등록' }[it.status]||it.status}</span>`;
    const ssCell = ((it.status === 'completed' || it.status === 'priority') && isEditor)
      ? (it.is_smartstore
          ? `<button class="btn btn-xs btn-ss-on"  data-item-id="${it.id}" onclick="ibToggleSmartstore('${it.id}', 1)">✅ 스마트스토어 등록됨</button>`
          : `<button class="btn btn-xs btn-ss-off" data-item-id="${it.id}" onclick="ibToggleSmartstore('${it.id}', 0)">🛒 스마트스토어 등록</button>`)
      : (it.is_smartstore ? '<span style="color:var(--success);font-size:.8rem">✅ 등록됨</span>' : '');
    return `
      <tr class="${priorityCls}">
        <td title="${escHtml(it.category || '-')}">${escHtml(it.category || '-')}</td>
        <td title="${escHtml(it.manufacturer)}">${escHtml(it.manufacturer)}</td>
        <td title="${escHtml(it.model_name)}">${escHtml(it.model_name)}</td>
        <td class="ib-td-spec" title="${escHtml(it.spec || '-')}">${escHtml(it.spec || '-')}</td>
        <td style="text-align:right">${Number(it.quantity).toLocaleString()}</td>
        <td class="price-col" style="text-align:right">${Number(it.purchase_price).toLocaleString()}</td>
        <td class="price-col" style="text-align:right">${Number(it.total_price).toLocaleString()}</td>
        <td><span class="ib-badge ${condCls}">${cond}</span></td>
        <td style="overflow:visible">${statusCell}</td>
        <td class="ib-td-notes" title="${escHtml(it.notes || '-')}">${escHtml(it.notes || '-')}</td>
        <td style="overflow:visible">
          <button class="btn btn-xs btn-ghost" onclick="ibShowPriceHistory('${it.id}','${escHtml(it.model_name)}')">이력</button>
        </td>
        <td style="overflow:visible">${ssCell}</td>
      </tr>
    `;
  }).join('');

  // 거래처 유형별 헤더 정보 구성
  const vt = order.vendor_type || 'company';
  let vendorRows = '';
  if (order.vendor_id) {
    if (vt === 'individual') {
      vendorRows = `
        <div class="ob-dd-pair"><dt>이름</dt><dd>${escHtml(order.individual_name || order.vendor_name || '-')}</dd></div>
        <div class="ob-dd-pair"><dt>전화번호</dt><dd>${order.individual_phone ? fmtPhone(order.individual_phone) : '-'}</dd></div>
        ${order.vendor_address ? `<div class="ob-dd-pair"><dt>주소</dt><dd>${escHtml(order.vendor_address)}</dd></div>` : ''}
      `;
    } else {
      vendorRows = `
        <div class="ob-dd-pair"><dt>상호명</dt><dd>${escHtml(order.vendor_company || order.vendor_name || '-')}</dd></div>
        <div class="ob-dd-pair"><dt>회사전화</dt><dd>${order.vendor_company_phone ? fmtPhone(order.vendor_company_phone) : '-'}</dd></div>
        ${order.manager_name ? `<div class="ob-dd-pair"><dt>담당자</dt><dd>${escHtml(order.manager_name)}</dd></div>` : ''}
        ${order.manager_phone ? `<div class="ob-dd-pair"><dt>담당자전화번호</dt><dd>${fmtPhone(order.manager_phone)}</dd></div>` : ''}
        ${order.vendor_address ? `<div class="ob-dd-pair"><dt>주소</dt><dd>${escHtml(order.vendor_address)}</dd></div>` : ''}
      `;
    }
  } else if (order.vendor_name) {
    vendorRows = `<div class="ob-dd-pair"><dt>상호명</dt><dd>${escHtml(order.vendor_name)}</dd></div>`;
  }

  document.getElementById('ib-detail-content').innerHTML = `
    <div class="ib-header-card">
      <dl class="ob-detail-dl" style="grid-template-columns:repeat(3,1fr)">
        <div class="ob-dd-pair"><dt>입고날짜</dt><dd>${escHtml(order.order_date)}</dd></div>
        ${vendorRows}
      </dl>
      <div class="vdd-meta" style="margin-top:.75rem">
        <span><span class="meta-label">등록자</span>${escHtml(order.created_by_name || '-')}</span>
        <span><span class="meta-label">등록일시</span>${fmtDateTime(order.created_at)}</span>
        <span><span class="meta-label">수정자</span>${escHtml(order.updated_by_name || '-')}</span>
        <span><span class="meta-label">수정일시</span>${order.updated_at ? fmtDateTime(order.updated_at) : '-'}</span>
      </div>
    </div>
    ${isEditor ? `
    <div class="ib-bulk-bar">
      <span class="ib-bulk-label">일괄 변경</span>
      <div class="ib-bulk-btns">
        <button type="button" class="ib-detail-bulk-btn" data-status="pending">매입미완료</button>
        <button type="button" class="ib-detail-bulk-btn" data-status="completed">매입완료</button>
        <button type="button" class="ib-detail-bulk-btn" data-status="priority">⚠ 우선등록</button>
      </div>
    </div>` : ''}
    <div class="ib-tbl-scroll-top"><div class="ib-tbl-scroll-inner"></div></div>
    <div class="ib-detail-table-wrap">
      <table class="tbl">
        <colgroup>
          <col style="width:70px">
          <col style="width:80px">
          <col style="width:120px">
          <col style="width:150px">
          <col style="width:60px">
          <col style="width:90px">
          <col style="width:100px">
          <col style="width:70px">
          <col style="width:110px">
          <col style="width:150px">
          <col style="width:60px">
          <col style="width:150px">
        </colgroup>
        <thead>
          <tr>
            <th>구분</th><th>브랜드</th><th>모델명</th><th>스펙</th>
            <th style="text-align:right">수량</th>
            <th class="price-col" style="text-align:right">매입가</th>
            <th class="price-col" style="text-align:right">합계</th>
            <th>처리구분</th><th>매입상태</th><th>비고</th><th>이력</th>
            <th>스마트스토어</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="12" class="empty">품목 없음</td></tr>'}</tbody>
        <tfoot>
          <tr class="price-col" style="background:var(--gray-50);font-weight:700">
            <td colspan="6" style="text-align:right;padding:.6rem 1rem">합계</td>
            <td style="text-align:right;padding:.6rem 1rem">${totalPrice.toLocaleString()}원</td>
            <td colspan="5"></td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;

  // 상단+하단 가로 스크롤바 연동
  ibInitDualScroll(
    document.querySelector('#ib-detail-content .ib-detail-table-wrap'),
    document.querySelector('#ib-detail-content .ib-tbl-scroll-top')
  );

  const delBtn = document.getElementById('btn-ib-delete');
  if (delBtn) delBtn.style.display = currentUser?.role === 'admin' ? '' : 'none';

  // 상세 페이지: 개별 상태 드롭다운 이벤트
  const detailContent = document.getElementById('ib-detail-content');
  detailContent.querySelectorAll('.ib-detail-status-sel').forEach(sel => {
    sel.addEventListener('change', () => ibDetailChangeItemStatus(sel));
  });

  // 상세 페이지: 일괄 변경 버튼 이벤트
  detailContent.querySelectorAll('.ib-detail-bulk-btn').forEach(btn => {
    btn.addEventListener('click', () => ibDetailBulkStatus(order, btn.dataset.status));
  });
}

// ── 상세 페이지 개별 상태 변경 ──────────────
async function ibDetailChangeItemStatus(sel) {
  const itemId    = sel.dataset.itemId;
  const newStatus = sel.value;
  const oldStatus = sel.dataset.prev || sel.value;
  sel.dataset.prev = newStatus;
  const labels = { completed: '매입완료', pending: '매입미완료', priority: '⚠️우선등록' };
  try {
    const result = await API.put(`/inbound/items/${itemId}/status`, { status: newStatus });
    const tr = sel.closest('tr');
    ibUpdateRowPriorityStyle(tr, newStatus);
    if (result.pctChange !== undefined && Math.abs(result.pctChange) >= 0.3) {
      toast(`이동평균가 ${(result.pctChange * 100).toFixed(1)}% 변동됨`, 'warning');
    }
    toast(`${labels[newStatus]}으로 변경됨`, 'success');
    loadInventory();
  } catch (err) {
    sel.value = oldStatus;
    sel.dataset.prev = oldStatus;
    toast(err.message, 'error');
  }
}

// ── 상세 페이지 일괄 상태 변경 ──────────────
async function ibDetailBulkStatus(order, status) {
  const labels = { completed: '매입완료', pending: '매입미완료', priority: '우선등록' };
  const msgs   = {
    completed: '전체 품목을 매입완료 처리하시겠습니까?',
    pending:   '전체 품목을 매입미완료로 변경하시겠습니까?',
    priority:  '전체 품목을 우선등록 처리하시겠습니까?',
  };
  const ok = await confirmDialog(msgs[status], `전체 ${labels[status]} 처리`, '변경');
  if (!ok) return;

  const sels = document.querySelectorAll('#ib-detail-content .ib-detail-status-sel');
  const changedIds = new Set();
  for (const sel of sels) {
    if (sel.value === status) continue;
    try {
      await API.put(`/inbound/items/${sel.dataset.itemId}/status`, { status });
      sel.value = status;
      sel.dataset.prev = status;
      ibUpdateRowPriorityStyle(sel.closest('tr'), status);
      changedIds.add(sel.dataset.itemId);
    } catch (err) {
      toast(`일부 항목 변경 실패: ${err.message}`, 'error');
    }
  }
  if (changedIds.size > 0) {
    toast(`${changedIds.size}개 항목이 ${labels[status]}으로 변경됨`, 'success');
    // _currentOrder 캐시 업데이트 (수정 폼 진입 시 정확한 상태 반영)
    if (_currentOrder?.items) {
      _currentOrder.items.forEach(item => {
        if (changedIds.has(item.id)) item.status = status;
      });
    }
    // 목록 카드 캐시 갱신 (목록으로 돌아갔을 때 최신 상태 반영)
    loadInboundList();
    loadInventory();
    // 버튼 active 표시
    document.querySelectorAll('#ib-detail-content .ib-detail-bulk-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.status === status);
    });
  }
}

// ── 스마트스토어 등록 토글 ─────────────────────
window.ibToggleSmartstore = async function(itemId, currentState) {
  const register = !currentState;
  const msg = register
    ? '이 상품을 스마트스토어 등록 상품으로 표시하시겠습니까?'
    : '스마트스토어 등록 표시를 해제하시겠습니까?';
  const ok = await confirmDialog(msg, '스마트스토어', register ? '등록' : '해제');
  if (!ok) return;
  try {
    const result = await API.put(`/inbound/items/${itemId}/smartstore`, { is_smartstore: register });
    // 캐시 업데이트
    if (_currentOrder?.items) {
      const item = _currentOrder.items.find(i => i.id === itemId);
      if (item) {
        item.is_smartstore = result.is_smartstore;
        item.smartstore_registered_at = result.smartstore_registered_at;
      }
    }
    // 버튼 교체
    const btn = document.querySelector(`[data-item-id="${itemId}"]`);
    if (btn) {
      if (result.is_smartstore) {
        btn.className = 'btn btn-xs btn-ss-on';
        btn.textContent = '✅ 스마트스토어 등록됨';
        btn.setAttribute('onclick', `ibToggleSmartstore('${itemId}', 1)`);
      } else {
        btn.className = 'btn btn-xs btn-ss-off';
        btn.textContent = '🛒 스마트스토어 등록';
        btn.setAttribute('onclick', `ibToggleSmartstore('${itemId}', 0)`);
      }
    }
    // 목록 카드 캐시 갱신
    const cached = _ibOrders.find(o => o.id === _currentOrder?.id);
    if (cached) cached.has_smartstore = _currentOrder.items.some(i => i.is_smartstore);
    toast(register ? '스마트스토어 등록됨' : '스마트스토어 등록 해제됨', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
};

// ── 메모 ────────────────────────────────────
function ibLoadMemo(order) {
  const textarea = document.getElementById('ib-memo-text');
  const metaEl   = document.getElementById('ib-memo-meta');
  if (!textarea) return;

  textarea.value = order.notes || '';

  if (order.updated_by_name && order.updated_at) {
    metaEl.textContent = `최종 수정: ${escHtml(order.updated_by_name)} · ${fmtDateTime(order.updated_at)}`;
  } else {
    metaEl.textContent = '';
  }
}

async function ibSaveMemo() {
  if (!_currentOrder || _ibMemoSaving) return;
  const text = document.getElementById('ib-memo-text')?.value ?? '';

  // 변경이 없으면 스킵
  if (text === (_currentOrder.notes || '')) return;

  _ibMemoSaving = true;
  try {
    const result = await API.patch(`/inbound/${_currentOrder.id}/memo`, { memo: text });
    _currentOrder.notes          = result.notes;
    _currentOrder.updated_at     = result.updated_at;
    _currentOrder.updated_by_name = result.updated_by_name;

    const metaEl = document.getElementById('ib-memo-meta');
    if (metaEl) {
      metaEl.textContent = `최종 수정: ${result.updated_by_name} · ${fmtDateTime(result.updated_at)}`;
    }
    // 캐시 업데이트
    const cached = _ibOrders.find(o => o.id === _currentOrder.id);
    if (cached) cached.notes = result.notes;
  } catch (err) {
    toast('메모 저장 실패: ' + err.message, 'error');
  } finally {
    _ibMemoSaving = false;
  }
}

// ── 매입가 수정이력 모달 ───────────────────────
window.ibShowPriceHistory = async function(itemId, modelName) {
  try {
    const history = await API.get(`/inbound/items/${itemId}/history`);
    document.getElementById('price-hist-title').textContent = `매입가 수정이력 — ${modelName}`;
    const tbody = document.getElementById('price-hist-tbody');
    if (!history.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">이력이 없습니다.</td></tr>';
    } else {
      tbody.innerHTML = history.map(h => `
        <tr>
          <td>${fmtDateTime(h.changed_at)}</td>
          <td style="text-align:right">${Number(h.old_price).toLocaleString()}원</td>
          <td style="text-align:right">${Number(h.new_price).toLocaleString()}원</td>
          <td>${escHtml(h.changed_by_name || '-')}</td>
        </tr>
      `).join('');
    }
    document.getElementById('modal-price-history').classList.remove('hidden');
  } catch (err) { toast(err.message, 'error'); }
};

// ── 폼 (등록/수정) ───────────────────────────
function ibShowForm(mode, order) {
  _editOrderId = order?.id || null;
  document.getElementById('ib-form-title').textContent = mode === 'edit' ? '매입 수정' : '매입 등록';

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('ib-vendor-id').value   = order?.vendor_id   || '';
  // vendor_name: 유형별 표시명
  let vendorDisplayName = order?.vendor_name || '';
  if (order?.vendor_id && order?.vendor_type === 'individual' && order?.individual_name) {
    vendorDisplayName = order.individual_name;
  } else if (order?.vendor_id && order?.vendor_company) {
    vendorDisplayName = order.vendor_company;
  }
  document.getElementById('ib-vendor-name').value = vendorDisplayName;
  document.getElementById('ib-vendor-dropdown')?.classList.add('hidden');

  // 상단 매입상태 버튼 초기화
  _ibBulkStatus = 'pending';
  document.querySelectorAll('.ib-bulk-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.status === 'pending')
  );

  if (_ibFlatpickr) _ibFlatpickr.destroy();
  _ibFlatpickr = flatpickr('#ib-date', {
    locale: 'ko', dateFormat: 'Y-m-d',
    defaultDate: order?.order_date || today, allowInput: true,
  });

  ibSwitchTab('direct');

  if (mode === 'edit' && order?.items?.length) {
    _directRowCount = order.items.length;
    ibRenderDirectTable(order.items);
  } else {
    _directRowCount = 5;
    ibRenderDirectTable();
  }

  document.getElementById('ib-excel-preview').classList.add('hidden');
  document.getElementById('ib-excel-error-bar').classList.add('hidden');
  document.getElementById('ib-excel-filename').textContent = '';
  document.getElementById('ib-excel-file').value = '';
  _excelRows = [];
  _excelBatchCount = 0;
  _ibExcelAppendMode = false;
  _ibEditItems = (mode === 'edit' ? (order?.items || []) : []);

  ibShowSubpage('form');
}

function ibSwitchTab(tab) {
  document.querySelectorAll('.ib-form-tabs .tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.ibTab === tab)
  );
  document.getElementById('ib-tab-excel').classList.toggle('hidden', tab !== 'excel');
  document.getElementById('ib-tab-direct').classList.toggle('hidden', tab !== 'direct');
}

// ── 상단 매입상태 버튼 (전체 적용) ────────────
async function ibSetBulkStatus(status) {
  const labels = { completed: '매입완료', pending: '매입미완료', priority: '우선등록' };
  const msgs   = {
    completed: '전체 품목을 매입완료 처리하시겠습니까?',
    pending:   '전체 품목을 매입미완료로 변경하시겠습니까?',
    priority:  '전체 품목을 우선등록 처리하시겠습니까?',
  };
  const label = labels[status] || status;
  const ok = await confirmDialog(msgs[status], `전체 ${label} 처리`, '변경');
  if (!ok) return;

  _ibBulkStatus = status;
  document.querySelectorAll('.ib-bulk-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.status === status)
  );
  // 직접 입력 탭 행 업데이트
  document.querySelectorAll('#ib-direct-tbody [data-field="status"]').forEach(sel => {
    sel.value = status;
    ibUpdateRowPriorityStyle(sel.closest('tr'), status);
  });
  // 엑셀 미리보기 탭 행 업데이트
  _excelRows.forEach(r => { r.status = status; });
  document.querySelectorAll('#ib-excel-tbody [data-field="status"]').forEach(sel => {
    sel.value = status;
    ibUpdateRowPriorityStyle(sel.closest('tr'), status);
  });
}

function ibUpdateRowPriorityStyle(tr, status) {
  if (!tr) return;
  tr.classList.toggle('ib-row-priority', status === 'priority');
}

// ── 직접 입력 테이블 ──────────────────────────
function ibRenderDirectTable(prefill) {
  document.getElementById('ib-row-count').value = _directRowCount;
  const tbody = document.getElementById('ib-direct-tbody');

  const rows = Array.from({ length: _directRowCount }, (_, i) => {
    const p       = prefill?.[i] || {};
    const st      = p.status || _ibBulkStatus;
    const isSpec  = p.product_type === 'spec';
    const cond    = p.condition_type || 'normal';
    return `
      <tr data-row="${i}">
        <td style="text-align:center;color:var(--gray-600)">${i + 1}</td>
        <td><input class="ib-inp" data-field="category"     value="${escHtml(p.category || '')}"     placeholder="구분" /></td>
        <td><input class="ib-inp" data-field="manufacturer" value="${escHtml(p.manufacturer || '')}" placeholder="브랜드" /><span class="req ib-mfr-star"${cond !== 'normal' ? ' style="display:none"' : ''}> *</span></td>
        <td><input class="ib-inp" data-field="model_name"   value="${escHtml(p.model_name || '')}"   placeholder="모델명" /></td>
        <td>
          <div class="ib-type-toggle">
            <button type="button" class="ib-type-btn${!isSpec ? ' active' : ''}" data-type="general">일반</button><button type="button" class="ib-type-btn${isSpec ? ' active' : ''}" data-type="spec">스펙</button>
          </div>
        </td>
        <td class="ib-spec-cell">
          <input class="ib-inp ib-spec-inp${!isSpec ? ' hidden' : ''}" data-field="spec"
            value="${escHtml(p.spec || '')}" placeholder="스펙 입력"
            autocomplete="off" list="ib-spec-datalist" />
        </td>
        <td><input class="ib-inp ib-num" data-field="quantity"       value="${p.quantity != null ? p.quantity : ''}"       placeholder="0" type="number" min="1" /></td>
        <td><input class="ib-inp ib-num" data-field="purchase_price" value="${p.purchase_price != null ? p.purchase_price : ''}" placeholder="0" type="number" min="0" /></td>
        <td class="ib-total-cell" style="text-align:right;padding:.5rem .7rem;font-size:.82rem;color:var(--gray-600)">-</td>
        <td>
          <select class="ib-inp" data-field="condition_type">
            <option value="normal"    ${cond === 'normal'    ? 'selected' : ''}>정상</option>
            <option value="defective" ${cond === 'defective' ? 'selected' : ''}>불량</option>
            <option value="disposal"  ${cond === 'disposal'  ? 'selected' : ''}>폐기</option>
          </select>
        </td>
        <td>
          <select class="ib-inp ib-status-sel" data-field="status">
            <option value="pending"   ${st === 'pending'   ? 'selected' : ''}>매입미완료</option>
            <option value="completed" ${st === 'completed' ? 'selected' : ''}>매입완료</option>
            <option value="priority"  ${st === 'priority'  ? 'selected' : ''}>우선등록</option>
          </select>
        </td>
        <td><input class="ib-inp" data-field="notes" value="${escHtml(p.notes || '')}" placeholder="비고" /></td>
      </tr>
    `;
  });

  tbody.innerHTML = rows.join('');
  ibRecalcDirectTotal();

  // 초기 priority 행 스타일
  tbody.querySelectorAll('tr').forEach(tr => {
    const sel = tr.querySelector('.ib-status-sel');
    if (sel) ibUpdateRowPriorityStyle(tr, sel.value);
  });

  // 수량/단가 합계 계산
  tbody.querySelectorAll('.ib-num').forEach(inp => {
    inp.addEventListener('input', () => ibRecalcDirectRow(inp.closest('tr')));
  });

  // 개별 상태 드롭다운 변경 시 행 스타일 반영
  tbody.querySelectorAll('.ib-status-sel').forEach(sel => {
    sel.addEventListener('change', () => ibUpdateRowPriorityStyle(sel.closest('tr'), sel.value));
  });

  // 처리구분 변경 시 브랜드 필수 표시 토글
  tbody.querySelectorAll('[data-field="condition_type"]').forEach(sel => {
    sel.addEventListener('change', () => {
      const star = sel.closest('tr').querySelector('.ib-mfr-star');
      if (star) star.style.display = sel.value === 'normal' ? '' : 'none';
    });
  });

  // 상품유형 토글
  tbody.querySelectorAll('.ib-type-toggle').forEach(tog => {
    tog.querySelectorAll('.ib-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        tog.querySelectorAll('.ib-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tr      = btn.closest('tr');
        const specInp = tr.querySelector('.ib-spec-inp');
        if (btn.dataset.type === 'spec') {
          specInp.classList.remove('hidden');
          specInp.focus();
        } else {
          specInp.classList.add('hidden');
          specInp.value = '';
        }
      });
    });
  });

  // 스펙 자동완성 — manufacturer + model_name 변경 시 datalist 갱신
  tbody.querySelectorAll('[data-field="spec"]').forEach(specInp => {
    specInp.addEventListener('focus', () => ibFetchSpecSuggestions(specInp));
    specInp.addEventListener('input', () => ibFetchSpecSuggestions(specInp));
  });

  // 듀얼 스크롤바 초기화
  ibInitDualScroll(
    document.querySelector('#ib-direct-table-wrap'),
    document.querySelector('#ib-direct-tbl-scroll-top')
  );
}

function ibRecalcDirectRow(tr) {
  const qty   = Number(tr.querySelector('[data-field="quantity"]').value)       || 0;
  const price = Number(tr.querySelector('[data-field="purchase_price"]').value) || 0;
  tr.querySelector('.ib-total-cell').textContent = (qty * price).toLocaleString() + '원';
  ibRecalcDirectTotal();
}

function ibRecalcDirectTotal() {
  let total = 0, qty = 0;
  document.querySelectorAll('#ib-direct-tbody tr').forEach(tr => {
    const q = Number(tr.querySelector('[data-field="quantity"]')?.value) || 0;
    const p = Number(tr.querySelector('[data-field="purchase_price"]')?.value) || 0;
    qty   += q;
    total += q * p;
    tr.querySelector('.ib-total-cell').textContent = q && p >= 0 ? (q * p).toLocaleString() + '원' : '-';
  });
  document.getElementById('ib-direct-total').textContent =
    `총 ${qty.toLocaleString()}개 / 합계 ${total.toLocaleString()}원`;
}

function ibGetDirectRows() {
  const items = [];
  document.querySelectorAll('#ib-direct-tbody tr').forEach(tr => {
    const get        = f => tr.querySelector(`[data-field="${f}"]`)?.value?.trim() || '';
    const activeType = tr.querySelector('.ib-type-btn.active')?.dataset.type || 'general';
    const specRaw    = get('spec');
    const spec       = activeType === 'spec' ? specRaw.toLowerCase().trim() : '';
    items.push({
      category:       get('category'),
      manufacturer:   get('manufacturer'),
      model_name:     get('model_name'),
      product_type:   spec ? 'spec' : 'general',
      spec,
      quantity:       get('quantity'),
      purchase_price: get('purchase_price'),
      condition_type: tr.querySelector('[data-field="condition_type"]')?.value || 'normal',
      status:         tr.querySelector('[data-field="status"]')?.value || 'pending',
      notes:          get('notes'),
    });
  });
  return items.filter(it => it.manufacturer || it.model_name);
}

// ── 스펙 자동완성 ─────────────────────────────
let _specFetchTimer = null;
async function ibFetchSpecSuggestions(specInp) {
  const tr    = specInp.closest('tr');
  const mfr   = tr.querySelector('[data-field="manufacturer"]')?.value?.trim() || '';
  const model = tr.querySelector('[data-field="model_name"]')?.value?.trim() || '';
  if (!mfr || !model) return;

  clearTimeout(_specFetchTimer);
  _specFetchTimer = setTimeout(async () => {
    try {
      const specs = await API.get(`/inbound/specs?manufacturer=${encodeURIComponent(mfr)}&model_name=${encodeURIComponent(model)}`);
      const dl = document.getElementById('ib-spec-datalist');
      if (dl) {
        dl.innerHTML = specs.map(s => `<option value="${escHtml(s)}"></option>`).join('');
      }
    } catch (_) {}
  }, 250);
}

// ── 듀얼 스크롤바 초기화 헬퍼 ─────────────────
function ibInitDualScroll(wrapEl, topBarEl) {
  if (!wrapEl || !topBarEl) return;
  const inner = topBarEl.querySelector('.ib-tbl-scroll-inner');
  if (!inner) return;
  // 너비 동기화 (렌더 후 1tick 대기)
  requestAnimationFrame(() => {
    inner.style.width = wrapEl.scrollWidth + 'px';
  });
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

// ── 엑셀 업로드 ──────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('ib-excel-file')?.addEventListener('change', function () {
    const file = this.files?.[0];
    if (!file) return;
    this.value = ''; // 동일 파일 재선택 허용

    if (_editOrderId) {
      // ── 수정 페이지: 기존 품목 수 확인 후 항상 팝업 표시
      const directCount   = ibGetDirectRows().length;
      const existingCount = _excelRows.length || _ibEditItems.length || directCount;
      if (existingCount > 0) {
        ibShowUploadModeModal(file, {
          existingCount,
          onReplace: () => {
            // 직접입력 행 초기화 + 엑셀 rows 교체
            _ibExcelAppendMode = false;
            _directRowCount = 5;
            ibRenderDirectTable([]);
            ibLoadExcelFile(file, false);
          },
          onAppend: () => {
            _ibExcelAppendMode = true;
            // 기존 DB 품목을 _excelRows에 미리 채우기 (아직 채워지지 않은 경우)
            if (_ibEditItems.length > 0 && !_excelRows.some(r => r._isExisting)) {
              _excelRows = _ibEditItems.map((item, idx) => ({
                _row:           idx + 2,
                category:       item.category      || '',
                manufacturer:   item.manufacturer  || '',
                model_name:     item.model_name    || '',
                spec:           (item.spec || '').toLowerCase().trim(),
                product_type:   item.spec ? 'spec' : 'general',
                quantity:       item.quantity,
                purchase_price: item.purchase_price || 0,
                condition_type: item.condition_type || 'normal',
                notes:          item.notes || '',
                status:         item.status || 'pending',
                _errCols:       new Set(),
                _errMsgs:       [],
                _batch:         0,
                _isExisting:    true,
              }));
            }
            ibLoadExcelFile(file, true);
          },
        });
      } else {
        ibLoadExcelFile(file, false);
      }
    } else {
      // ── 등록 페이지: 기존 엑셀 행 있을 때만 팝업 (기존 동작 유지)
      if (_excelRows.length > 0) {
        ibShowUploadModeModal(file);
      } else {
        ibLoadExcelFile(file, false);
      }
    }
  });
});

function ibShowUploadModeModal(file, opts = {}) {
  const modal = document.getElementById('modal-excel-upload-mode');
  if (!modal) { ibLoadExcelFile(file, false); return; }

  const existingCount = opts.existingCount ?? _excelRows.length;
  const desc = document.getElementById('excel-mode-desc');
  if (desc) desc.textContent = `현재 ${existingCount}개 품목이 입력되어 있습니다.\n어떻게 하시겠습니까?`;

  modal.classList.remove('hidden');

  function cleanup() {
    modal.classList.add('hidden');
    document.getElementById('btn-excel-mode-replace')?.removeEventListener('click', onReplace);
    document.getElementById('btn-excel-mode-append')?.removeEventListener('click', onAppend);
    document.querySelectorAll('.btn-excel-mode-cancel').forEach(b => b.removeEventListener('click', onCancel));
  }
  function onReplace() { cleanup(); (opts.onReplace ?? (() => ibLoadExcelFile(file, false)))(); }
  function onAppend()  { cleanup(); (opts.onAppend  ?? (() => ibLoadExcelFile(file, true)))();  }
  function onCancel()  { cleanup(); }

  document.getElementById('btn-excel-mode-replace')?.addEventListener('click', onReplace);
  document.getElementById('btn-excel-mode-append')?.addEventListener('click', onAppend);
  document.querySelectorAll('.btn-excel-mode-cancel').forEach(b => b.addEventListener('click', onCancel));
}

function ibLoadExcelFile(file, appendMode) {
  document.getElementById('ib-excel-filename').textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb   = XLSX.read(e.target.result, { type: 'array' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      ibParseExcel(data.slice(1).filter(r => r.some(c => String(c).trim())), appendMode);
    } catch (err) { toast('엑셀 파일 파싱 실패: ' + err.message, 'error'); }
  };
  reader.readAsArrayBuffer(file);
}

// 처리구분 문자열 → condition_type 변환 (대소문자 무관)
function ibParseConditionType(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v)       return { val: 'normal',    err: null };
  if (v === '불량') return { val: 'defective', err: null };
  if (v === '폐기') return { val: 'disposal',  err: null };
  return { val: null, err: '처리구분은 빈칸/불량/폐기만 입력 가능합니다.' };
}

function ibParseExcel(rows, appendMode = false) {
  // A:구분 B:브랜드 C:모델명 D:수량 E:매입가 F:처리구분 G:스펙 H:비고
  if (!appendMode) {
    _excelBatchCount = 0;
  } else {
    _excelBatchCount++;
  }
  const currentBatch = _excelBatchCount;
  const batchPrefix  = currentBatch > 0 ? `[${currentBatch}차] ` : '';

  const newRows = rows.map((r, idx) => {
    const rowNum       = idx + 2;
    const category     = String(r[0] ?? '').trim();
    const manufacturer = String(r[1] ?? '').trim();
    const model_name   = String(r[2] ?? '').trim();
    const quantityRaw  = String(r[3] ?? '').trim();
    const priceRaw     = String(r[4] ?? '').trim();
    const condRaw      = String(r[5] ?? '').trim();
    const specRaw      = String(r[6] ?? '').trim();
    const notes        = String(r[7] ?? '').trim();

    const spec         = specRaw.toLowerCase().trim();
    const product_type = spec ? 'spec' : 'general';

    const _errCols = new Set();
    const rowMsgs  = [];

    if (!model_name) {
      _errCols.add('C');
      rowMsgs.push(`${batchPrefix}${rowNum}행 C열(모델명)이 비어있습니다`);
    }

    const quantity = Number(quantityRaw);
    if (!quantityRaw || isNaN(quantity) || quantity <= 0) {
      _errCols.add('D');
      rowMsgs.push(
        !quantityRaw
          ? `${batchPrefix}${rowNum}행 D열(수량)이 비어있습니다`
          : `${batchPrefix}${rowNum}행 D열(수량)에 숫자가 아닌 값이 있습니다`
      );
    }

    const purchase_price = Number(priceRaw);
    if (priceRaw === '' || isNaN(purchase_price) || purchase_price < 0) {
      _errCols.add('E');
      rowMsgs.push(
        priceRaw === ''
          ? `${batchPrefix}${rowNum}행 E열(매입가)이 비어있습니다`
          : `${batchPrefix}${rowNum}행 E열(매입가)에 올바르지 않은 값이 있습니다`
      );
    }

    const { val: condition_type, err: condErr } = ibParseConditionType(condRaw);
    if (condErr) {
      _errCols.add('F');
      rowMsgs.push(`${batchPrefix}${rowNum}행 F열: ${condErr}`);
    }

    if ((condition_type || 'normal') === 'normal' && !manufacturer) {
      _errCols.add('B');
      rowMsgs.push(`${batchPrefix}${rowNum}행 B열(브랜드)이 비어있습니다`);
    }

    return {
      _row: rowNum, _errCols, _errMsgs: rowMsgs, _batch: currentBatch,
      category, manufacturer, model_name, product_type, spec,
      quantity, purchase_price,
      condition_type: condition_type || 'normal',
      status: _ibBulkStatus || 'pending', notes,
    };
  });

  if (appendMode) {
    _excelRows = [..._excelRows, ...newRows];
  } else {
    _excelRows = newRows;
  }

  ibRenderExcelPreview();
}

function ibRenderExcelPreview() {
  // 오류 수집 (전체 _excelRows에서)
  const errorLines = [];
  _excelRows.forEach(r => { if (r._errMsgs?.length) errorLines.push(...r._errMsgs); });

  const errBar   = document.getElementById('ib-excel-error-bar');
  const errCount = _excelRows.filter(r => r._errCols.size > 0).length;
  if (errorLines.length) {
    errBar.innerHTML =
      `<b>⚠ ${errCount}개 행에 오류가 있습니다</b><ul class="ib-err-list">` +
      errorLines.map(m => `<li>${escHtml(m)}</li>`).join('') +
      `</ul>`;
    errBar.classList.remove('hidden');
  } else {
    errBar.classList.add('hidden');
  }

  const condLabel   = { normal: '정상', defective: '불량', disposal: '폐기' };
  const statusLabel = { pending: '매입미완료', completed: '매입완료', priority: '우선등록' };

  let prevBatch = -1;
  let _shownExistingSep = false;
  let _shownNewSep = false;
  const rowHtml = _excelRows.flatMap((r, idx) => {
    const isExisting = !!r._isExisting;
    const hasErr   = r._errCols.size > 0;
    const rowClass = hasErr ? '' : (r.status === 'priority' ? ' class="ib-row-priority"' : '');
    let styleParts = [];
    if (hasErr) styleParts.push('background:#fff0f0');
    else if (isExisting) styleParts.push('background:#f5f6f8');
    const rowStyle = styleParts.length ? ` style="${styleParts.join(';')}"` : '';
    const total    = (r.quantity || 0) * (r.purchase_price || 0);
    const cellErr  = col => r._errCols.has(col)
      ? ' style="background:#ffd6d6;color:var(--danger);font-weight:700"' : '';
    const statusOpts = ['pending', 'completed', 'priority']
      .map(v => `<option value="${v}"${r.status === v ? ' selected' : ''}>${statusLabel[v]}</option>`)
      .join('');

    const parts = [];

    if (_ibExcelAppendMode) {
      // 추가 업로드 모드: 기존/신규 구분선
      if (isExisting && !_shownExistingSep) {
        _shownExistingSep = true;
        parts.push(`<tr class="ib-excel-batch-sep"><td colspan="11" style="text-align:center;padding:.35rem;background:#e8eaf0;color:#6b7280;font-size:.78rem;border-top:2px solid #9ca3af">─── 기존 등록 품목 ───</td></tr>`);
      }
      if (!isExisting && !_shownNewSep) {
        _shownNewSep = true;
        parts.push(`<tr class="ib-excel-batch-sep"><td colspan="11" style="text-align:center;padding:.35rem;background:var(--gray-100,#f3f4f6);color:var(--gray-500,#6b7280);font-size:.78rem;border-top:2px solid var(--primary,#4f6ef7)">─── 추가 업로드 품목 ───</td></tr>`);
      }
    } else {
      // 일반 추가 업로드 배치 구분선
      if (r._batch > 0 && r._batch !== prevBatch) {
        parts.push(`<tr class="ib-excel-batch-sep"><td colspan="11" style="text-align:center;padding:.35rem;background:var(--gray-100,#f3f4f6);color:var(--gray-500,#6b7280);font-size:.78rem;border-top:2px solid var(--primary,#4f6ef7)">── 추가 업로드 (${r._batch}차) ──</td></tr>`);
      }
    }
    prevBatch = r._batch;

    parts.push(`
      <tr${rowClass}${rowStyle}>
        <td style="text-align:center${hasErr ? ';color:var(--danger);font-weight:700' : ''}">📎 ${r._row}</td>
        <td>${escHtml(r.category)}</td>
        <td>${escHtml(r.manufacturer) || '-'}</td>
        <td${cellErr('C')}>${escHtml(r.model_name)   || '<span style="color:var(--danger)">비어있음</span>'}</td>
        <td style="text-align:right"${cellErr('D')}>${r._errCols.has('D') ? '<span style="color:var(--danger)">오류</span>' : r.quantity}</td>
        <td style="text-align:right"${cellErr('E')}>${r._errCols.has('E') ? '<span style="color:var(--danger)">오류</span>' : r.purchase_price.toLocaleString()}</td>
        <td style="text-align:right">${hasErr ? '-' : total.toLocaleString()}</td>
        <td${cellErr('F')}>${r._errCols.has('F') ? '<span style="color:var(--danger)">오류</span>' : condLabel[r.condition_type]}</td>
        <td>${escHtml(r.spec) || '-'}</td>
        <td><select data-field="status" data-idx="${idx}" style="font-size:.75rem;padding:2px 4px;width:100%">${statusOpts}</select></td>
        <td>${escHtml(r.notes)}</td>
      </tr>`);
    return parts;
  });

  document.getElementById('ib-excel-tbody').innerHTML = rowHtml.join('');

  document.getElementById('btn-ib-excel-save').disabled = _excelRows.some(r => r._errCols.size > 0);
  const total = _excelRows.reduce((s, r) => s + (r._errCols.size > 0 ? 0 : r.quantity * r.purchase_price), 0);
  document.getElementById('ib-excel-total').textContent = `${_excelRows.length}개 품목 / 합계 ${total.toLocaleString()}원`;
  document.getElementById('ib-excel-preview').classList.remove('hidden');

  // 추가 등록 버튼 표시/숨김 (수정+추가 업로드 모드일 때만)
  const addNewBtn = document.getElementById('btn-ib-excel-add-new');
  if (addNewBtn) {
    const showAddNew = _ibExcelAppendMode && _editOrderId
      && _excelRows.some(r => r._isExisting) && _excelRows.some(r => !r._isExisting);
    addNewBtn.style.display = showAddNew ? '' : 'none';
  }

  ibInitDualScroll(
    document.querySelector('#ib-excel-preview .table-wrap'),
    document.querySelector('#ib-excel-tbl-scroll-top')
  );
}

function ibDownloadTemplate() {
  // A:구분 B:브랜드 C:모델명 D:수량 E:매입가 F:처리구분 G:스펙 H:비고
  // 1행: 헤더(회색) 2행: 예시(노란) 3행+: 빈 행
  const header  = ['구분', '브랜드', '모델명', '수량', '매입가', '처리구분', '스펙', '비고'];
  const example = ['노트북', 'LG', '그램', 1, 800000, '불량', 'i5 16G', ''];
  const data    = [header, example];
  for (let i = 0; i < 14; i++) data.push(['', '', '', '', '', '', '', '']);

  const ws = XLSX.utils.aoa_to_sheet(data);

  // 헤더 행 회색, 예시 행 노란색
  const headerStyle  = { fill: { fgColor: { rgb: 'DDE1EA' } }, font: { bold: true } };
  const exampleStyle = { fill: { fgColor: { rgb: 'FFFDE7' } } };
  const cols = ['A','B','C','D','E','F','G','H'];
  cols.forEach(c => {
    if (ws[c + '1']) ws[c + '1'].s = headerStyle;
    if (ws[c + '2']) ws[c + '2'].s = exampleStyle;
  });

  // 열 너비
  ws['!cols'] = [10,12,16,14,8,10,10,14].map(w => ({ wch: w }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '매입양식');
  XLSX.writeFile(wb, '매입_입력양식.xlsx');
}

// ── 저장 ────────────────────────────────────
async function ibSave(items) {
  const order_date  = document.getElementById('ib-date').value;
  const vendor_id   = document.getElementById('ib-vendor-id').value || null;
  const vendor_name = document.getElementById('ib-vendor-name').value.trim() || null;

  if (!order_date)   { toast('입고날짜를 선택하세요.', 'error'); return; }
  if (!items.length) { toast('품목이 없습니다.', 'error'); return; }

  for (const it of items) {
    if (!it.model_name)             { toast('모델명이 비어있는 행이 있습니다.', 'error'); return; }
    if ((it.condition_type || 'normal') === 'normal' && !it.manufacturer) { toast(`'${it.model_name}' 브랜드는 정상 처리 시 필수입니다.`, 'error'); return; }
    if (!(Number(it.quantity) > 0)) { toast(`'${it.model_name}' 수량이 올바르지 않습니다.`, 'error'); return; }
    if (Number(it.purchase_price) < 0) { toast(`'${it.model_name}' 매입가가 올바르지 않습니다.`, 'error'); return; }
  }

  try {
    let result;
    if (_editOrderId) {
      result = await API.put(`/inbound/${_editOrderId}`, { order_date, vendor_id, vendor_name, items });
      toast('매입이 수정되었습니다.', 'success');
    } else {
      result = await API.post('/inbound', { order_date, vendor_id, vendor_name, items });
      toast('매입이 등록되었습니다.', 'success');
    }

    if (result.warnings?.length) {
      const msgs = result.warnings.map(w =>
        `${w.model}: ${Math.round(w.pctChange * 100)}% 변동 (${Math.round(w.oldAvg).toLocaleString()} → ${Math.round(w.newAvg).toLocaleString()}원)`
      ).join('\n');
      toast(`⚠️ 이동평균 30% 이상 변동:\n${msgs}`, 'info', 6000);
    }

    _editOrderId = null;
    // 버그 수정: 저장 후 탭을 all로 리셋 → 상태 변경 카드가 사라지지 않음
    _ibActiveTab = 'all';
    document.querySelectorAll('.ib-stab').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.stab === 'all')
    );
    await loadInboundList();
    ibShowSubpage('list');
    loadInventory();
  } catch (err) { toast(err.message, 'error'); }
}

// ── 상세 엑셀 다운로드 ───────────────────────
function ibExportDetailExcel() {
  if (!_currentOrder) return;
  const order = _currentOrder;

  const condLabel   = { normal: '정상', defective: '불량', disposal: '폐기' };
  const statusLabel = { pending: '매입미완료', completed: '매입완료', priority: '우선등록' };

  const headers = [
    '입고날짜', '거래처', '매입상태',
    '구분', '브랜드', '모델명', '스펙',
    '상태', '수량', '매입가', '합계',
    '처리구분', '비고', '등록자', '등록일시',
  ];

  const items = order.items || [];
  const dataRows = items.map(it => [
    order.order_date || '',
    order.vendor_name || '',
    statusLabel[it.status] || it.status || '',
    it.category || '',
    it.manufacturer || '',
    it.model_name || '',
    it.spec || '',
    condLabel[it.condition_type] || '정상',
    it.quantity,
    it.purchase_price,
    it.total_price,
    condLabel[it.condition_type] || '정상',
    it.notes || '',
    order.created_by_name || '',
    (order.created_at || '').replace('T', ' ').slice(0, 19),
  ]);

  const totalQty   = items.reduce((s, i) => s + (i.quantity || 0), 0);
  const totalPrice = items.reduce((s, i) => s + (i.total_price || 0), 0);
  const totalsRow  = ['합계', '', '', '', '', '', '', '', totalQty, '', totalPrice, '', '', '', ''];

  const aoa = [headers, ...dataRows, totalsRow];
  const ws  = XLSX.utils.aoa_to_sheet(aoa);

  // 헤더 스타일: 파란색 배경, 흰색 굵은 텍스트
  const headerStyle = {
    fill: { patternType: 'solid', fgColor: { rgb: '3B5BDB' } },
    font: { bold: true, color: { rgb: 'FFFFFF' } },
    alignment: { horizontal: 'center' },
  };
  // 합계행 스타일
  const totalStyle  = {
    fill: { patternType: 'solid', fgColor: { rgb: 'EEF2FF' } },
    font: { bold: true },
  };

  const COL_LETTERS = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O'];
  const lastRow = aoa.length; // 합계행 (1-indexed)

  COL_LETTERS.forEach(c => {
    if (ws[c + '1']) ws[c + '1'].s = headerStyle;
    const tc = ws[c + lastRow];
    if (tc) tc.s = totalStyle;
  });

  // 수량(I), 매입가(J), 합계(K) 숫자 포맷
  const numFmt = '#,##0';
  for (let r = 2; r <= lastRow; r++) {
    ['I','J','K'].forEach(c => {
      const cell = ws[c + r];
      if (cell && typeof cell.v === 'number') cell.z = numFmt;
    });
  }

  // 열 너비
  ws['!cols'] = [12, 16, 12, 10, 12, 18, 16, 8, 8, 12, 12, 8, 22, 12, 20].map(w => ({ wch: w }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '매입내역');

  const safeName = (order.vendor_name || '미지정').replace(/[\\/:*?"<>|]/g, '_');
  XLSX.writeFile(wb, `${safeName}_${order.order_date || 'unknown'}.xlsx`);
}

// ── 삭제 ────────────────────────────────────
async function ibDeleteOrder() {
  if (!_currentOrder) return;
  const ok = await confirmDialog(
    `'${_currentOrder.order_date} / ${_currentOrder.vendor_name || '거래처 없음'}' 매입을 삭제하시겠습니까?\n매입완료/우선등록 품목의 재고가 자동 차감됩니다.`,
    '매입 삭제', '삭제'
  );
  if (!ok) return;
  try {
    await API.del(`/inbound/${_currentOrder.id}`);
    toast('매입이 삭제되었습니다.', 'success');
    _currentOrder = null;
    _ibActiveTab  = 'all';
    document.querySelectorAll('.ib-stab').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.stab === 'all')
    );
    await loadInboundList();
    ibShowSubpage('list');
    loadInventory();
  } catch (err) { toast(err.message, 'error'); }
}

// ── 뒤로가기 (popstate) ──────────────────────
window.addEventListener('popstate', (e) => {
  const state = e.state;
  if (!state || state.ib === 'list') {
    ibShowSubpage('list', false);
  } else if (state.ib === 'detail' && state.id) {
    ibOpenDetail(state.id);
  } else if (state.ib === 'form') {
    if (state.id) {
      const order = _ibOrders.find(o => o.id === state.id);
      if (order) ibShowForm('edit', order);
    } else {
      ibShowForm('create', null);
    }
  }
});

// ── 이벤트 바인딩 ────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // 날짜 범위 flatpickr 초기화
  if (document.getElementById('ib-date-start')) {
    _ibFpStart = flatpickr('#ib-date-start', {
      locale: 'ko', dateFormat: 'Y-m-d', allowInput: true,
      onChange: () => { clearTimeout(_ibSearchTimer); _ibSearchTimer = setTimeout(ibApplyFilter, 200); },
    });
    _ibFpEnd = flatpickr('#ib-date-end', {
      locale: 'ko', dateFormat: 'Y-m-d', allowInput: true,
      onChange: () => { clearTimeout(_ibSearchTimer); _ibSearchTimer = setTimeout(ibApplyFilter, 200); },
    });
    ibSetQuickRange('today');
  }

  // 빠른 날짜 선택 버튼
  document.querySelectorAll('.ib-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => ibSetQuickRange(btn.dataset.range));
  });

  // 키워드 검색
  document.getElementById('ib-search')?.addEventListener('input', filterInbound);

  // 목록
  document.getElementById('btn-ib-new')?.addEventListener('click', () => ibShowForm('create', null));

  // 상태 탭 필터
  document.querySelectorAll('.ib-stab').forEach(btn => {
    btn.addEventListener('click', () => ibSetTab(btn.dataset.stab));
  });

  // 상단 매입상태 버튼
  document.querySelectorAll('.ib-bulk-btn').forEach(btn => {
    btn.addEventListener('click', () => ibSetBulkStatus(btn.dataset.status));
  });

  // 상세 뒤로
  document.getElementById('btn-ib-back-detail')?.addEventListener('click', () => {
    _currentOrder = null;
    ibShowSubpage('list');
  });
  document.getElementById('btn-ib-edit')?.addEventListener('click', () => {
    if (_currentOrder) ibShowForm('edit', _currentOrder);
  });
  document.getElementById('btn-ib-delete')?.addEventListener('click', ibDeleteOrder);
  document.getElementById('btn-ib-excel-dl')?.addEventListener('click', ibExportDetailExcel);

  // 폼 뒤로
  document.getElementById('btn-ib-back-form')?.addEventListener('click', () => {
    _editOrderId = null;
    if (_currentOrder) ibShowSubpage('detail');
    else ibShowSubpage('list');
  });

  // 탭 전환
  document.querySelectorAll('.ib-form-tabs .tab').forEach(btn => {
    btn.addEventListener('click', () => ibSwitchTab(btn.dataset.ibTab));
  });

  // 거래처 인라인 검색
  const ibVendorInp = document.getElementById('ib-vendor-name');
  if (ibVendorInp) {
    ibVendorInp.addEventListener('input', ibVendorSearch);
    ibVendorInp.addEventListener('focus', ibVendorSearch);
    ibVendorInp.addEventListener('blur', () => {
      // 약간 딜레이 후 닫기 (클릭 이벤트가 먼저 처리되도록)
      setTimeout(() => document.getElementById('ib-vendor-dropdown')?.classList.add('hidden'), 200);
    });
    ibVendorInp.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        document.getElementById('ib-vendor-dropdown')?.classList.add('hidden');
      }
    });
  }

  // 직접 입력 행 수
  document.getElementById('btn-ib-set-rows')?.addEventListener('click', () => {
    const n = parseInt(document.getElementById('ib-row-count').value) || 5;
    const existing = ibGetDirectRows();
    _directRowCount = Math.min(200, Math.max(1, n));
    ibRenderDirectTable(existing);
  });
  document.getElementById('ib-row-count')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-ib-set-rows').click();
  });

  // 상단 저장 버튼 — 직접입력 + 엑셀 통합 저장
  document.getElementById('btn-ib-save-top')?.addEventListener('click', () => {
    const isExcel     = !document.getElementById('ib-tab-excel').classList.contains('hidden');
    const directItems = ibGetDirectRows();
    const excelItems  = _excelRows.filter(r => r._errCols.size === 0);
    if (isExcel) {
      ibSave([...excelItems, ...directItems]);
    } else {
      ibSave([...directItems, ...excelItems]);
    }
  });

  // 직접 입력 저장
  document.getElementById('btn-ib-direct-save')?.addEventListener('click', () => ibSave(ibGetDirectRows()));

  // 엑셀 미리보기 행별 매입상태 개별 변경
  document.getElementById('ib-excel-tbody')?.addEventListener('change', e => {
    if (e.target.dataset.field !== 'status') return;
    const idx = Number(e.target.dataset.idx);
    if (_excelRows[idx]) _excelRows[idx].status = e.target.value;
    ibUpdateRowPriorityStyle(e.target.closest('tr'), e.target.value);
  });

  // 엑셀 일괄 등록
  document.getElementById('btn-ib-excel-save')?.addEventListener('click', () => {
    // 저장 전 select 값 → _excelRows 최종 동기화
    document.querySelectorAll('#ib-excel-tbody [data-field="status"]').forEach(sel => {
      const idx = Number(sel.dataset.idx);
      if (_excelRows[idx]) _excelRows[idx].status = sel.value;
    });
    ibSave(_excelRows.filter(r => r._errCols.size === 0));
  });

  // 추가 등록 (수정+추가 업로드 모드: 새 품목만 저장)
  document.getElementById('btn-ib-excel-add-new')?.addEventListener('click', async () => {
    const newRows = _excelRows.filter(r => !r._isExisting && r._errCols.size === 0);
    if (!newRows.length) { toast('추가할 정상 항목이 없습니다.', 'error'); return; }
    const existingItems = _ibEditItems.map(item => ({
      manufacturer:   item.manufacturer  || '',
      model_name:     item.model_name,
      spec:           item.spec          || '',
      category:       item.category      || null,
      quantity:       item.quantity,
      purchase_price: item.purchase_price || 0,
      condition_type: item.condition_type || 'normal',
      status:         item.status        || 'pending',
      notes:          item.notes         || null,
    }));
    const addedItems = newRows.map(r => ({
      manufacturer:   r.manufacturer  || '',
      model_name:     r.model_name,
      spec:           r.spec          || '',
      category:       r.category      || null,
      quantity:       r.quantity,
      purchase_price: r.purchase_price || 0,
      condition_type: r.condition_type || 'normal',
      status:         r.status        || 'pending',
      notes:          r.notes         || null,
    }));
    ibSave([...existingItems, ...addedItems]);
  });

  // 양식 다운로드
  document.getElementById('btn-ib-template')?.addEventListener('click', ibDownloadTemplate);

  // 메모 자동 저장 (blur 시)
  document.getElementById('ib-memo-text')?.addEventListener('blur', ibSaveMemo);

  // 메모 접기/펼치기
  document.getElementById('btn-ib-memo-toggle')?.addEventListener('click', () => {
    const body   = document.getElementById('ib-memo-body');
    const btn    = document.getElementById('btn-ib-memo-toggle');
    const hidden = body.classList.toggle('hidden');
    btn.textContent = hidden ? '펼치기' : '접기';
  });

  // 매입가 이력 모달 닫기
  document.getElementById('btn-price-hist-close')?.addEventListener('click',  () => document.getElementById('modal-price-history').classList.add('hidden'));
  document.getElementById('btn-price-hist-close2')?.addEventListener('click', () => document.getElementById('modal-price-history').classList.add('hidden'));
  document.getElementById('modal-price-history')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-price-history'))
      document.getElementById('modal-price-history').classList.add('hidden');
  });
});

// ── 입고 폼: 거래처 인라인 검색 드롭다운 ──────
function ibVendorSearch() {
  const inp = document.getElementById('ib-vendor-name');
  const dd  = document.getElementById('ib-vendor-dropdown');
  if (!inp || !dd) return;

  const q = inp.value.trim().toLowerCase();

  // allPurchaseVendors는 app.js에서 관리 (전역 변수)
  const list = typeof allPurchaseVendors !== 'undefined' ? allPurchaseVendors : [];

  // 비어있으면 로드
  if (!list.length) {
    API.get('/purchase-vendors').then(data => {
      if (typeof allPurchaseVendors !== 'undefined') allPurchaseVendors.push(...data);
      ibVendorSearch();
    }).catch(() => {});
    return;
  }

  const filtered = q
    ? list.filter(v => {
        const name = (v.vendor_type||'company') === 'individual'
          ? (v.individual_name||'') : (v.company_name||'');
        const phone = (v.vendor_type||'company') === 'individual'
          ? (v.individual_phone||'') : (v.phone||'');
        return name.toLowerCase().includes(q) ||
               (v.manager_name||'').toLowerCase().includes(q) ||
               phone.replace(/\D/g,'').includes(q.replace(/\D/g,''));
      })
    : list.slice(0, 20);

  const items = filtered.slice(0, 15).map(v => {
    const vt = v.vendor_type || 'company';
    const badge = vt === 'individual'
      ? '<span class="pv-type-badge pv-type-individual">개인</span>'
      : '<span class="pv-type-badge pv-type-company">기업</span>';
    const rawName = vt === 'individual' ? (v.individual_name||'') : (v.company_name||'');
    const displayName = escHtml(rawName);
    const safeId   = v.id.replace(/'/g, '');
    const safeName = rawName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const sub = vt === 'individual'
      ? (v.individual_phone ? fmtPhone(v.individual_phone) : '')
      : (v.manager_name ? `담당: ${escHtml(v.manager_name)}` : (v.phone ? fmtPhone(v.phone) : ''));
    const subHtml = sub ? `<span class="ib-vdd-sub">${sub}</span>` : '';
    return `<div class="ib-vendor-dd-item" onmousedown="ibSelectVendor('${safeId}','${safeName}')">
      ${badge} ${displayName} ${subHtml}
    </div>`;
  });

  const safeQ  = q.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const newBtn = `<div class="ib-vendor-dd-item dd-new" onmousedown="ibOpenNewVendor('${safeQ}')">
    + 신규 거래처 등록
  </div>`;

  if (!items.length && !q) {
    dd.innerHTML = `<div class="ib-vendor-dd-empty">거래처가 없습니다.</div>${newBtn}`;
  } else if (!items.length) {
    dd.innerHTML = `<div class="ib-vendor-dd-empty">"${escHtml(q)}" 검색 결과 없음</div>${newBtn}`;
  } else {
    dd.innerHTML = items.join('') + newBtn;
  }
  dd.classList.remove('hidden');
}

window.ibSelectVendor = function(id, displayName) {
  document.getElementById('ib-vendor-id').value   = id;
  document.getElementById('ib-vendor-name').value = displayName;
  document.getElementById('ib-vendor-dropdown')?.classList.add('hidden');
};

window.ibOpenNewVendor = function(prefillName) {
  // 전역 openVendorModal을 호출 (app.js에 있음)
  if (typeof openVendorModal === 'function') {
    if (typeof _currentVendorType !== 'undefined') {
      // eslint-disable-next-line no-undef
      _currentVendorType = 'purchase';
    }
    openVendorModal({ individual_name: prefillName });
    // 모달 저장 후 드롭다운 갱신을 위해 콜백 처리
    // (saveVendor가 호출되면 allPurchaseVendors가 갱신됨)
  }
};
