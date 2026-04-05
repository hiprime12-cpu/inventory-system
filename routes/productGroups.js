'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getDB, nowStr } = require('../db/database');
const auth = require('../middleware/auth');

// ── GET / — 전체 그룹 목록 (재고 합산 포함) ─────────────────────
router.get('/', auth('viewer'), async (req, res) => {
  try {
    const db = getDB();
    const groups = await db.allAsync(`
      SELECT
        pg.id, pg.group_name, pg.category, pg.brand,
        pg.created_at, pg.updated_at,
        COUNT(DISTINCT pgi.id) AS item_count,
        COALESCE(SUM(CASE WHEN inv.condition_type='normal'    THEN inv.current_stock ELSE 0 END), 0) AS normal_stock,
        COALESCE(SUM(CASE WHEN inv.condition_type='defective' THEN inv.current_stock ELSE 0 END), 0) AS defective_stock,
        COALESCE(SUM(CASE WHEN inv.condition_type='disposal'  THEN inv.current_stock ELSE 0 END), 0) AS disposal_stock,
        COALESCE(SUM(inv.current_stock), 0) AS total_stock
      FROM product_groups pg
      LEFT JOIN product_group_items pgi ON pgi.group_id = pg.id
      LEFT JOIN inventory inv
        ON inv.manufacturer = pgi.manufacturer
        AND inv.model_name  = pgi.model_name
        AND COALESCE(inv.spec,'') = COALESCE(pgi.spec,'')
      GROUP BY pg.id, pg.group_name, pg.category, pg.brand, pg.created_at, pg.updated_at
      ORDER BY pg.group_name
    `);
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /search?q=xxx — 이름 검색 (재고 검색 연동용) ────────────
router.get('/search', auth('viewer'), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);

    const db = getDB();
    const groups = await db.allAsync(
      `SELECT id, group_name, category, brand FROM product_groups
       WHERE LOWER(group_name) LIKE LOWER(?)
       ORDER BY group_name`,
      [`%${q}%`]
    );
    if (!groups.length) return res.json([]);

    const result = [];
    for (const g of groups) {
      const items = await db.allAsync(
        `SELECT * FROM product_group_items WHERE group_id = ?`,
        [g.id]
      );
      let normalStock = 0, defectiveStock = 0, disposalStock = 0;
      for (const item of items) {
        const rows = await db.allAsync(`
          SELECT condition_type, COALESCE(SUM(current_stock), 0) AS stock
          FROM inventory
          WHERE manufacturer = ? AND model_name = ? AND COALESCE(spec,'') = ?
          GROUP BY condition_type
        `, [item.manufacturer, item.model_name, item.spec || '']);
        for (const row of rows) {
          if (row.condition_type === 'normal')    normalStock    += Number(row.stock);
          if (row.condition_type === 'defective') defectiveStock += Number(row.stock);
          if (row.condition_type === 'disposal')  disposalStock  += Number(row.stock);
        }
      }
      result.push({
        ...g,
        items,
        normal_stock:    normalStock,
        defective_stock: defectiveStock,
        disposal_stock:  disposalStock,
        total_stock:     normalStock + defectiveStock + disposalStock,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /:id — 그룹 상세 (항목 + 재고 현황) ─────────────────────
router.get('/:id', auth('viewer'), async (req, res) => {
  try {
    const db = getDB();
    const group = await db.getAsync(
      `SELECT * FROM product_groups WHERE id = ?`, [req.params.id]
    );
    if (!group) return res.status(404).json({ error: '그룹을 찾을 수 없습니다.' });

    const items = await db.allAsync(
      `SELECT * FROM product_group_items WHERE group_id = ? ORDER BY created_at`,
      [req.params.id]
    );

    const itemsWithStock = await Promise.all(items.map(async item => {
      const stocks = await db.allAsync(`
        SELECT condition_type, current_stock
        FROM inventory
        WHERE manufacturer = ? AND model_name = ? AND COALESCE(spec,'') = ?
      `, [item.manufacturer, item.model_name, item.spec || '']);
      const sm = {};
      stocks.forEach(s => { sm[s.condition_type] = s.current_stock; });
      return {
        ...item,
        normal_stock:    sm.normal    || 0,
        defective_stock: sm.defective || 0,
        disposal_stock:  sm.disposal  || 0,
      };
    }));

    res.json({ ...group, items: itemsWithStock });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST / — 그룹 생성 ───────────────────────────────────────────
router.post('/', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const { group_name, category, brand, items = [] } = req.body;
    if (!group_name?.trim()) return res.status(400).json({ error: '그룹명을 입력하세요.' });

    const id  = uuidv4();
    const now = nowStr();
    const by  = req.user?.name || req.user?.id || '';

    await db.runAsync(
      `INSERT INTO product_groups (id, group_name, category, brand, created_at, created_by, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, group_name.trim(), category || null, brand || null, now, by, now, by]
    );
    for (const item of items) {
      if (!item.manufacturer || !item.model_name) continue;
      await db.runAsync(
        `INSERT INTO product_group_items (id, group_id, manufacturer, model_name, spec, created_at, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [uuidv4(), id, item.manufacturer, item.model_name, item.spec || '', now, by]
      );
    }
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /:id — 그룹 수정 ────────────────────────────────────────
router.put('/:id', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    const { group_name, category, brand, items = [] } = req.body;
    if (!group_name?.trim()) return res.status(400).json({ error: '그룹명을 입력하세요.' });

    const exists = await db.getAsync(`SELECT id FROM product_groups WHERE id = ?`, [req.params.id]);
    if (!exists) return res.status(404).json({ error: '그룹을 찾을 수 없습니다.' });

    const now = nowStr();
    const by  = req.user?.name || req.user?.id || '';

    await db.runAsync(
      `UPDATE product_groups SET group_name=?, category=?, brand=?, updated_at=?, updated_by=? WHERE id=?`,
      [group_name.trim(), category || null, brand || null, now, by, req.params.id]
    );
    await db.runAsync(`DELETE FROM product_group_items WHERE group_id = ?`, [req.params.id]);
    for (const item of items) {
      if (!item.manufacturer || !item.model_name) continue;
      await db.runAsync(
        `INSERT INTO product_group_items (id, group_id, manufacturer, model_name, spec, created_at, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [uuidv4(), req.params.id, item.manufacturer, item.model_name, item.spec || '', now, by]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /:id — 그룹 삭제 ─────────────────────────────────────
router.delete('/:id', auth('editor'), async (req, res) => {
  try {
    const db = getDB();
    await db.runAsync(`DELETE FROM product_group_items WHERE group_id = ?`, [req.params.id]);
    await db.runAsync(`DELETE FROM product_groups WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
