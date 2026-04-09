'use strict';

// ── 상태 ─────────────────────────────────────────────────────────────────────
let _dbWeeklyChart  = null;
let _dbMonthlyChart = null;
let _dbFpFrom       = null;
let _dbFpTo         = null;

// ── 유틸 ─────────────────────────────────────────────────────────────────────
const dbWon = v => (v == null ? '—' : Math.round(Number(v)).toLocaleString('ko-KR') + '원');
const dbNum = v => (v == null ? '—' : Number(v).toLocaleString('ko-KR'));

function dbTodayStr() {
  return new Date().toISOString().slice(0, 10);
}
function dbWeekStart() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().slice(0, 10);
}
function dbMonthStart() {
  return new Date().toISOString().slice(0, 8) + '01';
}
function dbLastMonthRange() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const start = d.toISOString().slice(0, 10);
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  const end = d.toISOString().slice(0, 10);
  return { start, end };
}

function dbTimeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return '방금 전';
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}시간 전`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}일 전`;
  return dateStr.slice(0, 10);
}

function dbDiffHtml(diff, label) {
  if (diff == null) return '';
  if (diff === 0) return `<span class="db-diff-neutral">— 동일</span>`;
  const cls   = diff > 0 ? 'db-diff-up' : 'db-diff-down';
  const arrow = diff > 0 ? '▲' : '▼';
  const sign  = diff > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${Math.abs(diff).toLocaleString('ko-KR')}원 ${arrow}</span>`;
}

function dbEsc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 메인 로드 함수 ───────────────────────────────────────────────────────────
async function dbLoad() {
  const loading = document.getElementById('db-loading');
  const content = document.getElementById('db-content');
  if (loading) loading.classList.remove('hidden');
  if (content) content.classList.add('hidden');

  // admin-only 행 표시 여부
  const isAdmin  = currentUser?.role === 'admin';
  const isViewer = currentUser?.role === 'viewer';
  document.querySelectorAll('.db-admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });

  try {
    const data = await API.get('/dashboard/summary');
    dbRenderTodayStatus(data.todayStatus, isAdmin);
    dbRenderActivity(data.recentActivity);
    if (!isViewer) {
      dbRenderKpi(data.kpi);
      dbRenderWeeklyChart(data.weeklyChart);
      dbRenderMonthlyChart(data.monthlyChart);
    }
  } catch (err) {
    console.error('[dashboard] load error', err);
    toast('대시보드 로딩 실패: ' + err.message, 'error');
  } finally {
    if (loading) loading.classList.add('hidden');
    if (content) content.classList.remove('hidden');
  }

  // flatpickr 초기화 (editor/admin)
  if (!isViewer) {
    dbInitDatepickers();
  }
}

// ── KPI 카드 렌더 ────────────────────────────────────────────────────────────
function dbRenderKpi(kpi) {
  if (!kpi) return;
  const set = (valId, diffId, val, diff) => {
    const vEl = document.getElementById(valId);
    const dEl = document.getElementById(diffId);
    if (vEl) vEl.textContent  = dbWon(val);
    if (dEl) dEl.innerHTML    = dbDiffHtml(diff);
  };
  set('db-kpi-today-val',   'db-kpi-today-diff',   kpi.today_profit,  kpi.today_profit_diff);
  set('db-kpi-week-val',    'db-kpi-week-diff',     kpi.week_profit,   kpi.week_profit_diff);
  set('db-kpi-mprofit-val', 'db-kpi-mprofit-diff',  kpi.month_profit,  kpi.month_profit_diff);
  set('db-kpi-msales-val',  'db-kpi-msales-diff',   kpi.month_sales,   kpi.month_sales_diff);
}

// ── 이번주 vs 저번주 차트 ────────────────────────────────────────────────────
function dbRenderWeeklyChart(data) {
  const canvas = document.getElementById('db-chart-weekly');
  if (!canvas || !data) return;

  if (_dbWeeklyChart) { _dbWeeklyChart.destroy(); _dbWeeklyChart = null; }

  const labels = ['월', '화', '수', '목', '금', '토', '일'];
  _dbWeeklyChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: '이번주',
          data:  data.thisWeek,
          backgroundColor: 'rgba(59,91,219,0.8)',
          borderRadius: 4,
        },
        {
          label: '저번주',
          data:  data.lastWeek,
          backgroundColor: 'rgba(173,181,189,0.7)',
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString('ko-KR')}원`,
          },
        },
      },
      scales: {
        y: {
          ticks: {
            callback: v => {
              if (Math.abs(v) >= 10000) return (v / 10000).toLocaleString('ko-KR') + '만';
              return v.toLocaleString('ko-KR');
            },
          },
          grid: { color: 'rgba(0,0,0,0.06)' },
        },
        x: { grid: { display: false } },
      },
    },
  });
}

// ── 월별 순수익 라인 차트 ────────────────────────────────────────────────────
function dbRenderMonthlyChart(data) {
  const canvas = document.getElementById('db-chart-monthly');
  if (!canvas || !data) return;

  if (_dbMonthlyChart) { _dbMonthlyChart.destroy(); _dbMonthlyChart = null; }

  const labels  = data.map(d => d.month.slice(5) + '월');
  const profits = data.map(d => d.profit);

  _dbMonthlyChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '순수익',
        data:  profits,
        borderColor:     '#3b5bdb',
        backgroundColor: 'rgba(59,91,219,0.08)',
        pointBackgroundColor: '#3b5bdb',
        pointRadius: 5,
        pointHoverRadius: 7,
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` 순수익: ${ctx.parsed.y.toLocaleString('ko-KR')}원`,
          },
        },
      },
      scales: {
        y: {
          ticks: {
            callback: v => {
              if (Math.abs(v) >= 10000) return (v / 10000).toLocaleString('ko-KR') + '만';
              return v.toLocaleString('ko-KR');
            },
          },
          grid: { color: 'rgba(0,0,0,0.06)' },
        },
        x: { grid: { display: false } },
      },
    },
  });
}

// ── 오늘 현황 렌더 ───────────────────────────────────────────────────────────
function dbRenderTodayStatus(status, isAdmin) {
  if (!status) return;
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val == null ? '—' : dbNum(val);
  };
  set('db-s-inbound',   status.inbound_count);
  set('db-s-outbound',  status.outbound_count);
  set('db-s-return',    status.return_count);
  set('db-s-stock',     status.stock_items);
  set('db-s-defective', status.defective_items);
  set('db-s-pending',   status.pending_purchase);
  if (isAdmin) set('db-s-users', status.pending_users);
}

// ── 최근 활동 렌더 ───────────────────────────────────────────────────────────
function dbRenderActivity(list) {
  const wrap = document.getElementById('db-activity-list');
  if (!wrap) return;

  if (!list || !list.length) {
    wrap.innerHTML = '<div class="empty">활동 내역이 없습니다.</div>';
    return;
  }

  wrap.innerHTML = list.map(r => `
    <div class="db-act-row">
      <span class="db-act-who">${dbEsc(r.performer_name)}</span>
      <span class="db-act-menu">${dbEsc(r.menu)}</span>
      <span class="db-act-action db-act-${r.action === '등록' ? 'create' : r.action === '수정' ? 'update' : 'delete'}">${dbEsc(r.action)}</span>
      <span class="db-act-content">${dbEsc(r.content)}</span>
      <span class="db-act-time">${dbTimeAgo(r.performed_at)}</span>
    </div>
  `).join('');
}

// ── 날짜 검색 flatpickr ──────────────────────────────────────────────────────
function dbInitDatepickers() {
  if (typeof flatpickr === 'undefined') return;

  if (_dbFpFrom) { _dbFpFrom.destroy(); _dbFpFrom = null; }
  if (_dbFpTo)   { _dbFpTo.destroy();   _dbFpTo   = null; }

  const today = dbTodayStr();

  _dbFpFrom = flatpickr('#db-from', {
    locale: 'ko', dateFormat: 'Y-m-d', defaultDate: today,
  });
  _dbFpTo = flatpickr('#db-to', {
    locale: 'ko', dateFormat: 'Y-m-d', defaultDate: today,
  });
  dbSearchRange();

  // 빠른 선택 버튼
  document.getElementById('btn-db-today')?.addEventListener('click', () => {
    _dbFpFrom.setDate(dbTodayStr()); _dbFpTo.setDate(dbTodayStr()); dbSearchRange();
  });
  document.getElementById('btn-db-week')?.addEventListener('click', () => {
    _dbFpFrom.setDate(dbWeekStart()); _dbFpTo.setDate(dbTodayStr()); dbSearchRange();
  });
  document.getElementById('btn-db-month')?.addEventListener('click', () => {
    _dbFpFrom.setDate(dbMonthStart()); _dbFpTo.setDate(dbTodayStr()); dbSearchRange();
  });
  document.getElementById('btn-db-lastmonth')?.addEventListener('click', () => {
    const { start: s, end: e } = dbLastMonthRange();
    _dbFpFrom.setDate(s); _dbFpTo.setDate(e); dbSearchRange();
  });
  document.getElementById('btn-db-search')?.addEventListener('click', dbSearchRange);
}

// ── 기간 조회 ────────────────────────────────────────────────────────────────
async function dbSearchRange() {
  const from = document.getElementById('db-from')?.value;
  const to   = document.getElementById('db-to')?.value;
  if (!from || !to) { toast('날짜를 선택해주세요.', 'warn'); return; }

  const result = document.getElementById('db-range-result');
  if (!result) return;
  result.innerHTML = '<div class="db-range-loading"><div class="db-spinner-sm"></div> 조회 중...</div>';
  result.classList.remove('hidden');

  try {
    const data = await API.get(`/dashboard/range?from=${from}&to=${to}`);
    dbRenderRangeResult(data, from, to);
  } catch (err) {
    result.innerHTML = `<div class="empty" style="color:var(--danger)">오류: ${dbEsc(err.message)}</div>`;
  }
}

function dbRenderRangeResult(data, from, to) {
  const result = document.getElementById('db-range-result');
  if (!result) return;

  const top5Html = data.top5?.length
    ? data.top5.map((p, i) => `
        <div class="db-top-row">
          <span class="db-top-rank">${i + 1}</span>
          <span class="db-top-name">${dbEsc(p.manufacturer)} ${dbEsc(p.model_name)}${p.spec ? ` <em>${dbEsc(p.spec)}</em>` : ''}</span>
          <span class="db-top-qty">${dbNum(p.netQty)}개</span>
          <span class="db-top-profit ${p.netProfit >= 0 ? 'db-profit-pos' : 'db-profit-neg'}">${dbWon(p.netProfit)}</span>
        </div>
      `).join('')
    : '<div class="empty">데이터가 없습니다.</div>';

  result.innerHTML = `
    <div class="db-range-stats-grid">
      <div class="db-rs-item">
        <span class="db-rs-label">총 매출</span>
        <span class="db-rs-val">${dbWon(data.sales)}</span>
      </div>
      <div class="db-rs-item">
        <span class="db-rs-label">총 순수익</span>
        <span class="db-rs-val ${(data.profit||0) >= 0 ? 'db-profit-pos' : 'db-profit-neg'}">${dbWon(data.profit)}</span>
      </div>
      <div class="db-rs-item">
        <span class="db-rs-label">출고 건수</span>
        <span class="db-rs-val">${dbNum(data.outbound_count)}건</span>
      </div>
      <div class="db-rs-item">
        <span class="db-rs-label">반품 건수</span>
        <span class="db-rs-val">${dbNum(data.return_count)}건</span>
      </div>
      <div class="db-rs-item">
        <span class="db-rs-label">교환 건수</span>
        <span class="db-rs-val">${dbNum(data.exchange_count)}건</span>
      </div>
    </div>
    <div class="db-top5">
      <div class="db-top5-title">상품별 순수익 TOP 5</div>
      ${top5Html}
    </div>
  `;
}
