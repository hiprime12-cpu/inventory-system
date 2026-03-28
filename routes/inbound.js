'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getDB, nowStr } = require('../db/database');
const auth = require('../middleware/auth');
const { writeAuditLog, moveToTrash } = require('../middleware/audit');

// ══════════════════════════════════════════════
//  재고 헬퍼
// ══════════════════════════════════════════════

/** 재고 추가 + 이동평균 계산. pctChange 반환
 *  spec='': 일반상품, spec='i5 16G': 스펙상품
 *  conditionType: 'normal'|'defective'|'disposal'
 */
async function addToInventory(db, manufacturer, modelName, category, qty, price, vendorId, spec = '', conditionType = 'normal') {
  const n         = nowStr();
  const specVal   = (spec || '').toLowerCase().trim();
  const prodType  = specVal ? 'spec' : 'general';
  const inv = await db.getAsync(
    'SELECT * FROM inventory WHERE manufacturer = ? AND model_name = ? AND spec = ?',
    [manufacturer, modelName, specVal]
  );

  // 어느 stock 컬럼에 반영할지
  const stockCol = conditionType === 'defective' ? 'defective_stock'
                 : conditionType === 'disposal'  ? 'disposal_stock'
                 : 'normal_stock';

  if (!inv) {
    const initNormal    = conditionType === 'normal'    ? qty : 0;
    const initDefective = conditionType === 'defective' ? qty : 0;
    const initDisposal  = conditionType === 'disposal'  ? qty : 0;
    await db.runAsync(
      `INSERT INTO inventory
         (id, category, product_type, spec, manufacturer, model_name,
          current_stock, avg_purchase_price, total_inbound, total_outbound,
          normal_stock, defective_stock, disposal_stock, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [uuidv4(), category || null, prodType, specVal, manufacturer, modelName,
       qty, price, qty, initNormal, initDefective, initDisposal, n]
    );
    return { oldAvg: 0, newAvg: price, pctChange: 0 };
  }

  const wasZero  = inv.current_stock === 0;
  const newStock = inv.current_stock + qty;
  const oldAvg   = inv.avg_purchase_price;
  // 재고 소진 후 재매입이면 이동평균 리셋
  const newAvg   = wasZero
    ? price
    : (newStock > 0 ? (inv.current_stock * oldAvg + qty * price) / newStock : 0);
  const pctChange = oldAvg > 0 ? Math.abs(newAvg - oldAvg) / oldAvg : 0;

  const avgReason = wasZero ? '재고 소진 후 재매입 - 평균 리셋' : '입고';
  if (Math.abs(newAvg - oldAvg) > 0.001) {
    await db.runAsync(
      `INSERT INTO avg_price_history (id, manufacturer, model_name, spec, old_avg, new_avg, changed_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), manufacturer, modelName, specVal, oldAvg, newAvg, n, avgReason]
    );
  }
  await db.runAsync(
    `UPDATE inventory SET current_stock=?, avg_purchase_price=?, total_inbound=total_inbound+?,
         ${stockCol}=${stockCol}+?, updated_at=? WHERE id=?`,
    [newStock, newAvg, qty, qty, n, inv.id]
  );
  return { oldAvg, newAvg, pctChange };
}

/** 재고 차감 + 이동평균 역산 */
async function removeFromInventory(db, manufacturer, modelName, qty, price, spec = '', conditionType = 'normal') {
  const specVal = (spec || '').toLowerCase().trim();
  const inv = await db.getAsync(
    'SELECT * FROM inventory WHERE manufacturer = ? AND model_name = ? AND spec = ?',
    [manufacturer, modelName, specVal]
  );
  if (!inv) return;

  const stockCol = conditionType === 'defective' ? 'defective_stock'
                 : conditionType === 'disposal'  ? 'disposal_stock'
                 : 'normal_stock';

  const newStock = Math.max(0, inv.current_stock - qty);
  let newAvg = inv.avg_purchase_price;
  if (inv.current_stock > qty) {
    newAvg = (inv.current_stock * inv.avg_purchase_price - qty * price) / (inv.current_stock - qty);
    if (newAvg < 0) newAvg = 0;
  } else if (newStock === 0) {
    newAvg = 0;
  }
  await db.runAsync(
    `UPDATE inventory SET current_stock=?, avg_purchase_price=?,
         total_inbound=MAX(0, total_inbound-?),
         ${stockCol}=MAX(0, ${stockCol}-?), updated_at=? WHERE id=?`,
    [newStock, newAvg, qty, qty, nowStr(), inv.id]
  );
}

/** 매입가 변경 → 이동평균 재계산 */
async function recalcAvgForPriceChange(db, manufacturer, modelName, qty, oldPrice, newPrice, spec = '') {
  const specVal = (spec || '').toLowerCase().trim();
  const inv = await db.getAsync(
    'SELECT * FROM inventory WHERE manufacturer = ? AND model_name = ? AND spec = ?',
    [manufacturer, modelName, specVal]
  );
  if (!inv || inv.current_stock <= 0) return { oldAvg: 0, newAvg: 0, pctChange: 0 };

  const oldAvg  = inv.avg_purchase_price;
  const rawNew  = inv.current_stock * oldAvg - qty * oldPrice + qty * newPrice;
  const newAvg  = Math.max(0, rawNew / inv.current_stock);
  const pctChange = oldAvg > 0 ? Math.abs(newAvg - oldAvg) / oldAvg : 0;

  if (Math.abs(newAvg - oldAvg) > 0.001) {
    await db.runAsync(
      `INSERT INTO avg_price_history (id, manufacturer, model_name, spec, old_avg, new_avg, changed_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, '매입가수정')`,
      [uuidv4(), manufacturer, modelName, specVal, oldAvg, newAvg, nowStr()]
    );
  }
  await db.runAsync(
    'UPDATE inventory SET avg_purchase_price=?, updated_at=? WHERE id=?',
    [newAvg, nowStr(), inv.id]
  );
  return { oldAvg, newAvg, pctChange };
}

// ══════════════════════════════════════════════
//  스펙 자동완성
// ══════════════════════════════════════════════

// GET /specs — 브랜드+모델명 기준 기존 스펙 목록
router.get('/specs', auth('editor'), async (req, res) => {
  try {
    const { manufacturer, model_name } = req.query;
    const rows = await getDB().allAsync(
      `SELECT DISTINCT LOWER(spec) AS spec FROM inbound
       WHERE manufacturer = ? AND model_name = ?
         AND spec != '' AND is_deleted = 0
       ORDER BY spec`,
      [manufacturer || '', model_name || '']
    );
    res.json(rows.map(r => r.spec));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
//  /items/:itemId + /:id/memo 먼저 등록 (/:id CRUD 보다 앞에)
// ══════════════════════════════════════════════

// PATCH /:id/memo — 메모 자동 저장
router.patch('/:id/memo', auth('editor'), async (req, res) => {
  try {
    const db    = getDB();
    const order = await db.getAsync(
      'SELECT id FROM inbound_orders WHERE id = ? AND is_deleted = 0', [req.params.id]
    );
    if (!order) return res.status(404).json({ error: '매입 정보를 찾을 수 없습니다.' });

    const memo = req.body.memo ?? null;
    const n    = nowStr();
    await db.runAsync(
      'UPDATE inbound_orders SET notes=?, updated_at=?, updated_by=? WHERE id=?',
      [memo || null, n, req.user.id, req.params.id]
    );
    const user = await db.getAsync('SELECT name FROM users WHERE id=?', [req.user.id]);
    res.json({ notes: memo || null, updated_at: n, updated_by_name: user?.name || '-' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /items/:itemId/history
router.get('/items/:itemId/history', auth('editor'), async (req, res) => {
  try {
    const rows = await getDB().allAsync(
      `SELECT h.*, u.name AS changed_by_name
       FROM inbound_price_history h
       LEFT JOIN users u ON h.changed_by = u.id
       WHERE h.inbound_id = ?
       ORDER BY h.changed_at DESC`,
      [req.params.itemId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /items/:itemId/price
router.put('/items/:itemId/price', auth('editor'), async (req, res) => {
  try {
    const db   = getDB();
    const item = await db.getAsync(
      'SELECT * FROM inbound WHERE id = ? AND is_deleted = 0', [req.params.itemId]
    );
    if (!item) return res.status(404).json({ error: '품목을 찾을 수 없습니다.' });

    const newPrice = Number(req.body.purchase_price);
    if (!Number.isFinite(newPrice) || newPrice < 0)
      return res.status(400).json({ error: '매입가는 0 이상이어야 합니다.' });

    const oldPrice = item.purchase_price;
    const newTotal = item.quantity * newPrice;
    const n        = nowStr();

    await db.runAsync(
      `INSERT INTO inbound_price_history (id, inbound_id, old_price, new_price, changed_at, changed_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), item.id, oldPrice, newPrice, n, req.user.id]
    );
    await db.runAsync(
      'UPDATE inbound SET purchase_price=?, total_price=?, updated_at=?, updated_by=? WHERE id=?',
      [newPrice, newTotal, n, req.user.id, item.id]
    );

    let pctChange = 0;
    if (item.status === 'completed' || item.status === 'priority') {
      const result = await recalcAvgForPriceChange(
        db, item.manufacturer, item.model_name, item.quantity, oldPrice, newPrice,
        item.spec || ''
      );
      pctChange = result.pctChange;
    }

    const updated = await db.getAsync('SELECT * FROM inbound WHERE id = ?', [item.id]);
    res.json({ ...updated, pctChange });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /items/:itemId/status
router.put('/items/:itemId/status', auth('editor'), async (req, res) => {
  try {
    const db   = getDB();
    const item = await db.getAsync(
      'SELECT * FROM inbound WHERE id = ? AND is_deleted = 0', [req.params.itemId]
    );
    if (!item) return res.status(404).json({ error: '품목을 찾을 수 없습니다.' });

    const newStatus = req.body.status;
    if (!['pending', 'completed', 'priority'].includes(newStatus))
      return res.status(400).json({ error: '유효하지 않은 상태입니다.' });

    const wasActive = item.status === 'completed' || item.status === 'priority';
    const isActive  = newStatus  === 'completed' || newStatus  === 'priority';
    const n = nowStr();

    await db.runAsync(
      'UPDATE inbound SET status=?, updated_at=?, updated_by=? WHERE id=?',
      [newStatus, n, req.user.id, item.id]
    );

    let pctChange = 0;
    if (!wasActive && isActive) {
      const order = await db.getAsync(
        'SELECT vendor_id FROM inbound_orders WHERE id = ?', [item.order_id]
      );
      const r = await addToInventory(
        db, item.manufacturer, item.model_name, item.category,
        item.quantity, item.purchase_price, order?.vendor_id,
        item.spec || '', item.condition_type || 'normal'
      );
      pctChange = r.pctChange;
    } else if (wasActive && !isActive) {
      await removeFromInventory(
        db, item.manufacturer, item.model_name, item.quantity, item.purchase_price,
        item.spec || '', item.condition_type || 'normal'
      );
    }

    const updated = await db.getAsync('SELECT * FROM inbound WHERE id = ?', [item.id]);
    res.json({ ...updated, pctChange });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
//  주문 CRUD
// ══════════════════════════════════════════════

// GET / — 주문 목록 (품목 요약 포함)
router.get('/', auth('editor'), async (req, res) => {
  try {
    const db     = getDB();
    const orders = await db.allAsync(
      `SELECT o.*,
         pv.company_name AS vendor_company,
         u1.name AS created_by_name,
         u2.name AS updated_by_name
       FROM inbound_orders o
       LEFT JOIN purchase_vendors pv ON o.vendor_id = pv.id
       LEFT JOIN users u1 ON o.created_by = u1.id
       LEFT JOIN users u2 ON o.updated_by = u2.id
       WHERE o.is_deleted = 0
       ORDER BY o.order_date DESC, o.created_at DESC`
    );

    const result = [];
    for (const order of orders) {
      const items = await db.allAsync(
        'SELECT * FROM inbound WHERE order_id = ? AND is_deleted = 0',
        [order.id]
      );
      const totalPrice = items.reduce((s, i) => s + i.total_price, 0);
      const statuses   = [...new Set(items.map(i => i.status))];

      // 카드 요약: category(없으면 manufacturer) 별 수량
      const byGroup = {};
      for (const it of items) {
        const key = it.category || it.manufacturer;
        byGroup[key] = (byGroup[key] || 0) + it.quantity;
      }

      result.push({
        ...order,
        vendor_name: order.vendor_name || order.vendor_company || '-',
        items,
        item_count:  items.length,
        total_price: totalPrice,
        statuses,
        summary:     byGroup,
      });
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /:id — 주문 상세
router.get('/:id', auth('editor'), async (req, res) => {
  try {
    const db    = getDB();
    const order = await db.getAsync(
      `SELECT o.*,
         pv.company_name AS vendor_company,
         u1.name AS created_by_name,
         u2.name AS updated_by_name
       FROM inbound_orders o
       LEFT JOIN purchase_vendors pv ON o.vendor_id = pv.id
       LEFT JOIN users u1 ON o.created_by = u1.id
       LEFT JOIN users u2 ON o.updated_by = u2.id
       WHERE o.id = ? AND o.is_deleted = 0`,
      [req.params.id]
    );
    if (!order) return res.status(404).json({ error: '매입 정보를 찾을 수 없습니다.' });

    const items = await db.allAsync(
      `SELECT i.*, u1.name AS created_by_name, u2.name AS updated_by_name
       FROM inbound i
       LEFT JOIN users u1 ON i.created_by = u1.id
       LEFT JOIN users u2 ON i.updated_by = u2.id
       WHERE i.order_id = ? AND i.is_deleted = 0
       ORDER BY i.created_at ASC`,
      [req.params.id]
    );

    res.json({
      ...order,
      vendor_name: order.vendor_name || order.vendor_company,
      items,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST / — 주문 생성
router.post('/', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const { order_date, vendor_id, vendor_name, items } = req.body;

    if (!order_date)    return res.status(400).json({ error: '입고날짜는 필수입니다.' });
    if (!items?.length) return res.status(400).json({ error: '품목이 없습니다.' });

    for (const it of items) {
      if (!it.manufacturer?.trim()) return res.status(400).json({ error: '브랜드는 필수입니다.' });
      if (!it.model_name?.trim())   return res.status(400).json({ error: '모델명은 필수입니다.' });
      if (!(Number(it.quantity) > 0))  return res.status(400).json({ error: '수량은 1 이상이어야 합니다.' });
      if (Number(it.purchase_price) < 0) return res.status(400).json({ error: '매입가는 0 이상이어야 합니다.' });
    }

    // 거래처 없는 경우 자동 생성 (상호명만)
    let resolvedVendorId = vendor_id || null;
    const resolvedVendorName = vendor_name?.trim() || null;

    if (!resolvedVendorId && resolvedVendorName) {
      const existing = await db.getAsync(
        'SELECT id FROM purchase_vendors WHERE company_name = ? AND is_deleted = 0',
        [resolvedVendorName]
      );
      if (existing) {
        resolvedVendorId = existing.id;
      } else {
        resolvedVendorId = uuidv4();
        await db.runAsync(
          `INSERT INTO purchase_vendors (id, company_name, same_address, created_at, created_by)
           VALUES (?, ?, 0, ?, ?)`,
          [resolvedVendorId, resolvedVendorName, nowStr(), req.user.id]
        );
      }
    }

    const orderId = uuidv4();
    const n = nowStr();

    await db.runAsync(
      `INSERT INTO inbound_orders (id, order_date, vendor_id, vendor_name, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, order_date, resolvedVendorId, resolvedVendorName, n, req.user.id]
    );

    const warnings = [];
    for (const it of items) {
      const itemId       = uuidv4();
      const qty          = Number(it.quantity);
      const price        = Number(it.purchase_price);
      const status       = it.status || 'pending';
      const specVal      = (it.spec || '').toLowerCase().trim();
      const productType  = specVal ? 'spec' : 'general';
      const condType     = it.condition_type || 'normal';

      await db.runAsync(
        `INSERT INTO inbound
           (id, order_id, category, manufacturer, model_name,
            product_type, spec, condition_type,
            quantity, purchase_price, total_price, status, notes, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [itemId, orderId, it.category?.trim() || null,
         it.manufacturer.trim(), it.model_name.trim(),
         productType, specVal, condType,
         qty, price, qty * price, status, it.notes?.trim() || null, n, req.user.id]
      );

      if (status === 'completed' || status === 'priority') {
        const r = await addToInventory(
          db, it.manufacturer.trim(), it.model_name.trim(),
          it.category?.trim() || null, qty, price, resolvedVendorId,
          specVal, condType
        );
        if (r.pctChange >= 0.3)
          warnings.push({ model: it.model_name, oldAvg: r.oldAvg, newAvg: r.newAvg, pctChange: r.pctChange });
      }
    }

    const created      = await db.getAsync('SELECT * FROM inbound_orders WHERE id = ?', [orderId]);
    const createdItems = await db.allAsync('SELECT * FROM inbound WHERE order_id = ? AND is_deleted = 0', [orderId]);
    res.status(201).json({ ...created, items: createdItems, warnings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /:id — 주문 수정 (기존 품목 교체)
router.put('/:id', auth('editor'), async (req, res) => {
  try {
    const db    = getDB();
    const order = await db.getAsync(
      'SELECT * FROM inbound_orders WHERE id = ? AND is_deleted = 0', [req.params.id]
    );
    if (!order) return res.status(404).json({ error: '매입 정보를 찾을 수 없습니다.' });

    const { order_date, vendor_id, vendor_name, items } = req.body;
    const n = nowStr();

    // 기존 품목 재고 역산
    const oldItems = await db.allAsync(
      'SELECT * FROM inbound WHERE order_id = ? AND is_deleted = 0', [req.params.id]
    );
    for (const it of oldItems) {
      if (it.status === 'completed' || it.status === 'priority')
        await removeFromInventory(db, it.manufacturer, it.model_name, it.quantity, it.purchase_price,
          it.spec || '', it.condition_type || 'normal');
    }
    await db.runAsync(
      'UPDATE inbound SET is_deleted=1, deleted_at=? WHERE order_id=? AND is_deleted=0',
      [n, req.params.id]
    );

    // 거래처 자동 생성
    let resolvedVendorId = vendor_id || null;
    const resolvedVendorName = vendor_name?.trim() || null;
    if (!resolvedVendorId && resolvedVendorName) {
      const existing = await db.getAsync(
        'SELECT id FROM purchase_vendors WHERE company_name = ? AND is_deleted = 0',
        [resolvedVendorName]
      );
      resolvedVendorId = existing ? existing.id : uuidv4();
      if (!existing) {
        await db.runAsync(
          `INSERT INTO purchase_vendors (id, company_name, same_address, created_at, created_by)
           VALUES (?, ?, 0, ?, ?)`,
          [resolvedVendorId, resolvedVendorName, n, req.user.id]
        );
      }
    }

    await db.runAsync(
      `UPDATE inbound_orders SET order_date=?, vendor_id=?, vendor_name=?,
           updated_at=?, updated_by=? WHERE id=?`,
      [order_date || order.order_date, resolvedVendorId, resolvedVendorName,
       n, req.user.id, req.params.id]
    );

    const warnings = [];
    for (const it of (items || [])) {
      const itemId      = uuidv4();
      const qty         = Number(it.quantity);
      const price       = Number(it.purchase_price);
      const status      = it.status || 'pending';
      const specVal     = (it.spec || '').toLowerCase().trim();
      const productType = specVal ? 'spec' : 'general';
      const condType    = it.condition_type || 'normal';

      await db.runAsync(
        `INSERT INTO inbound
           (id, order_id, category, manufacturer, model_name,
            product_type, spec, condition_type,
            quantity, purchase_price, total_price, status, notes,
            created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [itemId, req.params.id, it.category?.trim() || null,
         it.manufacturer.trim(), it.model_name.trim(),
         productType, specVal, condType,
         qty, price, qty * price, status, it.notes?.trim() || null,
         n, req.user.id, n, req.user.id]
      );

      if (status === 'completed' || status === 'priority') {
        const r = await addToInventory(
          db, it.manufacturer.trim(), it.model_name.trim(),
          it.category?.trim() || null, qty, price, resolvedVendorId,
          specVal, condType
        );
        if (r.pctChange >= 0.3)
          warnings.push({ model: it.model_name, oldAvg: r.oldAvg, newAvg: r.newAvg, pctChange: r.pctChange });
      }
    }

    const updated      = await db.getAsync('SELECT * FROM inbound_orders WHERE id = ?', [req.params.id]);
    const updatedItems = await db.allAsync('SELECT * FROM inbound WHERE order_id=? AND is_deleted=0', [req.params.id]);
    res.json({ ...updated, items: updatedItems, warnings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /:id — admin only
router.delete('/:id', auth('admin'), async (req, res) => {
  try {
    const db    = getDB();
    const order = await db.getAsync(
      'SELECT * FROM inbound_orders WHERE id = ? AND is_deleted = 0', [req.params.id]
    );
    if (!order) return res.status(404).json({ error: '매입 정보를 찾을 수 없습니다.' });

    const items = await db.allAsync(
      'SELECT * FROM inbound WHERE order_id = ? AND is_deleted = 0', [req.params.id]
    );
    for (const it of items) {
      if (it.status === 'completed' || it.status === 'priority')
        await removeFromInventory(db, it.manufacturer, it.model_name, it.quantity, it.purchase_price,
          it.spec || '', it.condition_type || 'normal');
    }

    const n = nowStr();
    await db.runAsync('UPDATE inbound SET is_deleted=1, deleted_at=? WHERE order_id=?', [n, req.params.id]);
    await db.runAsync('UPDATE inbound_orders SET is_deleted=1, deleted_at=? WHERE id=?', [n, req.params.id]);
    await moveToTrash('inbound_orders', req.params.id, req.user.id);
    res.json({ message: '매입이 삭제되었습니다.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
