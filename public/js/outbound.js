'use strict';
// ══════════════════════════════════════════════
//  출고 관리 (outbound.js) — v2 (orders + items)
// ══════════════════════════════════════════════

// ── 상태 ──
let _obOrders          = [];     // 전체 주문 캐시
let _obCurrentOrder    = null;   // 현재 보고 있는 주문
let _obEditOrderId     = null;   // 수정 중인 주문 ID
let _obInventory       = [];     // 재고 목록 (자동완성용)
let _obTaxType         = 'none'; // 'none' | '10'
let _obNewVendorCb     = null;   // 신규거래처 등록 후 콜백
let _obFpStart         = null;   // 검색 시작일 flatpickr
let _obFpEnd           = null;   // 검색 종료일 flatpickr
let _obFlatpickr       = null;   // 폼 날짜 flatpickr
let _obSearchTimer     = null;   // 디바운스 타이머
let _obRowCount        = 0;      // 현재 행 수
let _obDropdownItems        = [];  // 모델 드롭다운 아이템 캐시
let _obDropdownRow          = -1;  // 모델 드롭다운이 열린 행 인덱스
let _obVendorSelected  = false;  // 거래처 목록에서 선택 여부
let _obVendorId        = null;   // 선택된 거래처 ID
let _obExcelRows       = [];     // 파싱된 엑셀 행 (엑셀 업로드 탭)
let _obFormTab         = 'excel'; // 'excel' | 'direct'
let _obEditItems       = [];     // 수정 시 기존 품목 (추가 업로드 구분용)
let _obExcelAppendMode = false;  // 엑셀 추가 업로드 모드

// ── 서브페이지 전환 ──────────────────────────
function obShowSubpage(name) {
  ['list', 'form', 'detail'].forEach(p =>
    document.getElementById(`ob-${p}`)?.classList.toggle('hidden', p !== name)
  );
  // 모델 드롭다운 닫기
  document.getElementById('ob-model-dropdown')?.classList.add('hidden');
  // 상세가 아닐 때 스티키 푸터 숨김
  if (name !== 'detail') {
    document.getElementById('ob-sticky-footer')?.classList.add('hidden');
  }
}

// ── 금액 포맷 헬퍼 ────────────────────────────
function obFmtMoney(v) {
  if (v === null || v === undefined) return '-';
  const n = Number(v);
  return (n >= 0 ? '' : '-') + Math.abs(n).toLocaleString('ko-KR') + '원';
}

// ══════════════════════════════════════════════
//  목록 페이지
// ══════════════════════════════════════════════

async function loadOutboundList() {
  try {
    const list = await API.get('/outbound');
    _obOrders = list;
    obApplyFilter();
  } catch (err) { toast(err.message, 'error'); }
}

function obApplyFilter() {
  const start = document.getElementById('ob-date-start')?.value || '';
  const end   = document.getElementById('ob-date-end')?.value   || '';
  const q     = (document.getElementById('ob-search')?.value || '').toLowerCase().trim();

  const filtered = _obOrders.filter(r => {
    const d = r.order_date || '';
    if (start && d < start) return false;
    if (end   && d > end)   return false;
    if (q) {
      const itemText = (r.items || []).map(it =>
        [it.manufacturer, it.model_name, it.spec, it.category].map(v => (v||'').toLowerCase()).join(' ')
      ).join(' ');
      const text = [(r.vendor_name||''), itemText].join(' ').toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });
  obRenderCards(filtered);
}

function obRenderCards(list) {
  const wrap = document.getElementById('ob-cards');
  if (!wrap) return;

  if (!list.length) {
    wrap.innerHTML = '<div class="empty">출고 내역이 없습니다.</div>';
    return;
  }

  wrap.innerHTML = list.map(r => {
    // 아이템 요약: "RAM 3개, SSD 2개"
    const summaryParts = Object.entries(r.summary || {})
      .map(([k, v]) => `${escHtml(k)} ${v}개`);
    const summaryStr = summaryParts.length
      ? summaryParts.slice(0, 3).join(', ') + (summaryParts.length > 3 ? ' 외' : '')
      : `${r.item_count || 0}개 항목`;

    const taxBadge    = r.tax_type === '10'
      ? '<span class="ob-cat-chip" style="background:#fff3bf;color:#e67700">부가세 10%</span>'
      : '';
    const unpaidBadge = r.payment_status === 'unpaid'
      ? '<span class="ob-cat-chip ob-unpaid-badge">미입금</span>'
      : '';

    return `
      <div class="ib-card ob-card${r.payment_status === 'unpaid' ? ' ob-card-unpaid' : ''}" onclick="obOpenDetail('${r.id}')">
        <div class="ob-card-hd">
          <span class="ib-card-vendor">${escHtml(r.vendor_name || '거래처 없음')}</span>
          <span class="ib-card-date">${r.order_date}</span>
          <div style="flex:1"></div>
          <span class="ob-card-total">${obFmtMoney(r.total_price)}</span>
        </div>
        <div class="ob-card-body">${summaryStr} ${taxBadge} ${unpaidBadge}</div>
        <div class="ob-card-ft">
          <span>항목 <b>${r.item_count}개</b></span>
        </div>
      </div>
    `;
  }).join('');
}

function obSetQuickRange(range) {
  const today = new Date();
  const fmt = d => d.toISOString().slice(0, 10);
  let start = '', end = '';

  if (range === 'today') {
    start = end = fmt(today);
  } else if (range === 'week') {
    const day = today.getDay();
    const mon = new Date(today); mon.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
    const sun = new Date(mon);   sun.setDate(mon.getDate() + 6);
    start = fmt(mon); end = fmt(sun);
  } else if (range === 'month') {
    start = fmt(new Date(today.getFullYear(), today.getMonth(), 1));
    end   = fmt(new Date(today.getFullYear(), today.getMonth() + 1, 0));
  }

  if (_obFpStart) _obFpStart.setDate(start ? new Date(start) : null, true);
  if (_obFpEnd)   _obFpEnd.setDate(end   ? new Date(end)   : null, true);
  obApplyFilter();
}

// ══════════════════════════════════════════════
//  상세 페이지
// ══════════════════════════════════════════════

window.obOpenDetail = async function(id) {
  try {
    const order = await API.get(`/outbound/${id}`);
    _obCurrentOrder = order;
    const vendorInfo = order.sales_vendor_id
      ? await API.get(`/sales-vendors/${order.sales_vendor_id}`).catch(() => null)
      : null;
    obRenderDetail(order, vendorInfo);
    obShowSubpage('detail');
  } catch (err) { toast(err.message, 'error'); }
};

function obRenderDetail(order, vendorInfo) {
  const taxLabel = order.tax_type === '10' ? '10%' : '없음';
  const supplyTotal = (order.items || []).reduce((s, it) => s + it.quantity * it.sale_price, 0);
  const taxTotal    = (order.items || []).reduce((s, it) => s + (it.tax_amount || 0), 0);
  const grandTotal  = supplyTotal + taxTotal;

  const rows = (order.items || []).map((it, i) => {
    const profitCls = (it.total_profit || 0) >= 0 ? 'ob-profit-pos' : 'ob-profit-neg';
    const ct = it.condition_type || 'normal';
    const ctLabel = ct === 'defective' ? '불량' : ct === 'disposal' ? '폐기' : '정상';
    const ctCls   = ct === 'defective' ? 'ob-cond-defective' : ct === 'disposal' ? 'ob-cond-disposal' : 'ob-cond-normal';
    return `
      <tr>
        <td style="text-align:center">${i + 1}</td>
        <td title="${escHtml(it.category || '-')}">${escHtml(it.category || '-')}</td>
        <td title="${escHtml(it.manufacturer)}">${escHtml(it.manufacturer)}</td>
        <td title="${escHtml(it.model_name)}">${escHtml(it.model_name)}</td>
        <td title="${escHtml(it.spec || '-')}">${escHtml(it.spec || '-')}</td>
        <td style="overflow:visible"><span class="ob-cond-badge ${ctCls}">${ctLabel}</span></td>
        <td style="text-align:right">${it.quantity}</td>
        <td style="text-align:right">${obFmtMoney(it.sale_price)}</td>
        <td style="text-align:right">${obFmtMoney(it.tax_amount)}</td>
        <td style="text-align:right"><b>${obFmtMoney(it.total_price)}</b></td>
        <td class="${profitCls}" style="text-align:right">${obFmtMoney(it.total_profit)}</td>
        <td title="${escHtml(it.notes || '-')}">${escHtml(it.notes || '-')}</td>
      </tr>
    `;
  }).join('');

  // 거래처 상세 정보 행
  let vendorRows = '';
  if (vendorInfo) {
    vendorRows += `<div class="ob-dd-pair"><dt>상호명</dt><dd>${escHtml(vendorInfo.company_name || vendorInfo.vendor_name || '-')}</dd></div>`;
    const _vAddr = vendorInfo.registered_address || vendorInfo.address || '';
    if (_vAddr) vendorRows += `<div class="ob-dd-pair"><dt>사업장주소</dt><dd>${escHtml(_vAddr)}</dd></div>`;
    if (vendorInfo.phone) vendorRows += `<div class="ob-dd-pair"><dt>전화번호</dt><dd>${escHtml(vendorInfo.phone)}</dd></div>`;
    if (vendorInfo.name) vendorRows += `<div class="ob-dd-pair"><dt>이름</dt><dd>${escHtml(vendorInfo.name)}</dd></div>`;
  } else if (order.vendor_name) {
    vendorRows = `<div class="ob-dd-pair"><dt>상호명</dt><dd>${escHtml(order.vendor_name)}</dd></div>`;
  }

  const html = `
    <div class="ib-header-card">
      <dl class="ob-detail-dl">
        <div class="ob-dd-pair"><dt>출고일</dt><dd>${order.order_date}</dd></div>
        ${vendorRows}
        <div class="ob-dd-pair"><dt>부가세</dt><dd>${taxLabel}</dd></div>
        <div class="ob-dd-pair"><dt>비고</dt><dd>${escHtml(order.notes || '-')}</dd></div>
      </dl>
      <div class="vdd-meta" style="margin-top:.75rem">
        <span><span class="meta-label">등록자</span>${escHtml(order.created_by_name || '-')}</span>
        <span><span class="meta-label">등록일시</span>${fmtDateTime(order.created_at)}</span>
        <span><span class="meta-label">수정자</span>${escHtml(order.updated_by_name || '-')}</span>
        <span><span class="meta-label">수정일시</span>${order.updated_at ? fmtDateTime(order.updated_at) : '-'}</span>
      </div>
    </div>

    <div class="ib-header-card" style="margin-top:.75rem;padding:0;overflow:visible">
      <div class="dual-scroll-top" id="ob-scroll-top"><div class="dual-scroll-inner"></div></div>
      <div class="dual-scroll-wrap" id="ob-table-wrap" style="max-height:60vh">
      <table class="tbl ob-detail-tbl">
        <colgroup>
          <col style="width:40px">
          <col style="width:70px">
          <col style="width:80px">
          <col style="width:120px">
          <col style="width:150px">
          <col style="width:70px">
          <col style="width:60px">
          <col style="width:90px">
          <col style="width:80px">
          <col style="width:100px">
          <col style="width:90px">
          <col style="width:150px">
        </colgroup>
        <thead>
          <tr>
            <th>#</th><th>구분</th><th>브랜드</th><th>모델명</th><th>스펙</th>
            <th>상태</th><th>수량</th><th>판매가</th><th>세금</th><th>합계</th><th>이익</th><th>비고</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="9" style="text-align:right;font-weight:600">공급가액</td>
            <td style="text-align:right;font-weight:600">${obFmtMoney(supplyTotal)}</td>
            <td colspan="2"></td>
          </tr>
          <tr>
            <td colspan="9" style="text-align:right">세액 (${taxLabel})</td>
            <td style="text-align:right">${obFmtMoney(taxTotal)}</td>
            <td colspan="2"></td>
          </tr>
          <tr>
            <td colspan="9" style="text-align:right;font-weight:800">합계금액</td>
            <td style="text-align:right;font-weight:800">${obFmtMoney(grandTotal)}</td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
      </div>
    </div>
  `;

  document.getElementById('ob-detail-content').innerHTML = html;

  initDualScroll(
    document.getElementById('ob-table-wrap'),
    document.getElementById('ob-scroll-top')
  );

  // 스티키 푸터 업데이트
  const footer = document.getElementById('ob-sticky-footer');
  if (footer) {
    document.getElementById('ob-sf-supply').textContent = obFmtMoney(supplyTotal);
    document.getElementById('ob-sf-tax').textContent    = obFmtMoney(taxTotal);
    document.getElementById('ob-sf-grand').textContent  = obFmtMoney(grandTotal);
    footer.classList.remove('hidden');
  }

  // 버튼 권한
  const isAdmin = currentUser?.role === 'admin';
  const isEditor = currentUser?.role === 'editor' || isAdmin;
  document.getElementById('btn-ob-edit').style.display   = isEditor ? '' : 'none';
  document.getElementById('btn-ob-delete').style.display = isEditor ? '' : 'none';

  // 미입금 버튼 상태
  const unpaidBtn = document.getElementById('btn-ob-unpaid');
  if (unpaidBtn && isEditor) {
    const isUnpaid = order.payment_status === 'unpaid';
    unpaidBtn.textContent = isUnpaid ? '입금완료' : '미입금';
    unpaidBtn.className   = isUnpaid ? 'btn btn-success' : 'btn btn-warning';
    unpaidBtn.onclick = () => obTogglePaymentStatus(order.id, isUnpaid ? 'paid' : 'unpaid');
  } else if (unpaidBtn) {
    unpaidBtn.style.display = 'none';
  }
}

async function obTogglePaymentStatus(id, newStatus) {
  const label = newStatus === 'unpaid' ? '미입금' : '입금완료';
  if (!confirm(`이 출고건을 "${label}"으로 변경하시겠습니까?`)) return;
  try {
    const updated = await API.patch(`/outbound/${id}/payment-status`, { status: newStatus });
    _obCurrentOrder = updated;
    // 목록 캐시 업데이트
    const idx = _obOrders.findIndex(o => o.id === id);
    if (idx >= 0) _obOrders[idx] = { ..._obOrders[idx], payment_status: newStatus };
    const vendorInfo = updated.sales_vendor_id
      ? await API.get(`/sales-vendors/${updated.sales_vendor_id}`).catch(() => null)
      : null;
    obRenderDetail(updated, vendorInfo);
    toast(`"${label}"으로 변경되었습니다.`, 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// ══════════════════════════════════════════════
//  등록/수정 폼
// ══════════════════════════════════════════════

async function obShowForm(id = null) {
  _obEditOrderId = id;
  _obRowCount  = 0;
  document.getElementById('ob-form-title').textContent = id ? '출고 수정' : '출고 등록';

  // 엑셀 탭 초기화
  _obExcelRows = [];
  _obExcelAppendMode = false;
  _obEditItems = [];
  document.getElementById('ob-excel-preview')?.classList.add('hidden');
  const obFileInp = document.getElementById('ob-excel-file');
  if (obFileInp) obFileInp.value = '';
  const obFilename = document.getElementById('ob-excel-filename');
  if (obFilename) obFilename.textContent = '';
  // 수정 시 직접 입력 탭 기본, 등록 시 엑셀 탭 기본
  obSwitchFormTab(id ? 'direct' : 'excel');

  // 재고 로드 (condition_type별 분리 목록)
  try { _obInventory = await API.get('/outbound/inventory-search'); } catch { /* 무시 */ }

  // Flatpickr 초기화
  if (!_obFlatpickr) {
    _obFlatpickr = flatpickr('#ob-date', { locale: 'ko', dateFormat: 'Y-m-d' });
  }

  // 세금 토글 초기화
  _obTaxType = 'none';
  obUpdateTaxToggle();

  // 거래처 초기화
  _obVendorId = null;
  _obVendorSelected = false;
  document.getElementById('ob-vendor-input').value = '';
  document.getElementById('ob-vendor-id').value    = '';
  document.getElementById('btn-ob-new-vendor')?.classList.add('hidden');
  document.getElementById('ob-vendor-dropdown')?.classList.add('hidden');

  if (id) {
    try {
      const order = await API.get(`/outbound/${id}`);
      _obFlatpickr.setDate(order.order_date, true);
      _obTaxType = order.tax_type || 'none';
      obUpdateTaxToggle();

      if (order.vendor_name || order.sales_vendor_id) {
        document.getElementById('ob-vendor-input').value = order.vendor_name || '';
        document.getElementById('ob-vendor-id').value    = order.sales_vendor_id || '';
        _obVendorId       = order.sales_vendor_id || null;
        _obVendorSelected = !!order.sales_vendor_id;
      }
      document.getElementById('ob-notes').value = order.notes || '';

      // 기존 행 채우기
      const items = order.items || [];
      _obEditItems = items;
      obSetRows(Math.max(items.length, 1));
      items.forEach((it, i) => obFillRow(i, it));
    } catch (err) { toast(err.message, 'error'); return; }
  } else {
    const today = new Date().toISOString().slice(0, 10);
    _obFlatpickr.setDate(today, true);
    document.getElementById('ob-notes').value = '';
    obSetRows(3);
  }

  obShowSubpage('form');
}

function obSetRows(n) {
  const tbody = document.getElementById('ob-items-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  _obRowCount = 0;
  for (let i = 0; i < n; i++) obAddRow();
}

function obAddRow() {
  const tbody = document.getElementById('ob-items-tbody');
  if (!tbody) return;
  const idx = _obRowCount++;
  const tr = document.createElement('tr');
  tr.id = `ob-row-${idx}`;
  tr.dataset.maxStock = '';
  tr.innerHTML = `
    <td style="text-align:center;color:var(--gray-400)">${idx + 1}</td>
    <td><input class="ob-inp ob-inp-category" type="text" placeholder="구분" /></td>
    <td><input class="ob-inp ob-inp-mfr" type="text" placeholder="브랜드" /></td>
    <td style="position:relative">
      <input class="ob-inp ob-inp-model" type="text" placeholder="모델명" autocomplete="off"
        oninput="obModelInputChange(this,${idx})"
        onfocus="obShowModelDropdown(this,${idx})"
        onblur="setTimeout(()=>document.getElementById('ob-model-dropdown')?.classList.add('hidden'),200)" />
    </td>
    <td><input class="ob-inp ob-inp-spec" type="text" placeholder="스펙" /></td>
    <td class="ob-cell-cond">
      <input type="hidden" class="ob-inp-condition" value="normal" />
      <span class="ob-cond-badge ob-cond-normal">정상</span>
    </td>
    <td><input class="ob-inp ob-inp-qty" type="number" min="1" placeholder="0"
      oninput="obCalcRow(${idx})" style="width:60px" /></td>
    <td><input class="ob-inp ob-inp-price" type="number" min="0" placeholder="0"
      oninput="obCalcRow(${idx})" /></td>
    <td class="ob-cell-subtotal" style="text-align:right;color:var(--gray-600);font-size:.88rem">0</td>
    <td class="ob-cell-tax" style="text-align:right;color:var(--gray-600);font-size:.82rem">0</td>
    <td class="ob-cell-total" style="text-align:right;font-weight:600">0</td>
    <td><input class="ob-inp ob-inp-notes" type="text" placeholder="비고" /></td>
    <td>
      <button type="button" class="btn btn-sm btn-ghost" style="padding:.15rem .4rem;color:var(--gray-400)"
        onclick="obRemoveRow(${idx})">✕</button>
    </td>
  `;
  tbody.appendChild(tr);
}

function obFillRow(idx, it) {
  const row = document.getElementById(`ob-row-${idx}`);
  if (!row) return;
  row.querySelector('.ob-inp-category').value = it.category || '';
  row.querySelector('.ob-inp-mfr').value      = it.manufacturer || '';
  row.querySelector('.ob-inp-model').value    = it.model_name || '';
  row.querySelector('.ob-inp-spec').value     = it.spec || '';
  row.querySelector('.ob-inp-qty').value      = it.quantity || '';
  row.querySelector('.ob-inp-price').value    = it.sale_price || '';
  row.querySelector('.ob-inp-notes').value    = it.notes || '';
  // condition_type 반영
  const ct = it.condition_type || 'normal';
  const ctLabel = ct === 'defective' ? '불량' : ct === 'disposal' ? '폐기' : '정상';
  const ctCls   = ct === 'defective' ? 'ob-cond-defective' : ct === 'disposal' ? 'ob-cond-disposal' : 'ob-cond-normal';
  const hiddenInp = row.querySelector('.ob-inp-condition');
  const badgeSpan = row.querySelector('.ob-cond-badge');
  if (hiddenInp) hiddenInp.value = ct;
  if (badgeSpan) { badgeSpan.className = `ob-cond-badge ${ctCls}`; badgeSpan.textContent = ctLabel; }
  obCalcRow(idx);
}

function obRemoveRow(idx) {
  const row = document.getElementById(`ob-row-${idx}`);
  if (row) row.remove();
  obCalcFooter();
}

function obCalcRow(idx) {
  const row = document.getElementById(`ob-row-${idx}`);
  if (!row) return;
  const qty   = Number(row.querySelector('.ob-inp-qty')?.value)   || 0;
  const price = Number(row.querySelector('.ob-inp-price')?.value) || 0;
  const taxRate = _obTaxType === '10' ? 0.1 : 0;
  const taxAmt  = Math.round(qty * price * taxRate);
  const total   = qty * price + taxAmt;
  row.querySelector('.ob-cell-subtotal').textContent = (qty * price).toLocaleString();
  row.querySelector('.ob-cell-tax').textContent      = taxAmt.toLocaleString();
  row.querySelector('.ob-cell-total').textContent    = total.toLocaleString();

  // 재고 초과 경고
  const maxStock = row.dataset.maxStock;
  const qtyInp   = row.querySelector('.ob-inp-qty');
  if (qtyInp && maxStock !== '' && maxStock !== undefined) {
    const over = qty > Number(maxStock);
    qtyInp.style.color       = over ? '#e03131' : '';
    qtyInp.style.borderColor = over ? '#e03131' : '';
    qtyInp.title             = over ? `재고 부족 (최대 ${maxStock}개)` : '';
  }

  obCalcFooter();
}

function obCalcFooter() {
  const rows = document.querySelectorAll('#ob-items-tbody tr');
  let totalTax = 0, grandTotal = 0;
  rows.forEach(row => {
    const qty   = Number(row.querySelector('.ob-inp-qty')?.value)   || 0;
    const price = Number(row.querySelector('.ob-inp-price')?.value) || 0;
    const taxRate = _obTaxType === '10' ? 0.1 : 0;
    const taxAmt  = Math.round(qty * price * taxRate);
    totalTax  += taxAmt;
    grandTotal += qty * price + taxAmt;
  });
  const footTax   = document.getElementById('ob-foot-tax');
  const footTotal = document.getElementById('ob-foot-total');
  if (footTax)   footTax.textContent   = totalTax.toLocaleString() + '원';
  if (footTotal) footTotal.textContent = grandTotal.toLocaleString() + '원';
}

function obUpdateTaxToggle() {
  document.querySelectorAll('.ob-tax-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tax === _obTaxType);
  });
  // 세금 변경 시 모든 행 재계산
  document.querySelectorAll('#ob-items-tbody tr').forEach(row => {
    const idx = parseInt(row.id?.replace('ob-row-', ''), 10);
    if (!isNaN(idx)) obCalcRow(idx);
  });
}

// ── 거래처 인라인 드롭다운 ──────────────────────
function obFilterVendors(q) {
  const dd     = document.getElementById('ob-vendor-dropdown');
  const newBtn = document.getElementById('btn-ob-new-vendor');
  if (!dd) return;

  const list = allSalesVendors || [];

  // 목록이 비어있으면 API 로드 후 재시도
  if (!list.length) {
    API.get('/sales-vendors').then(data => {
      if (Array.isArray(data)) {
        data.forEach(v => { if (!allSalesVendors.some(x => x.id === v.id)) allSalesVendors.push(v); });
      }
      obFilterVendors(q);
    }).catch(() => {});
    return;
  }

  const filtered = q
    ? list.filter(v => (v.company_name || '').toLowerCase().includes(q.toLowerCase())).slice(0, 10)
    : list.slice(0, 20);

  const newRow = `<div class="ob-vendor-item ob-vendor-new" onmousedown="obShowNewVendorModal()">+ 신규 거래처 등록</div>`;

  if (!filtered.length) {
    dd.innerHTML = `<div class="ob-vendor-empty">"${escHtml(q)}" 검색 결과 없음</div>${newRow}`;
  } else {
    dd.innerHTML = filtered.map(v =>
      `<div class="ob-vendor-item" onmousedown="obSelectVendor('${v.id}','${escHtml(v.company_name)}')">${escHtml(v.company_name)}</div>`
    ).join('') + newRow;
  }
  dd.classList.remove('hidden');
  if (newBtn) newBtn.classList.add('hidden');
}

window.obSelectVendor = function(id, name) {
  document.getElementById('ob-vendor-input').value = name;
  document.getElementById('ob-vendor-id').value    = id;
  _obVendorId       = id;
  _obVendorSelected = true;
  document.getElementById('ob-vendor-dropdown')?.classList.add('hidden');
  document.getElementById('btn-ob-new-vendor')?.classList.add('hidden');
};

// ── 신규 거래처 모달 ──────────────────────────
window.obShowNewVendorModal = function() {
  const q = document.getElementById('ob-vendor-input')?.value?.trim() || '';
  document.getElementById('ob-nv-company').value = q;
  document.getElementById('ob-nv-phone').value   = '';
  document.getElementById('ob-nv-name').value    = '';
  document.getElementById('ob-nv-address').value = '';
  document.getElementById('ob-nv-biz').value     = '';
  const fileEl = document.getElementById('ob-nv-file');
  if (fileEl) fileEl.value = '';
  const errEl = document.getElementById('ob-nv-err');
  errEl.textContent = '';
  errEl.classList.add('hidden');
  document.getElementById('modal-ob-new-vendor').classList.remove('hidden');
};

window.obConfirmNewVendor = async function() {
  const company = document.getElementById('ob-nv-company').value.trim();
  const phone   = document.getElementById('ob-nv-phone').value.replace(/\D/g, '');
  const name    = document.getElementById('ob-nv-name').value.trim();
  const address = document.getElementById('ob-nv-address').value.trim();
  const biz     = document.getElementById('ob-nv-biz').value.replace(/\D/g, '');
  const errEl   = document.getElementById('ob-nv-err');

  if (!company) {
    errEl.textContent = '상호명을 입력해주세요.';
    errEl.classList.remove('hidden'); return;
  }
  if (!phone) {
    errEl.textContent = '전화번호를 입력해주세요.';
    errEl.classList.remove('hidden'); return;
  }
  if (phone.length < 10 || phone.length > 11) {
    errEl.textContent = '전화번호는 10~11자리여야 합니다.';
    errEl.classList.remove('hidden'); return;
  }

  const btn = document.querySelector('#modal-ob-new-vendor .btn-primary');
  if (btn) btn.disabled = true;
  try {
    const v = await API.post('/sales-vendors', {
      company_name: company, name: name || null,
      phone, registered_address: address || null, business_number: biz || null,
    });
    if (Array.isArray(allSalesVendors)) allSalesVendors.push(v);

    // 입력칸에 등록한 거래처 자동입력 + 선택 상태
    document.getElementById('ob-vendor-input').value = v.company_name;
    document.getElementById('ob-vendor-id').value    = v.id;
    _obVendorId       = v.id;
    _obVendorSelected = true;
    document.getElementById('btn-ob-new-vendor')?.classList.add('hidden');

    document.getElementById('modal-ob-new-vendor').classList.add('hidden');
    toast(`거래처 "${v.company_name}"이(가) 등록되었습니다.`, 'success');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    if (btn) btn.disabled = false;
  }
};

// ── 모델명 드롭다운 ───────────────────────────
let _obModelInputTimer = null;

window.obModelInputChange = function(inputEl, rowIdx) {
  clearTimeout(_obModelInputTimer);
  _obModelInputTimer = setTimeout(() => obShowModelDropdown(inputEl, rowIdx), 300);
};

window.obShowModelDropdown = function(inputEl, rowIdx) {
  _obDropdownRow = rowIdx;
  const q = (inputEl.value || '').toLowerCase().trim();

  // 같은 행의 구분/브랜드 값 읽기
  const row    = document.getElementById(`ob-row-${rowIdx}`);
  const catVal = (row?.querySelector('.ob-inp-category')?.value || '').toLowerCase().trim();
  const mfrVal = (row?.querySelector('.ob-inp-mfr')?.value      || '').toLowerCase().trim();

  let pool = _obInventory;
  let hint = '';

  if (catVal && mfrVal) {
    pool = pool.filter(inv =>
      (inv.category     || '').toLowerCase() === catVal &&
      (inv.manufacturer || '').toLowerCase() === mfrVal
    );
  } else if (catVal) {
    pool = pool.filter(inv => (inv.category || '').toLowerCase() === catVal);
  } else if (mfrVal) {
    pool = pool.filter(inv => (inv.manufacturer || '').toLowerCase() === mfrVal);
  } else {
    hint = '더 정확한 검색을 위해 구분 또는 브랜드를 먼저 입력하세요.';
  }

  // 모델명 키워드 필터
  const matches = q
    ? pool.filter(inv => (inv.model_name || '').toLowerCase().includes(q))
    : pool;

  const limited = matches.slice(0, 20);
  _obDropdownItems = limited;

  const dd = document.getElementById('ob-model-dropdown');
  if (!dd) return;
  const rect = inputEl.getBoundingClientRect();
  dd.style.top      = (rect.bottom + window.scrollY) + 'px';
  dd.style.left     = rect.left + 'px';
  dd.style.minWidth = '580px';

  const tbody = document.getElementById('ob-model-dropdown-tbody');
  if (!tbody) return;

  // ── 개별 상품 섹션 HTML ─────────────────────────
  let rows = '';
  if (!limited.length) {
    rows = `<tr><td colspan="6" class="empty" style="padding:.5rem">검색 결과 없음</td></tr>`;
  } else if (limited.length) {
    rows = limited.map((inv, i) => {
      const noStock  = inv.current_stock <= 0;
      const isDisp   = inv.condition_type === 'disposal';
      const disabled = noStock || isDisp;
      const ct = inv.condition_type || 'normal';
      const ctLabel = ct === 'defective' ? '불량' : ct === 'disposal' ? '폐기' : '정상';
      const ctCls   = ct === 'defective' ? 'ob-cond-defective' : ct === 'disposal' ? 'ob-cond-disposal' : 'ob-cond-normal';
      return `<tr class="ob-model-row${disabled ? ' ob-row-nostock' : ''}"
        ${disabled ? '' : `onmousedown="obSelectModelByIdx(${i})"`}>
        <td>${escHtml(inv.category || '-')}</td>
        <td>${escHtml(inv.manufacturer || '-')}</td>
        <td>${escHtml(inv.model_name)}</td>
        <td>${escHtml(inv.spec || '-')}</td>
        <td><span class="ob-cond-badge ${ctCls}">${ctLabel}</span></td>
        <td class="${(noStock || isDisp) ? 'ob-stock-zero' : ''}">${inv.current_stock}개${isDisp ? ' (출고불가)' : ''}</td>
      </tr>`;
    }).join('');
  }

  // 안내 + 더보기
  const hintRow = hint
    ? `<tr><td colspan="6" style="padding:.35rem .6rem;font-size:.8rem;color:var(--gray-500);background:#fafafa">${hint}</td></tr>`
    : '';
  const moreRow = matches.length > 20
    ? `<tr><td colspan="6" style="padding:.35rem .6rem;font-size:.8rem;color:var(--gray-500);background:#fafafa">... 외 ${matches.length - 20}개 더 있습니다.</td></tr>`
    : '';

  tbody.innerHTML = hintRow + rows + moreRow;
  dd.classList.remove('hidden');
};

window.obSelectModelByIdx = function(i) {
  const inv = _obDropdownItems[i];
  if (!inv) return;
  const row = document.getElementById(`ob-row-${_obDropdownRow}`);
  if (!row) return;
  row.querySelector('.ob-inp-category').value  = inv.category || '';
  row.querySelector('.ob-inp-mfr').value       = inv.manufacturer;
  row.querySelector('.ob-inp-model').value     = inv.model_name;
  row.querySelector('.ob-inp-spec').value      = inv.spec || '';
  row.dataset.maxStock = inv.current_stock;
  // condition_type 반영
  const ct = inv.condition_type || 'normal';
  const ctLabel = ct === 'defective' ? '불량' : ct === 'disposal' ? '폐기' : '정상';
  const ctCls   = ct === 'defective' ? 'ob-cond-defective' : ct === 'disposal' ? 'ob-cond-disposal' : 'ob-cond-normal';
  const hiddenInp = row.querySelector('.ob-inp-condition');
  const badgeSpan = row.querySelector('.ob-cond-badge');
  if (hiddenInp) hiddenInp.value = ct;
  if (badgeSpan) { badgeSpan.className = `ob-cond-badge ${ctCls}`; badgeSpan.textContent = ctLabel; }
  obCalcRow(_obDropdownRow);
  document.getElementById('ob-model-dropdown')?.classList.add('hidden');
};

// ══════════════════════════════════════════════
//  엑셀 업로드 기능
// ══════════════════════════════════════════════

// ── 탭 전환 ──────────────────────────────────
function obSwitchFormTab(tab) {
  _obFormTab = tab;
  document.querySelectorAll('[data-ob-form-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.obFormTab === tab);
  });
  document.getElementById('ob-tab-excel')?.classList.toggle('hidden', tab !== 'excel');
  document.getElementById('ob-tab-direct')?.classList.toggle('hidden', tab !== 'direct');
  // 직접 입력 탭일 때만 상단 [저장] 버튼 표시
  const saveBtn = document.getElementById('btn-ob-save');
  if (saveBtn) saveBtn.style.display = tab === 'direct' ? '' : 'none';
}

// ── 양식 다운로드 ─────────────────────────────
function obDownloadTemplate() {
  const header  = ['구분', '브랜드', '모델명', '수량', '판매가', '상태', '스펙', '비고'];
  const example = ['RAM', '삼성', 'DDR4 16G', 5, 20000, '정상', '', ''];
  const data    = [header, example];
  for (let i = 0; i < 14; i++) data.push(['', '', '', '', '', '', '', '']);

  const ws = XLSX.utils.aoa_to_sheet(data);
  const headerStyle  = { fill: { fgColor: { rgb: 'DDE1EA' } }, font: { bold: true } };
  const exampleStyle = { fill: { fgColor: { rgb: 'FFFDE7' } } };
  ['A','B','C','D','E','F','G','H'].forEach(c => {
    if (ws[c + '1']) ws[c + '1'].s = headerStyle;
    if (ws[c + '2']) ws[c + '2'].s = exampleStyle;
  });
  ws['!cols'] = [10, 12, 18, 14, 8, 8, 12, 18].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '출고양식');
  XLSX.writeFile(wb, '출고_입력양식.xlsx');
}

// ── 업로드 방식 선택 팝업 (수정 모드) ──────────
function obShowUploadModeModal(file, existingCount) {
  const modal = document.getElementById('modal-excel-upload-mode');
  if (!modal) { _obExcelAppendMode = false; obLoadExcelFile(file); return; }
  const desc = document.getElementById('excel-mode-desc');
  if (desc) desc.textContent = `현재 ${existingCount}개 품목이 등록되어 있습니다.\n어떻게 하시겠습니까?`;
  modal.classList.remove('hidden');
  function cleanup() {
    modal.classList.add('hidden');
    document.getElementById('btn-excel-mode-replace')?.removeEventListener('click', onReplace);
    document.getElementById('btn-excel-mode-append')?.removeEventListener('click', onAppend);
    document.querySelectorAll('.btn-excel-mode-cancel').forEach(b => b.removeEventListener('click', onCancel));
  }
  function onReplace() {
    cleanup();
    _obExcelAppendMode = false;
    _obExcelRows = [];
    obLoadExcelFile(file);
  }
  function onAppend() {
    cleanup();
    _obExcelAppendMode = true;
    if (_obEditItems.length > 0 && !_obExcelRows.some(r => r._isExisting)) {
      _obExcelRows = _obEditItems.map((item, idx) => ({
        _row:           idx + 2,
        category:       item.category      || '',
        manufacturer:   item.manufacturer  || '',
        model_name:     item.model_name    || '',
        spec:           item.spec          || '',
        condition_type: item.condition_type || 'normal',
        quantity:       item.quantity      || null,
        sale_price:     item.sale_price    || null,
        notes:          item.notes         || '',
        _status: 'ok', _stock: null, _errFields: [],
        _isExisting: true,
      }));
    }
    obLoadExcelFile(file, true);
  }
  function onCancel() { cleanup(); }
  document.getElementById('btn-excel-mode-replace')?.addEventListener('click', onReplace);
  document.getElementById('btn-excel-mode-append')?.addEventListener('click', onAppend);
  document.querySelectorAll('.btn-excel-mode-cancel').forEach(b => b.addEventListener('click', onCancel));
}

// ── 엑셀 파일 로드 ───────────────────────────
function obLoadExcelFile(file, appendMode = false) {
  document.getElementById('ob-excel-filename').textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb   = XLSX.read(e.target.result, { type: 'array' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      obParseExcel(data.slice(1).filter(r => r.some(c => String(c).trim())), appendMode);
    } catch (err) { toast('엑셀 파일 파싱 실패: ' + err.message, 'error'); }
  };
  reader.readAsArrayBuffer(file);
}

// ── 엑셀 파싱 ────────────────────────────────
// 컬럼 순서: A:구분 B:브랜드 C:모델명 D:수량 E:판매가 F:상태 G:스펙 H:비고
function obParseExcel(rows, appendMode = false) {
  const newRows = rows.map((r, idx) => {
    const rowNum       = idx + 2;
    const category     = String(r[0] ?? '').trim();
    const manufacturer = String(r[1] ?? '').trim();
    const model_name   = String(r[2] ?? '').trim();
    const quantityRaw  = String(r[3] ?? '').trim();
    const salePriceRaw = String(r[4] ?? '').trim();
    const condRaw      = String(r[5] ?? '').trim().toLowerCase();
    const spec         = String(r[6] ?? '').trim();
    const notes        = String(r[7] ?? '').trim();

    const condition_type = condRaw === '불량' ? 'defective' : 'normal';
    const quantity   = quantityRaw   !== '' ? Number(quantityRaw)   : null;
    const sale_price = salePriceRaw  !== '' ? Number(salePriceRaw)  : null;

    const row = {
      _row: rowNum, category, manufacturer, model_name, spec,
      condition_type,
      quantity:   (quantity   !== null && !isNaN(quantity))   ? quantity   : null,
      sale_price: (sale_price !== null && !isNaN(sale_price)) ? sale_price : null,
      notes, _status: 'missing', _stock: null, _errFields: [],
      _isExisting: false,
    };
    obCheckRowStatus(row);
    return row;
  });
  if (appendMode) {
    _obExcelRows = [..._obExcelRows, ...newRows];
  } else {
    _obExcelRows = newRows;
  }
  obRenderExcelPreview();
}

// ── 행 상태 검사 ─────────────────────────────
function obCheckRowStatus(r) {
  const errFields = [];
  if (!r.model_name) errFields.push('model_name');
  if (r.quantity === null || r.quantity === undefined || isNaN(r.quantity) || r.quantity <= 0) errFields.push('quantity');
  if (r.sale_price === null || r.sale_price === undefined || isNaN(r.sale_price) || r.sale_price < 0) errFields.push('sale_price');

  r._errFields = errFields;
  if (errFields.length > 0) { r._status = 'missing'; r._stock = null; return; }

  const found = _obInventory.find(inv =>
    (inv.model_name    || '').toLowerCase() === (r.model_name    || '').toLowerCase() &&
    (inv.manufacturer  || '').toLowerCase() === (r.manufacturer  || '').toLowerCase() &&
    (inv.category      || '').toLowerCase() === (r.category      || '').toLowerCase() &&
    (inv.spec          || '').toLowerCase() === (r.spec          || '').toLowerCase() &&
    (inv.condition_type || 'normal')         === (r.condition_type || 'normal')
  );

  r._stock = found || null;
  if (!found)                                  r._status = 'not_found';
  else if (r.quantity > (found.current_stock || 0)) r._status = 'insufficient';
  else                                          r._status = 'ok';
}

// ── 결과 셀 HTML ─────────────────────────────
function obExcelResultHtml(r, idx) {
  if (r._status === 'missing') {
    const labels = { model_name: '모델명', quantity: '수량', sale_price: '판매가' };
    const missing = r._errFields.map(f => labels[f] || f).join(', ');
    return `<span class="ob-excel-badge ob-excel-err-badge">❌ 필수값 누락</span> <small style="color:var(--danger,#e03131)">${escHtml(missing)} 입력해주세요</small>`;
  }
  if (r._status === 'not_found') {
    return `<span class="ob-excel-badge ob-excel-err-badge">❌ 재고 없음</span> <button class="btn btn-sm btn-ghost" onclick="obExcelReCheckRow(${idx})" style="font-size:.72rem;padding:.1rem .4rem">재조회</button>`;
  }
  if (r._status === 'insufficient') {
    const stock = r._stock ? r._stock.current_stock : 0;
    const pri   = r._stock && r._stock.has_temp_purchase_qty > 0 ? ' <span title="우선등록 재고 포함" style="color:#f59e0b">⚠</span>' : '';
    return `<span class="ob-excel-badge ob-excel-warn-badge">⚠️ 재고부족</span> <small style="color:#e67700">(현재 ${stock}개)</small>${pri}`;
  }
  const stock = r._stock ? r._stock.current_stock : 0;
  const pri   = r._stock && r._stock.has_temp_purchase_qty > 0 ? ' <span title="우선등록 재고 포함" style="color:#f59e0b">⚠</span>' : '';
  return `<span class="ob-excel-badge ob-excel-ok-badge">✅ 정상</span> <small style="color:var(--gray-500)">(${stock}개)</small>${pri}`;
}

// ── 미리보기 전체 렌더 ─────────────────────────
function obRenderExcelPreview() {
  const tbody = document.getElementById('ob-excel-tbody');
  if (!tbody) return;

  let _obShownExistingSep = false;
  let _obShownNewSep = false;
  let html = '';
  _obExcelRows.forEach((r, idx) => {
    const isExisting = !!r._isExisting;
    if (_obExcelAppendMode) {
      if (isExisting && !_obShownExistingSep) {
        _obShownExistingSep = true;
        html += `<tr class="ib-excel-batch-sep"><td colspan="12" style="text-align:center;padding:.35rem;background:#e8eaf0;color:#6b7280;font-size:.78rem;border-top:2px solid #9ca3af">─── 기존 등록 품목 ───</td></tr>`;
      }
      if (!isExisting && !_obShownNewSep) {
        _obShownNewSep = true;
        html += `<tr class="ib-excel-batch-sep"><td colspan="12" style="text-align:center;padding:.35rem;background:var(--gray-100,#f3f4f6);color:var(--gray-500,#6b7280);font-size:.78rem;border-top:2px solid var(--primary,#4f6ef7)">─── 추가 업로드 품목 ───</td></tr>`;
      }
    }
    const total  = (r.quantity > 0 && r.sale_price >= 0) ? r.quantity * r.sale_price : null;
    const stock  = r._stock ? r._stock.current_stock : null;
    const rowCls = isExisting ? '' : (r._status === 'ok' ? 'ob-excel-ok' : r._status === 'insufficient' ? 'ob-excel-warn' : 'ob-excel-bad');
    const rowStyle = isExisting ? ' style="background:#f5f6f8"' : '';
    const ec     = f => r._errFields.includes(f) ? ' ob-excel-err' : '';
    html += `<tr data-ob-excel-idx="${idx}" class="${rowCls}"${rowStyle}>
      <td style="text-align:center;color:var(--gray-400);font-size:.8rem">${r._row}</td>
      <td><input class="ob-excel-inp" data-f="category" value="${escHtml(r.category)}" placeholder="구분"${isExisting ? ' disabled' : ''} /></td>
      <td><input class="ob-excel-inp" data-f="manufacturer" value="${escHtml(r.manufacturer)}" placeholder="브랜드"${isExisting ? ' disabled' : ''} /></td>
      <td><input class="ob-excel-inp${ec('model_name')}" data-f="model_name" value="${escHtml(r.model_name)}" placeholder="모델명 *"${isExisting ? ' disabled' : ''} /></td>
      <td><input class="ob-excel-inp" data-f="spec" value="${escHtml(r.spec)}" placeholder="스펙"${isExisting ? ' disabled' : ''} /></td>
      <td><select class="ob-excel-inp ob-excel-sel" data-f="condition_type"${isExisting ? ' disabled' : ''}>
        <option value="normal"${r.condition_type === 'normal' ? ' selected' : ''}>정상</option>
        <option value="defective"${r.condition_type === 'defective' ? ' selected' : ''}>불량</option>
      </select></td>
      <td><input class="ob-excel-inp ob-excel-num${ec('quantity')}" data-f="quantity" type="number" min="1" value="${r.quantity != null ? r.quantity : ''}" placeholder="수량 *"${isExisting ? ' disabled' : ''} /></td>
      <td><input class="ob-excel-inp ob-excel-num${ec('sale_price')}" data-f="sale_price" type="number" min="0" value="${r.sale_price != null ? r.sale_price : ''}" placeholder="판매가 *"${isExisting ? ' disabled' : ''} /></td>
      <td class="ob-excel-total" style="text-align:right;font-size:.85rem">${total != null ? total.toLocaleString() + '원' : '-'}</td>
      <td class="ob-excel-stock" style="text-align:right;font-size:.85rem">${stock != null ? stock + '개' : '-'}</td>
      <td class="ob-excel-result">${isExisting ? '<span class="ob-excel-badge" style="background:#e5e7eb;color:#6b7280">기존</span>' : obExcelResultHtml(r, idx)}</td>
      <td><input class="ob-excel-inp" data-f="notes" value="${escHtml(r.notes)}" placeholder="비고"${isExisting ? ' disabled' : ''} /></td>
    </tr>`;
  });
  tbody.innerHTML = html;

  // 추가 등록 버튼 표시/숨김
  const addNewBtn = document.getElementById('btn-ob-excel-add-new');
  if (addNewBtn) {
    const showAddNew = _obExcelAppendMode && _obEditOrderId
      && _obExcelRows.some(r => r._isExisting) && _obExcelRows.some(r => !r._isExisting);
    addNewBtn.style.display = showAddNew ? '' : 'none';
  }

  obUpdateExcelSummary();
  document.getElementById('ob-excel-preview')?.classList.remove('hidden');
  ibInitDualScroll(
    document.getElementById('ob-excel-table-wrap'),
    document.getElementById('ob-excel-tbl-scroll-top')
  );
}

// ── 특정 행 재체크 (DOM 입력값 읽어 상태 갱신) ─
window.obExcelReCheckRow = function(idx) {
  const r  = _obExcelRows[idx];
  if (!r) return;
  const tr = document.querySelector(`#ob-excel-tbody tr[data-ob-excel-idx="${idx}"]`);
  if (tr) {
    tr.querySelectorAll('.ob-excel-inp[data-f]').forEach(el => {
      const f = el.dataset.f;
      if (el.tagName === 'SELECT') {
        r[f] = el.value;
      } else if (f === 'quantity' || f === 'sale_price') {
        r[f] = el.value === '' ? null : Number(el.value);
      } else {
        r[f] = el.value;
      }
    });
  }
  obCheckRowStatus(r);
  if (!tr) return;

  tr.className = r._status === 'ok' ? 'ob-excel-ok' : r._status === 'insufficient' ? 'ob-excel-warn' : 'ob-excel-bad';

  const total = (r.quantity > 0 && r.sale_price >= 0) ? r.quantity * r.sale_price : null;
  const totalCell = tr.querySelector('.ob-excel-total');
  if (totalCell) totalCell.textContent = total != null ? total.toLocaleString() + '원' : '-';

  const stockCell = tr.querySelector('.ob-excel-stock');
  if (stockCell) stockCell.textContent = r._stock ? r._stock.current_stock + '개' : '-';

  const resultCell = tr.querySelector('.ob-excel-result');
  if (resultCell) resultCell.innerHTML = obExcelResultHtml(r, idx);

  tr.querySelectorAll('.ob-excel-inp[data-f]').forEach(el => {
    const f = el.dataset.f;
    if (el.tagName !== 'SELECT') el.classList.toggle('ob-excel-err', r._errFields.includes(f));
  });

  obUpdateExcelSummary();
};

// ── 요약 & 버튼 상태 갱신 ─────────────────────
function obUpdateExcelSummary() {
  const okRows  = _obExcelRows.filter(r => r._status === 'ok');
  const errRows = _obExcelRows.filter(r => r._status !== 'ok');
  const total   = okRows.reduce((s, r) => s + (r.quantity || 0) * (r.sale_price || 0), 0);

  const sumEl = document.getElementById('ob-excel-summary');
  if (sumEl) {
    sumEl.textContent = `정상 ${okRows.length}건 / 오류 ${errRows.length}건 | 합계 ${total.toLocaleString()}원`;
    sumEl.style.color = errRows.length > 0 ? 'var(--danger,#e03131)' : '';
  }
  const btnAll   = document.getElementById('btn-ob-excel-save-all');
  const btnValid = document.getElementById('btn-ob-excel-save-valid');
  if (btnAll)   btnAll.disabled   = errRows.length > 0 || okRows.length === 0;
  if (btnValid) btnValid.disabled = okRows.length === 0;
}

// ── 엑셀 저장 ────────────────────────────────
async function obExcelSave(onlyValid) {
  const date = document.getElementById('ob-date')?.value?.trim();
  if (!date) { toast('출고일을 선택하세요.', 'error'); return; }

  const vendorInput = document.getElementById('ob-vendor-input')?.value?.trim() || '';
  const vendorIdVal = document.getElementById('ob-vendor-id')?.value?.trim()    || '';
  if (!vendorInput) {
    toast('거래처명을 입력하세요.', 'error');
    document.getElementById('ob-vendor-input')?.focus();
    return;
  }

  const validRows = _obExcelRows.filter(r => r._status === 'ok');
  const rows = onlyValid ? validRows : _obExcelRows;
  if (!rows.length) { toast('등록할 정상 항목이 없습니다.', 'error'); return; }

  if (onlyValid && _obExcelRows.some(r => r._status !== 'ok')) {
    const errCount = _obExcelRows.filter(r => r._status !== 'ok').length;
    const ok = confirm(`정상 ${validRows.length}건 등록합니다.\n오류 ${errCount}건은 제외됩니다.\n진행하시겠습니까?`);
    if (!ok) return;
  }

  const items = rows.map(r => ({
    category:       r.category      || null,
    manufacturer:   r.manufacturer  || '',
    model_name:     r.model_name,
    spec:           r.spec          || '',
    condition_type: r.condition_type || 'normal',
    quantity:       r.quantity,
    sale_price:     r.sale_price    || 0,
    notes:          r.notes         || null,
  }));

  const btnValid = document.getElementById('btn-ob-excel-save-valid');
  const btnAll   = document.getElementById('btn-ob-excel-save-all');
  if (btnValid) btnValid.disabled = true;
  if (btnAll)   btnAll.disabled   = true;
  try {
    const body = {
      order_date:      date,
      sales_vendor_id: vendorIdVal || null,
      vendor_name:     vendorInput || null,
      tax_type:        _obTaxType,
      notes:           document.getElementById('ob-notes')?.value?.trim() || null,
      items,
    };
    if (_obEditOrderId) {
      await API.put(`/outbound/${_obEditOrderId}`, body);
      toast('출고 정보가 수정되었습니다.', 'success');
    } else {
      await API.post('/outbound', body);
      const excluded = _obExcelRows.length - rows.length;
      toast(excluded > 0
        ? `출고가 등록되었습니다. (성공 ${rows.length}건 / 제외 ${excluded}건)`
        : `출고가 등록되었습니다. (${rows.length}건)`, 'success');
    }
    _obInventory = [];
    _obExcelRows = [];
    await loadOutboundList();
    obShowSubpage('list');
    loadInventory();
  } catch (err) { toast(err.message, 'error'); }
  finally {
    if (btnValid) btnValid.disabled = false;
    if (btnAll)   btnAll.disabled   = false;
    obUpdateExcelSummary();
  }
}

// ── 저장 ─────────────────────────────────────
async function obSave() {
  const date = document.getElementById('ob-date')?.value?.trim();
  if (!date) { toast('출고일을 선택하세요.', 'error'); return; }

  const vendorInput = document.getElementById('ob-vendor-input')?.value?.trim() || '';
  const vendorIdVal = document.getElementById('ob-vendor-id')?.value?.trim()    || '';
  const notes       = document.getElementById('ob-notes')?.value?.trim()        || '';

  if (!vendorInput) {
    toast('거래처명을 입력하세요.', 'error');
    document.getElementById('ob-vendor-input')?.focus();
    return;
  }

  // 항목 수집
  const itemRows = Array.from(document.querySelectorAll('#ob-items-tbody tr'));
  const items = [];
  for (const row of itemRows) {
    const mfr   = row.querySelector('.ob-inp-mfr')?.value?.trim()   || '';
    const model = row.querySelector('.ob-inp-model')?.value?.trim() || '';
    const qty   = Number(row.querySelector('.ob-inp-qty')?.value)   || 0;
    if (!mfr && !model && !qty) continue; // 빈 행 무시
    if (!mfr || !model || qty < 1) {
      toast('각 항목의 브랜드, 모델명, 수량(1 이상)을 입력하세요.', 'error'); return;
    }
    items.push({
      category:       row.querySelector('.ob-inp-category')?.value?.trim()  || null,
      manufacturer:   mfr,
      model_name:     model,
      spec:           row.querySelector('.ob-inp-spec')?.value?.trim()      || '',
      condition_type: row.querySelector('.ob-inp-condition')?.value         || 'normal',
      quantity:       qty,
      sale_price:     Number(row.querySelector('.ob-inp-price')?.value)     || 0,
      notes:          row.querySelector('.ob-inp-notes')?.value?.trim()     || null,
    });
  }
  if (!items.length) { toast('출고 항목을 1개 이상 입력하세요.', 'error'); return; }

  const doSave = async (vendorId, vendorName) => {
    const body = {
      order_date:      date,
      sales_vendor_id: vendorId   || null,
      vendor_name:     vendorName || null,
      tax_type:        _obTaxType,
      notes:           notes || null,
      items,
    };

    const btn = document.getElementById('btn-ob-save');
    if (btn) btn.disabled = true;
    try {
      if (_obEditOrderId) {
        await API.put(`/outbound/${_obEditOrderId}`, body);
        toast('출고 정보가 수정되었습니다.', 'success');
      } else {
        await API.post('/outbound', body);
        toast('출고가 등록되었습니다.', 'success');
      }
      _obInventory = [];
      await loadOutboundList();
      obShowSubpage('list');
      loadInventory();
    } catch (err) { toast(err.message, 'error'); }
    finally { if (btn) btn.disabled = false; }
  };

  // 거래처 처리 — 신규등록은 버튼으로 사전 등록하므로 여기선 단순 분기
  await doSave(vendorIdVal || null, vendorInput || null);
}

// ── 삭제 ─────────────────────────────────────
async function obDelete() {
  if (!_obCurrentOrder) return;
  const total = _obCurrentOrder.item_count || 0;
  const ok = await confirmDialog(
    `출고 주문(${_obCurrentOrder.order_date}, ${total}개 항목)을 삭제하시겠습니까?\n삭제 시 재고가 복구됩니다.`
  );
  if (!ok) return;
  try {
    await API.del(`/outbound/${_obCurrentOrder.id}`);
    toast('출고 내역이 삭제되었습니다.', 'success');
    _obInventory = [];
    await loadOutboundList();
    obShowSubpage('list');
    loadInventory();
  } catch (err) { toast(err.message, 'error'); }
}

// ══════════════════════════════════════════════
//  거래명세서
// ══════════════════════════════════════════════

function obStatementHtml(order, company, vendorInfo) {
  const taxLabel    = order.tax_type === '10' ? '10%' : '없음';
  const supplyTotal = (order.items || []).reduce((s, it) => s + it.quantity * it.sale_price, 0);
  const taxTotal    = (order.items || []).reduce((s, it) => s + (it.tax_amount || 0), 0);
  const grandTotal  = supplyTotal + taxTotal;

  const rows = (order.items || []).map((it, i) => `
    <tr>
      <td style="text-align:center">${i + 1}</td>
      <td>${escHtml(it.category || '-')}</td>
      <td>${escHtml(it.manufacturer)} ${escHtml(it.model_name)}</td>
      <td>${escHtml(it.spec || '-')}</td>
      <td style="text-align:right">${it.quantity}</td>
      <td style="text-align:right">${Number(it.sale_price).toLocaleString()}</td>
      <td style="text-align:right">${Number(it.tax_amount).toLocaleString()}</td>
      <td style="text-align:right">${Number(it.total_price).toLocaleString()}</td>
    </tr>
  `).join('');

  return `<div class="stmt-wrap">
    <h2 class="stmt-title">거래명세서</h2>
    <div class="stmt-meta">출고일자: ${order.order_date}</div>
    <div class="stmt-parties">
      <div class="stmt-party">
        <div class="stmt-party-title">공급자</div>
        <table class="stmt-party-tbl">
          <tr><td>상호</td><td>${escHtml(company?.company_name || '')}</td></tr>
          <tr><td>사업자번호</td><td>${fmtBizNum(company?.business_number) || ''}</td></tr>
          <tr><td>주소</td><td>${escHtml(company?.address || '')}</td></tr>
          <tr><td>대표자</td><td>${escHtml(company?.representative || '')}</td></tr>
          <tr><td>전화번호</td><td>${fmtPhone(company?.phone) || ''}</td></tr>
          ${company?.bank_name || company?.account_number ? `<tr><td>은행</td><td>${escHtml(company?.bank_name || '')}</td></tr>` : ''}
          ${company?.account_number ? `<tr><td>계좌번호</td><td>${escHtml(company?.account_number || '')}${company?.account_holder ? ` (${escHtml(company.account_holder)})` : ''}</td></tr>` : ''}
        </table>
      </div>
      <div class="stmt-party">
        <div class="stmt-party-title">공급받는자</div>
        <table class="stmt-party-tbl">
          <tr><td>상호</td><td>${escHtml(vendorInfo?.company_name || vendorInfo?.vendor_name || order.vendor_name || '')}</td></tr>
          ${vendorInfo?.business_number ? `<tr><td>사업자번호</td><td>${fmtBizNum(vendorInfo.business_number)}</td></tr>` : ''}
          ${(vendorInfo?.registered_address || vendorInfo?.address) ? `<tr><td>주소</td><td>${escHtml(vendorInfo.registered_address || vendorInfo.address)}</td></tr>` : ''}
          ${vendorInfo?.phone ? `<tr><td>전화번호</td><td>${fmtPhone(vendorInfo.phone)}</td></tr>` : ''}
          ${vendorInfo?.name ? `<tr><td>이름</td><td>${escHtml(vendorInfo.name)}</td></tr>` : ''}
        </table>
      </div>
    </div>
    <table class="stmt-items-tbl">
      <thead>
        <tr><th>번호</th><th>구분</th><th>품목</th><th>스펙</th><th>수량</th><th>단가</th><th>세금</th><th>합계</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="7" style="text-align:right;font-weight:700">공급가액</td>
          <td style="text-align:right;font-weight:700">${supplyTotal.toLocaleString()}원</td>
        </tr>
        <tr>
          <td colspan="7" style="text-align:right">세액 (${taxLabel})</td>
          <td style="text-align:right">${taxTotal.toLocaleString()}원</td>
        </tr>
        <tr class="stmt-grand">
          <td colspan="7" style="text-align:right;font-weight:800">합계금액</td>
          <td style="text-align:right;font-weight:800">${grandTotal.toLocaleString()}원</td>
        </tr>
      </tfoot>
    </table>
  </div>`;
}

async function obShowStatement(order) {
  const [company, vendorInfo] = await Promise.all([
    API.get('/company').catch(() => null),
    order.sales_vendor_id ? API.get(`/sales-vendors/${order.sales_vendor_id}`).catch(() => null) : Promise.resolve(null),
  ]);
  if (!company || !company.company_name) {
    toast('회사 정보를 먼저 등록해주세요.', 'error');
    const go = confirm('회사 정보 페이지로 이동하시겠습니까?');
    if (go) showPage('company');
    return;
  }
  const content = document.getElementById('ob-statement-content');
  if (content) content.innerHTML = obStatementHtml(order, company, vendorInfo);
  document.getElementById('modal-ob-statement')?.classList.remove('hidden');
}

window.obPrintStatement = async function() {
  const order = _obCurrentOrder;
  if (!order) return;
  const [company, vendorInfo] = await Promise.all([
    API.get('/company').catch(() => null),
    order.sales_vendor_id ? API.get(`/sales-vendors/${order.sales_vendor_id}`).catch(() => null) : Promise.resolve(null),
  ]);
  const html = obStatementHtml(order, company, vendorInfo);
  const win = window.open('', '_blank', 'width=820,height=700');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>거래명세서</title>
  <style>
    body { font-family: 'Malgun Gothic', sans-serif; font-size: 13px; padding: 20px; }
    .stmt-wrap { max-width: 760px; margin: 0 auto; }
    .stmt-title { text-align: center; font-size: 22px; font-weight: 800; margin-bottom: 8px; }
    .stmt-meta { text-align: center; margin-bottom: 16px; color: #555; }
    .stmt-parties { display: flex; gap: 16px; margin-bottom: 16px; }
    .stmt-party { flex: 1; border: 1px solid #bbb; border-radius: 4px; padding: 8px; }
    .stmt-party-title { font-weight: 700; margin-bottom: 6px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    .stmt-party-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
    .stmt-party-tbl td { padding: 2px 4px; }
    .stmt-party-tbl td:first-child { color: #666; width: 80px; }
    .stmt-items-tbl { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .stmt-items-tbl th, .stmt-items-tbl td { border: 1px solid #bbb; padding: 5px 8px; }
    .stmt-items-tbl th { background: #f4f4f4; font-weight: 700; text-align: center; }
    .stmt-grand td { background: #f8f8f8; }
    @media print { body { padding: 0; } }
  </style></head><body>${html}<script>window.onload=()=>window.print();<\/script></body></html>`);
  win.document.close();
};

// ══════════════════════════════════════════════
//  이벤트 바인딩
// ══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {

  // 엑셀 탭 전환
  document.querySelectorAll('[data-ob-form-tab]').forEach(btn => {
    btn.addEventListener('click', () => obSwitchFormTab(btn.dataset.obFormTab));
  });

  // 엑셀 파일 선택
  document.getElementById('ob-excel-file')?.addEventListener('change', function () {
    const file = this.files?.[0];
    if (!file) return;
    this.value = '';
    if (_obEditOrderId && _obEditItems.length > 0) {
      const existingCount = _obExcelRows.length || _obEditItems.length;
      obShowUploadModeModal(file, existingCount);
    } else {
      _obExcelAppendMode = false;
      obLoadExcelFile(file);
    }
  });

  // 양식 다운로드
  document.getElementById('btn-ob-template')?.addEventListener('click', obDownloadTemplate);

  // 엑셀 [추가 등록] (수정+추가 업로드 모드: 새 품목만 저장)
  document.getElementById('btn-ob-excel-add-new')?.addEventListener('click', async () => {
    const date = document.getElementById('ob-date')?.value?.trim();
    if (!date) { toast('출고일을 선택하세요.', 'error'); return; }
    const vendorInput = document.getElementById('ob-vendor-input')?.value?.trim() || '';
    if (!vendorInput) { toast('거래처명을 입력하세요.', 'error'); return; }
    const vendorIdVal = document.getElementById('ob-vendor-id')?.value?.trim() || '';

    const newRows = _obExcelRows.filter(r => !r._isExisting && r._status === 'ok');
    if (!newRows.length) { toast('추가할 정상 항목이 없습니다.', 'error'); return; }

    const existingItems = _obEditItems.map(item => ({
      category:       item.category      || null,
      manufacturer:   item.manufacturer  || '',
      model_name:     item.model_name,
      spec:           item.spec          || '',
      condition_type: item.condition_type || 'normal',
      quantity:       item.quantity,
      sale_price:     item.sale_price    || 0,
      notes:          item.notes         || null,
    }));
    const newItems = newRows.map(r => ({
      category:       r.category      || null,
      manufacturer:   r.manufacturer  || '',
      model_name:     r.model_name,
      spec:           r.spec          || '',
      condition_type: r.condition_type || 'normal',
      quantity:       r.quantity,
      sale_price:     r.sale_price    || 0,
      notes:          r.notes         || null,
    }));
    const body = {
      order_date:      date,
      sales_vendor_id: vendorIdVal || null,
      vendor_name:     vendorInput || null,
      tax_type:        _obTaxType,
      notes:           document.getElementById('ob-notes')?.value?.trim() || null,
      items:           [...existingItems, ...newItems],
    };
    const btn = document.getElementById('btn-ob-excel-add-new');
    if (btn) btn.disabled = true;
    try {
      await API.put(`/outbound/${_obEditOrderId}`, body);
      toast(`${newItems.length}개 품목이 추가 등록되었습니다.`, 'success');
      _obInventory = []; _obExcelRows = []; _obEditItems = []; _obExcelAppendMode = false;
      await loadOutboundList();
      obShowSubpage('list');
      loadInventory();
    } catch (err) { toast(err.message, 'error'); }
    finally { if (btn) btn.disabled = false; }
  });

  // 엑셀 [정상 행만 등록] / [전체 등록]
  document.getElementById('btn-ob-excel-save-valid')?.addEventListener('click', () => obExcelSave(true));
  document.getElementById('btn-ob-excel-save-all')?.addEventListener('click',   () => obExcelSave(false));

  // 엑셀 미리보기 인라인 편집 (이벤트 위임)
  document.getElementById('ob-excel-tbody')?.addEventListener('input', e => {
    const inp = e.target;
    if (!inp.classList.contains('ob-excel-inp') || !inp.dataset.f) return;
    const tr  = inp.closest('tr[data-ob-excel-idx]');
    if (!tr) return;
    const idx = Number(tr.dataset.obExcelIdx);
    const r   = _obExcelRows[idx];
    if (!r) return;
    const f = inp.dataset.f;
    if (f === 'quantity' || f === 'sale_price') {
      r[f] = inp.value === '' ? null : Number(inp.value);
    } else {
      r[f] = inp.value;
    }
    obExcelReCheckRow(idx);
  });
  document.getElementById('ob-excel-tbody')?.addEventListener('change', e => {
    const sel = e.target;
    if (sel.tagName !== 'SELECT' || !sel.dataset.f) return;
    const tr  = sel.closest('tr[data-ob-excel-idx]');
    if (!tr) return;
    const idx = Number(tr.dataset.obExcelIdx);
    const r   = _obExcelRows[idx];
    if (!r) return;
    r[sel.dataset.f] = sel.value;
    obExcelReCheckRow(idx);
  });

  // + 출고 등록
  document.getElementById('btn-ob-new')?.addEventListener('click', () => obShowForm());

  // 목록으로
  document.getElementById('btn-ob-back-form')?.addEventListener('click', () => {
    document.getElementById('ob-model-dropdown')?.classList.add('hidden');
    obShowSubpage('list');
  });
  document.getElementById('btn-ob-back-detail')?.addEventListener('click', () => { obShowSubpage('list'); obApplyFilter(); });

  // 저장
  document.getElementById('btn-ob-save')?.addEventListener('click', obSave);

  // 수정 / 삭제 / 거래명세서
  document.getElementById('btn-ob-edit')?.addEventListener('click', () => obShowForm(_obCurrentOrder?.id));
  document.getElementById('btn-ob-delete')?.addEventListener('click', obDelete);
  document.getElementById('btn-ob-statement')?.addEventListener('click', () => {
    if (_obCurrentOrder) obShowStatement(_obCurrentOrder);
  });

  // 행 추가
  document.getElementById('btn-ob-add-row')?.addEventListener('click', () => {
    obAddRow();
  });

  // 세금 토글
  document.querySelectorAll('.ob-tax-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _obTaxType = btn.dataset.tax;
      obUpdateTaxToggle();
    });
  });

  // 날짜 빠른 선택
  document.querySelectorAll('[data-ob-range]').forEach(btn => {
    btn.addEventListener('click', () => obSetQuickRange(btn.dataset.obRange));
  });

  // 검색 디바운스
  document.getElementById('ob-search')?.addEventListener('input', () => {
    clearTimeout(_obSearchTimer);
    _obSearchTimer = setTimeout(obApplyFilter, 250);
  });

  // 날짜 범위 flatpickr
  if (typeof flatpickr !== 'undefined') {
    const obToday = new Date().toISOString().slice(0, 10);
    _obFpStart = flatpickr('#ob-date-start', {
      locale: 'ko', dateFormat: 'Y-m-d', defaultDate: obToday, onChange: () => obApplyFilter(),
    });
    _obFpEnd = flatpickr('#ob-date-end', {
      locale: 'ko', dateFormat: 'Y-m-d', defaultDate: obToday, onChange: () => obApplyFilter(),
    });
    obApplyFilter();
  }

  // 거래처 인라인 검색
  let _obVendorTimer = null;
  const obVendorInp = document.getElementById('ob-vendor-input');
  if (obVendorInp) {
    obVendorInp.addEventListener('focus', () => {
      obFilterVendors(obVendorInp.value.trim());
    });
    obVendorInp.addEventListener('input', (e) => {
      _obVendorSelected = false;
      document.getElementById('ob-vendor-id').value = '';
      _obVendorId = null;
      clearTimeout(_obVendorTimer);
      _obVendorTimer = setTimeout(() => obFilterVendors(e.target.value.trim()), 300);
    });
    obVendorInp.addEventListener('blur', () => {
      setTimeout(() => document.getElementById('ob-vendor-dropdown')?.classList.add('hidden'), 200);
    });
    obVendorInp.addEventListener('keydown', e => {
      if (e.key === 'Escape') document.getElementById('ob-vendor-dropdown')?.classList.add('hidden');
    });
  }

  // 전역 클릭으로 모델 드롭다운 닫기
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('ob-model-dropdown');
    if (dd && !dd.contains(e.target) && !e.target.classList.contains('ob-inp-model')) {
      dd.classList.add('hidden');
    }
  });

});
