'use strict';
// ══════════════════════════════════════════════
//  재고 현황 (inventory.js)
// ══════════════════════════════════════════════

let _invAll        = [];   // 전체 재고 데이터
let _invFiltered   = [];   // 필터 후 목록
let _invActiveTab  = 'all';
let _invCatFilter  = 'all'; // 구분 필터
let _invSearch     = { cat: '', brand: '', model: '', vendor: '' };
let _invDetailId   = null; // 현재 상세 팝업 대상 inventory.id
let _invDetailData = null; // 상세 이력 데이터
let _invDetailTab  = 'inbound';
let _adjFp         = null; // 조정일자 flatpickr

// ── 입고 상태 라벨 ──────────────────────────────────────────────
const IB_STATUS_LABEL = { pending:'매입미완료', completed:'매입완료', priority:'우선등록' };

// ── 구분 순서 / 색상 ─────────────────────────────────────────────
const INV_CAT_ORDER  = ['CPU', 'RAM', 'VGA', 'SSD', 'NVMe', 'M.2', 'HDD', 'MB', '노트북', '모니터', '본체', 'PW'];
const INV_CAT_COLORS = {
  'CPU':   { bg: '#e0f6ff', color: '#0369a1' },
  'RAM':   { bg: '#d1fae5', color: '#047857' },
  'VGA':   { bg: '#ffedd5', color: '#c2410c' },
  'SSD':   { bg: '#dbeafe', color: '#1d4ed8' },
  'NVMe':  { bg: '#ede9fe', color: '#6d28d9' },
  'M.2':   { bg: '#fce7f3', color: '#be185d' },
  'HDD':   { bg: '#fef9c3', color: '#92400e' },
  'MB':    { bg: '#fee2e2', color: '#dc2626' },
  '노트북': { bg: '#ecfdf5', color: '#047857' },
  '모니터': { bg: '#cffafe', color: '#0e7490' },
  '본체':  { bg: '#e0e7ff', color: '#4338ca' },
  'PW':    { bg: '#ecfccb', color: '#4d7c0f' },
};

// 구분값 대소문자 정규화 (ram→RAM, nvme→NVMe 등)
const INV_CAT_NORMALIZE = {
  'cpu': 'CPU', 'ram': 'RAM', 'vga': 'VGA',
  'ssd': 'SSD', 'nvme': 'NVMe', 'm.2': 'M.2',
  'hdd': 'HDD', 'mb': 'MB', '노트북': '노트북',
  '모니터': '모니터', '본체': '본체', 'pw': 'PW',
};
function invNormCat(cat) {
  return INV_CAT_NORMALIZE[(cat || '').toLowerCase()] || (cat || '');
}

// 구분 카드 필터 매칭
function invMatchesCatFilter(category) {
  if (_invCatFilter === 'all') return true;
  const norm = invNormCat(category || '');
  if (_invCatFilter === '기타') return !INV_CAT_ORDER.includes(norm);
  return norm === _invCatFilter;
}

// ── 금액 포맷 ────────────────────────────────────────────────────
function invFmt(v) {
  if (v === null || v === undefined || v === '') return '-';
  const n = Number(v);
  if (isNaN(n)) return '-';
  return Math.round(n).toLocaleString('ko-KR') + '원';
}
function invNum(v) {
  if (v === null || v === undefined) return '-';
  return Number(v).toLocaleString('ko-KR');
}

function invCatBadge(cat) {
  const c   = invNormCat(cat || '');
  const col = INV_CAT_COLORS[c];
  const style = col
    ? `background:${col.bg};color:${col.color}`
    : 'background:#f1f5f9;color:#64748b';
  return `<span class="inv-cat-badge" style="${style}">${escHtml(c || '—')}</span>`;
}

// ══════════════════════════════════════════════
//  목록 로드
// ══════════════════════════════════════════════
async function loadInventory() {
  try {
    const [list, summary] = await Promise.all([
      API.get('/inventory'),
      API.get('/inventory/summary'),
    ]);
    _invAll = Array.isArray(list) ? list : [];
    invRenderSummary(summary);
    invApplyFilter();
  } catch (err) { toast(err.message, 'error'); }
}

function invRenderSummary(s) {
  if (!s) return;
  document.getElementById('invs-items').textContent = invNum(s.total_items);
  document.getElementById('invs-stock').textContent = invNum(s.total_stock);
  document.getElementById('invs-temp').textContent  = invNum(s.temp_purchase_items);
  document.getElementById('invs-def').textContent   = invNum(s.defective_items);
  document.getElementById('invs-dis').textContent   = invNum(s.disposal_items);
  document.getElementById('invs-pend').textContent  = invNum(s.pending_inbound_items);

  // 동적 색상: 값 있을 때만 강조
  const tempItem = document.querySelector('#invs-temp')?.closest('.inv-sum-item');
  const defItem  = document.querySelector('#invs-def')?.closest('.inv-sum-item');
  if (tempItem) tempItem.classList.toggle('inv-sum-warn',   (s.temp_purchase_items || 0) > 0);
  if (defItem)  defItem.classList.toggle('inv-sum-danger',  (s.defective_items     || 0) > 0);
}

// ── 필터 적용 ────────────────────────────────────────────────────
function invApplyFilter() {
  const { cat, brand, model, vendor } = _invSearch;
  const qCat    = cat.toLowerCase().trim();
  const qBrand  = brand.toLowerCase().trim();
  const qModel  = model.toLowerCase().trim();
  const qVendor = vendor.toLowerCase().trim();

  const tabRows = invGetTabFiltered();
  let list = tabRows.filter(r => {
    if (qCat    && !(r.category    || '').toLowerCase().includes(qCat))    return false;
    if (qBrand  && !(r.manufacturer|| '').toLowerCase().includes(qBrand))  return false;
    if (qModel  && !(r.model_name  || '').toLowerCase().includes(qModel))  return false;
    if (qVendor && !(r.last_vendor || r.last_vendor_name || '').toLowerCase().includes(qVendor)) return false;
    return true;
  });

  // 구분 카드 필터
  if (_invCatFilter !== 'all') {
    list = list.filter(r => invMatchesCatFilter(r.category));
  }

  // 정렬: 구분순 → 브랜드 가나다 → 모델명 가나다
  list.sort((a, b) => {
    const ai = INV_CAT_ORDER.indexOf(invNormCat(a.category || ''));
    const bi = INV_CAT_ORDER.indexOf(invNormCat(b.category || ''));
    const ak = ai === -1 ? INV_CAT_ORDER.length : ai;
    const bk = bi === -1 ? INV_CAT_ORDER.length : bi;
    if (ak !== bk) return ak - bk;
    const brandCmp = (a.manufacturer || '').localeCompare(b.manufacturer || '', 'ko');
    if (brandCmp !== 0) return brandCmp;
    return (a.model_name || '').localeCompare(b.model_name || '', 'ko');
  });

  _invFiltered = list;

  // 탭 카운트
  const all = _invAll;
  document.getElementById('invtab-all').textContent        = all.length;
  document.getElementById('invtab-normal').textContent     = all.filter(r => r.condition_type === 'normal'    && (r.current_stock||0)>0).length;
  document.getElementById('invtab-defective').textContent  = all.filter(r => r.condition_type === 'defective').length;
  document.getElementById('invtab-disposal').textContent   = all.filter(r => r.condition_type === 'disposal').length;
  const ssEl = document.getElementById('invtab-smartstore');
  if (ssEl) ssEl.textContent = all.filter(r => (r.has_smartstore||0) > 0).length;

  // 구분 필터 카운트
  invUpdateCatCounts();
  invUpdateFilterStatus();

  invRenderTable(list);
}

function invGetTabFiltered() {
  return _invAll.filter(r => {
    if (_invActiveTab === 'normal')     return r.condition_type === 'normal' && (r.current_stock || 0) > 0;
    if (_invActiveTab === 'defective')  return r.condition_type === 'defective';
    if (_invActiveTab === 'disposal')   return r.condition_type === 'disposal';
    if (_invActiveTab === 'smartstore') return (r.has_smartstore || 0) > 0;
    return true;
  });
}

function invUpdateCatCounts() {
  const idMap = { 'M.2': 'M2', '노트북': '노트북' };
  const keys  = ['all', ...INV_CAT_ORDER, '기타'];

  const catMatchCount = (items, cat, getCategory) => {
    if (cat === 'all')  return items.length;
    if (cat === '기타') return items.filter(r => !INV_CAT_ORDER.includes(invNormCat(getCategory(r)))).length;
    return items.filter(r => invNormCat(getCategory(r)) === cat).length;
  };

  const tabFiltered = invGetTabFiltered();
  keys.forEach(cat => {
    const cnt = catMatchCount(tabFiltered, cat, r => r.category || '');
    const el = document.getElementById('icf-' + (idMap[cat] || cat));
    if (el) el.textContent = cnt;
  });
}

function invUpdateFilterStatus() {
  const statusEl = document.getElementById('inv-filter-status');
  const textEl   = document.getElementById('inv-filter-status-text');
  if (!statusEl || !textEl) return;

  const tabLabel = { all: '전체', normal: '정상재고', defective: '불량재고', disposal: '폐기재고', smartstore: '스마트스토어' };
  const hasTabFilter = _invActiveTab !== 'all';
  const hasCatFilter = _invCatFilter !== 'all';

  if (!hasTabFilter && !hasCatFilter) {
    statusEl.classList.add('hidden');
    return;
  }

  let parts = [];
  if (hasTabFilter) parts.push(tabLabel[_invActiveTab] || _invActiveTab);
  if (hasCatFilter) parts.push(_invCatFilter);
  textEl.textContent = parts.join(' > ') + ' 필터 적용 중';
  statusEl.classList.remove('hidden');
}

// ── 테이블 렌더 ──────────────────────────────────────────────────
function invRenderTable(list) {
  const tbody = document.getElementById('inv-tbody');
  if (!tbody) return;

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="15" class="empty">재고 데이터가 없습니다.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(r => {
    const hasTemp  = (r.has_temp_purchase || 0) > 0;
    const warnBadge = hasTemp ? ' <span class="inv-temp-badge" title="임시매입 포함">⚠</span>' : '';

    // 상태 배지
    let condHtml;
    if (r.condition_type === 'disposal') {
      condHtml = '<span class="inv-cond-badge disposal">폐기</span>';
    } else if (r.condition_type === 'defective') {
      condHtml = '<span class="inv-cond-badge defective">불량</span>';
    } else if ((r.pending_inbound_qty || 0) > 0) {
      condHtml = '<span class="inv-cond-badge pending">매입중</span>';
    } else {
      condHtml = '<span class="inv-cond-badge normal">정상</span>';
    }

    // 현재재고 배지
    const curStock = r.current_stock || 0;
    const stockHtml = curStock > 0
      ? `<span class="inv-stock-ok">${invNum(curStock)}</span>`
      : `<span class="inv-stock-zero">${invNum(curStock)}</span>`;

    // 수치 셀 헬퍼
    const numCell = (v, cls) => {
      const n = Number(v) || 0;
      if (!n) return `<span style="color:var(--gray-300)">—</span>`;
      return cls ? `<span class="${cls}">${invNum(n)}</span>` : invNum(n);
    };

    const notesVal  = r.notes?.trim() || '';
    const notesCell = notesVal
      ? `<span title="${escHtml(notesVal)}">${escHtml(notesVal)}</span>`
      : '<span style="color:var(--gray-400)">—</span>';
    const ssCell   = (r.has_smartstore || 0) > 0 ? '<span title="스마트스토어 등록 상품">🛒</span>' : '';
    return `<tr class="inv-row" onclick="invShowDetail('${r.id}')" title="클릭하여 상세 보기">
      <td>${invCatBadge(r.category)}</td>
      <td class="inv-brand-tag">${escHtml(r.manufacturer || '')}</td>
      <td style="max-width:180px"><strong style="font-size:.83rem">${escHtml(r.model_name || '')}</strong>${warnBadge}</td>
      <td class="inv-col-spec">${escHtml(r.spec || '')}<span style="color:var(--gray-300)">${r.spec ? '' : '—'}</span></td>
      <td>${condHtml}</td>
      <td>${stockHtml}</td>
      <td>${numCell(r.completed_stock)}</td>
      <td>${numCell(r.priority_stock, 'inv-priority-cell')}</td>
      <td>${numCell(r.pending_inbound_qty, 'inv-pending-cell')}</td>
      <td>${numCell(r.total_inbound)}</td>
      <td>${numCell(r.total_outbound)}</td>
      <td class="inv-price-cell price-col">${invFmt(r.avg_purchase_price)}</td>
      <td class="inv-vendor-cell">${escHtml(r.last_vendor || r.last_vendor_name || '')}</td>
      <td class="inv-notes-cell">${notesCell}</td>
      <td style="text-align:center">${ssCell}</td>
    </tr>`;
  }).join('');

  initDualScroll(
    document.getElementById('inv-table-wrap'),
    document.getElementById('inv-scroll-top')
  );
}

// ══════════════════════════════════════════════
//  상세 팝업
// ══════════════════════════════════════════════
window.invShowDetail = async function(id) {
  _invDetailId  = id;
  _invDetailTab = 'inbound';

  const modal = document.getElementById('modal-inv-detail');
  modal.classList.remove('hidden');

  try {
    const data = await API.get(`/inventory/${id}/history`);
    _invDetailData = data;
    const inv = data.inventory;

    // 타이틀
    const titleEl = document.getElementById('inv-detail-title');
    titleEl.textContent = `${inv.manufacturer} ${inv.model_name}${inv.spec ? ' / ' + inv.spec : ''}`;

    // 탭 활성화 리셋
    document.querySelectorAll('[data-dtab]').forEach(b =>
      b.classList.toggle('active', b.dataset.dtab === 'inbound')
    );

    invDetailRenderTab('inbound');
  } catch (err) {
    toast(err.message, 'error');
    modal.classList.add('hidden');
  }
};

function invDetailRenderTab(tab) {
  _invDetailTab = tab;
  document.querySelectorAll('[data-dtab]').forEach(b =>
    b.classList.toggle('active', b.dataset.dtab === tab)
  );

  const d   = _invDetailData;
  const el  = document.getElementById('inv-detail-content');
  if (!d || !el) return;

  if (tab === 'inbound') {
    if (!d.inbound.length) { el.innerHTML = '<p class="empty">입고 이력 없음</p>'; return; }
    el.innerHTML = `<table class="data-table inv-hist-tbl">
      <thead><tr><th>입고일</th><th>상태</th><th>수량</th><th class="price-col">매입가</th><th>거래처</th><th>비고</th></tr></thead>
      <tbody>${d.inbound.map(r => `<tr>
        <td>${r.order_date || ''}</td>
        <td><span class="ib-badge ib-badge-${r.status}">${IB_STATUS_LABEL[r.status]||r.status}</span></td>
        <td>${invNum(r.quantity)}</td>
        <td class="price-col">${invFmt(r.purchase_price)}</td>
        <td>${escHtml(r.vendor_name||'')}</td>
        <td>${escHtml(r.notes||'')}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  } else if (tab === 'outbound') {
    const regularOb  = (d.outbound          || []).map(r => ({ ...r, _isExchange: false }));
    const exchangeOb = (d.exchange_outbound || []).map(r => ({ ...r, _isExchange: true  }));
    const combined   = [...regularOb, ...exchangeOb]
      .sort((a, b) => (b.order_date || '').localeCompare(a.order_date || ''));
    if (!combined.length) { el.innerHTML = '<p class="empty">출고 이력 없음</p>'; return; }
    el.innerHTML = `<table class="data-table inv-hist-tbl">
      <thead><tr><th>출고일</th><th>유형</th><th>수량</th><th>판매가</th><th>거래처</th></tr></thead>
      <tbody>${combined.map(r => `<tr>
        <td>${r.order_date || ''}</td>
        <td>${r._isExchange
          ? '<span class="sl-type-badge sl-type-exchange">🔄 교환</span>'
          : '<span class="sl-type-badge sl-type-normal">일반</span>'}</td>
        <td>${invNum(r.quantity)}</td>
        <td>${invFmt(r.sale_price)}</td>
        <td>${escHtml(r.vendor_name||'')}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  } else if (tab === 'returns') {
    if (!d.returns.length) { el.innerHTML = '<p class="empty">반품 이력 없음</p>'; return; }
    const RT_STAT = { pending:'접수대기', testing:'테스트중', normal:'정상확정', defective:'불량확정' };
    el.innerHTML = `<table class="data-table inv-hist-tbl">
      <thead><tr><th>접수일</th><th>유형</th><th>상태</th><th>수량</th><th>거래처</th><th>비고</th></tr></thead>
      <tbody>${d.returns.map(r => `<tr>
        <td>${r.received_at||''}</td>
        <td><span class="sl-type-badge sl-type-return">🔄 반품</span></td>
        <td>${RT_STAT[r.status]||r.status}</td>
        <td>${invNum(r.quantity)}</td>
        <td>${escHtml(r.vendor_name||'')}</td>
        <td>${escHtml(r.item_notes||'')}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  } else if (tab === 'adjustments') {
    if (!d.adjustments.length) { el.innerHTML = '<p class="empty">재고조정 이력 없음</p>'; return; }
    const ADJ_LABEL = {
      shortage:'실사조정(부족)', surplus:'실사조정(초과)',
      temp_purchase:'임의매입(임시)', confirm_purchase:'임의매입(확정)',
    };
    el.innerHTML = `<table class="data-table inv-hist-tbl">
      <thead><tr><th>조정일</th><th>유형</th><th>수량</th><th class="price-col">금액</th><th>사유</th><th>처리자</th></tr></thead>
      <tbody>${d.adjustments.map(r => {
        const price = r.adjustment_type === 'temp_purchase' ? r.temp_price
                    : r.adjustment_type === 'confirm_purchase' ? r.confirmed_price : null;
        const isTemp = r.adjustment_type === 'temp_purchase';
        return `<tr>
          <td>${r.adjustment_date||''}</td>
          <td>${ADJ_LABEL[r.adjustment_type]||r.adjustment_type}${isTemp ? ' ⚠️' : ''}</td>
          <td>${invNum(r.quantity)}</td>
          <td class="price-col">${price != null ? invFmt(price) : '-'}</td>
          <td>${escHtml(r.reason||'')}</td>
          <td>${escHtml(r.performer_name||r.created_by||'')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  } else if (tab === 'avg_history') {
    if (!d.avg_history.length) { el.innerHTML = '<p class="empty">평균매입가 변동 이력 없음</p>'; return; }
    el.innerHTML = `<table class="data-table inv-hist-tbl">
      <thead><tr><th>변동일시</th><th>변동 전</th><th>변동 후</th><th>변동률</th><th>사유</th></tr></thead>
      <tbody>${d.avg_history.map(r => {
        const pct = r.old_avg > 0 ? ((r.new_avg - r.old_avg) / r.old_avg * 100).toFixed(1) : '-';
        const cls = r.new_avg > r.old_avg ? 'color:var(--danger)' : 'color:var(--success)';
        return `<tr>
          <td>${(r.changed_at||'').slice(0,16)}</td>
          <td>${invFmt(r.old_avg)}</td>
          <td style="${cls}"><strong>${invFmt(r.new_avg)}</strong></td>
          <td style="${cls}">${pct !== '-' ? (Number(pct) > 0 ? '+' : '') + pct + '%' : '-'}</td>
          <td>${escHtml(r.reason||'')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }
}



// ══════════════════════════════════════════════
//  재고조정 모달
// ══════════════════════════════════════════════
function invOpenAdjustModal(prefill = {}) {
  // 폼 리셋
  document.getElementById('adj-date').value         = '';
  document.getElementById('adj-type').value         = prefill.adjustment_type || 'shortage';
  document.getElementById('adj-category').value     = prefill.category  || '';
  document.getElementById('adj-manufacturer').value = prefill.manufacturer || '';
  document.getElementById('adj-model').value        = prefill.model_name || '';
  document.getElementById('adj-spec').value         = prefill.spec || '';
  document.getElementById('adj-qty').value          = '';
  document.getElementById('adj-temp-price').value   = '';
  document.getElementById('adj-conf-price').value   = '';
  document.getElementById('adj-reason').value       = '';
  document.getElementById('adj-pending-temps').textContent = '';

  // 처리자 표시
  const userData = JSON.parse(sessionStorage.getItem('user') || '{}');
  document.getElementById('adj-performer').textContent = userData.name || '-';

  // 날짜 피커
  if (_adjFp) _adjFp.destroy();
  _adjFp = flatpickr('#adj-date', {
    locale: 'ko', dateFormat: 'Y-m-d', defaultDate: 'today',
  });

  adjToggleFields(prefill.adjustment_type || 'shortage');
  document.getElementById('modal-inv-adjust').classList.remove('hidden');
}

function adjToggleFields(type) {
  const tempWrap = document.getElementById('adj-temp-price-wrap');
  const confWrap = document.getElementById('adj-conf-price-wrap');
  tempWrap.classList.toggle('hidden', type !== 'temp_purchase');
  confWrap.classList.toggle('hidden', type !== 'confirm_purchase');

  if (type === 'confirm_purchase') {
    adjLoadPendingTemps();
  }
}

async function adjLoadPendingTemps() {
  const mfr   = document.getElementById('adj-manufacturer').value.trim();
  const model = document.getElementById('adj-model').value.trim();
  const spec  = document.getElementById('adj-spec').value.trim();
  const el    = document.getElementById('adj-pending-temps');
  if (!mfr || !model) { el.textContent = '브랜드와 모델명을 먼저 입력하세요.'; return; }

  try {
    const rows = await API.get(`/inventory/adjustments/pending-temp/${encodeURIComponent(mfr)}/${encodeURIComponent(model)}/${encodeURIComponent(spec || '')}`);
    if (!rows.length) {
      el.textContent = '확정 대기 중인 임시매입 기록이 없습니다.';
    } else {
      el.innerHTML = `<strong>확정 대기 임시매입 (${rows.length}건):</strong> ` +
        rows.map(r => `${r.adjustment_date} ${r.quantity}개 @${Number(r.temp_price||0).toLocaleString()}원`).join(' / ');
    }
  } catch { el.textContent = '조회 실패'; }
}

async function invSaveAdjustment(force = false) {
  const adjType   = document.getElementById('adj-type').value;
  const mfr       = document.getElementById('adj-manufacturer').value.trim();
  const model     = document.getElementById('adj-model').value.trim();
  const spec      = document.getElementById('adj-spec').value.trim();
  const category  = document.getElementById('adj-category').value.trim();
  const qty       = Number(document.getElementById('adj-qty').value);
  const tempPrice = document.getElementById('adj-temp-price').value;
  const confPrice = document.getElementById('adj-conf-price').value;
  const reason    = document.getElementById('adj-reason').value.trim();
  const adjDate   = document.getElementById('adj-date').value;

  if (!mfr || !model)  return toast('브랜드와 모델명을 입력하세요.', 'error');
  if (!qty || qty <= 0) return toast('조정수량을 올바르게 입력하세요.', 'error');
  if (!reason)          return toast('사유를 입력하세요.', 'error');
  if (adjType === 'temp_purchase' && !tempPrice)
    return toast('임시매입가를 입력하세요.', 'error');
  if (adjType === 'confirm_purchase' && !confPrice)
    return toast('확정매입가를 입력하세요.', 'error');

  const body = {
    adjustment_date: adjDate,
    manufacturer: mfr, model_name: model, spec, category,
    adjustment_type: adjType, quantity: qty, reason,
    temp_price:    tempPrice    ? Number(tempPrice)    : undefined,
    confirmed_price: confPrice  ? Number(confPrice)    : undefined,
    force,
  };

  try {
    const result = await API.post('/inventory/adjustments', body);
    toast('재고조정이 저장되었습니다.', 'success');
    document.getElementById('modal-inv-adjust').classList.add('hidden');
    loadInventory();
  } catch (err) {
    // 30% 변동 경고
    if (err.status === 409 && err.data?.warn === 'avg_price_change') {
      const d = err.data;
      const ok = confirm(
        `평균매입가가 ${Math.round(d.old_avg).toLocaleString()}원 → ${Math.round(d.new_avg).toLocaleString()}원으로 ${d.pct}% 변동됩니다.\n진행하시겠습니까?`
      );
      if (ok) invSaveAdjustment(true);
    } else {
      toast(err.message || '저장 실패', 'error');
    }
  }
}

// ══════════════════════════════════════════════
//  엑셀 다운로드
// ══════════════════════════════════════════════
function invExportExcel() {
  if (!window.XLSX) return toast('XLSX 라이브러리가 로드되지 않았습니다.', 'error');
  if (!_invFiltered.length) return toast('내보낼 데이터가 없습니다.', 'error');

  const isViewer = currentUser?.role === 'viewer';
  const rows = _invFiltered.map(r => {
    const row = {
      '구분':          r.category || '',
      '브랜드':        r.manufacturer || '',
      '모델명':        r.model_name || '',
      '스펙':          r.spec || '',
      '현재재고':      r.current_stock || 0,
      '매입완료재고':  r.completed_stock || 0,
      '우선등록재고':  r.priority_stock || 0,
      '매입미완료수량':r.pending_inbound_qty || 0,
      '처리구분':      r.condition_type === 'defective' ? '불량' : r.condition_type === 'disposal' ? '폐기' : '정상',
      '총입고':        r.total_inbound || 0,
      '총출고':        r.total_outbound || 0,
      '최근거래처':    r.last_vendor || r.last_vendor_name || '',
      '비고':          r.notes || '',
      '임시매입포함':  (r.has_temp_purchase || 0) > 0 ? '⚠️' : '',
    };
    if (!isViewer) row['평균매입가'] = r.avg_purchase_price || 0;
    return row;
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '재고현황');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  XLSX.writeFile(wb, `재고현황_${date}.xlsx`);
}

// ══════════════════════════════════════════════
//  API 헬퍼 확장 (409 데이터 보존)
// ══════════════════════════════════════════════
(function patchApiForConflict() {
  const _origPost = API.post.bind(API);
  API.post = async function(url, body) {
    const res = await fetch('/api' + url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (localStorage.getItem('token') || ''),
      },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      const data = await res.json();
      const err  = new Error(data.error || '충돌');
      err.status = 409;
      err.data   = data;
      throw err;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText);
    }
    return res.json();
  };
})();

// ══════════════════════════════════════════════
//  이벤트 바인딩
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {

  // 검색 (4개 필드)
  const searchBindings = [
    ['inv-search-cat',    'cat'],
    ['inv-search-brand',  'brand'],
    ['inv-search-model',  'model'],
    ['inv-search-vendor', 'vendor'],
  ];
  searchBindings.forEach(([id, key]) => {
    document.getElementById(id)?.addEventListener('input', e => {
      _invSearch[key] = e.target.value;
      invApplyFilter();
    });
  });

  // 검색 초기화
  document.getElementById('btn-inv-search-clear')?.addEventListener('click', () => {
    searchBindings.forEach(([id, key]) => {
      _invSearch[key] = '';
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    invApplyFilter();
  });

  // 탭
  document.querySelectorAll('[data-invtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      _invActiveTab = btn.dataset.invtab;
      document.querySelectorAll('[data-invtab]').forEach(b =>
        b.classList.toggle('active', b.dataset.invtab === _invActiveTab)
      );
      // 스마트스토어 탭은 항상 최신 데이터로 재조회
      if (_invActiveTab === 'smartstore') {
        loadInventory();
      } else {
        invApplyFilter();
      }
    });
  });

  // 구분 필터 버튼
  document.querySelectorAll('.inv-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _invCatFilter = btn.dataset.catfilter;
      document.querySelectorAll('.inv-cat-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.catfilter === _invCatFilter)
      );
      invApplyFilter();
    });
  });

  // 필터 초기화
  document.getElementById('btn-inv-filter-reset')?.addEventListener('click', () => {
    _invActiveTab = 'all';
    _invCatFilter = 'all';
    document.querySelectorAll('[data-invtab]').forEach(b =>
      b.classList.toggle('active', b.dataset.invtab === 'all')
    );
    document.querySelectorAll('.inv-cat-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.catfilter === 'all')
    );
    invApplyFilter();
  });

  // 재고조정 버튼
  document.getElementById('btn-inv-adjust')?.addEventListener('click', () => {
    invOpenAdjustModal();
  });

  // 재고조정 닫기
  document.getElementById('btn-inv-adjust-close')?.addEventListener('click', () => {
    document.getElementById('modal-inv-adjust').classList.add('hidden');
  });
  document.getElementById('btn-adj-cancel')?.addEventListener('click', () => {
    document.getElementById('modal-inv-adjust').classList.add('hidden');
  });

  // 조정유형 변경
  document.getElementById('adj-type')?.addEventListener('change', e => {
    adjToggleFields(e.target.value);
  });

  // 모델명/스펙 변경 시 pending temps 재조회
  ['adj-manufacturer', 'adj-model', 'adj-spec'].forEach(id => {
    document.getElementById(id)?.addEventListener('blur', () => {
      if (document.getElementById('adj-type').value === 'confirm_purchase') {
        adjLoadPendingTemps();
      }
    });
  });

  // 저장
  document.getElementById('btn-adj-save')?.addEventListener('click', () => {
    invSaveAdjustment(false);
  });

  // 새로고침
  document.getElementById('btn-inv-refresh')?.addEventListener('click', () => loadInventory());

  // 엑셀 다운로드
  document.getElementById('btn-inv-excel')?.addEventListener('click', invExportExcel);

  // 상세 팝업 닫기
  document.getElementById('btn-inv-detail-close')?.addEventListener('click', () => {
    document.getElementById('modal-inv-detail').classList.add('hidden');
    _invDetailId = null;
  });

  // 상세 팝업 배경 클릭 닫기
  document.getElementById('modal-inv-detail')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) {
      document.getElementById('modal-inv-detail').classList.add('hidden');
      _invDetailId = null;
    }
  });
  document.getElementById('modal-inv-adjust')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) {
      document.getElementById('modal-inv-adjust').classList.add('hidden');
    }
  });

  // 상세 탭
  document.querySelectorAll('[data-dtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      invDetailRenderTab(btn.dataset.dtab);
    });
  });

});
