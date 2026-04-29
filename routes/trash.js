'use strict';

const { getDB, nowStr } = require('../db/database');
const auth   = require('../middleware/auth');
const router = require('express').Router();
const { addToInventory, cleanupZeroInventory } = require('../db/inventoryHelpers');

const TABLE_LABELS = {
  inbound_orders:   '매입',
  outbound_orders:  '출고',
  return_orders:    '반품',
  purchase_vendors: '매입거래처',
  sales_vendors:    '출고거래처',
  users:            '사용자',
};

const TABLE_ICONS = {
  inbound_orders:   '📦',
  outbound_orders:  '🚚',
  return_orders:    '🔄',
  purchase_vendors: '🏢',
  sales_vendors:    '🏢',
  users:            '👤',
};

// return_orders: type에 따라 라벨 분리
function getTypeLabel(tableName, row) {
  if (tableName === 'return_orders') {
    return row?.type === 'exchange' ? '교환' : '반품';
  }
  return TABLE_LABELS[tableName] || tableName;
}
function getTypeIcon(tableName, row) {
  if (tableName === 'return_orders') return '🔄';
  return TABLE_ICONS[tableName] || '📄';
}

// 금액 포맷 (서버사이드용)
function fmtWon(v) {
  if (v == null || v === '') return '-';
  return Math.round(Number(v)).toLocaleString('ko-KR') + '원';
}

// 테이블별 요약 정보 생성
async function buildSummary(db, tableName, recordId) {
  try {
    const row = await db.getAsync(`SELECT * FROM ${tableName} WHERE id = ?`, [recordId]);
    if (!row) return { text: '(삭제된 레코드)', display_name: '(알 수 없음)' };

    if (tableName === 'inbound_orders') {
      const items = await db.allAsync(
        `SELECT * FROM inbound WHERE order_id = ? ORDER BY created_at`, [recordId]
      );
      const total = items.reduce((s, i) => s + (i.total_price || 0), 0);
      const display_name = `${row.order_date || ''} ${row.vendor_name || ''}`.trim();
      const text = [
        row.vendor_name,
        row.order_date,
        fmtWon(total),
      ].filter(Boolean).join(' / ');
      return { text, display_name, row, items, total };
    }

    if (tableName === 'outbound_orders') {
      const items = await db.allAsync(
        `SELECT * FROM outbound_items WHERE order_id = ? ORDER BY created_at`, [recordId]
      );
      const display_name = `${row.order_date || ''} ${row.vendor_name || ''}`.trim();
      const text = [
        row.vendor_name,
        row.order_date,
        fmtWon(row.total_price),
      ].filter(Boolean).join(' / ');
      return { text, display_name, row, items, total: row.total_price };
    }

    if (tableName === 'return_orders') {
      const retItems = await db.allAsync(
        `SELECT * FROM return_items WHERE return_order_id = ? ORDER BY created_at`, [recordId]
      );
      const exchItems = await db.allAsync(
        `SELECT * FROM exchange_items WHERE return_order_id = ? ORDER BY created_at`, [recordId]
      );
      const REASON_MAP = {
        change_of_mind: '단순변심',
        wrong_delivery: '오배송',
        defect_suspected: '불량의심',
        other: '기타',
      };
      const display_name = `${row.received_at || ''} ${row.vendor_name || ''}`.trim();
      const parts = [row.vendor_name, row.received_at];
      if (row.reason) parts.push(REASON_MAP[row.reason] || row.reason);
      const text = parts.filter(Boolean).join(' / ');
      return { text, display_name, row, retItems, exchItems };
    }

    if (tableName === 'purchase_vendors') {
      const name = row.company_name || row.individual_name || recordId;
      const text = [name, row.phone, row.address].filter(Boolean).join(' / ');
      return { text, display_name: name, row };
    }

    if (tableName === 'sales_vendors') {
      const name = row.company_name || recordId;
      const text = [name, row.phone].filter(Boolean).join(' / ');
      return { text, display_name: name, row };
    }

    if (tableName === 'users') {
      const name = row.name || row.username || recordId;
      const text = [name, row.phone, row.role].filter(Boolean).join(' / ');
      return { text, display_name: name, row };
    }

    return { text: recordId, display_name: recordId, row };
  } catch (e) {
    return { text: '(조회 실패)', display_name: recordId };
  }
}

// ── GET / — 휴지통 목록 ──────────────────────────────
router.get('/', auth('admin'), async (req, res) => {
  try {
    const db   = getDB();
    const { from, to, type } = req.query;

    let sql = `SELECT t.*, u.name AS deleted_by_name
               FROM trash t
               LEFT JOIN users u ON t.deleted_by = u.id
               WHERE 1=1`;
    const params = [];

    if (from) { sql += ` AND DATE(t.deleted_at) >= ?`; params.push(from); }
    if (to)   { sql += ` AND DATE(t.deleted_at) <= ?`; params.push(to); }
    if (type) {
      if (type === 'inbound')   { sql += ` AND t.table_name = 'inbound_orders'`; }
      else if (type === 'outbound') { sql += ` AND t.table_name = 'outbound_orders'`; }
      else if (type === 'return')   {
        sql += ` AND t.table_name = 'return_orders' AND EXISTS (
          SELECT 1 FROM return_orders ro WHERE ro.id = t.record_id AND ro.type = 'return'
        )`;
      }
      else if (type === 'exchange') {
        sql += ` AND t.table_name = 'return_orders' AND EXISTS (
          SELECT 1 FROM return_orders ro WHERE ro.id = t.record_id AND ro.type = 'exchange'
        )`;
      }
      else if (type === 'vendor') {
        sql += ` AND t.table_name IN ('purchase_vendors','sales_vendors')`;
      }
      else if (type === 'user') { sql += ` AND t.table_name = 'users'`; }
    }
    sql += ` ORDER BY t.deleted_at DESC`;

    const rows = await db.allAsync(sql, params);

    const items = await Promise.all(rows.map(async r => {
      const summary = await buildSummary(db, r.table_name, r.record_id);
      const rowData = summary.row || null;
      return {
        ...r,
        type_label:   getTypeLabel(r.table_name, rowData),
        type_icon:    getTypeIcon(r.table_name, rowData),
        display_name: summary.display_name,
        summary_text: summary.text,
      };
    }));

    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /:id/detail — 상세 정보 ──────────────────────
router.get('/:id/detail', auth('admin'), async (req, res) => {
  try {
    const db = getDB();
    const t  = await db.getAsync(
      `SELECT t.*, u.name AS deleted_by_name
       FROM trash t LEFT JOIN users u ON t.deleted_by = u.id
       WHERE t.id = ?`, [req.params.id]
    );
    if (!t) return res.status(404).json({ error: '휴지통 항목을 찾을 수 없습니다.' });

    const summary = await buildSummary(db, t.table_name, t.record_id);
    const row     = summary.row || null;

    const REASON_MAP = {
      change_of_mind: '단순변심',
      wrong_delivery: '오배송',
      defect_suspected: '불량의심',
      other: '기타',
    };
    const STATUS_MAP = {
      pending:          '접수대기',
      testing:          '테스트중',
      normal:           '정상확정',
      defective:        '불량확정',
      exchange_pending: '교환대기',
      exchange_done:    '교환완료',
    };
    const IB_STATUS = { pending: '입고대기', completed: '완료', priority: '우선입고' };
    const TAX_MAP   = { none: '없음', tax: '과세', tax_free: '면세' };

    let detail = {
      trash_id:       t.id,
      table_name:     t.table_name,
      record_id:      t.record_id,
      deleted_at:     t.deleted_at,
      deleted_by_name: t.deleted_by_name || '-',
      auto_delete_at: t.auto_delete_at,
      type_label:     getTypeLabel(t.table_name, row),
      type_icon:      getTypeIcon(t.table_name, row),
    };

    if (t.table_name === 'inbound_orders' && row) {
      const total = (summary.items || []).reduce((s, i) => s + (i.total_price || 0), 0);
      detail = {
        ...detail,
        order_date:  row.order_date,
        vendor_name: row.vendor_name || '-',
        total:       total,
        notes:       row.notes || '',
        items: (summary.items || []).map(i => ({
          category:       i.category || '-',
          manufacturer:   i.manufacturer || '-',
          model_name:     i.model_name || '-',
          spec:           i.spec || '',
          condition_type: i.condition_type || 'normal',
          quantity:       i.quantity,
          purchase_price: i.purchase_price,
          total_price:    i.total_price,
          status:         IB_STATUS[i.status] || i.status,
          notes:          i.notes || '',
        })),
      };
    }

    else if (t.table_name === 'outbound_orders' && row) {
      detail = {
        ...detail,
        order_date:  row.order_date,
        vendor_name: row.vendor_name || '-',
        tax_type:    TAX_MAP[row.tax_type] || row.tax_type || '-',
        total:       row.total_price,
        notes:       row.notes || '',
        items: (summary.items || []).map(i => ({
          category:      i.category || '-',
          manufacturer:  i.manufacturer || '-',
          model_name:    i.model_name || '-',
          spec:          i.spec || '',
          quantity:      i.quantity,
          sale_price:    i.sale_price,
          tax_amount:    i.tax_amount,
          total_price:   i.total_price,
          notes:         i.notes || '',
        })),
      };
    }

    else if (t.table_name === 'return_orders' && row) {
      detail = {
        ...detail,
        type_detail:  row.type === 'exchange' ? '교환' : '반품',
        received_at:  row.received_at,
        vendor_name:  row.vendor_name || '-',
        reason:       REASON_MAP[row.reason] || row.reason || '-',
        status:       STATUS_MAP[row.status] || row.status || '-',
        notes:        row.notes || '',
        ret_items: (summary.retItems || []).map(i => ({
          category:     i.category || '-',
          manufacturer: i.manufacturer || '-',
          model_name:   i.model_name || '-',
          spec:         i.spec || '',
          quantity:     i.quantity,
          condition:    i.condition || '-',
          notes:        i.notes || '',
        })),
        exch_items: (summary.exchItems || []).map(i => ({
          category:     i.category || '-',
          manufacturer: i.manufacturer || '-',
          model_name:   i.model_name || '-',
          spec:         i.spec || '',
          quantity:     i.quantity,
          sale_price:   i.sale_price,
          total_price:  i.total_price,
          notes:        i.notes || '',
        })),
      };
    }

    else if ((t.table_name === 'purchase_vendors' || t.table_name === 'sales_vendors') && row) {
      const vendor_type = t.table_name === 'purchase_vendors' ? '매입거래처' : '출고거래처';
      detail = {
        ...detail,
        vendor_type,
        company_name:    row.company_name || '',
        individual_name: row.individual_name || '',
        phone:           row.phone || '-',
        address:         row.address || '-',
        business_number: row.business_number || '-',
        remarks:         row.remarks || '',
      };
    }

    else if (t.table_name === 'users' && row) {
      const ROLE_MAP = { admin: '관리자', editor: '편집자', viewer: '뷰어' };
      detail = {
        ...detail,
        name:       row.name || '-',
        username:   row.username || '-',
        phone:      row.phone || '-',
        role:       ROLE_MAP[row.role] || row.role || '-',
        created_at: (row.created_at || '').slice(0, 16),
      };
    }

    res.json(detail);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /:id/restore — 복구 ─────────────────────────
router.post('/:id/restore', auth('admin'), async (req, res) => {
  try {
    const db = getDB();
    const t  = await db.getAsync('SELECT * FROM trash WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: '휴지통 항목을 찾을 수 없습니다.' });

    if (t.table_name === 'inbound_orders') {
      // 1. 주문 복구
      await db.runAsync(
        'UPDATE inbound_orders SET is_deleted=0, deleted_at=NULL WHERE id=?',
        [t.record_id]
      );
      // 2. 연관 품목 복구
      await db.runAsync(
        'UPDATE inbound SET is_deleted=0, deleted_at=NULL WHERE order_id=?',
        [t.record_id]
      );
      // 3. 복구된 품목 조회 후 재고 재추가
      const items = await db.allAsync(
        'SELECT * FROM inbound WHERE order_id=? AND is_deleted=0',
        [t.record_id]
      );
      const order = await db.getAsync(
        'SELECT vendor_id FROM inbound_orders WHERE id=?', [t.record_id]
      );
      for (const it of items) {
        if (it.status === 'completed' || it.status === 'priority') {
          await addToInventory(
            db, it.manufacturer, it.model_name, it.category,
            it.quantity, it.purchase_price, order?.vendor_id,
            it.spec || '', it.condition_type || 'normal'
          );
        }
      }
    } else {
      await db.runAsync(
        `UPDATE ${t.table_name} SET is_deleted=0, deleted_at=NULL WHERE id=?`,
        [t.record_id]
      );
    }

    await db.runAsync('DELETE FROM trash WHERE id=?', [req.params.id]);
    res.json({ message: '복구되었습니다.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /:id — 영구삭제 ───────────────────────────
router.delete('/:id', auth('admin'), async (req, res) => {
  try {
    const db = getDB();
    const t  = await db.getAsync('SELECT * FROM trash WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: '휴지통 항목을 찾을 수 없습니다.' });

    await db.transaction(async () => {
      if (t.table_name === 'inbound_orders') {
        // 1. 하위 품목 전체 조회
        const items = await db.allAsync(
          'SELECT * FROM inbound WHERE order_id=?', [t.record_id]
        );
        // 2. 남은 활성 입고 기준으로 평균매입가 재계산 (영구삭제 전 보정)
        const n = nowStr();
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
            if (inv) {
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
              await db.runAsync(
                `UPDATE inventory SET avg_purchase_price=?, updated_at=? WHERE id=?`,
                [newAvg, n, inv.id]
              );
            }
          }
        }
        // 3. 매입가 수정이력 삭제
        for (const it of items) {
          await db.runAsync('DELETE FROM inbound_price_history WHERE inbound_id=?', [it.id]);
        }
        // 4. 입고 품목 삭제
        await db.runAsync('DELETE FROM inbound WHERE order_id=?', [t.record_id]);
        // 5. 입고 주문 삭제
        await db.runAsync('DELETE FROM inbound_orders WHERE id=?', [t.record_id]);
        // 6. 재고 0 된 orphan row 정리
        for (const it of items) {
          if (it.status === 'completed' || it.status === 'priority') {
            await cleanupZeroInventory(db, it.manufacturer, it.model_name,
              it.spec || '', it.condition_type || 'normal', it.category);
          }
        }

      } else if (t.table_name === 'outbound_orders') {
        const obItems = await db.allAsync(
          'SELECT * FROM outbound_items WHERE order_id=?', [t.record_id]
        );
        await db.runAsync('DELETE FROM outbound_items WHERE order_id=?', [t.record_id]);
        await db.runAsync('DELETE FROM outbound_orders WHERE id=?', [t.record_id]);
        for (const it of obItems) {
          await cleanupZeroInventory(db, it.manufacturer, it.model_name,
            it.spec || '', it.condition_type || 'normal', it.category);
        }

      } else if (t.table_name === 'return_orders') {
        const retOrder = await db.getAsync('SELECT * FROM return_orders WHERE id=?', [t.record_id]);
        const retItems = retOrder ? await db.allAsync('SELECT * FROM return_items WHERE return_order_id=?', [t.record_id]) : [];
        await db.runAsync('DELETE FROM return_items WHERE return_order_id=?', [t.record_id]);
        await db.runAsync('DELETE FROM exchange_items WHERE return_order_id=?', [t.record_id]);
        await db.runAsync('DELETE FROM return_orders WHERE id=?', [t.record_id]);
        if (retOrder && retItems.length > 0) {
          const condType = retOrder.status === 'defective' ? 'defective' : 'normal';
          for (const item of retItems) {
            await cleanupZeroInventory(db, item.manufacturer, item.model_name,
              item.spec || '', condType, item.category);
          }
        }

      } else {
        await db.runAsync(`DELETE FROM ${t.table_name} WHERE id=?`, [t.record_id]);
      }

      await db.runAsync('DELETE FROM trash WHERE id=?', [req.params.id]);
    });

    res.json({ message: '영구 삭제되었습니다.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
