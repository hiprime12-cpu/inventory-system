'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getDB, nowStr } = require('../db/database');
const auth  = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');

// ── 공통 서브쿼리: 입고 상태별 집계 ────────────────────────────────
// SQLite/PG 모두 동작하는 인라인 서브쿼리
const INBOUND_SUBS = `
  COALESCE((
    SELECT SUM(i.quantity) FROM inbound i
    WHERE i.manufacturer=inv.manufacturer AND i.model_name=inv.model_name
      AND COALESCE(i.spec,'')=COALESCE(inv.spec,'')
      AND i.condition_type=inv.condition_type
      AND i.status='completed' AND i.is_deleted=0
  ),0) AS completed_stock,
  COALESCE((
    SELECT SUM(i.quantity) FROM inbound i
    WHERE i.manufacturer=inv.manufacturer AND i.model_name=inv.model_name
      AND COALESCE(i.spec,'')=COALESCE(inv.spec,'')
      AND i.condition_type=inv.condition_type
      AND i.status='priority' AND i.is_deleted=0
  ),0) AS priority_stock,
  COALESCE((
    SELECT SUM(i.quantity) FROM inbound i
    WHERE i.manufacturer=inv.manufacturer AND i.model_name=inv.model_name
      AND COALESCE(i.spec,'')=COALESCE(inv.spec,'')
      AND i.status='pending' AND i.is_deleted=0
  ),0) AS pending_inbound_qty,
  (
    SELECT io.vendor_name FROM inbound_orders io
    INNER JOIN inbound i ON i.order_id=io.id
    WHERE i.manufacturer=inv.manufacturer AND i.model_name=inv.model_name
      AND COALESCE(i.spec,'')=COALESCE(inv.spec,'')
      AND i.condition_type=inv.condition_type
      AND i.is_deleted=0 AND io.is_deleted=0
    ORDER BY io.order_date DESC LIMIT 1
  ) AS last_vendor,
  COALESCE((
    SELECT MAX(i.is_smartstore) FROM inbound i
    WHERE i.manufacturer=inv.manufacturer AND i.model_name=inv.model_name
      AND COALESCE(i.spec,'')=COALESCE(inv.spec,'')
      AND i.is_deleted=0
  ),0) AS has_smartstore
`;

// ── GET /api/inventory ─────────────────────────────────────────────
router.get('/', auth('viewer'), async (req, res) => {
  try {
    const db = getDB();
    const rows = await db.allAsync(
      `SELECT inv.*, ${INBOUND_SUBS}
       FROM inventory inv
       ORDER BY inv.manufacturer, inv.model_name, inv.spec`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/inventory/summary ─────────────────────────────────────
router.get('/summary', auth('viewer'), async (req, res) => {
  try {
    const db = getDB();
    const rows = await db.allAsync('SELECT * FROM inventory');
    const summary = {
      total_items:          new Set(rows.map(r => `${r.manufacturer}|${r.model_name}|${r.spec||''}`)).size,
      total_stock:          rows.reduce((s, r) => s + (r.current_stock || 0), 0),
      temp_purchase_items:  rows.filter(r => r.has_temp_purchase > 0).length,
      defective_items:      rows.filter(r => r.condition_type === 'defective' && (r.current_stock || 0) > 0).length,
      disposal_items:       rows.filter(r => r.condition_type === 'disposal'  && (r.current_stock || 0) > 0).length,
      pending_inbound_items: 0, // 아래서 계산
    };
    // 매입미완료 품목 수
    const pendingGroups = await db.allAsync(
      `SELECT DISTINCT manufacturer, model_name, COALESCE(spec,'') as spec
       FROM inbound WHERE status='pending' AND is_deleted=0`
    );
    summary.pending_inbound_items = pendingGroups.length;
    res.json(summary);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/inventory/adjustments ────────────────────────────────
router.get('/adjustments', auth('viewer'), async (req, res) => {
  try {
    const db = getDB();
    const rows = await db.allAsync(
      `SELECT * FROM inventory_adjustments
       WHERE is_deleted=0
       ORDER BY adjustment_date DESC, created_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/inventory/adjustments/pending-temp/:mfr/:model/:spec ─
router.get('/adjustments/pending-temp/:mfr/:model/:spec', auth('viewer'), async (req, res) => {
  try {
    const db = getDB();
    const { mfr, model, spec } = req.params;
    const rows = await db.allAsync(
      `SELECT * FROM inventory_adjustments
       WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=COALESCE(?,'')
         AND adjustment_type='temp_purchase' AND status='temp' AND is_deleted=0
       ORDER BY created_at DESC`,
      [mfr, model, spec || '']
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/inventory/:id ─────────────────────────────────────────
router.get('/:id', auth('viewer'), async (req, res) => {
  try {
    const db = getDB();
    const row = await db.getAsync(
      `SELECT inv.*, ${INBOUND_SUBS}
       FROM inventory inv WHERE inv.id=?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: '재고 항목을 찾을 수 없습니다.' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/inventory/:id/history ────────────────────────────────
router.get('/:id/history', auth('viewer'), async (req, res) => {
  try {
    const db  = getDB();
    const inv = await db.getAsync('SELECT * FROM inventory WHERE id=?', [req.params.id]);
    if (!inv) return res.status(404).json({ error: '재고 항목을 찾을 수 없습니다.' });

    const { manufacturer, model_name, spec } = inv;
    const specVal = spec || '';

    // 입고 이력
    const inboundRows = await db.allAsync(
      `SELECT i.*, io.order_date, io.vendor_name, io.id as order_id_ref
       FROM inbound i
       INNER JOIN inbound_orders io ON i.order_id=io.id
       WHERE i.manufacturer=? AND i.model_name=? AND COALESCE(i.spec,'')=?
         AND i.is_deleted=0
       ORDER BY io.order_date DESC, i.created_at DESC`,
      [manufacturer, model_name, specVal]
    );

    // 교환으로 반품된 원판매 outbound_item_id 목록 (A상품 원판매 — 출고이력에서 제외)
    const exchangedOutItemIds = (await db.allAsync(
      `SELECT ri.outbound_item_id
       FROM return_items ri
       JOIN return_orders ro ON ri.return_order_id = ro.id
       WHERE ro.type = 'exchange' AND ro.is_deleted = 0
         AND ri.outbound_item_id IS NOT NULL`
    )).map(r => r.outbound_item_id);

    // 일반 출고 이력 (교환출고 제외 + 교환으로 반품된 원판매 제외)
    const allOutboundRows = await db.allAsync(
      `SELECT oi.*, oo.order_date, oo.vendor_name, oo.id as order_id_ref,
              oo.exchange_return_id, oo.notes AS order_notes
       FROM outbound_items oi
       INNER JOIN outbound_orders oo ON oi.order_id=oo.id
       WHERE oi.manufacturer=? AND oi.model_name=? AND COALESCE(oi.spec,'')=?
         AND oi.is_deleted=0 AND oo.is_deleted=0
       ORDER BY oo.order_date DESC, oi.created_at DESC`,
      [manufacturer, model_name, specVal]
    );

    // exchange_return_id 있거나 notes 패턴으로 교환출고 판별
    const isExchangeOrder = r =>
      (r.exchange_return_id && r.exchange_return_id !== '') ||
      (r.order_notes && r.order_notes.startsWith('교환출고 (접수번호: '));

    const outboundRows = allOutboundRows.filter(r =>
      !isExchangeOrder(r) && !exchangedOutItemIds.includes(r.id)
    );
    const exchangeOutboundRows = allOutboundRows.filter(r => isExchangeOrder(r));

    // 반품 이력 (일반 반품만 — 교환으로 인한 복구는 제외)
    const returnRows = await db.allAsync(
      `SELECT ro.id, ro.type, ro.status, ro.received_at, ro.vendor_name, ro.reason,
              ri.quantity, ri.condition, ri.notes as item_notes
       FROM return_items ri
       INNER JOIN return_orders ro ON ri.return_order_id=ro.id
       WHERE ri.manufacturer=? AND ri.model_name=? AND COALESCE(ri.spec,'')=?
         AND ro.is_deleted=0 AND ro.type='return'
       ORDER BY ro.received_at DESC`,
      [manufacturer, model_name, specVal]
    );

    // 재고조정 이력
    const adjustRows = await db.allAsync(
      `SELECT * FROM inventory_adjustments
       WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=? AND is_deleted=0
       ORDER BY adjustment_date DESC, created_at DESC`,
      [manufacturer, model_name, specVal]
    );

    // 평균매입가 변동 이력
    const avgRows = await db.allAsync(
      `SELECT * FROM avg_price_history
       WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=?
       ORDER BY changed_at DESC`,
      [manufacturer, model_name, specVal]
    );

    res.json({
      inventory:         inv,
      inbound:           inboundRows,
      outbound:          outboundRows,
      exchange_outbound: exchangeOutboundRows,
      returns:           returnRows,
      adjustments:       adjustRows,
      avg_history:       avgRows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /api/inventory/:id/notes ────────────────────────────────
router.patch('/:id/notes', auth('editor'), async (req, res) => {
  try {
    const db    = getDB();
    const { notes } = req.body;
    const n     = nowStr();
    await db.runAsync(
      'UPDATE inventory SET notes=?, updated_at=? WHERE id=?',
      [notes ?? null, n, req.params.id]
    );
    const updated = await db.getAsync('SELECT * FROM inventory WHERE id=?', [req.params.id]);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/inventory/adjustments ───────────────────────────────
router.post('/adjustments', auth('editor'), async (req, res) => {
  try {
    const db  = getDB();
    const {
      adjustment_date, manufacturer, model_name, spec,
      category, adjustment_type, quantity,
      temp_price, confirmed_price, reason,
    } = req.body;

    if (!manufacturer || !model_name || !quantity || !adjustment_type)
      return res.status(400).json({ error: '필수 항목을 모두 입력하세요.' });

    const specVal = spec || '';
    const qty     = Math.abs(Number(quantity));
    if (!qty) return res.status(400).json({ error: '수량은 0보다 커야 합니다.' });

    const VALID_TYPES = ['shortage','surplus','temp_purchase','confirm_purchase'];
    if (!VALID_TYPES.includes(adjustment_type))
      return res.status(400).json({ error: '유효하지 않은 조정유형입니다.' });

    // 재고 조회
    const inv = await db.getAsync(
      `SELECT * FROM inventory WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=?`,
      [manufacturer, model_name, specVal]
    );
    if (!inv) return res.status(404).json({ error: '해당 모델의 재고 데이터가 없습니다.' });

    const n    = nowStr();
    const id   = uuidv4();
    let adjStatus = 'confirmed';

    // ── 유형별 재고 처리 ────────────────────────────────────────
    if (adjustment_type === 'shortage') {
      // 차감 검증
      if (inv.current_stock - qty < 0)
        return res.status(400).json({ error: `현재 재고(${inv.current_stock})보다 많이 차감할 수 없습니다.` });

      await db.runAsync(
        `UPDATE inventory SET
           current_stock=current_stock-?,
           updated_at=?
         WHERE id=?`,
        [qty, n, inv.id]
      );

    } else if (adjustment_type === 'surplus') {
      await db.runAsync(
        `UPDATE inventory SET
           current_stock=current_stock+?,
           updated_at=?
         WHERE id=?`,
        [qty, n, inv.id]
      );

    } else if (adjustment_type === 'temp_purchase') {
      if (!temp_price && temp_price !== 0)
        return res.status(400).json({ error: '임시매입가를 입력하세요.' });

      const price    = Number(temp_price) || 0;
      const oldAvg   = inv.avg_purchase_price;
      const oldStock = inv.current_stock;
      const newStock = oldStock + qty;
      const newAvg   = newStock > 0 ? (oldStock * oldAvg + qty * price) / newStock : price;
      const pctChg   = oldAvg > 0 ? Math.abs(newAvg - oldAvg) / oldAvg : 0;

      // 30% 이상 변동 시 경고 응답 (클라이언트가 force=true 로 재요청)
      if (pctChg >= 0.3 && !req.body.force) {
        return res.status(409).json({
          warn: 'avg_price_change',
          old_avg: Math.round(oldAvg),
          new_avg: Math.round(newAvg),
          pct: Math.round(pctChg * 100),
        });
      }

      // avg_price_history 기록
      if (Math.abs(newAvg - oldAvg) > 0.5) {
        await db.runAsync(
          `INSERT INTO avg_price_history (id,manufacturer,model_name,spec,old_avg,new_avg,changed_at,reason)
           VALUES (?,?,?,?,?,?,?,?)`,
          [uuidv4(), manufacturer, model_name, specVal, oldAvg, newAvg, n, '임의매입(임시)']
        );
      }

      await db.runAsync(
        `UPDATE inventory SET
           current_stock=?, avg_purchase_price=?,
           total_inbound=total_inbound+?, has_temp_purchase=has_temp_purchase+1,
           updated_at=?
         WHERE id=?`,
        [newStock, newAvg, qty, n, inv.id]
      );
      adjStatus = 'temp';

    } else if (adjustment_type === 'confirm_purchase') {
      if (!confirmed_price && confirmed_price !== 0)
        return res.status(400).json({ error: '확정매입가를 입력하세요.' });

      const confPrice = Number(confirmed_price) || 0;
      const oldAvg    = inv.avg_purchase_price;
      const curStock  = inv.current_stock;

      // 해당 qty 를 oldAvg → confPrice 로 재계산
      const newAvg = curStock > 0
        ? Math.max(0, (curStock * oldAvg - qty * oldAvg + qty * confPrice) / curStock)
        : confPrice;
      const pctChg = oldAvg > 0 ? Math.abs(newAvg - oldAvg) / oldAvg : 0;

      if (pctChg >= 0.3 && !req.body.force) {
        return res.status(409).json({
          warn: 'avg_price_change',
          old_avg: Math.round(oldAvg),
          new_avg: Math.round(newAvg),
          pct: Math.round(pctChg * 100),
        });
      }

      if (Math.abs(newAvg - oldAvg) > 0.5) {
        await db.runAsync(
          `INSERT INTO avg_price_history (id,manufacturer,model_name,spec,old_avg,new_avg,changed_at,reason)
           VALUES (?,?,?,?,?,?,?,?)`,
          [uuidv4(), manufacturer, model_name, specVal, oldAvg, newAvg, n, '임의매입(확정)']
        );
      }

      // 가장 오래된 temp 조정 하나를 confirmed 처리
      const pendingTemps = await db.allAsync(
        `SELECT * FROM inventory_adjustments
         WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=?
           AND adjustment_type='temp_purchase' AND status='temp' AND is_deleted=0
         ORDER BY created_at ASC`,
        [manufacturer, model_name, specVal]
      );
      if (pendingTemps.length > 0) {
        await db.runAsync(
          'UPDATE inventory_adjustments SET status=? WHERE id=?',
          ['confirmed', pendingTemps[0].id]
        );
      }

      const newHasTemp = Math.max(0, inv.has_temp_purchase - 1);
      await db.runAsync(
        `UPDATE inventory SET avg_purchase_price=?, has_temp_purchase=?, updated_at=? WHERE id=?`,
        [newAvg, newHasTemp, n, inv.id]
      );
      adjStatus = 'confirmed';
    }

    // 조정 기록 저장
    const performerRow = await db.getAsync('SELECT name FROM users WHERE id=?', [req.user.id]);
    await db.runAsync(
      `INSERT INTO inventory_adjustments
         (id, adjustment_date, manufacturer, model_name, spec, category,
          adjustment_type, quantity, temp_price, confirmed_price,
          reason, status, performer_name, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        adjustment_date || n.slice(0, 10),
        manufacturer, model_name, specVal, category || null,
        adjustment_type, qty,
        temp_price    != null ? Number(temp_price)    : null,
        confirmed_price != null ? Number(confirmed_price) : null,
        reason || null,
        adjStatus,
        performerRow?.name || req.user.id,
        n, req.user.id,
      ]
    );

    const created = await db.getAsync('SELECT * FROM inventory_adjustments WHERE id=?', [id]);
    await writeAuditLog('inventory_adjustments', id, 'create', null, created, req.user.id);
    res.status(201).json(created);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
