'use strict';

const { v4: uuidv4 } = require('uuid');
const { nowStr } = require('./database');

/** 재고 추가 + 이동평균 계산. pctChange 반환 */
async function addToInventory(db, manufacturer, modelName, category, qty, price, vendorId, spec = '', conditionType = 'normal') {
  const n        = nowStr();
  const specVal  = (spec || '').toLowerCase().trim();
  const prodType = specVal ? 'spec' : 'general';
  const ct       = conditionType || 'normal';
  const catVal   = (category || '').trim().toLowerCase();

  const inv = await db.getAsync(
    `SELECT * FROM inventory WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=? AND condition_type=? AND LOWER(COALESCE(category,''))=?`,
    [manufacturer, modelName, specVal, ct, catVal]
  );

  if (!inv) {
    const initAvg = ct === 'disposal' ? 0 : price;
    await db.runAsync(
      `INSERT INTO inventory
         (id, category, product_type, spec, manufacturer, model_name, condition_type,
          current_stock, avg_purchase_price, total_inbound, total_outbound, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [uuidv4(), catVal || null, prodType, specVal, manufacturer, modelName, ct,
       qty, initAvg, qty, n]
    );
    return { oldAvg: 0, newAvg: initAvg, pctChange: 0 };
  }

  const wasZero  = inv.current_stock === 0;
  const newStock = inv.current_stock + qty;
  const oldAvg   = inv.avg_purchase_price;
  const newAvg   = ct === 'disposal' ? 0
    : wasZero ? price
    : (newStock > 0 ? (inv.current_stock * oldAvg + qty * price) / newStock : 0);
  const pctChange = oldAvg > 0 ? Math.abs(newAvg - oldAvg) / oldAvg : 0;

  if (ct !== 'disposal' && Math.abs(newAvg - oldAvg) > 0.001) {
    const avgReason = wasZero ? '재고 소진 후 재매입 - 평균 리셋' : '입고';
    await db.runAsync(
      `INSERT INTO avg_price_history
         (id, manufacturer, model_name, spec, condition_type, old_avg, new_avg, changed_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), manufacturer, modelName, specVal, ct, oldAvg, newAvg, n, avgReason]
    );
  }
  await db.runAsync(
    `UPDATE inventory SET current_stock=?, avg_purchase_price=?,
       total_inbound=total_inbound+?, updated_at=? WHERE id=?`,
    [newStock, newAvg, qty, n, inv.id]
  );
  return { oldAvg, newAvg, pctChange };
}

/** 재고 차감 + 이동평균 역산. 재고 0 미만은 0으로 처리 */
async function removeFromInventory(db, manufacturer, modelName, qty, price, spec = '', conditionType = 'normal', category = null) {
  const specVal = (spec || '').toLowerCase().trim();
  const ct      = conditionType || 'normal';
  const catVal  = (category || '').trim().toLowerCase();
  const inv = await db.getAsync(
    `SELECT * FROM inventory WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=? AND condition_type=? AND LOWER(COALESCE(category,''))=?`,
    [manufacturer, modelName, specVal, ct, catVal]
  );
  if (!inv) return;

  if (inv.current_stock < qty) {
    console.warn(`[재고경고] ${manufacturer} ${modelName}(${specVal||'-'}) 차감 수량(${qty})이 현재 재고(${inv.current_stock})보다 많습니다. 재고를 0으로 처리합니다.`);
  }

  const newStock = Math.max(0, inv.current_stock - qty);
  let newAvg = inv.avg_purchase_price;
  if (ct !== 'disposal') {
    if (inv.current_stock > qty) {
      newAvg = (inv.current_stock * inv.avg_purchase_price - qty * price) / (inv.current_stock - qty);
      if (newAvg < 0) newAvg = 0;
    } else {
      newAvg = 0;
    }
  }
  const newTotalInbound = Math.max(0, (inv.total_inbound || 0) - qty);
  await db.runAsync(
    `UPDATE inventory SET current_stock=?, avg_purchase_price=?,
       total_inbound=?, updated_at=? WHERE id=?`,
    [newStock, newAvg, newTotalInbound, nowStr(), inv.id]
  );
}

/** 재고 수량이 0이고 활성 입고/출고 이력이 없는 orphan row 삭제. true 반환 시 삭제 */
async function cleanupZeroInventory(db, manufacturer, modelName, spec = '', conditionType = 'normal', category = null) {
  const specVal = (spec || '').toLowerCase().trim();
  const ct      = conditionType || 'normal';
  const catVal  = (category || '').trim().toLowerCase();

  const inv = await db.getAsync(
    `SELECT id, current_stock FROM inventory
     WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=? AND condition_type=?
       AND LOWER(COALESCE(category,''))=?`,
    [manufacturer, modelName, specVal, ct, catVal]
  );
  if (!inv || inv.current_stock > 0) return false;

  const hasInbound = await db.getAsync(
    `SELECT 1 FROM inbound
     WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=? AND condition_type=?
       AND LOWER(COALESCE(category,''))=?
       AND status IN ('completed','priority') AND is_deleted=0 LIMIT 1`,
    [manufacturer, modelName, specVal, ct, catVal]
  );
  if (hasInbound) return false;

  const hasOutbound = await db.getAsync(
    `SELECT 1 FROM outbound_items
     WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=?
       AND condition_type=?
       AND LOWER(COALESCE(category,''))=? AND is_deleted=0 LIMIT 1`,
    [manufacturer, modelName, specVal, ct, catVal]
  );
  if (hasOutbound) return false;

  await db.runAsync('DELETE FROM inventory WHERE id=?', [inv.id]);
  return true;
}

/** 매입가 변경 → 이동평균 재계산 */
async function recalcAvgForPriceChange(db, manufacturer, modelName, qty, oldPrice, newPrice, spec = '', conditionType = 'normal') {
  const specVal = (spec || '').toLowerCase().trim();
  const ct      = conditionType || 'normal';
  if (ct === 'disposal') return { oldAvg: 0, newAvg: 0, pctChange: 0 };

  const inv = await db.getAsync(
    `SELECT * FROM inventory WHERE manufacturer=? AND model_name=? AND COALESCE(spec,'')=? AND condition_type=?`,
    [manufacturer, modelName, specVal, ct]
  );
  if (!inv || inv.current_stock <= 0) return { oldAvg: 0, newAvg: 0, pctChange: 0 };

  const oldAvg   = inv.avg_purchase_price;
  const rawNew   = inv.current_stock * oldAvg - qty * oldPrice + qty * newPrice;
  const newAvg   = Math.max(0, rawNew / inv.current_stock);
  const pctChange = oldAvg > 0 ? Math.abs(newAvg - oldAvg) / oldAvg : 0;

  if (Math.abs(newAvg - oldAvg) > 0.001) {
    await db.runAsync(
      `INSERT INTO avg_price_history
         (id, manufacturer, model_name, spec, condition_type, old_avg, new_avg, changed_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '매입가수정')`,
      [uuidv4(), manufacturer, modelName, specVal, ct, oldAvg, newAvg, nowStr()]
    );
  }
  await db.runAsync(
    'UPDATE inventory SET avg_purchase_price=?, updated_at=? WHERE id=?',
    [newAvg, nowStr(), inv.id]
  );
  return { oldAvg, newAvg, pctChange };
}

module.exports = { addToInventory, removeFromInventory, cleanupZeroInventory, recalcAvgForPriceChange };
