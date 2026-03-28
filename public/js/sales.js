'use strict';

// ── 상태 ────────────────────────────────────────────────────────
let _slAll   = [];   // 전체 데이터 (서버에서 받은 원본)
let _slView  = [];   // 현재 필터 적용 결과
let _slTab   = 'all';
let _slSearch = { cat: '', brand: '', model: '', vendor: '' };
let _slFrom  = '';
let _slTo    = '';

// ── 유틸 ────────────────────────────────────────────────────────
const won = v => (v == null ? '—' : Number(v).toLocaleString('ko-KR') + '원');
const num = v => (v == null ? '—' : Number(v).toLocaleString('ko-KR'));

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function weekStart() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1));
  return d.toISOString().slice(0, 10);
}
function monthStart() {
  return new Date().toISOString().slice(0, 8) + '01';
}

// ── 초기 진입 ────────────────────────────────────────────────────
async function loadSalesList() {
  // 기본 날짜 범위: 이번달
  if (!_slFrom) {
    _slFrom = monthStart();
    _slTo   = todayStr();
    const fromEl = document.getElementById('sl-from');
    const toEl   = document.getElementById('sl-to');
    if (fromEl) fromEl.value = _slFrom;
    if (toEl)   toEl.value   = _slTo;
  }
  await slFetch();
}

// ── 서버 fetch ───────────────────────────────────────────────────
async function slFetch() {
  try {
    const qs = new URLSearchParams();
    if (_slFrom) qs.set('from', _slFrom);
    if (_slTo)   qs.set('to',   _slTo);
    _slAll = await API.get(`/sales/items?${qs}`);
    slApplyFilter();
  } catch (e) {
    console.error('[sales] fetch error', e);
  }
}

// ── 필터 적용 ────────────────────────────────────────────────────
function slApplyFilter() {
  const { cat, brand, model, vendor } = _slSearch;
  const catL    = cat.toLowerCase();
  const brandL  = brand.toLowerCase();
  const modelL  = model.toLowerCase();
  const vendorL = vendor.toLowerCase();

  _slView = _slAll.filter(r => {
    if (_slTab !== 'all' && r.sale_type !== _slTab) return false;
    if (catL    && !(r.category    || '').toLowerCase().includes(catL))   return false;
    if (brandL  && !(r.manufacturer|| '').toLowerCase().includes(brandL)) return false;
    if (modelL  && !(r.model_name  || '').toLowerCase().includes(modelL)) return false;
    if (vendorL && !(r.vendor_name || '').toLowerCase().includes(vendorL)) return false;
    return true;
  });

  slUpdateTabCounts();
  slRenderTable();
  slRenderSummary();
}

// ── 탭 카운트 업데이트 ───────────────────────────────────────────
function slUpdateTabCounts() {
  const counts = { all: 0, normal: 0, return_deducted: 0, exchange: 0 };
  _slAll.forEach(r => {
    counts.all++;
    if (r.sale_type === 'normal')           counts.normal++;
    else if (r.sale_type === 'return_deducted') counts.return_deducted++;
    else if (r.sale_type === 'exchange')    counts.exchange++;
  });
  // 검색어 적용 후 카운트 (탭 필터 제외)
  const { cat, brand, model, vendor } = _slSearch;
  const catL   = cat.toLowerCase();
  const brandL = brand.toLowerCase();
  const modelL = model.toLowerCase();
  const vendorL = vendor.toLowerCase();
  const filtered = _slAll.filter(r => {
    if (catL    && !(r.category    || '').toLowerCase().includes(catL))   return false;
    if (brandL  && !(r.manufacturer|| '').toLowerCase().includes(brandL)) return false;
    if (modelL  && !(r.model_name  || '').toLowerCase().includes(modelL)) return false;
    if (vendorL && !(r.vendor_name || '').toLowerCase().includes(vendorL)) return false;
    return true;
  });
  const fc = { all: filtered.length, normal: 0, return_deducted: 0, exchange: 0 };
  filtered.forEach(r => {
    if (r.sale_type === 'normal')               fc.normal++;
    else if (r.sale_type === 'return_deducted') fc.return_deducted++;
    else if (r.sale_type === 'exchange')        fc.exchange++;
  });

  const el = id => document.getElementById(id);
  if (el('sl-cnt-all'))    el('sl-cnt-all').textContent    = fc.all;
  if (el('sl-cnt-normal')) el('sl-cnt-normal').textContent = fc.normal;
  if (el('sl-cnt-return')) el('sl-cnt-return').textContent = fc.return_deducted;
  if (el('sl-cnt-exchange')) el('sl-cnt-exchange').textContent = fc.exchange;
}

// ── 테이블 렌더 ──────────────────────────────────────────────────
function slRenderTable() {
  const tbody = document.getElementById('sl-tbody');
  if (!tbody) return;

  if (!_slView.length) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty">표시할 데이터가 없습니다.</td></tr>`;
    return;
  }

  tbody.innerHTML = _slView.map(r => {
    const typeLabel = slTypeLabel(r.sale_type);
    const priorityMark = r.is_priority_stock ? ' <span class="sl-priority-badge" title="우선등록 재고 기반">⚠</span>' : '';
    const specCell = r.spec ? `<span class="sl-spec-tag">${esc(r.spec)}</span>` : '<span class="sl-empty-spec">—</span>';

    // 순수익 색상
    const profitCls = (r.net_total_profit || 0) >= 0 ? 'sl-profit-pos' : 'sl-profit-neg';
    const profitUnitCls = (r.profit_per_unit || 0) >= 0 ? 'sl-profit-pos' : 'sl-profit-neg';

    return `<tr class="sl-row sl-type-${r.sale_type}">
      <td class="sl-date">${r.order_date || '—'}</td>
      <td>${r.category ? `<span class="inv-cat-tag">${esc(r.category)}</span>` : '—'}</td>
      <td class="sl-brand">${esc(r.manufacturer || '—')}</td>
      <td class="sl-model">${esc(r.model_name || '—')}${priorityMark}</td>
      <td>${specCell}</td>
      <td class="sl-num">${r.net_quantity !== r.quantity
        ? `<span class="sl-qty-reduced">${r.net_quantity}</span><span class="sl-qty-orig"> (${r.quantity})</span>`
        : r.quantity}</td>
      <td class="sl-num">${won(r.sale_price)}</td>
      <td class="sl-num">${won(r.net_total_price)}</td>
      <td class="sl-num sl-avg-price">${won(r.avg_purchase_price)}</td>
      <td class="sl-num ${profitUnitCls}">${won(r.profit_per_unit)}</td>
      <td class="sl-num ${profitCls}">${won(r.net_total_profit)}</td>
      <td class="sl-vendor">${esc(r.vendor_name || '—')}</td>
      <td>${typeLabel}</td>
    </tr>`;
  }).join('');
}

function slTypeLabel(type) {
  if (type === 'return_deducted') return '<span class="sl-type-badge sl-type-return">🔄 반품차감</span>';
  if (type === 'exchange')        return '<span class="sl-type-badge sl-type-exchange">🔄 교환</span>';
  return '<span class="sl-type-badge sl-type-normal">일반판매</span>';
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 하단 요약 렌더 ───────────────────────────────────────────────
function slRenderSummary() {
  const el = id => document.getElementById(id);

  const totalSales   = _slView.reduce((s, r) => s + (r.net_total_price  || 0), 0);
  const totalProfit  = _slView.reduce((s, r) => s + (r.net_total_profit  || 0), 0);
  const totalQty     = _slView.reduce((s, r) => s + (r.net_quantity      || 0), 0);
  const totalItems   = _slView.length;

  // 유형별
  const normalItems  = _slView.filter(r => r.sale_type === 'normal');
  const returnItems  = _slView.filter(r => r.sale_type === 'return_deducted');
  const exchItems    = _slView.filter(r => r.sale_type === 'exchange');

  const returnProfit = returnItems.reduce((s, r) => s + (r.net_total_profit || 0), 0);
  const exchProfit   = exchItems.reduce((s, r)   => s + (r.net_total_profit || 0), 0);

  if (el('sl-sum-items'))       el('sl-sum-items').textContent       = totalItems.toLocaleString('ko-KR') + '건';
  if (el('sl-sum-qty'))         el('sl-sum-qty').textContent         = totalQty.toLocaleString('ko-KR') + '개';
  if (el('sl-sum-sales'))       el('sl-sum-sales').textContent       = won(totalSales);
  if (el('sl-sum-profit'))      el('sl-sum-profit').textContent      = won(totalProfit);
  if (el('sl-sum-normal-cnt'))  el('sl-sum-normal-cnt').textContent  = normalItems.length + '건';
  if (el('sl-sum-return-cnt'))  el('sl-sum-return-cnt').textContent  = returnItems.length + '건';
  if (el('sl-sum-exch-cnt'))    el('sl-sum-exch-cnt').textContent    = exchItems.length + '건';
  if (el('sl-sum-return-profit')) el('sl-sum-return-profit').textContent = won(returnProfit);
  if (el('sl-sum-exch-profit'))   el('sl-sum-exch-profit').textContent   = won(exchProfit);

  // 순수익 색상
  const profitEl = el('sl-sum-profit');
  if (profitEl) {
    profitEl.classList.toggle('sl-profit-pos', totalProfit >= 0);
    profitEl.classList.toggle('sl-profit-neg', totalProfit < 0);
  }
}

// ── 엑셀(CSV) 다운로드 ───────────────────────────────────────────
function slExportCsv() {
  if (!_slView.length) { alert('내보낼 데이터가 없습니다.'); return; }

  const headers = [
    '출고날짜','구분','브랜드','모델명','스펙',
    '수량','반품수량','순판매수량',
    '판매가','판매가합계',
    '평균매입가','순수익/개','순수익합계',
    '거래처','유형','우선등록재고'
  ];

  const rows = _slView.map(r => [
    r.order_date || '',
    r.category || '',
    r.manufacturer || '',
    r.model_name || '',
    r.spec || '',
    r.quantity,
    r.returned_qty || 0,
    r.net_quantity,
    r.sale_price || 0,
    r.net_total_price || 0,
    r.avg_purchase_price || 0,
    r.profit_per_unit || 0,
    r.net_total_profit || 0,
    r.vendor_name || '',
    r.sale_type === 'return_deducted' ? '반품차감'
      : r.sale_type === 'exchange'   ? '교환'
      : '일반판매',
    r.is_priority_stock ? 'Y' : '',
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const dateStr = (_slFrom || todayStr()).replace(/-/g, '') + '_' + (_slTo || todayStr()).replace(/-/g, '');
  a.href     = url;
  a.download = `판매현황_${dateStr}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── 이벤트 바인딩 ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // 날짜 범위
  document.getElementById('sl-from')?.addEventListener('change', e => {
    _slFrom = e.target.value; slFetch();
  });
  document.getElementById('sl-to')?.addEventListener('change', e => {
    _slTo = e.target.value; slFetch();
  });

  // 빠른 선택
  document.getElementById('btn-sl-today')?.addEventListener('click', () => {
    _slFrom = _slTo = todayStr();
    document.getElementById('sl-from').value = _slFrom;
    document.getElementById('sl-to').value   = _slTo;
    slFetch();
  });
  document.getElementById('btn-sl-week')?.addEventListener('click', () => {
    _slFrom = weekStart();
    _slTo   = todayStr();
    document.getElementById('sl-from').value = _slFrom;
    document.getElementById('sl-to').value   = _slTo;
    slFetch();
  });
  document.getElementById('btn-sl-month')?.addEventListener('click', () => {
    _slFrom = monthStart();
    _slTo   = todayStr();
    document.getElementById('sl-from').value = _slFrom;
    document.getElementById('sl-to').value   = _slTo;
    slFetch();
  });

  // 검색창 4개
  const searchBindings = [
    ['sl-search-cat',    'cat'],
    ['sl-search-brand',  'brand'],
    ['sl-search-model',  'model'],
    ['sl-search-vendor', 'vendor'],
  ];
  searchBindings.forEach(([id, key]) => {
    document.getElementById(id)?.addEventListener('input', e => {
      _slSearch[key] = e.target.value;
      slApplyFilter();
    });
  });
  document.getElementById('btn-sl-search-clear')?.addEventListener('click', () => {
    searchBindings.forEach(([id, key]) => {
      _slSearch[key] = '';
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    slApplyFilter();
  });

  // 탭
  document.querySelectorAll('.sl-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sl-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _slTab = btn.dataset.sltab;
      slApplyFilter();
    });
  });

  // 엑셀
  document.getElementById('btn-sl-excel')?.addEventListener('click', slExportCsv);
});
