'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getDB, nowStr } = require('../db/database');
const auth  = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');

// ── Helper: 주문 목록 + 아이템 조회 ─────────────────────────────
async function fetchOrdersWithItems(db, where = 'o.is_deleted = 0', params = []) {
  const orders = await db.allAsync(`
    SELECT o.*, sv.company_name AS vendor_name_resolved,
           u1.name AS created_by_name, u2.name AS updated_by_name
    FROM outbound_orders o
    LEFT JOIN sales_vendors sv ON o.sales_vendor_id = sv.id
    LEFT JOIN users u1 ON o.created_by = u1.id
    LEFT JOIN users u2 ON o.updated_by = u2.id
    WHERE ${where}
    ORDER BY o.order_date DESC, o.created_at DESC
  `, params);
  if (!orders.length) return [];

  const ids = orders.map(o => o.id);
  const items = await db.allAsync(
    `SELECT * FROM outbound_items WHERE is_deleted = 0 AND order_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`,
    ids
  );

  const itemMap = {};
  items.forEach(it => {
    if (!itemMap[it.order_id]) itemMap[it.order_id] = [];
    itemMap[it.order_id].push(it);
  });

  return orders.map(o => {
    const orderItems = itemMap[o.id] || [];
    const summary = {};
    orderItems.forEach(it => {
      const k = it.category || it.manufacturer || '기타';
      summary[k] = (summary[k] || 0) + it.quantity;
    });
    return {
      ...o,
      vendor_name: o.vendor_name || o.vendor_name_resolved,
      items: orderItems,
      item_count: orderItems.length,
      summary,
    };
  });
}

// GET /api/outbound — all orders with items + summary (교환출고 제외)
router.get('/', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const orders = await fetchOrdersWithItems(
      db,
      "o.is_deleted = 0 AND (o.exchange_return_id IS NULL OR o.exchange_return_id = '')"
    );
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/outbound/:id — single order with items
router.get('/:id', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const orders = await fetchOrdersWithItems(db, 'o.is_deleted = 0 AND o.id = ?', [req.params.id]);
    if (!orders.length) return res.status(404).json({ error: '출고 내역을 찾을 수 없습니다.' });
    res.json(orders[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/outbound — create order + items, deduct inventory
router.post('/', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const { order_date, sales_vendor_id, vendor_name, tax_type, notes, items } = req.body;

    if (!order_date) return res.status(400).json({ error: '출고일은 필수입니다.' });
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ error: '출고 항목을 1개 이상 입력하세요.' });

    // Validate items and check stock
    for (const it of items) {
      if (!it.manufacturer || !it.model_name || !(it.quantity > 0))
        return res.status(400).json({ error: '브랜드, 모델명, 수량은 필수입니다.' });

      const inv = await db.getAsync(
        `SELECT * FROM inventory WHERE manufacturer = ? AND model_name = ? AND spec = ?`,
        [it.manufacturer, it.model_name, it.spec || '']
      ) || await db.getAsync(
        `SELECT * FROM inventory WHERE manufacturer = ? AND model_name = ?`,
        [it.manufacturer, it.model_name]
      );
      if (!inv || inv.current_stock < Number(it.quantity)) {
        return res.status(400).json({
          error: `재고 부족: ${it.manufacturer} ${it.model_name} (현재재고: ${inv ? inv.current_stock : 0}개)`
        });
      }
      it._inv = inv;
    }

    const orderId = uuidv4();
    const n = nowStr();
    const taxT = (tax_type === '10') ? '10' : 'none';

    // 우선등록 재고 유무 사전 확인
    const priorityCheckMap = {};
    for (const it of items) {
      const key = `${it.manufacturer}|${it.model_name}|${(it.spec||'').toLowerCase().trim()}`;
      if (!(key in priorityCheckMap)) {
        const pRow = await db.getAsync(
          `SELECT COALESCE(SUM(quantity),0) AS pqty FROM inbound
           WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=?
             AND status='priority' AND is_deleted=0`,
          [it.manufacturer, it.model_name, (it.spec||'').toLowerCase().trim()]
        );
        priorityCheckMap[key] = (pRow?.pqty || 0) > 0 ? 1 : 0;
      }
    }

    let orderTotal = 0;
    const itemRows = items.map(it => {
      const inv = it._inv;
      const qty = Number(it.quantity);
      const salePrice = Number(it.sale_price) || 0;
      const taxRate = taxT === '10' ? 0.1 : 0;
      const taxAmt = Math.round(qty * salePrice * taxRate);
      const rowTotal = qty * salePrice + taxAmt;
      const avgPrice = inv.avg_purchase_price || 0;
      const profitUnit = salePrice - avgPrice;
      const totalProfit = profitUnit * qty;
      const key = `${it.manufacturer}|${it.model_name}|${(it.spec||'').toLowerCase().trim()}`;
      orderTotal += rowTotal;
      return {
        id: uuidv4(),
        order_id: orderId,
        category: it.category || null,
        manufacturer: it.manufacturer,
        model_name: it.model_name,
        spec: it.spec || '',
        quantity: qty,
        sale_price: salePrice,
        tax_amount: taxAmt,
        total_price: rowTotal,
        avg_purchase_price: avgPrice,
        profit_per_unit: profitUnit,
        total_profit: totalProfit,
        is_priority_stock: priorityCheckMap[key] || 0,
        notes: it.notes || null,
        inv_id: inv.id,
      };
    });

    await db.runAsync(
      `INSERT INTO outbound_orders
         (id, order_date, sales_vendor_id, vendor_name, tax_type, total_price, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, order_date, sales_vendor_id || null, vendor_name || null, taxT,
       orderTotal, notes || null, n, req.user.id]
    );

    for (const row of itemRows) {
      await db.runAsync(
        `INSERT INTO outbound_items
           (id, order_id, category, manufacturer, model_name, spec, quantity, sale_price,
            tax_amount, total_price, avg_purchase_price, profit_per_unit, total_profit,
            is_priority_stock, notes, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.order_id, row.category, row.manufacturer, row.model_name, row.spec,
         row.quantity, row.sale_price, row.tax_amount, row.total_price,
         row.avg_purchase_price, row.profit_per_unit, row.total_profit,
         row.is_priority_stock || 0, row.notes, n, req.user.id]
      );

      await db.runAsync(
        `UPDATE inventory SET current_stock = current_stock - ?, normal_stock = normal_stock - ?,
         total_outbound = total_outbound + ?, updated_at = ? WHERE id = ?`,
        [row.quantity, row.quantity, row.quantity, n, row.inv_id]
      );
    }

    const [created] = await fetchOrdersWithItems(db, 'o.is_deleted = 0 AND o.id = ?', [orderId]);
    await writeAuditLog('outbound_orders', orderId, 'create', null, created, req.user.id);
    res.status(201).json(created);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/outbound/:id — replace items (restore old stock, check+deduct new stock)
router.put('/:id', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const [old] = await fetchOrdersWithItems(db, 'o.is_deleted = 0 AND o.id = ?', [req.params.id]);
    if (!old) return res.status(404).json({ error: '출고 내역을 찾을 수 없습니다.' });

    const { order_date, sales_vendor_id, vendor_name, tax_type, notes, items } = req.body;

    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ error: '출고 항목을 1개 이상 입력하세요.' });

    const n = nowStr();
    const taxT = (tax_type === '10') ? '10' : 'none';

    // Restore old stock
    for (const oldItem of old.items) {
      const inv = await db.getAsync(
        `SELECT id FROM inventory WHERE manufacturer = ? AND model_name = ? AND spec = ?`,
        [oldItem.manufacturer, oldItem.model_name, oldItem.spec || '']
      ) || await db.getAsync(
        `SELECT id FROM inventory WHERE manufacturer = ? AND model_name = ?`,
        [oldItem.manufacturer, oldItem.model_name]
      );
      if (inv) {
        await db.runAsync(
          `UPDATE inventory SET current_stock = current_stock + ?, normal_stock = normal_stock + ?,
           total_outbound = total_outbound - ?, updated_at = ? WHERE id = ?`,
          [oldItem.quantity, oldItem.quantity, oldItem.quantity, n, inv.id]
        );
      }
    }

    // Validate new items and check stock
    for (const it of items) {
      if (!it.manufacturer || !it.model_name || !(it.quantity > 0))
        return res.status(400).json({ error: '브랜드, 모델명, 수량은 필수입니다.' });

      const inv = await db.getAsync(
        `SELECT * FROM inventory WHERE manufacturer = ? AND model_name = ? AND spec = ?`,
        [it.manufacturer, it.model_name, it.spec || '']
      ) || await db.getAsync(
        `SELECT * FROM inventory WHERE manufacturer = ? AND model_name = ?`,
        [it.manufacturer, it.model_name]
      );
      if (!inv || inv.current_stock < Number(it.quantity)) {
        // Rollback: restore old stock already applied above — we need to reverse
        for (const oldItem of old.items) {
          const ri = await db.getAsync(
            `SELECT id FROM inventory WHERE manufacturer = ? AND model_name = ?`,
            [oldItem.manufacturer, oldItem.model_name]
          );
          if (ri) {
            await db.runAsync(
              `UPDATE inventory SET current_stock = current_stock - ?, normal_stock = normal_stock - ?,
               total_outbound = total_outbound + ?, updated_at = ? WHERE id = ?`,
              [oldItem.quantity, oldItem.quantity, oldItem.quantity, n, ri.id]
            );
          }
        }
        return res.status(400).json({
          error: `재고 부족: ${it.manufacturer} ${it.model_name} (현재재고: ${inv ? inv.current_stock : 0}개)`
        });
      }
      it._inv = inv;
    }

    // Soft-delete old items
    await db.runAsync(
      `UPDATE outbound_items SET is_deleted = 1, deleted_at = ? WHERE order_id = ? AND is_deleted = 0`,
      [n, req.params.id]
    );

    let orderTotal = 0;
    for (const it of items) {
      const inv = it._inv;
      const qty = Number(it.quantity);
      const salePrice = Number(it.sale_price) || 0;
      const taxRate = taxT === '10' ? 0.1 : 0;
      const taxAmt = Math.round(qty * salePrice * taxRate);
      const rowTotal = qty * salePrice + taxAmt;
      const avgPrice = inv.avg_purchase_price || 0;
      const profitUnit = salePrice - avgPrice;
      const totalProfit = profitUnit * qty;
      orderTotal += rowTotal;

      await db.runAsync(
        `INSERT INTO outbound_items
           (id, order_id, category, manufacturer, model_name, spec, quantity, sale_price,
            tax_amount, total_price, avg_purchase_price, profit_per_unit, total_profit, notes, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), req.params.id, it.category || null, it.manufacturer, it.model_name, it.spec || '',
         qty, salePrice, taxAmt, rowTotal, avgPrice, profitUnit, totalProfit, it.notes || null, n, req.user.id]
      );

      await db.runAsync(
        `UPDATE inventory SET current_stock = current_stock - ?, normal_stock = normal_stock - ?,
         total_outbound = total_outbound + ?, updated_at = ? WHERE id = ?`,
        [qty, qty, qty, n, inv.id]
      );
    }

    await db.runAsync(
      `UPDATE outbound_orders SET order_date=?, sales_vendor_id=?, vendor_name=?, tax_type=?,
       total_price=?, notes=?, updated_at=?, updated_by=? WHERE id=?`,
      [order_date || old.order_date, sales_vendor_id !== undefined ? (sales_vendor_id || null) : old.sales_vendor_id,
       vendor_name !== undefined ? (vendor_name || null) : old.vendor_name,
       taxT, orderTotal, notes !== undefined ? (notes || null) : old.notes,
       n, req.user.id, req.params.id]
    );

    const [updated] = await fetchOrdersWithItems(db, 'o.is_deleted = 0 AND o.id = ?', [req.params.id]);
    await writeAuditLog('outbound_orders', req.params.id, 'update', old, updated, req.user.id);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/outbound/:id — soft delete + restore stock
router.delete('/:id', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const [order] = await fetchOrdersWithItems(db, 'o.is_deleted = 0 AND o.id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: '출고 내역을 찾을 수 없습니다.' });

    const n = nowStr();

    // Restore stock for each item
    for (const it of order.items) {
      const inv = await db.getAsync(
        `SELECT id FROM inventory WHERE manufacturer = ? AND model_name = ? AND spec = ?`,
        [it.manufacturer, it.model_name, it.spec || '']
      ) || await db.getAsync(
        `SELECT id FROM inventory WHERE manufacturer = ? AND model_name = ?`,
        [it.manufacturer, it.model_name]
      );
      if (inv) {
        await db.runAsync(
          `UPDATE inventory SET current_stock = current_stock + ?, normal_stock = normal_stock + ?,
           total_outbound = total_outbound - ?, updated_at = ? WHERE id = ?`,
          [it.quantity, it.quantity, it.quantity, n, inv.id]
        );
      }
    }

    await db.runAsync(
      `UPDATE outbound_items SET is_deleted = 1, deleted_at = ? WHERE order_id = ? AND is_deleted = 0`,
      [n, req.params.id]
    );
    await db.runAsync(
      `UPDATE outbound_orders SET is_deleted = 1, deleted_at = ? WHERE id = ?`,
      [n, req.params.id]
    );

    await writeAuditLog('outbound_orders', req.params.id, 'delete', order, null, req.user.id);
    res.json({ message: '삭제되었습니다.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
