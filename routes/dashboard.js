'use strict';

const router = require('express').Router();
const { getDB } = require('../db/database');
const auth = require('../middleware/auth');

// ── 날짜 유틸 ────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
function thisMonday() {
  const now  = new Date();
  const utcY = now.getUTCFullYear();
  const utcM = now.getUTCMonth();
  const utcD = now.getUTCDate();
  const day  = now.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const dt   = new Date(Date.UTC(utcY, utcM, utcD + diff));
  return dt.toISOString().slice(0, 10);
}
function monthStart(dateStr) {
  return dateStr.slice(0, 8) + '01';
}
function addMonths(dateStr, months) {
  const [y, m] = dateStr.split('-').map(Number);
  let newM = (m - 1) + months;         // 0-indexed
  let newY = y + Math.floor(newM / 12);
  newM = ((newM % 12) + 12) % 12;
  return `${newY}-${String(newM + 1).padStart(2, '0')}-01`;
}

// ── 공통 출고 행 조회 ─────────────────────────────────────────────────────────
async function getOutboundRows(db, from, to) {
  return db.allAsync(
    `SELECT
       oi.id, oi.quantity, oi.sale_price, oi.profit_per_unit,
       oi.category, oi.manufacturer, oi.model_name, oi.spec,
       oo.order_date, oo.exchange_return_id,
       COALESCE(ri_agg.returned_qty, 0) AS returned_qty,
       COALESCE(ri_agg.has_exchange,  0) AS has_exchange
     FROM outbound_items oi
     JOIN outbound_orders oo ON oi.order_id = oo.id
     LEFT JOIN (
       SELECT
         CASE
           WHEN ri.outbound_item_id IS NOT NULL THEN ri.outbound_item_id
           WHEN ro.linked_outbound_id IS NOT NULL THEN (
             SELECT oi2.id FROM outbound_items oi2
             WHERE oi2.order_id     = ro.linked_outbound_id
               AND oi2.manufacturer = ri.manufacturer
               AND oi2.model_name   = ri.model_name
               AND COALESCE(oi2.spec,'') = COALESCE(ri.spec,'')
               AND oi2.is_deleted   = 0
             LIMIT 1
           )
           ELSE (
             SELECT oi2.id FROM outbound_items oi2
             JOIN outbound_orders oo2 ON oi2.order_id = oo2.id
             WHERE oi2.manufacturer = ri.manufacturer
               AND oi2.model_name   = ri.model_name
               AND COALESCE(oi2.spec,'') = COALESCE(ri.spec,'')
               AND oo2.vendor_name  = ro.vendor_name
               AND oi2.is_deleted   = 0 AND oo2.is_deleted = 0
             ORDER BY oo2.order_date DESC LIMIT 1
           )
         END AS target_item_id,
         SUM(ri.quantity) AS returned_qty,
         MAX(CASE WHEN ro.type = 'exchange' THEN 1 ELSE 0 END) AS has_exchange
       FROM return_items ri
       JOIN return_orders ro ON ri.return_order_id = ro.id
       WHERE ro.is_deleted = 0
         AND ro.status IN ('normal', 'defective', 'exchange_done')
       GROUP BY target_item_id
     ) ri_agg ON ri_agg.target_item_id = oi.id
     WHERE oi.is_deleted = 0 AND oo.is_deleted = 0
       AND oo.order_date BETWEEN ? AND ?`,
    [from, to]
  );
}

// ── 행 통계 계산 ──────────────────────────────────────────────────────────────
function computeStats(rows) {
  let netProfit = 0, netSales = 0, netQty = 0, count = 0;
  rows.forEach(r => {
    if (r.has_exchange) return;
    const returnedQty = Math.min(r.returned_qty || 0, r.quantity);
    if (r.exchange_return_id) {
      netProfit += (r.profit_per_unit || 0) * r.quantity;
      netSales  += (r.sale_price || 0) * r.quantity;
      netQty    += r.quantity;
      count++;
    } else if (returnedQty > 0) {
      // 원래 판매 전체 더하고 반품 수량만 차감 → 순판매만 반영
      const netQtyRow = r.quantity - returnedQty;
      netProfit += (r.profit_per_unit || 0) * netQtyRow;
      netSales  += (r.sale_price || 0) * netQtyRow;
      netQty    += netQtyRow;
      if (netQtyRow > 0) count++;
    } else {
      netProfit += (r.profit_per_unit || 0) * r.quantity;
      netSales  += (r.sale_price || 0) * r.quantity;
      netQty    += r.quantity;
      count++;
    }
  });
  return { netProfit, netSales, netQty, count };
}

// ── GET /api/dashboard/summary ────────────────────────────────────────────────
router.get('/summary', auth('viewer'), async (req, res) => {
  try {
    const db    = getDB();
    const today = todayStr();
    const isViewer = req.user.role === 'viewer';

    // ── 오늘 현황 ─────────────────────────────────────────────────────────────
    const [todayIn, todayOut, todayRet, invRow, pendPurch] = await Promise.all([
      db.getAsync(
        `SELECT COUNT(*) AS cnt FROM inbound_orders WHERE order_date = ? AND is_deleted = 0`,
        [today]
      ),
      db.getAsync(
        `SELECT COUNT(*) AS cnt FROM outbound_orders WHERE order_date = ? AND is_deleted = 0`,
        [today]
      ),
      db.getAsync(
        `SELECT COUNT(*) AS cnt FROM return_orders WHERE DATE(received_at) = ? AND is_deleted = 0`,
        [today]
      ),
      db.getAsync(
        `SELECT
           SUM(CASE WHEN condition_type='normal'    THEN 1 ELSE 0 END) AS items,
           SUM(CASE WHEN condition_type='defective' AND current_stock>0 THEN 1 ELSE 0 END) AS defective,
           SUM(CASE WHEN condition_type='disposal'  AND current_stock>0 THEN 1 ELSE 0 END) AS disposal
         FROM inventory`
      ),
      db.getAsync(
        `SELECT COUNT(*) AS cnt FROM inbound WHERE status = 'pending' AND is_deleted = 0`
      ),
    ]);

    let pendingUsers = null;
    if (req.user.role === 'admin') {
      const pu = await db.getAsync(
        `SELECT COUNT(*) AS cnt FROM users WHERE role = 'pending' AND is_deleted = 0`
      );
      pendingUsers = pu.cnt;
    }

    const todayStatus = {
      inbound_count:    todayIn.cnt,
      outbound_count:   todayOut.cnt,
      return_count:     todayRet.cnt,
      stock_items:      invRow.items,
      defective_items:  (invRow.defective || 0) + (invRow.disposal || 0),
      pending_purchase: pendPurch.cnt,
      pending_users:    pendingUsers,
    };

    // ── 최근 활동 10건 ────────────────────────────────────────────────────────
    const activityRows = await db.allAsync(
      `SELECT table_name, record_id, action, new_data, old_data, performed_at, performer_name
       FROM audit_log ORDER BY performed_at DESC LIMIT 10`
    );

    const TABLE_LABELS = {
      inbound: '입고관리',         inbound_orders: '입고관리',
      outbound_items: '출고관리',   outbound_orders: '출고관리',
      return_orders: '반품/교환',   return_items: '반품/교환',
      exchange_items: '반품/교환',
      inventory: '재고관리',        inventory_adjustments: '재고조정',
      users: '회원관리',
      purchase_vendors: '매입거래처', sales_vendors: '매출거래처',
    };
    const ACTION_LABELS = { create: '등록', update: '수정', delete: '삭제' };

    const recentActivity = activityRows.map(r => {
      let content = '';
      try {
        const data = JSON.parse(r.new_data || r.old_data || '{}');
        if (data.model_name)    content = `${data.manufacturer || ''} ${data.model_name}`.trim();
        else if (data.company_name) content = data.company_name;
        else if (data.vendor_name)  content = data.vendor_name;
        else if (data.name)         content = data.name;
      } catch {}
      return {
        performer_name: r.performer_name || '알 수 없음',
        menu:           TABLE_LABELS[r.table_name] || r.table_name,
        action:         ACTION_LABELS[r.action] || r.action,
        content,
        performed_at:   r.performed_at,
      };
    });

    if (isViewer) {
      return res.json({ todayStatus, recentActivity });
    }

    // ── KPI 계산 ──────────────────────────────────────────────────────────────
    const yesterday        = addDays(today, -1);
    const thisMonStr       = thisMonday();
    const lastWeekMonStr   = addDays(thisMonStr, -7);
    const lastWeekSameEnd  = addDays(today, -7);
    const thisMonthStart   = monthStart(today);
    const lastMonthStart   = monthStart(addMonths(today, -1));
    const lastMonthSameEnd = addMonths(today, -1);

    // 2주치 데이터 (이번주+저번주)
    const wideRows = await getOutboundRows(db, lastWeekMonStr, today);
    const filterDate = (from, to) => wideRows.filter(r => r.order_date >= from && r.order_date <= to);

    const todayStats     = computeStats(filterDate(today, today));
    const yesterdayStats = computeStats(filterDate(yesterday, yesterday));
    const weekStats      = computeStats(filterDate(thisMonStr, today));
    const lastWeekStats  = computeStats(filterDate(lastWeekMonStr, lastWeekSameEnd));

    // 이번달+저번달 동기간
    const monthRows     = await getOutboundRows(db, lastMonthStart, today);
    const thisMonStats  = computeStats(monthRows.filter(r => r.order_date >= thisMonthStart  && r.order_date <= today));
    const lastMonStats  = computeStats(monthRows.filter(r => r.order_date >= lastMonthStart  && r.order_date <= lastMonthSameEnd));

    const kpi = {
      today_profit:      todayStats.netProfit,
      today_profit_diff: todayStats.netProfit - yesterdayStats.netProfit,
      week_profit:       weekStats.netProfit,
      week_profit_diff:  weekStats.netProfit - lastWeekStats.netProfit,
      month_profit:      thisMonStats.netProfit,
      month_profit_diff: thisMonStats.netProfit - lastMonStats.netProfit,
      month_sales:       thisMonStats.netSales,
      month_sales_diff:  thisMonStats.netSales - lastMonStats.netSales,
    };

    // ── 이번주 vs 저번주 일별 차트 ───────────────────────────────────────────
    const weeklyChart = { thisWeek: [], lastWeek: [] };
    for (let i = 0; i < 7; i++) {
      const d1 = addDays(thisMonStr, i);
      const d2 = addDays(lastWeekMonStr, i);
      weeklyChart.thisWeek.push(computeStats(filterDate(d1, d1)).netProfit);
      weeklyChart.lastWeek.push(computeStats(filterDate(d2, d2)).netProfit);
    }

    // ── 월별 순수익 (최근 6개월) ──────────────────────────────────────────────
    const sixMonthsAgoStart = monthStart(addMonths(today, -5));
    const monthlyRows = await getOutboundRows(db, sixMonthsAgoStart, today);
    const monthlyChart = [];
    const [todayY, todayMo] = today.split('-').map(Number);
    for (let i = 5; i >= 0; i--) {
      let mo = todayMo - i;
      let yr = todayY;
      if (mo <= 0) { mo += 12; yr--; }
      const mStr  = `${yr}-${String(mo).padStart(2, '0')}`;
      const mRows = monthlyRows.filter(r => r.order_date.startsWith(mStr));
      monthlyChart.push({ month: mStr, profit: computeStats(mRows).netProfit });
    }

    res.json({ kpi, weeklyChart, monthlyChart, todayStatus, recentActivity });
  } catch (err) {
    console.error('[dashboard] summary error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dashboard/range ──────────────────────────────────────────────────
router.get('/range', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from, to required' });

    const rows  = await getOutboundRows(db, from, to);
    const stats = computeStats(rows);

    const [retRow, exRow, outRow] = await Promise.all([
      db.getAsync(
        `SELECT COUNT(*) AS cnt FROM return_orders
         WHERE type = 'return' AND DATE(received_at) BETWEEN ? AND ? AND is_deleted = 0`,
        [from, to]
      ),
      db.getAsync(
        `SELECT COUNT(*) AS cnt FROM return_orders
         WHERE type = 'exchange' AND DATE(received_at) BETWEEN ? AND ? AND is_deleted = 0`,
        [from, to]
      ),
      db.getAsync(
        `SELECT COUNT(*) AS cnt FROM outbound_orders
         WHERE order_date BETWEEN ? AND ? AND is_deleted = 0`,
        [from, to]
      ),
    ]);

    // 상품별 TOP 5
    const productMap = {};
    rows.forEach(r => {
      if (r.has_exchange) return;
      const key = `${r.manufacturer}||${r.model_name}||${r.spec || ''}`;
      if (!productMap[key]) {
        productMap[key] = {
          manufacturer: r.manufacturer,
          model_name:   r.model_name,
          spec:         r.spec,
          netProfit:    0,
          netQty:       0,
        };
      }
      const returnedQty = Math.min(r.returned_qty || 0, r.quantity);
      if (r.exchange_return_id) {
        productMap[key].netProfit += (r.profit_per_unit || 0) * r.quantity;
        productMap[key].netQty   += r.quantity;
      } else if (returnedQty > 0) {
        productMap[key].netProfit -= (r.profit_per_unit || 0) * returnedQty;
        productMap[key].netQty   -= returnedQty;
      } else {
        productMap[key].netProfit += (r.profit_per_unit || 0) * r.quantity;
        productMap[key].netQty   += r.quantity;
      }
    });

    const top5 = Object.values(productMap)
      .sort((a, b) => b.netProfit - a.netProfit)
      .slice(0, 5);

    res.json({
      sales:          stats.netSales,
      profit:         stats.netProfit,
      outbound_count: outRow.cnt,
      return_count:   retRow.cnt,
      exchange_count: exRow.cnt,
      top5,
    });
  } catch (err) {
    console.error('[dashboard] range error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
