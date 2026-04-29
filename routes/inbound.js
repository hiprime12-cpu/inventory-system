'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getDB, nowStr } = require('../db/database');
const auth = require('../middleware/auth');
const { writeAuditLog, moveToTrash } = require('../middleware/audit');
const {
  addToInventory, removeFromInventory,
  cleanupZeroInventory, recalcAvgForPriceChange,
} = require('../db/inventoryHelpers');

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
        item.spec || '', item.condition_type || 'normal'
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
      if (item.notes?.trim()) {
        const specVal = (item.spec || '').toLowerCase().trim();
        const condType = item.condition_type || 'normal';
        await db.runAsync(
          `UPDATE inventory SET notes=?, updated_at=? WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=? AND condition_type=? AND LOWER(COALESCE(category,''))=LOWER(COALESCE(?,'')`  + `)`,
          [item.notes.trim(), n, item.manufacturer, item.model_name, specVal, condType, item.category?.trim() || null]
        );
      }
    } else if (wasActive && !isActive) {
      await removeFromInventory(
        db, item.manufacturer, item.model_name, item.quantity, item.purchase_price,
        item.spec || '', item.condition_type || 'normal', item.category
      );
      await cleanupZeroInventory(db, item.manufacturer, item.model_name,
        item.spec || '', item.condition_type || 'normal', item.category);
    }

    const updated = await db.getAsync('SELECT * FROM inbound WHERE id = ?', [item.id]);
    res.json({ ...updated, pctChange });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /items/:itemId/smartstore — 스마트스토어 등록 표시 토글
router.put('/items/:itemId/smartstore', auth('editor'), async (req, res) => {
  try {
    const db   = getDB();
    const item = await db.getAsync(
      'SELECT * FROM inbound WHERE id = ? AND is_deleted = 0', [req.params.itemId]
    );
    if (!item) return res.status(404).json({ error: '품목을 찾을 수 없습니다.' });
    if (item.status !== 'completed' && item.status !== 'priority')
      return res.status(400).json({ error: '매입완료 또는 우선등록 상태인 품목만 스마트스토어 등록할 수 있습니다.' });

    const register = req.body.is_smartstore ? 1 : 0;
    const n        = nowStr();
    await db.runAsync(
      'UPDATE inbound SET is_smartstore=?, smartstore_registered_at=?, smartstore_registered_by=? WHERE id=?',
      [register, register ? n : null, register ? req.user.id : null, item.id]
    );
    res.json({ is_smartstore: register, smartstore_registered_at: register ? n : null });
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
        vendor_name:   order.vendor_name || order.vendor_company || '-',
        items,
        item_count:    items.length,
        total_price:   totalPrice,
        statuses,
        summary:       byGroup,
        has_smartstore: items.some(i => i.is_smartstore),
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
         pv.vendor_type, pv.company_name AS vendor_company,
         pv.individual_name, pv.individual_phone, pv.individual_notes, pv.individual_account,
         pv.manager_name, pv.manager_phone, pv.registered_address AS vendor_address, pv.phone AS vendor_company_phone,
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
      if ((it.condition_type || 'normal') === 'normal' && !it.manufacturer?.trim()) return res.status(400).json({ error: '브랜드는 필수입니다.' });
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
        if (it.notes?.trim()) {
          await db.runAsync(
            `UPDATE inventory SET notes=?, updated_at=? WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=? AND condition_type=?`,
            [it.notes.trim(), n, it.manufacturer.trim(), it.model_name.trim(), specVal, condType]
          );
        }
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

    // 1. 기존 품목 재고 역산
    const oldItems = await db.allAsync(
      'SELECT * FROM inbound WHERE order_id = ? AND is_deleted = 0', [req.params.id]
    );
    for (const it of oldItems) {
      if (it.status === 'completed' || it.status === 'priority')
        await removeFromInventory(db, it.manufacturer, it.model_name, it.quantity, it.purchase_price,
          it.spec || '', it.condition_type || 'normal', it.category);
    }

    // 2. 기존 품목 소프트 삭제
    await db.runAsync(
      'UPDATE inbound SET is_deleted=1, deleted_at=? WHERE order_id=? AND is_deleted=0',
      [n, req.params.id]
    );

    // 3. 재고 수량이 0이 된 orphan row 정리 (소프트 삭제 후에 체크)
    for (const it of oldItems) {
      if (it.status === 'completed' || it.status === 'priority')
        await cleanupZeroInventory(db, it.manufacturer, it.model_name,
          it.spec || '', it.condition_type || 'normal', it.category);
    }

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
        if (it.notes?.trim()) {
          await db.runAsync(
            `UPDATE inventory SET notes=?, updated_at=? WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=? AND condition_type=?`,
            [it.notes.trim(), n, it.manufacturer.trim(), it.model_name.trim(), specVal, condType]
          );
        }
      }
    }

    const updated      = await db.getAsync('SELECT * FROM inbound_orders WHERE id = ?', [req.params.id]);
    const updatedItems = await db.allAsync('SELECT * FROM inbound WHERE order_id=? AND is_deleted=0', [req.params.id]);
    res.json({ ...updated, items: updatedItems, warnings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/cleanup-orphan-inventory — 고아/불일치 재고 row 일괄 정리 (admin only)
// ?dry_run=true 이면 조회만 하고 실제 변경 없음
router.post('/admin/cleanup-orphan-inventory', auth('admin'), async (req, res) => {
  try {
    const db      = getDB();
    const dryRun  = req.query.dry_run === 'true';
    const allRows = await db.allAsync(
      `SELECT id, manufacturer, model_name, COALESCE(spec,'') AS spec, condition_type,
              LOWER(COALESCE(category,'')) AS category, current_stock
       FROM inventory`
    );

    let deleted = 0;
    let fixed   = 0;
    const kept  = [];
    const log   = [];

    for (const row of allRows) {
      // 활성 입고 합계 (category 포함)
      const ibSum = await db.getAsync(
        `SELECT COALESCE(SUM(quantity),0) AS total FROM inbound
         WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=? AND condition_type=?
           AND LOWER(COALESCE(category,''))=?
           AND status IN ('completed','priority') AND is_deleted=0`,
        [row.manufacturer, row.model_name, row.spec, row.condition_type, row.category]
      );
      // 활성 출고 합계 (category 포함, 정상 재고에서만 차감)
      const obSum = row.condition_type === 'normal'
        ? await db.getAsync(
            `SELECT COALESCE(SUM(quantity),0) AS total FROM outbound_items
             WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=?
               AND LOWER(COALESCE(category,''))=? AND is_deleted=0`,
            [row.manufacturer, row.model_name, row.spec, row.category]
          )
        : { total: 0 };

      const expectedStock = Math.max(0, (ibSum?.total || 0) - (obSum?.total || 0));

      if (expectedStock === 0) {
        if (!dryRun) await db.runAsync('DELETE FROM inventory WHERE id=?', [row.id]);
        deleted++;
        log.push(`[${dryRun?'예정:삭제':'삭제'}] ${row.manufacturer} ${row.model_name}(cat:${row.category||'-'}, spec:${row.spec||'-'}, cond:${row.condition_type}) 재고:${row.current_stock}→0`);
      } else if (expectedStock !== row.current_stock) {
        if (!dryRun) await db.runAsync(
          'UPDATE inventory SET current_stock=?, updated_at=? WHERE id=?',
          [expectedStock, nowStr(), row.id]
        );
        fixed++;
        log.push(`[${dryRun?'예정:보정':'보정'}] ${row.manufacturer} ${row.model_name}(cat:${row.category||'-'}, spec:${row.spec||'-'}, cond:${row.condition_type}) 재고:${row.current_stock}→${expectedStock}`);
      } else {
        kept.push(`${row.manufacturer} ${row.model_name}(cat:${row.category||'-'})`);
      }
    }

    res.json({ dry_run: dryRun, deleted, fixed, kept: kept.length, log, message: `${dryRun?'[DRY RUN] ':''}삭제 ${deleted}건, 보정 ${fixed}건, 정상 ${kept.length}건` });
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

    await db.transaction(async () => {
      const n = nowStr();

      // 1. 품목 소프트 삭제 먼저 (이후 remaining 쿼리에서 제외하기 위해)
      await db.runAsync('UPDATE inbound SET is_deleted=1, deleted_at=? WHERE order_id=?', [n, req.params.id]);

      // 2. 남은 활성 입고 기준으로 평균매입가 재계산 + 재고 차감
      for (const it of items) {
        if (it.status === 'completed' || it.status === 'priority') {
          const specVal  = (it.spec || '').toLowerCase().trim();
          const condType = it.condition_type || 'normal';
          const catVal   = (it.category || '').trim().toLowerCase();
          const inv = await db.getAsync(
            `SELECT * FROM inventory
             WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=? AND condition_type=?
               AND LOWER(COALESCE(category,''))=?`,
            [it.manufacturer, it.model_name, specVal, condType, catVal]
          );
          if (!inv) continue;
          const remaining = await db.allAsync(
            `SELECT quantity, purchase_price FROM inbound
             WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=? AND condition_type=?
               AND LOWER(COALESCE(category,''))=?
               AND status IN ('completed','priority') AND is_deleted=0`,
            [it.manufacturer, it.model_name, specVal, condType, catVal]
          );
          const remQty = remaining.reduce((s, r) => s + r.quantity, 0);
          const remVal = remaining.reduce((s, r) => s + r.quantity * r.purchase_price, 0);
          const newAvg = remQty > 0 ? remVal / remQty : 0;
          const newStock = Math.max(0, inv.current_stock - it.quantity);
          const newTotalInbound = Math.max(0, (inv.total_inbound || 0) - it.quantity);
          await db.runAsync(
            `UPDATE inventory SET current_stock=?, avg_purchase_price=?, total_inbound=?, updated_at=? WHERE id=?`,
            [newStock, newAvg, newTotalInbound, n, inv.id]
          );
        }
      }

      // 3. 재고 0 된 orphan row 정리
      for (const it of items) {
        if (it.status === 'completed' || it.status === 'priority')
          await cleanupZeroInventory(db, it.manufacturer, it.model_name,
            it.spec || '', it.condition_type || 'normal', it.category);
      }

      // 4. 주문 소프트 삭제 + 휴지통 이동
      await db.runAsync('UPDATE inbound_orders SET is_deleted=1, deleted_at=? WHERE id=?', [n, req.params.id]);
      await moveToTrash('inbound_orders', req.params.id, req.user.id);
    });

    res.json({ message: '매입이 삭제되었습니다.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
