'use strict';

// ══════════════════════════════════════════════
//  휴지통 관리
// ══════════════════════════════════════════════

let _trashItems  = [];   // 서버에서 받은 원본
let _trashTab    = 'all';
let _trashSearch = '';
let _trashFrom   = '';
let _trashTo     = '';

function trEsc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function trFmtDate(str) {
  if (!str) return '-';
  return str.slice(0, 16).replace('T', ' ');
}
function trFmtWon(v) {
  if (v == null || v === '') return '-';
  return Math.round(Number(v)).toLocaleString('ko-KR') + '원';
}

function trDaysLeft(autoDeleteAt) {
  if (!autoDeleteAt) return '';
  const diff = new Date(autoDeleteAt) - new Date();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  if (days <= 0)  return '<span class="tr-expire danger">만료됨</span>';
  if (days <= 7)  return `<span class="tr-expire danger">⚠️ ${days}일 후 자동삭제</span>`;
  if (days <= 14) return `<span class="tr-expire warn">${days}일 남음</span>`;
  return `<span class="tr-expire muted">${days}일 남음</span>`;
}

// ── 데이터 로드 ──────────────────────────────────────
async function loadTrash() {
  try {
    const qs = new URLSearchParams();
    if (_trashFrom) qs.set('from', _trashFrom);
    if (_trashTo)   qs.set('to',   _trashTo);
    if (_trashTab !== 'all') qs.set('type', _trashTab);

    _trashItems = await API.get(`/trash?${qs}`);
    trRender();
  } catch (err) {
    document.getElementById('trash-tbody').innerHTML =
      `<tr><td colspan="6" class="empty">${trEsc(err.message)}</td></tr>`;
  }
}

// ── 렌더링 ───────────────────────────────────────────
function trRender() {
  const tbody = document.getElementById('trash-tbody');
  const q = _trashSearch.toLowerCase();

  const filtered = q ? _trashItems.filter(t =>
    (t.display_name  || '').toLowerCase().includes(q) ||
    (t.summary_text  || '').toLowerCase().includes(q) ||
    (t.deleted_by_name || '').toLowerCase().includes(q) ||
    (t.type_label    || '').toLowerCase().includes(q)
  ) : _trashItems;

  const countEl = document.getElementById('trash-count');
  if (countEl) countEl.textContent = `총 ${filtered.length.toLocaleString()}건`;

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">휴지통이 비어있습니다.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(t => `
    <tr class="tr-row" onclick="trShowDetail('${trEsc(t.id)}')" style="cursor:pointer">
      <td><span class="trash-type-badge">${trEsc(t.type_icon)} ${trEsc(t.type_label)}</span></td>
      <td>
        <div class="tr-summary-name">${trEsc(t.display_name)}</div>
        <div class="tr-summary-sub">${trEsc(t.summary_text || '')}</div>
      </td>
      <td>${trEsc(t.deleted_by_name || '-')}</td>
      <td class="cell-date">${trFmtDate(t.deleted_at)}</td>
      <td>${trDaysLeft(t.auto_delete_at)}<br><span style="font-size:.75rem;color:var(--gray-400)">${trFmtDate(t.auto_delete_at)}</span></td>
      <td class="cell-action" style="white-space:nowrap" onclick="event.stopPropagation()">
        <button class="btn btn-xs btn-ghost" onclick="trashRestore('${trEsc(t.id)}')">복구</button>
        <button class="btn btn-xs btn-ghost" style="color:var(--danger)" onclick="trashDelete('${trEsc(t.id)}','${trEsc(t.display_name)}')">영구삭제</button>
      </td>
    </tr>
  `).join('');
}

// ── 상세 팝업 ────────────────────────────────────────
async function trShowDetail(id) {
  let detail;
  try {
    detail = await API.get(`/trash/${id}/detail`);
  } catch (err) {
    toast(err.message || '상세 조회 실패', 'error');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '1200';

  const title = `${detail.type_icon} ${detail.type_label} 삭제 내용`;
  const expireHtml = trDaysLeft(detail.auto_delete_at);

  overlay.innerHTML = `
    <div class="modal" style="max-width:700px;width:96vw">
      <div class="modal-hd">
        <h3>${trEsc(title)}</h3>
        <button class="btn-close" id="tr-detail-close">✕</button>
      </div>
      <div class="modal-bd tr-detail-bd">
        ${trBuildDetailMeta(detail)}
        <hr class="tr-sep" />
        ${trBuildDetailBody(detail)}
        <hr class="tr-sep" />
        <div class="tr-expire-row">
          <span style="font-size:.82rem;color:var(--gray-500)">자동삭제 예정:</span>
          ${expireHtml}
          <span style="font-size:.78rem;color:var(--gray-400);margin-left:.5rem">${trFmtDate(detail.auto_delete_at)}</span>
        </div>
      </div>
      <div class="modal-ft" style="gap:.5rem">
        <button class="btn btn-ghost" id="tr-detail-close2">닫기</button>
        <div style="flex:1"></div>
        <button class="btn btn-ghost" style="color:var(--danger)" id="tr-detail-delete">영구삭제</button>
        <button class="btn btn-primary" id="tr-detail-restore">복구</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#tr-detail-close').onclick  = close;
  overlay.querySelector('#tr-detail-close2').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  // 복구 / 영구삭제 — 팝업 내 버튼
  const item = _trashItems.find(t => t.id === id);
  const displayName = item?.display_name || detail.type_label;

  overlay.querySelector('#tr-detail-restore').onclick = async () => {
    if (!confirm('이 항목을 복구하시겠습니까?')) return;
    try {
      await API.post(`/trash/${id}/restore`, {});
      toast('복구되었습니다.', 'success');
      close();
      await loadTrash();
    } catch (err) { toast(err.message, 'error'); }
  };

  overlay.querySelector('#tr-detail-delete').onclick = async () => {
    if (!confirm(`"${displayName}" 을(를) 영구 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      await API.del(`/trash/${id}`);
      toast('영구 삭제되었습니다.', 'success');
      close();
      await loadTrash();
    } catch (err) { toast(err.message, 'error'); }
  };
}

function trBuildDetailMeta(d) {
  return `
    <table class="tbl tr-meta-tbl">
      <tbody>
        <tr><th style="width:90px">유형</th><td>${trEsc(d.type_icon + ' ' + d.type_label)}</td></tr>
        <tr><th>삭제일시</th><td>${trEsc(trFmtDate(d.deleted_at))}</td></tr>
        <tr><th>삭제자</th><td>${trEsc(d.deleted_by_name || '-')}</td></tr>
      </tbody>
    </table>
  `;
}

function trBuildDetailBody(d) {
  if (d.table_name === 'inbound_orders') {
    return trBodyInbound(d);
  }
  if (d.table_name === 'outbound_orders') {
    return trBodyOutbound(d);
  }
  if (d.table_name === 'return_orders') {
    return d.type_detail === '교환' ? trBodyExchange(d) : trBodyReturn(d);
  }
  if (d.table_name === 'purchase_vendors' || d.table_name === 'sales_vendors') {
    return trBodyVendor(d);
  }
  if (d.table_name === 'users') {
    return trBodyUser(d);
  }
  return '<p class="empty">상세 정보를 표시할 수 없습니다.</p>';
}

// ── 매입 상세 ────────────────────────────────────────
function trBodyInbound(d) {
  const IB_COND = { normal: '정상', defective: '불량', disposal: '폐기' };
  const rows = (d.items || []).map(it => `
    <tr>
      <td>${trEsc(it.category || '-')}</td>
      <td>${trEsc(it.manufacturer)}</td>
      <td>${trEsc(it.model_name)}${it.spec ? `<span class="sl-spec-tag">${trEsc(it.spec)}</span>` : ''}</td>
      <td style="text-align:right">${it.quantity}개</td>
      <td style="text-align:right">${trFmtWon(it.purchase_price)}</td>
      <td style="text-align:right">${trFmtWon(it.total_price)}</td>
      <td>${trEsc(it.status)}</td>
    </tr>
  `).join('');

  return `
    <table class="tbl tr-meta-tbl" style="margin-bottom:.75rem">
      <tbody>
        <tr><th style="width:90px">입고날짜</th><td>${trEsc(d.order_date || '-')}</td></tr>
        <tr><th>거래처</th><td>${trEsc(d.vendor_name)}</td></tr>
        <tr><th>합계금액</th><td><strong>${trFmtWon(d.total)}</strong></td></tr>
        ${d.notes ? `<tr><th>비고</th><td>${trEsc(d.notes)}</td></tr>` : ''}
      </tbody>
    </table>
    <div class="tr-items-title">품목 목록 (${(d.items||[]).length}건)</div>
    ${rows ? `
    <div class="table-wrap" style="max-height:260px;overflow-y:auto">
      <table class="tbl tr-items-tbl">
        <thead><tr><th>구분</th><th>브랜드</th><th>모델명</th><th>수량</th><th>매입가</th><th>합계</th><th>상태</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : '<p class="empty" style="padding:.5rem">품목 없음</p>'}
  `;
}

// ── 출고 상세 ────────────────────────────────────────
function trBodyOutbound(d) {
  const rows = (d.items || []).map(it => `
    <tr>
      <td>${trEsc(it.category || '-')}</td>
      <td>${trEsc(it.manufacturer)}</td>
      <td>${trEsc(it.model_name)}${it.spec ? `<span class="sl-spec-tag">${trEsc(it.spec)}</span>` : ''}</td>
      <td style="text-align:right">${it.quantity}개</td>
      <td style="text-align:right">${trFmtWon(it.sale_price)}</td>
      <td style="text-align:right">${trFmtWon(it.total_price)}</td>
    </tr>
  `).join('');

  return `
    <table class="tbl tr-meta-tbl" style="margin-bottom:.75rem">
      <tbody>
        <tr><th style="width:90px">출고날짜</th><td>${trEsc(d.order_date || '-')}</td></tr>
        <tr><th>거래처</th><td>${trEsc(d.vendor_name)}</td></tr>
        <tr><th>부가세</th><td>${trEsc(d.tax_type || '-')}</td></tr>
        <tr><th>합계금액</th><td><strong>${trFmtWon(d.total)}</strong></td></tr>
        ${d.notes ? `<tr><th>비고</th><td>${trEsc(d.notes)}</td></tr>` : ''}
      </tbody>
    </table>
    <div class="tr-items-title">품목 목록 (${(d.items||[]).length}건)</div>
    ${rows ? `
    <div class="table-wrap" style="max-height:260px;overflow-y:auto">
      <table class="tbl tr-items-tbl">
        <thead><tr><th>구분</th><th>브랜드</th><th>모델명</th><th>수량</th><th>판매가</th><th>합계</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : '<p class="empty" style="padding:.5rem">품목 없음</p>'}
  `;
}

// ── 반품 상세 ────────────────────────────────────────
function trBodyReturn(d) {
  const rows = (d.ret_items || []).map(it => `
    <tr>
      <td>${trEsc(it.category || '-')}</td>
      <td>${trEsc(it.manufacturer)}</td>
      <td>${trEsc(it.model_name)}${it.spec ? `<span class="sl-spec-tag">${trEsc(it.spec)}</span>` : ''}</td>
      <td style="text-align:right">${it.quantity}개</td>
      <td>${trEsc(it.condition || '-')}</td>
    </tr>
  `).join('');

  return `
    <table class="tbl tr-meta-tbl" style="margin-bottom:.75rem">
      <tbody>
        <tr><th style="width:90px">접수일</th><td>${trEsc(d.received_at || '-')}</td></tr>
        <tr><th>거래처</th><td>${trEsc(d.vendor_name)}</td></tr>
        <tr><th>반품사유</th><td>${trEsc(d.reason || '-')}</td></tr>
        <tr><th>상태</th><td>${trEsc(d.status || '-')}</td></tr>
        ${d.notes ? `<tr><th>비고</th><td>${trEsc(d.notes)}</td></tr>` : ''}
      </tbody>
    </table>
    <div class="tr-items-title">반품 품목 (${(d.ret_items||[]).length}건)</div>
    ${rows ? `
    <div class="table-wrap" style="max-height:220px;overflow-y:auto">
      <table class="tbl tr-items-tbl">
        <thead><tr><th>구분</th><th>브랜드</th><th>모델명</th><th>수량</th><th>상태</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : '<p class="empty" style="padding:.5rem">품목 없음</p>'}
  `;
}

// ── 교환 상세 ────────────────────────────────────────
function trBodyExchange(d) {
  const retRows = (d.ret_items || []).map(it => `
    <tr>
      <td>${trEsc(it.category || '-')}</td>
      <td>${trEsc(it.manufacturer)}</td>
      <td>${trEsc(it.model_name)}${it.spec ? `<span class="sl-spec-tag">${trEsc(it.spec)}</span>` : ''}</td>
      <td style="text-align:right">${it.quantity}개</td>
    </tr>
  `).join('');

  const exchRows = (d.exch_items || []).map(it => `
    <tr>
      <td>${trEsc(it.category || '-')}</td>
      <td>${trEsc(it.manufacturer)}</td>
      <td>${trEsc(it.model_name)}${it.spec ? `<span class="sl-spec-tag">${trEsc(it.spec)}</span>` : ''}</td>
      <td style="text-align:right">${it.quantity}개</td>
      <td style="text-align:right">${trFmtWon(it.sale_price)}</td>
    </tr>
  `).join('');

  return `
    <table class="tbl tr-meta-tbl" style="margin-bottom:.75rem">
      <tbody>
        <tr><th style="width:90px">접수일</th><td>${trEsc(d.received_at || '-')}</td></tr>
        <tr><th>거래처</th><td>${trEsc(d.vendor_name)}</td></tr>
        <tr><th>교환사유</th><td>${trEsc(d.reason || '-')}</td></tr>
        ${d.notes ? `<tr><th>비고</th><td>${trEsc(d.notes)}</td></tr>` : ''}
      </tbody>
    </table>
    <div class="tr-items-title">반품 품목 (${(d.ret_items||[]).length}건)</div>
    ${retRows ? `
    <div class="table-wrap" style="max-height:180px;overflow-y:auto;margin-bottom:.5rem">
      <table class="tbl tr-items-tbl">
        <thead><tr><th>구분</th><th>브랜드</th><th>모델명</th><th>수량</th></tr></thead>
        <tbody>${retRows}</tbody>
      </table>
    </div>` : '<p class="empty" style="padding:.3rem">품목 없음</p>'}
    <div class="tr-items-title">교환 출고 품목 (${(d.exch_items||[]).length}건)</div>
    ${exchRows ? `
    <div class="table-wrap" style="max-height:180px;overflow-y:auto">
      <table class="tbl tr-items-tbl">
        <thead><tr><th>구분</th><th>브랜드</th><th>모델명</th><th>수량</th><th>판매가</th></tr></thead>
        <tbody>${exchRows}</tbody>
      </table>
    </div>` : '<p class="empty" style="padding:.3rem">품목 없음</p>'}
  `;
}

// ── 거래처 상세 ──────────────────────────────────────
function trBodyVendor(d) {
  const name = d.company_name || d.individual_name || '-';
  return `
    <table class="tbl tr-meta-tbl">
      <tbody>
        <tr><th style="width:90px">유형</th><td>${trEsc(d.vendor_type || '-')}</td></tr>
        <tr><th>상호명</th><td>${trEsc(name)}</td></tr>
        <tr><th>전화번호</th><td>${trEsc(d.phone || '-')}</td></tr>
        <tr><th>주소</th><td>${trEsc(d.address || '-')}</td></tr>
        <tr><th>사업자번호</th><td>${trEsc(d.business_number || '-')}</td></tr>
        ${d.remarks ? `<tr><th>비고</th><td>${trEsc(d.remarks)}</td></tr>` : ''}
      </tbody>
    </table>
  `;
}

// ── 사용자 상세 ──────────────────────────────────────
function trBodyUser(d) {
  return `
    <table class="tbl tr-meta-tbl">
      <tbody>
        <tr><th style="width:90px">이름</th><td>${trEsc(d.name || '-')}</td></tr>
        <tr><th>아이디</th><td>${trEsc(d.username || '-')}</td></tr>
        <tr><th>전화번호</th><td>${trEsc(d.phone || '-')}</td></tr>
        <tr><th>권한</th><td>${trEsc(d.role || '-')}</td></tr>
        <tr><th>가입일</th><td>${trEsc(d.created_at || '-')}</td></tr>
      </tbody>
    </table>
  `;
}

// ── 복구 / 영구삭제 (목록에서 직접) ──────────────────
async function trashRestore(id) {
  if (!confirm('이 항목을 복구하시겠습니까?')) return;
  try {
    await API.post(`/trash/${id}/restore`, {});
    toast('복구되었습니다.', 'success');
    await loadTrash();
  } catch (err) { toast(err.message, 'error'); }
}

async function trashDelete(id, name) {
  if (!confirm(`"${name}" 을(를) 영구 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
  try {
    await API.del(`/trash/${id}`);
    toast('영구 삭제되었습니다.', 'success');
    await loadTrash();
  } catch (err) { toast(err.message, 'error'); }
}

// ── 이벤트 바인딩 ────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // 유형 탭
  document.querySelectorAll('.trash-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.trash-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _trashTab = btn.dataset.trtype;
      loadTrash();
    });
  });

  // 날짜 필터
  document.getElementById('trash-date-from')?.addEventListener('change', e => {
    _trashFrom = e.target.value;
    loadTrash();
  });
  document.getElementById('trash-date-to')?.addEventListener('change', e => {
    _trashTo = e.target.value;
    loadTrash();
  });

  // 실시간 검색
  document.getElementById('trash-search')?.addEventListener('input', function () {
    _trashSearch = this.value;
    trRender();
  });

  // 초기화
  document.getElementById('btn-trash-reset')?.addEventListener('click', () => {
    _trashTab    = 'all';
    _trashSearch = '';
    _trashFrom   = '';
    _trashTo     = '';
    document.getElementById('trash-search').value    = '';
    document.getElementById('trash-date-from').value = '';
    document.getElementById('trash-date-to').value   = '';
    document.querySelectorAll('.trash-tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.trtype === 'all')
    );
    loadTrash();
  });
});
