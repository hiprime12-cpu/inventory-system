'use strict';

const router = require('express').Router();
const { getDB } = require('../db/database');
const auth = require('../middleware/auth');

// ── GET /api/sales/items ────────────────────────────────────────
// outbound_items + 주문 정보 + 반품 수량 조인
// query: from, to (YYYY-MM-DD)
router.get('/items', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const { from, to } = req.query;

    let dateWhere = '';
    const params = [];
    if (from) { dateWhere += ' AND oo.order_date >= ?'; params.push(from); }
    if (to)   { dateWhere += ' AND oo.order_date <= ?'; params.push(to); }

    const rows = await db.allAsync(
      `SELECT
         oi.id, oi.order_id,
         oi.category, oi.manufacturer, oi.model_name, oi.spec,
         oi.condition_type,
         oi.quantity,
         oi.sale_price, oi.tax_amount, oi.total_price,
         oi.avg_purchase_price, oi.profit_per_unit, oi.total_profit,
         oi.is_priority_stock,
         oi.notes AS item_notes,
         oo.order_date, oo.vendor_name, oo.tax_type,
         oo.exchange_return_id, oo.payment_status,
         COALESCE(ri_agg.returned_qty, 0)  AS returned_qty,
         COALESCE(ri_agg.has_exchange, 0)  AS has_exchange,
         COALESCE(ri_agg.has_return,   0)  AS has_return
       FROM outbound_items oi
       JOIN outbound_orders oo ON oi.order_id = oo.id
       LEFT JOIN (
         SELECT
           CASE
             WHEN ri.outbound_item_id IS NOT NULL THEN ri.outbound_item_id
             WHEN ro.linked_outbound_id IS NOT NULL THEN (
               SELECT oi2.id FROM outbound_items oi2
               WHERE oi2.order_id      = ro.linked_outbound_id
                 AND oi2.manufacturer  = ri.manufacturer
                 AND oi2.model_name    = ri.model_name
                 AND COALESCE(oi2.spec,'') = COALESCE(ri.spec,'')
                 AND oi2.is_deleted    = 0
               LIMIT 1
             )
             ELSE (
               SELECT oi2.id FROM outbound_items oi2
               JOIN outbound_orders oo2 ON oi2.order_id = oo2.id
               WHERE oi2.manufacturer = ri.manufacturer
                 AND oi2.model_name   = ri.model_name
                 AND COALESCE(oi2.spec,'') = COALESCE(ri.spec,'')
                 AND oo2.vendor_name  = ro.vendor_name
                 AND oi2.is_deleted   = 0
                 AND oo2.is_deleted   = 0
               ORDER BY oo2.order_date DESC
               LIMIT 1
             )
           END AS target_item_id,
           SUM(ri.quantity) AS returned_qty,
           MAX(CASE WHEN ro.type = 'exchange' THEN 1 ELSE 0 END) AS has_exchange,
           MAX(CASE WHEN ro.type = 'return'   THEN 1 ELSE 0 END) AS has_return
         FROM return_items ri
         JOIN return_orders ro ON ri.return_order_id = ro.id
         WHERE ro.is_deleted = 0
           AND ro.status IN ('normal', 'defective', 'exchange_done')
         GROUP BY target_item_id
       ) ri_agg ON ri_agg.target_item_id = oi.id
       WHERE oi.is_deleted = 0 AND oo.is_deleted = 0
       ${dateWhere}
       ORDER BY oo.order_date DESC, oo.created_at DESC, oi.created_at`,
      params
    );

    // sale_type 및 순수익 보정 계산
    const result = rows.map(r => {
      const returnedQty = Math.min(r.returned_qty || 0, r.quantity);
      const netQty      = r.quantity - returnedQty;

      // B 상품 (교환 출고) — 🔄 교환으로 표시
      if (r.exchange_return_id) {
        return {
          ...r,
          returned_qty:     0,
          net_quantity:     r.quantity,
          net_total_price:  r.quantity * (r.sale_price || 0),
          net_total_profit: (r.profit_per_unit || 0) * r.quantity,
          sale_type:        'exchange',
        };
      }

      // A 상품 (교환으로 반품된 원판매) — 판매현황에서 제외
      if (r.has_exchange) return null;

      let saleType;
      if (r.has_return && returnedQty > 0) saleType = 'return_deducted';
      else saleType = 'normal';

      // 반품차감: 반품된 수량을 음수로, 순수익도 음수(환불)로 표시
      if (saleType === 'return_deducted') {
        return {
          ...r,
          returned_qty:     returnedQty,
          net_quantity:     -returnedQty,
          net_total_price:  -(returnedQty * (r.sale_price || 0)),
          net_total_profit: -((r.profit_per_unit || 0) * returnedQty),
          sale_type:        saleType,
        };
      }

      // 미입금인 경우 sale_type을 'unpaid'로 표시 (매출은 유지)
      if (r.payment_status === 'unpaid') saleType = 'unpaid';

      return {
        ...r,
        returned_qty:     returnedQty,
        net_quantity:     netQty,
        net_total_price:  netQty * (r.sale_price || 0),
        net_total_profit: (r.profit_per_unit || 0) * netQty,
        sale_type:        saleType,
      };
    }).filter(r => r !== null);

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
