'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getDB, nowStr } = require('../db/database');
const auth  = require('../middleware/auth');
const { writeAuditLog, moveToTrash } = require('../middleware/audit');

// ── 헬퍼: 주문 + 품목 함께 조회 ──────────────────────────────────
async function fetchReturnOrder(db, id) {
  const order = await db.getAsync(
    `SELECT r.*,
       u1.name AS created_by_name,
       u2.name AS updated_by_name
     FROM return_orders r
     LEFT JOIN users u1 ON r.created_by = u1.id
     LEFT JOIN users u2 ON r.updated_by = u2.id
     WHERE r.id = ? AND r.is_deleted = 0`,
    [id]
  );
  if (!order) return null;
  order.return_items   = await db.allAsync(`SELECT * FROM return_items   WHERE return_order_id = ?`, [id]);
  order.exchange_items = await db.allAsync(`SELECT * FROM exchange_items WHERE return_order_id = ?`, [id]);
  return order;
}

// ── 헬퍼: 재고 조회 ──────────────────────────────────────────────
async function getInv(db, manufacturer, model_name, spec, conditionType = 'normal') {
  return (
    await db.getAsync(
      `SELECT * FROM inventory WHERE manufacturer = ? AND model_name = ? AND spec = ? AND condition_type = ?`,
      [manufacturer, model_name, spec || '', conditionType]
    ) ||
    await db.getAsync(
      `SELECT * FROM inventory WHERE manufacturer = ? AND model_name = ? AND condition_type = ?`,
      [manufacturer, model_name, conditionType]
    )
  );
}

// ── GET /api/returns ─────────────────────────────────────────────
router.get('/', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const orders = await db.allAsync(
      `SELECT r.*, u.name AS created_by_name
       FROM return_orders r
       LEFT JOIN users u ON r.created_by = u.id
       WHERE r.is_deleted = 0
       ORDER BY r.received_at DESC, r.created_at DESC`
    );
    for (const o of orders) {
      o.return_items   = await db.allAsync(`SELECT * FROM return_items   WHERE return_order_id = ?`, [o.id]);
      o.exchange_items = await db.allAsync(`SELECT * FROM exchange_items WHERE return_order_id = ?`, [o.id]);
    }
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/returns/outbound-by-vendor/:vendorId ──────────────
// 특정 거래처의 출고건 목록 (출고건 연동용)
router.get('/outbound-by-vendor/:vendorId', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const vid  = req.params.vendorId;
    const from = req.query.from?.trim();
    const to   = req.query.to?.trim();

    // 날짜 조건 공통 빌더
    let dateClause = '';
    const dateParams = [];
    if (from) { dateClause += ' AND order_date >= ?'; dateParams.push(from); }
    if (to)   { dateClause += ' AND order_date <= ?'; dateParams.push(to); }

    let orders;
    if (vid === 'novendor') {
      const nameFilter = req.query.name?.trim();
      if (nameFilter) {
        orders = await db.allAsync(
          `SELECT * FROM outbound_orders WHERE sales_vendor_id IS NULL AND vendor_name = ? AND is_deleted = 0 AND (exchange_return_id IS NULL OR exchange_return_id = '')${dateClause}
           ORDER BY order_date DESC LIMIT 200`,
          [nameFilter, ...dateParams]
        );
      } else {
        orders = await db.allAsync(
          `SELECT * FROM outbound_orders WHERE sales_vendor_id IS NULL AND is_deleted = 0 AND (exchange_return_id IS NULL OR exchange_return_id = '')${dateClause}
           ORDER BY order_date DESC LIMIT 200`,
          dateParams
        );
      }
    } else {
      orders = await db.allAsync(
        `SELECT * FROM outbound_orders WHERE sales_vendor_id = ? AND is_deleted = 0 AND (exchange_return_id IS NULL OR exchange_return_id = '')${dateClause}
         ORDER BY order_date DESC LIMIT 200`,
        [vid, ...dateParams]
      );
    }
    for (const o of orders) {
      o.items = await db.allAsync(
        `SELECT * FROM outbound_items WHERE order_id = ? AND is_deleted = 0`,
        [o.id]
      );
    }
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/returns/:id ─────────────────────────────────────────
router.get('/:id', auth('editor'), async (req, res) => {
  try {
    const db    = getDB();
    const order = await fetchReturnOrder(db, req.params.id);
    if (!order) return res.status(404).json({ error: '반품/교환 내역을 찾을 수 없습니다.' });
    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/returns ────────────────────────────────────────────
router.post('/', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const {
      type, received_at, sales_vendor_id, vendor_name,
      linked_outbound_id, reason, notes,
      return_items, exchange_items,
    } = req.body;

    if (!type || !['return', 'exchange'].includes(type))
      return res.status(400).json({ error: '유형은 return 또는 exchange여야 합니다.' });
    if (!received_at)
      return res.status(400).json({ error: '접수일은 필수입니다.' });
    if (!Array.isArray(return_items) || !return_items.some(it => it.manufacturer && it.model_name && it.quantity > 0))
      return res.status(400).json({ error: '반품 품목을 1개 이상 입력하세요.' });

    const id = uuidv4();
    const n  = nowStr();

    await db.runAsync(
      `INSERT INTO return_orders
         (id, type, status, received_at, sales_vendor_id, vendor_name,
          linked_outbound_id, reason, notes, created_at, created_by)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, type, received_at, sales_vendor_id || null, vendor_name || null,
       linked_outbound_id || null, reason || 'other', notes || null, n, req.user.id]
    );

    // 반품 품목 삽입
    for (const item of return_items) {
      if (!item.manufacturer || !item.model_name || !(Number(item.quantity) > 0)) continue;
      await db.runAsync(
        `INSERT INTO return_items
           (id, return_order_id, outbound_item_id, category, manufacturer, model_name, spec, quantity, sale_price, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), id, item.outbound_item_id || null, item.category || null,
         item.manufacturer, item.model_name, item.spec || '', Number(item.quantity),
         Number(item.sale_price) || 0, item.notes || null]
      );
    }

    // 교환 출고 품목 삽입
    if (type === 'exchange' && Array.isArray(exchange_items)) {
      for (const item of exchange_items) {
        if (!item.manufacturer || !item.model_name || !(Number(item.quantity) > 0)) continue;
        const qty       = Number(item.quantity);
        const salePrice = Number(item.sale_price) || 0;
        await db.runAsync(
          `INSERT INTO exchange_items
             (id, return_order_id, category, manufacturer, model_name, spec, quantity, sale_price, total_price, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), id, item.category || null, item.manufacturer, item.model_name,
           item.spec || '', qty, salePrice, qty * salePrice, item.notes || null]
        );
      }
    }

    const created = await fetchReturnOrder(db, id);
    await writeAuditLog('return_orders', id, 'create', null, created, req.user.id);
    res.status(201).json(created);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /api/returns/:id ─────────────────────────────────────────
// 접수대기만 수정 가능 (admin은 제한 없음)
router.put('/:id', auth('editor'), async (req, res) => {
  try {
    const db  = getDB();
    const old = await fetchReturnOrder(db, req.params.id);
    if (!old) return res.status(404).json({ error: '반품/교환 내역을 찾을 수 없습니다.' });

    if (old.status !== 'pending' && req.user.role !== 'admin')
      return res.status(400).json({ error: '접수대기 상태에서만 수정할 수 있습니다.' });

    const {
      received_at, sales_vendor_id, vendor_name, linked_outbound_id,
      reason, notes, return_items, exchange_items,
    } = req.body;

    const n = nowStr();

    // 기존 품목 삭제
    await db.runAsync(`DELETE FROM return_items   WHERE return_order_id = ?`, [req.params.id]);
    await db.runAsync(`DELETE FROM exchange_items WHERE return_order_id = ?`, [req.params.id]);

    // 헤더 업데이트
    await db.runAsync(
      `UPDATE return_orders
       SET received_at=?, sales_vendor_id=?, vendor_name=?, linked_outbound_id=?,
           reason=?, notes=?, updated_at=?, updated_by=?
       WHERE id=?`,
      [
        received_at || old.received_at,
        sales_vendor_id !== undefined ? (sales_vendor_id || null) : old.sales_vendor_id,
        vendor_name     !== undefined ? (vendor_name     || null) : old.vendor_name,
        linked_outbound_id !== undefined ? (linked_outbound_id || null) : old.linked_outbound_id,
        reason || old.reason,
        notes  !== undefined ? (notes || null) : old.notes,
        n, req.user.id, req.params.id,
      ]
    );

    // 새 반품 품목 삽입
    const newReturnItems = return_items || old.return_items;
    for (const item of newReturnItems) {
      if (!item.manufacturer || !item.model_name || !(Number(item.quantity) > 0)) continue;
      await db.runAsync(
        `INSERT INTO return_items
           (id, return_order_id, outbound_item_id, category, manufacturer, model_name, spec, quantity, sale_price, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), req.params.id, item.outbound_item_id || null, item.category || null,
         item.manufacturer, item.model_name, item.spec || '', Number(item.quantity),
         Number(item.sale_price) || 0, item.notes || null]
      );
    }

    // 새 교환 출고 품목 삽입
    if (old.type === 'exchange') {
      const newExItems = exchange_items || old.exchange_items;
      for (const item of newExItems) {
        if (!item.manufacturer || !item.model_name || !(Number(item.quantity) > 0)) continue;
        const qty       = Number(item.quantity);
        const salePrice = Number(item.sale_price) || 0;
        await db.runAsync(
          `INSERT INTO exchange_items
             (id, return_order_id, category, manufacturer, model_name, spec, quantity, sale_price, total_price, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), req.params.id, item.category || null, item.manufacturer, item.model_name,
           item.spec || '', qty, salePrice, qty * salePrice, item.notes || null]
        );
      }
    }

    const updated = await fetchReturnOrder(db, req.params.id);
    await writeAuditLog('return_orders', req.params.id, 'update', old, updated, req.user.id);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /api/returns/:id/status ────────────────────────────────
router.patch('/:id/status', auth('editor'), async (req, res) => {
  try {
    const db    = getDB();
    const order = await fetchReturnOrder(db, req.params.id);
    if (!order) return res.status(404).json({ error: '반품/교환 내역을 찾을 수 없습니다.' });

    const { status } = req.body;
    const validStatuses = ['pending','testing','normal','defective','exchange_pending','exchange_done'];
    if (!validStatuses.includes(status))
      return res.status(400).json({ error: '유효하지 않은 상태입니다.' });

    const isAdmin = req.user.role === 'admin';
    const oldStatus = order.status;

    // 상태 전이 검증 (admin 제외)
    if (!isAdmin) {
      const allowed = {
        pending:           ['testing'],
        testing:           order.type === 'return'
                             ? ['normal', 'defective']
                             : ['exchange_pending', 'defective'],
        exchange_pending:  ['exchange_done'],
      };
      if (!(allowed[oldStatus] || []).includes(status))
        return res.status(400).json({ error: `현재 상태(${oldStatus})에서 ${status}(으)로 변경할 수 없습니다.` });
    }

    const n = nowStr();

    // ── 재고 처리 (트랜잭션으로 묶어 원자적으로 처리) ──────────
    await db.transaction(async () => {

      if (status === 'normal' && oldStatus !== 'normal') {
        // 반품 정상확정: current_stock↑ normal_returns↑
        for (const item of order.return_items) {
          const inv = await getInv(db, item.manufacturer, item.model_name, item.spec);
          if (inv) {
            await db.runAsync(
              `UPDATE inventory
               SET current_stock  = current_stock + ?,
                   normal_returns = normal_returns + ?,
                   updated_at     = ?
               WHERE id = ?`,
              [item.quantity, item.quantity, n, inv.id]
            );
          } else {
            // 재고 레코드가 없으면 신규 생성
            console.warn(`[Returns] 정상확정 - 재고 없어 신규 생성: ${item.manufacturer} ${item.model_name}`);
            await db.runAsync(
              `INSERT INTO inventory
                 (id, category, product_type, spec, manufacturer, model_name, condition_type,
                  current_stock, avg_purchase_price, total_inbound, total_outbound,
                  normal_returns, has_temp_purchase, updated_at)
               VALUES (?, ?, 'general', ?, ?, ?, 'normal', ?, 0, 0, 0, ?, 0, ?)`,
              [uuidv4(), item.category || null, (item.spec || '').toLowerCase().trim(),
               item.manufacturer, item.model_name,
               item.quantity, item.quantity, n]
            );
          }
        }

      } else if (status === 'defective' && oldStatus !== 'defective') {
        // 불량확정: condition_type='defective' 행 current_stock↑ (없으면 생성)
        for (const item of order.return_items) {
          const defInv = await getInv(db, item.manufacturer, item.model_name, item.spec, 'defective');
          if (defInv) {
            await db.runAsync(
              `UPDATE inventory SET current_stock = current_stock + ?, updated_at = ? WHERE id = ?`,
              [item.quantity, n, defInv.id]
            );
          } else {
            const normInv = await getInv(db, item.manufacturer, item.model_name, item.spec, 'normal');
            const specVal = (item.spec || '').toLowerCase().trim();
            await db.runAsync(
              `INSERT INTO inventory
                 (id, category, product_type, spec, manufacturer, model_name, condition_type,
                  current_stock, avg_purchase_price, total_inbound, total_outbound,
                  normal_returns, has_temp_purchase, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'defective', ?, 0, 0, 0, 0, 0, ?)`,
              [uuidv4(), normInv?.category || null, normInv?.product_type || 'general', specVal,
               item.manufacturer, item.model_name, item.quantity, n]
            );
          }
        }

      } else if (status === 'exchange_done' && oldStatus !== 'exchange_done') {
        // 교환완료: 반품품목 current_stock↑, 교환출고품목 current_stock↓ + 출고건 자동생성

        // 교환 출고 재고 사전 검증 (트랜잭션 전에 확인)
        if (order.exchange_items && order.exchange_items.length > 0) {
          for (const item of order.exchange_items) {
            const inv = await getInv(db, item.manufacturer, item.model_name, item.spec);
            if (!inv || inv.current_stock < item.quantity) {
              throw Object.assign(
                new Error(`교환출고 재고 부족: ${item.manufacturer} ${item.model_name} (현재: ${inv ? inv.current_stock : 0}개)`),
                { statusCode: 400 }
              );
            }
          }
        }

        // 반품 품목 재고 증가
        for (const item of order.return_items) {
          const inv = await getInv(db, item.manufacturer, item.model_name, item.spec);
          if (inv) {
            await db.runAsync(
              `UPDATE inventory
               SET current_stock  = current_stock + ?,
                   normal_returns = normal_returns + ?,
                   updated_at     = ?
               WHERE id = ?`,
              [item.quantity, item.quantity, n, inv.id]
            );
          } else {
            console.warn(`[Returns] 교환완료 - 반품재고 없어 신규 생성: ${item.manufacturer} ${item.model_name}`);
            await db.runAsync(
              `INSERT INTO inventory
                 (id, category, product_type, spec, manufacturer, model_name, condition_type,
                  current_stock, avg_purchase_price, total_inbound, total_outbound,
                  normal_returns, has_temp_purchase, updated_at)
               VALUES (?, ?, 'general', ?, ?, ?, 'normal', ?, 0, 0, 0, ?, 0, ?)`,
              [uuidv4(), item.category || null, (item.spec || '').toLowerCase().trim(),
               item.manufacturer, item.model_name,
               item.quantity, item.quantity, n]
            );
          }
        }

        // 교환 출고 처리
        if (order.exchange_items && order.exchange_items.length > 0) {
          const exOrderId = uuidv4();
          let   exTotal   = 0;

          await db.runAsync(
            `INSERT INTO outbound_orders
               (id, order_date, sales_vendor_id, vendor_name, tax_type, total_price, notes, exchange_return_id, created_at, created_by)
             VALUES (?, ?, ?, ?, 'none', 0, ?, ?, ?, ?)`,
            [exOrderId, order.received_at, order.sales_vendor_id || null, order.vendor_name || null,
             `교환출고 (접수번호: ${order.id.slice(0,8)})`, order.id, n, req.user.id]
          );

          for (const item of order.exchange_items) {
            const inv       = await getInv(db, item.manufacturer, item.model_name, item.spec);
            const qty       = item.quantity;
            const salePrice = item.sale_price || 0;
            const avgPrice  = inv.avg_purchase_price || 0;
            const profitUnit= salePrice - avgPrice;
            const total     = qty * salePrice;
            exTotal += total;

            await db.runAsync(
              `INSERT INTO outbound_items
                 (id, order_id, category, manufacturer, model_name, spec, quantity, sale_price,
                  tax_amount, total_price, avg_purchase_price, profit_per_unit, total_profit,
                  notes, created_at, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
              [uuidv4(), exOrderId, item.category || null, item.manufacturer, item.model_name,
               item.spec || '', qty, salePrice, total, avgPrice, profitUnit, profitUnit * qty,
               item.notes || null, n, req.user.id]
            );

            await db.runAsync(
              `UPDATE inventory
               SET current_stock   = current_stock - ?,
                   total_outbound  = total_outbound + ?,
                   updated_at      = ?
               WHERE id = ?`,
              [qty, qty, n, inv.id]
            );
          }

          await db.runAsync(
            `UPDATE outbound_orders SET total_price = ? WHERE id = ?`,
            [exTotal, exOrderId]
          );
        }
      }

      // 상태 업데이트 (트랜잭션 내에서 함께 커밋)
      await db.runAsync(
        `UPDATE return_orders SET status=?, updated_at=?, updated_by=? WHERE id=?`,
        [status, n, req.user.id, req.params.id]
      );

    }); // end transaction

    const updated = await fetchReturnOrder(db, req.params.id);
    await writeAuditLog('return_orders', req.params.id, 'update',
      { status: oldStatus }, { status }, req.user.id);
    res.json(updated);
  } catch (err) {
    console.error('[Returns] 상태 변경 오류:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── DELETE /api/returns/:id ──────────────────────────────────────
// 접수대기만 삭제 가능 (admin은 모든 상태 삭제 가능)
router.delete('/:id', auth('editor'), async (req, res) => {
  try {
    const db    = getDB();
    const order = await fetchReturnOrder(db, req.params.id);
    if (!order) return res.status(404).json({ error: '반품/교환 내역을 찾을 수 없습니다.' });

    const isAdmin = req.user.role === 'admin';
    if (order.status !== 'pending' && !isAdmin)
      return res.status(400).json({ error: '접수대기 상태에서만 삭제할 수 있습니다.' });

    const n = nowStr();

    // 교환완료로 생성된 출고 주문도 함께 삭제
    if (order.status === 'exchange_done') {
      const linkedOutbound = await db.getAsync(
        `SELECT id FROM outbound_orders WHERE exchange_return_id = ? AND is_deleted = 0`,
        [req.params.id]
      );
      if (linkedOutbound) {
        await db.runAsync(
          `UPDATE outbound_orders SET is_deleted = 1, deleted_at = ? WHERE id = ?`,
          [n, linkedOutbound.id]
        );
        await db.runAsync(
          `UPDATE outbound_items SET is_deleted = 1, deleted_at = ? WHERE order_id = ?`,
          [n, linkedOutbound.id]
        );
      }
    }

    // ── 재고 역처리 (확정 상태였을 때만) ──────────────────────────
    if (order.status === 'normal') {
      for (const item of order.return_items) {
        const inv = await getInv(db, item.manufacturer, item.model_name, item.spec, 'normal');
        if (inv) {
          await db.runAsync(
            `UPDATE inventory SET current_stock = current_stock - ?, normal_returns = normal_returns - ?, updated_at = ? WHERE id = ?`,
            [item.quantity, item.quantity, n, inv.id]
          );
        }
      }
    } else if (order.status === 'defective') {
      for (const item of order.return_items) {
        const defInv = await getInv(db, item.manufacturer, item.model_name, item.spec, 'defective');
        if (defInv) {
          await db.runAsync(
            `UPDATE inventory SET current_stock = current_stock - ?, updated_at = ? WHERE id = ?`,
            [item.quantity, n, defInv.id]
          );
        }
      }
    } else if (order.status === 'exchange_done') {
      for (const item of order.return_items) {
        const inv = await getInv(db, item.manufacturer, item.model_name, item.spec, 'normal');
        if (inv) {
          await db.runAsync(
            `UPDATE inventory SET current_stock = current_stock - ?, normal_returns = normal_returns - ?, updated_at = ? WHERE id = ?`,
            [item.quantity, item.quantity, n, inv.id]
          );
        }
      }
      for (const item of order.exchange_items) {
        const inv = await getInv(db, item.manufacturer, item.model_name, item.spec, 'normal');
        if (inv) {
          await db.runAsync(
            `UPDATE inventory SET current_stock = current_stock + ?, total_outbound = total_outbound - ?, updated_at = ? WHERE id = ?`,
            [item.quantity, item.quantity, n, inv.id]
          );
        }
      }
    }

    await db.runAsync(
      `UPDATE return_orders SET is_deleted = 1, deleted_at = ? WHERE id = ?`,
      [n, req.params.id]
    );
    await moveToTrash('return_orders', req.params.id, req.user.id);
    await writeAuditLog('return_orders', req.params.id, 'delete', order, null, req.user.id);
    res.json({ message: '삭제되었습니다.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
