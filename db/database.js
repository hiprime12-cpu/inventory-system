'use strict';

const path = require('path');
const fs   = require('fs');

let db;

// ── PostgreSQL 어댑터 ──────────────────────────────────────────
// ? → $1, $2, ... 변환 헬퍼
function pgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function makePgAdapter(pool) {
  return {
    async runAsync(sql, params = []) {
      const { rowCount } = await pool.query(pgSql(sql), params);
      return { changes: rowCount };
    },
    async allAsync(sql, params = []) {
      const { rows } = await pool.query(pgSql(sql), params);
      return rows;
    },
    async getAsync(sql, params = []) {
      const { rows } = await pool.query(pgSql(sql), params);
      return rows[0] || null;
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    pool,
    _isPg: true,
  };
}

// ── SQLite 어댑터 (node:sqlite 빌트인 — Node.js v22+) ──────────
function makeSqliteAdapter(sqlite) {
  return {
    async runAsync(sql, params = []) {
      const info = sqlite.prepare(sql).run(...params);
      return { changes: info.changes };
    },
    async allAsync(sql, params = []) {
      return sqlite.prepare(sql).all(...params);
    },
    async getAsync(sql, params = []) {
      return sqlite.prepare(sql).get(...params) ?? null;
    },
    async transaction(fn) {
      sqlite.exec('BEGIN');
      try {
        const result = await fn();
        sqlite.exec('COMMIT');
        return result;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    sqlite,
    _isPg: false,
  };
}

// ── 마이그레이션 (기존 DB에 컬럼 추가) ────────────────────────
async function runMigrations(adapter) {
  const cols = [
    { table: 'vendors',          column: 'phone',           def: 'TEXT' },
    { table: 'vendors',          column: 'remarks',         def: 'TEXT' },
    { table: 'purchase_vendors', column: 'phone',           def: 'TEXT' },
    { table: 'purchase_vendors', column: 'remarks',         def: 'TEXT' },
    { table: 'sales_vendors',    column: 'phone',           def: 'TEXT' },
    { table: 'sales_vendors',    column: 'remarks',         def: 'TEXT' },
    { table: 'sales_vendors',    column: 'bank_name',       def: 'TEXT' },
    { table: 'sales_vendors',    column: 'account_number',  def: 'TEXT' },
    { table: 'sales_vendors',    column: 'account_holder',  def: 'TEXT' },
    { table: 'sales_vendors',    column: 'is_important',    def: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'audit_log',        column: 'performer_name',  def: 'TEXT' },
    // 상품유형 / 스펙 / 처리구분
    { table: 'inbound',          column: 'product_type',    def: "TEXT NOT NULL DEFAULT 'general'" },
    { table: 'inbound',          column: 'spec',            def: "TEXT NOT NULL DEFAULT ''" },
    { table: 'inbound',          column: 'condition_type',  def: "TEXT NOT NULL DEFAULT 'normal'" },
    { table: 'outbound',         column: 'product_type',    def: "TEXT NOT NULL DEFAULT 'general'" },
    { table: 'outbound',         column: 'spec',            def: "TEXT NOT NULL DEFAULT ''" },
    { table: 'avg_price_history', column: 'spec',           def: "TEXT NOT NULL DEFAULT ''" },
    { table: 'outbound',         column: 'sales_vendor_id', def: 'TEXT' },
    { table: 'sales_vendors',    column: 'contact_person',  def: 'TEXT' },
    { table: 'sales_vendors',    column: 'name',            def: 'TEXT' },
  ];

  for (const c of cols) {
    try {
      if (adapter._isPg) {
        await adapter.runAsync(
          `ALTER TABLE ${c.table} ADD COLUMN IF NOT EXISTS ${c.column} ${c.def}`
        );
      } else {
        const existing = adapter.sqlite
          .prepare(`PRAGMA table_info(${c.table})`).all()
          .map(r => r.name);
        if (!existing.includes(c.column)) {
          adapter.sqlite.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.def}`);
        }
      }
    } catch (err) {
      console.log(`[Migration] ${c.table}.${c.column}: ${err.message}`);
    }
  }
}

// ── Inbound 스키마 마이그레이션 ────────────────────────────────
// 기존 item-per-row 구조 → inbound_orders + inbound 구조로 전환
async function migrateInbound(adapter) {
  try {
    if (adapter._isPg) {
      // PostgreSQL: ADD COLUMN IF NOT EXISTS 사용
      await adapter.runAsync(
        `ALTER TABLE inbound ADD COLUMN IF NOT EXISTS order_id TEXT`
      );
      await adapter.runAsync(
        `ALTER TABLE inbound ADD COLUMN IF NOT EXISTS notes TEXT`
      );
    } else {
      // SQLite: order_id 컬럼 없으면 테이블 재생성
      const cols = adapter.sqlite
        .prepare('PRAGMA table_info(inbound)').all()
        .map(r => r.name);

      if (!cols.includes('order_id')) {
        console.log('[Migration] inbound 테이블 재생성 (order_id 구조로 전환)');
        adapter.sqlite.exec('DROP TABLE IF EXISTS inbound_price_history');
        adapter.sqlite.exec('DROP TABLE IF EXISTS inbound');
        adapter.sqlite.exec(`
          CREATE TABLE inbound (
            id             TEXT PRIMARY KEY,
            order_id       TEXT NOT NULL,
            category       TEXT,
            manufacturer   TEXT NOT NULL,
            model_name     TEXT NOT NULL,
            quantity       INTEGER NOT NULL DEFAULT 0,
            purchase_price REAL NOT NULL DEFAULT 0,
            total_price    REAL NOT NULL DEFAULT 0,
            status         TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','completed','priority')),
            notes          TEXT,
            created_at     TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            created_by     TEXT,
            updated_at     TEXT,
            updated_by     TEXT,
            is_deleted     INTEGER NOT NULL DEFAULT 0,
            deleted_at     TEXT
          )
        `);
        adapter.sqlite.exec(`
          CREATE TABLE IF NOT EXISTS inbound_price_history (
            id         TEXT PRIMARY KEY,
            inbound_id TEXT NOT NULL REFERENCES inbound(id),
            old_price  REAL NOT NULL,
            new_price  REAL NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            changed_by TEXT
          )
        `);
        adapter.sqlite.exec(`
          CREATE INDEX IF NOT EXISTS idx_inbound_order ON inbound(order_id)
        `);
        adapter.sqlite.exec(`
          CREATE INDEX IF NOT EXISTS idx_inbound_model ON inbound(manufacturer, model_name)
        `);
      }
    }
  } catch (err) {
    console.log('[Migration] inbound:', err.message);
  }
}

// ── Inventory 스키마 마이그레이션 ──────────────────────────────
// spec 컬럼 추가 + UNIQUE(manufacturer, model_name) → UNIQUE(manufacturer, model_name, spec)
async function migrateInventory(adapter) {
  try {
    if (adapter._isPg) {
      await adapter.runAsync(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'general'`);
      await adapter.runAsync(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS spec TEXT NOT NULL DEFAULT ''`);
      await adapter.runAsync(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS normal_stock INTEGER NOT NULL DEFAULT 0`);
      await adapter.runAsync(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS disposal_stock INTEGER NOT NULL DEFAULT 0`);
      // current_stock → normal_stock 동기화 (기존 데이터)
      await adapter.runAsync(`UPDATE inventory SET normal_stock = current_stock WHERE normal_stock = 0 AND current_stock > 0`);
      // 기존 unique constraint 제거 후 새 인덱스 생성
      await adapter.runAsync(`DROP INDEX IF EXISTS idx_inventory_model`);
      await adapter.runAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_model ON inventory(manufacturer, model_name, spec)`);
    } else {
      const cols = adapter.sqlite
        .prepare('PRAGMA table_info(inventory)').all()
        .map(r => r.name);

      if (!cols.includes('spec')) {
        console.log('[Migration] inventory 테이블 재생성 (spec + UNIQUE 변경)');
        adapter.sqlite.exec(`
          CREATE TABLE IF NOT EXISTS inventory_new (
            id                  TEXT PRIMARY KEY,
            category            TEXT,
            product_type        TEXT NOT NULL DEFAULT 'general',
            spec                TEXT NOT NULL DEFAULT '',
            manufacturer        TEXT NOT NULL,
            model_name          TEXT NOT NULL,
            current_stock       INTEGER NOT NULL DEFAULT 0,
            avg_purchase_price  REAL NOT NULL DEFAULT 0,
            total_inbound       INTEGER NOT NULL DEFAULT 0,
            total_outbound      INTEGER NOT NULL DEFAULT 0,
            normal_returns      INTEGER NOT NULL DEFAULT 0,
            normal_stock        INTEGER NOT NULL DEFAULT 0,
            defective_stock     INTEGER NOT NULL DEFAULT 0,
            disposal_stock      INTEGER NOT NULL DEFAULT 0,
            pending_test        INTEGER NOT NULL DEFAULT 0,
            last_vendor_id      TEXT,
            notes               TEXT,
            updated_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            UNIQUE(manufacturer, model_name, spec)
          )
        `);
        // 기존 데이터 복사 (전부 general / spec='' / normal_stock=current_stock)
        adapter.sqlite.exec(`
          INSERT INTO inventory_new
            (id, category, product_type, spec, manufacturer, model_name,
             current_stock, avg_purchase_price, total_inbound, total_outbound,
             normal_returns, normal_stock, defective_stock, disposal_stock,
             pending_test, last_vendor_id, notes, updated_at)
          SELECT
            id, category, 'general', '', manufacturer, model_name,
            current_stock, avg_purchase_price, total_inbound, total_outbound,
            normal_returns, current_stock, defective_stock, 0,
            pending_test, last_vendor_id, notes, updated_at
          FROM inventory
        `);
        adapter.sqlite.exec('DROP TABLE inventory');
        adapter.sqlite.exec('ALTER TABLE inventory_new RENAME TO inventory');
        adapter.sqlite.exec('CREATE INDEX IF NOT EXISTS idx_inventory_model ON inventory(manufacturer, model_name, spec)');
        console.log('[Migration] inventory 테이블 재생성 완료');
      }
    }
  } catch (err) {
    console.log('[Migration] inventory:', err.message);
  }
}

// ── Company Info 테이블 마이그레이션 ───────────────────────────
async function migrateCompanyInfo(adapter) {
  try {
    if (adapter._isPg) {
      await adapter.runAsync(`
        CREATE TABLE IF NOT EXISTS company_info (
          id TEXT PRIMARY KEY DEFAULT 'main',
          company_name TEXT,
          representative TEXT,
          business_number TEXT,
          business_license_image TEXT,
          address TEXT,
          phone TEXT,
          fax TEXT,
          email TEXT,
          bank_name TEXT,
          account_number TEXT,
          account_holder TEXT,
          notes TEXT,
          updated_at TEXT,
          updated_by TEXT
        )
      `);
    } else {
      adapter.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS company_info (
          id TEXT PRIMARY KEY DEFAULT 'main',
          company_name TEXT,
          representative TEXT,
          business_number TEXT,
          business_license_image TEXT,
          address TEXT,
          phone TEXT,
          fax TEXT,
          email TEXT,
          bank_name TEXT,
          account_number TEXT,
          account_holder TEXT,
          notes TEXT,
          updated_at TEXT,
          updated_by TEXT
        )
      `);
    }
    console.log('[Migration] company_info 테이블 확인 완료');
  } catch (err) {
    console.error('[Migration] company_info 오류:', err.message);
  }
}

// ── Inventory2 마이그레이션 (has_temp_purchase, adjustment 컬럼 추가) ──────
async function migrateInventory2(adapter) {
  try {
    const newCols = [
      { table: 'inventory',             column: 'has_temp_purchase', def: 'INTEGER NOT NULL DEFAULT 0' },
      { table: 'inventory_adjustments', column: 'spec',              def: "TEXT NOT NULL DEFAULT ''" },
      { table: 'inventory_adjustments', column: 'category',          def: 'TEXT' },
      { table: 'inventory_adjustments', column: 'performer_name',    def: 'TEXT' },
    ];
    for (const c of newCols) {
      try {
        if (adapter._isPg) {
          await adapter.runAsync(
            `ALTER TABLE ${c.table} ADD COLUMN IF NOT EXISTS ${c.column} ${c.def}`
          );
        } else {
          const existing = adapter.sqlite
            .prepare(`PRAGMA table_info(${c.table})`).all()
            .map(r => r.name);
          if (!existing.includes(c.column)) {
            adapter.sqlite.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.def}`);
          }
        }
      } catch(e) { console.log(`[Migration] inv2 ${c.table}.${c.column}: ${e.message}`); }
    }
    console.log('[Migration] inventory2 컬럼 확인 완료');
  } catch (err) {
    console.log('[Migration] inventory2:', err.message);
  }
}

// ── Returns2 테이블 마이그레이션 (return_orders/return_items/exchange_items) ──
async function migrateReturns2(adapter) {
  try {
    if (adapter._isPg) {
      await adapter.runAsync(`
        CREATE TABLE IF NOT EXISTS return_orders (
          id                TEXT PRIMARY KEY,
          type              TEXT NOT NULL DEFAULT 'return',
          status            TEXT NOT NULL DEFAULT 'pending',
          received_at       TEXT NOT NULL,
          sales_vendor_id   TEXT,
          vendor_name       TEXT,
          linked_outbound_id TEXT,
          reason            TEXT NOT NULL DEFAULT 'other',
          notes             TEXT,
          created_at        TEXT NOT NULL DEFAULT NOW(),
          created_by        TEXT,
          updated_at        TEXT,
          updated_by        TEXT,
          is_deleted        INTEGER NOT NULL DEFAULT 0,
          deleted_at        TEXT
        )
      `);
      await adapter.runAsync(`
        CREATE TABLE IF NOT EXISTS return_items (
          id                TEXT PRIMARY KEY,
          return_order_id   TEXT NOT NULL,
          outbound_item_id  TEXT,
          category          TEXT,
          manufacturer      TEXT NOT NULL DEFAULT '',
          model_name        TEXT NOT NULL DEFAULT '',
          spec              TEXT NOT NULL DEFAULT '',
          quantity          INTEGER NOT NULL DEFAULT 0,
          condition         TEXT NOT NULL DEFAULT 'normal',
          notes             TEXT,
          created_at        TEXT NOT NULL DEFAULT NOW()
        )
      `);
      await adapter.runAsync(`
        CREATE TABLE IF NOT EXISTS exchange_items (
          id                TEXT PRIMARY KEY,
          return_order_id   TEXT NOT NULL,
          category          TEXT,
          manufacturer      TEXT NOT NULL DEFAULT '',
          model_name        TEXT NOT NULL DEFAULT '',
          spec              TEXT NOT NULL DEFAULT '',
          quantity          INTEGER NOT NULL DEFAULT 0,
          sale_price        REAL NOT NULL DEFAULT 0,
          total_price       REAL NOT NULL DEFAULT 0,
          notes             TEXT,
          created_at        TEXT NOT NULL DEFAULT NOW()
        )
      `);
    } else {
      adapter.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS return_orders (
          id                TEXT PRIMARY KEY,
          type              TEXT NOT NULL DEFAULT 'return'
                              CHECK (type IN ('return', 'exchange')),
          status            TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','testing','normal','defective','exchange_pending','exchange_done')),
          received_at       TEXT NOT NULL,
          sales_vendor_id   TEXT,
          vendor_name       TEXT,
          linked_outbound_id TEXT,
          reason            TEXT NOT NULL DEFAULT 'other'
                              CHECK (reason IN ('change_of_mind','wrong_delivery','defect_suspected','other')),
          notes             TEXT,
          created_at        TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          created_by        TEXT,
          updated_at        TEXT,
          updated_by        TEXT,
          is_deleted        INTEGER NOT NULL DEFAULT 0,
          deleted_at        TEXT
        )
      `);
      adapter.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS return_items (
          id                TEXT PRIMARY KEY,
          return_order_id   TEXT NOT NULL,
          outbound_item_id  TEXT,
          category          TEXT,
          manufacturer      TEXT NOT NULL DEFAULT '',
          model_name        TEXT NOT NULL DEFAULT '',
          spec              TEXT NOT NULL DEFAULT '',
          quantity          INTEGER NOT NULL DEFAULT 0,
          condition         TEXT NOT NULL DEFAULT 'normal'
                              CHECK (condition IN ('normal','defective')),
          notes             TEXT,
          created_at        TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        )
      `);
      adapter.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS exchange_items (
          id                TEXT PRIMARY KEY,
          return_order_id   TEXT NOT NULL,
          category          TEXT,
          manufacturer      TEXT NOT NULL DEFAULT '',
          model_name        TEXT NOT NULL DEFAULT '',
          spec              TEXT NOT NULL DEFAULT '',
          quantity          INTEGER NOT NULL DEFAULT 0,
          sale_price        REAL NOT NULL DEFAULT 0,
          total_price       REAL NOT NULL DEFAULT 0,
          notes             TEXT,
          created_at        TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        )
      `);
      adapter.sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_return_items_order ON return_items(return_order_id)`);
      adapter.sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_exchange_items_order ON exchange_items(return_order_id)`);
      adapter.sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_return_orders_date ON return_orders(received_at)`);
    }
    console.log('[Migration] return_orders / return_items / exchange_items 테이블 확인 완료');
  } catch (err) {
    console.log('[Migration] returns2:', err.message);
  }
}

// ── ExchangeOutbound 마이그레이션 (outbound_orders.exchange_return_id 추가) ─
async function migrateExchangeOutbound(adapter) {
  try {
    const col = { table: 'outbound_orders', column: 'exchange_return_id', def: 'TEXT' };
    if (adapter._isPg) {
      await adapter.runAsync(
        `ALTER TABLE ${col.table} ADD COLUMN IF NOT EXISTS ${col.column} ${col.def}`
      );
      // 기존 교환출고 데이터: notes 패턴으로 exchange_return_id 역추적
      await adapter.runAsync(`
        UPDATE outbound_orders
        SET exchange_return_id = (
          SELECT ro.id FROM return_orders ro
          WHERE ro.type = 'exchange' AND ro.is_deleted = 0
            AND POSITION(SUBSTRING(ro.id, 1, 8) IN outbound_orders.notes) > 0
          LIMIT 1
        )
        WHERE notes LIKE '교환출고 (접수번호: %)'
          AND (exchange_return_id IS NULL OR exchange_return_id = '')
      `);
    } else {
      const existing = adapter.sqlite
        .prepare(`PRAGMA table_info(${col.table})`).all()
        .map(r => r.name);
      if (!existing.includes(col.column)) {
        adapter.sqlite.exec(`ALTER TABLE ${col.table} ADD COLUMN ${col.column} ${col.def}`);
      }
      // 기존 교환출고 데이터: notes 패턴으로 exchange_return_id 역추적
      adapter.sqlite.exec(`
        UPDATE outbound_orders
        SET exchange_return_id = (
          SELECT ro.id FROM return_orders ro
          WHERE ro.type = 'exchange' AND ro.is_deleted = 0
            AND INSTR(outbound_orders.notes, SUBSTR(ro.id, 1, 8)) > 0
          LIMIT 1
        )
        WHERE notes LIKE '교환출고 (접수번호: %)'
          AND (exchange_return_id IS NULL OR exchange_return_id = '')
      `);
    }
    console.log('[Migration] exchange_return_id 컬럼 + 기존 데이터 확인 완료');
  } catch (err) {
    console.log('[Migration] migrateExchangeOutbound:', err.message);
  }
}

// ── Sales8 마이그레이션 (outbound_items.is_priority_stock 추가) ─
async function migrateSales8(adapter) {
  try {
    const newCols = [
      { table: 'outbound_items', column: 'is_priority_stock', def: 'INTEGER NOT NULL DEFAULT 0' },
    ];
    for (const c of newCols) {
      try {
        if (adapter._isPg) {
          await adapter.runAsync(
            `ALTER TABLE ${c.table} ADD COLUMN IF NOT EXISTS ${c.column} ${c.def}`
          );
        } else {
          const existing = adapter.sqlite
            .prepare(`PRAGMA table_info(${c.table})`).all()
            .map(r => r.name);
          if (!existing.includes(c.column)) {
            adapter.sqlite.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.def}`);
          }
        }
      } catch(e) { console.log(`[Migration] sales8 ${c.table}.${c.column}: ${e.message}`); }
    }
    console.log('[Migration] sales8 컬럼 확인 완료');
  } catch (err) {
    console.log('[Migration] sales8:', err.message);
  }
}

// ── Outbound 주문/항목 테이블 마이그레이션 ──────────────────────
async function migrateOutbound2(adapter) {
  try {
    if (adapter._isPg) {
      await adapter.runAsync(`
        CREATE TABLE IF NOT EXISTS outbound_orders (
          id              TEXT PRIMARY KEY,
          order_date      TEXT NOT NULL,
          sales_vendor_id TEXT,
          vendor_name     TEXT,
          tax_type        TEXT NOT NULL DEFAULT 'none',
          total_price     REAL NOT NULL DEFAULT 0,
          notes           TEXT,
          created_at      TEXT NOT NULL DEFAULT NOW(),
          created_by      TEXT,
          updated_at      TEXT,
          updated_by      TEXT,
          is_deleted      INTEGER NOT NULL DEFAULT 0,
          deleted_at      TEXT
        )
      `);
      await adapter.runAsync(`
        CREATE TABLE IF NOT EXISTS outbound_items (
          id                  TEXT PRIMARY KEY,
          order_id            TEXT NOT NULL,
          category            TEXT,
          manufacturer        TEXT NOT NULL DEFAULT '',
          model_name          TEXT NOT NULL DEFAULT '',
          spec                TEXT,
          quantity            INTEGER NOT NULL DEFAULT 0,
          sale_price          REAL NOT NULL DEFAULT 0,
          tax_amount          REAL NOT NULL DEFAULT 0,
          total_price         REAL NOT NULL DEFAULT 0,
          avg_purchase_price  REAL NOT NULL DEFAULT 0,
          profit_per_unit     REAL NOT NULL DEFAULT 0,
          total_profit        REAL NOT NULL DEFAULT 0,
          notes               TEXT,
          created_at          TEXT NOT NULL DEFAULT NOW(),
          created_by          TEXT,
          is_deleted          INTEGER NOT NULL DEFAULT 0,
          deleted_at          TEXT
        )
      `);
    } else {
      adapter.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS outbound_orders (
          id              TEXT PRIMARY KEY,
          order_date      TEXT NOT NULL,
          sales_vendor_id TEXT,
          vendor_name     TEXT,
          tax_type        TEXT NOT NULL DEFAULT 'none',
          total_price     REAL NOT NULL DEFAULT 0,
          notes           TEXT,
          created_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          created_by      TEXT,
          updated_at      TEXT,
          updated_by      TEXT,
          is_deleted      INTEGER NOT NULL DEFAULT 0,
          deleted_at      TEXT
        )
      `);
      adapter.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS outbound_items (
          id                  TEXT PRIMARY KEY,
          order_id            TEXT NOT NULL,
          category            TEXT,
          manufacturer        TEXT NOT NULL DEFAULT '',
          model_name          TEXT NOT NULL DEFAULT '',
          spec                TEXT,
          quantity            INTEGER NOT NULL DEFAULT 0,
          sale_price          REAL NOT NULL DEFAULT 0,
          tax_amount          REAL NOT NULL DEFAULT 0,
          total_price         REAL NOT NULL DEFAULT 0,
          avg_purchase_price  REAL NOT NULL DEFAULT 0,
          profit_per_unit     REAL NOT NULL DEFAULT 0,
          total_profit        REAL NOT NULL DEFAULT 0,
          notes               TEXT,
          created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          created_by          TEXT,
          is_deleted          INTEGER NOT NULL DEFAULT 0,
          deleted_at          TEXT
        )
      `);
      adapter.sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_ob_items_order ON outbound_items(order_id)`);
      adapter.sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_ob_orders_date ON outbound_orders(order_date)`);
    }
    console.log('[Migration] outbound_orders / outbound_items 테이블 확인 완료');
  } catch (err) {
    console.log('[Migration] outbound2:', err.message);
  }
}

// ── 스키마 초기화 ──────────────────────────────────────────────
async function initSchema(adapter) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  let sql = fs.readFileSync(schemaPath, 'utf8');

  if (adapter._isPg) {
    sql = sql
      .replace(/CURRENT_TIMESTAMP/g, 'NOW()')
      .replace(/\(CURRENT_TIMESTAMP\)/g, 'NOW()')
    ;
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await adapter.runAsync(stmt.replace(/\$\d+/g, '?')); // 스키마엔 파라미터 없음
    }
  } else {
    adapter.sqlite.exec(sql);
  }
}

// ── 현재 시각 (ISO 문자열) ─────────────────────────────────────
function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ── 관리자 계정 시드 ───────────────────────────────────────────
async function seedAdmin(adapter) {
  const bcrypt    = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');

  const adminName = process.env.ADMIN_ID || 'hiprime';
  const adminPw   = process.env.ADMIN_PW || 'admin1234';

  const existing = await adapter.getAsync(
    'SELECT id FROM users WHERE name = ? AND is_deleted = 0',
    [adminName]
  );
  if (existing) return;

  const hash = await bcrypt.hash(adminPw, 12);
  await adapter.runAsync(
    `INSERT INTO users (id, name, phone, password_hash, role, created_at)
     VALUES (?, ?, NULL, ?, 'admin', ?)`,
    [uuidv4(), adminName, hash, now()]
  );
  console.log(`[DB] 관리자 계정 생성: ${adminName}`);
}

// ── 테스트 계정 시드 ───────────────────────────────────────────
async function seedTestAccounts(adapter) {
  const bcrypt    = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');

  const accounts = [
    { name: '뷰어',   phone: '01011111111', password: 'test1234', role: 'viewer' },
    { name: '에디터', phone: '01022222222', password: 'test1234', role: 'editor' },
  ];

  for (const acc of accounts) {
    const exists = await adapter.getAsync(
      'SELECT id FROM users WHERE phone = ? AND is_deleted = 0',
      [acc.phone]
    );
    if (exists) continue;

    const hash = await bcrypt.hash(acc.password, 12);
    await adapter.runAsync(
      `INSERT INTO users (id, name, phone, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), acc.name, acc.phone, hash, acc.role, now()]
    );
    console.log(`[DB] 테스트 계정 생성: ${acc.name} (${acc.role})`);
  }
}

// ── 샘플 거래처 시드 ───────────────────────────────────────────
async function seedVendors(adapter) {
  const { v4: uuidv4 } = require('uuid');

  const purchaseSamples = [
    {
      company_name: '삼성전자 부품사',
      business_number: '1234567890',
      phone: '0212345678',
      registered_address: '서울시 강남구 테헤란로 123',
      delivery_address: '서울시 강남구 테헤란로 123',
      same_address: 1,
      notes: '삼성 정품 부품 공급업체',
      remarks: '우수 거래처',
    },
    {
      company_name: 'LG전자 유통',
      business_number: '9876543210',
      phone: '03112345678',
      registered_address: '경기도 성남시 분당구 판교로 456',
      delivery_address: '경기도 성남시 분당구 판교로 456',
      same_address: 1,
      notes: 'LG 공식 유통망',
      remarks: null,
    },
    {
      company_name: '글로벌 IT 무역',
      business_number: '5555555555',
      phone: '0232109876',
      registered_address: '서울시 마포구 홍익로 78',
      delivery_address: '서울시 용산구 한강대로 200',
      same_address: 0,
      notes: '수입 부품 전문',
      remarks: '배송주소 별도 확인 필요',
    },
  ];

  const salesSamples = [
    {
      company_name: '한국전자 유통',
      business_number: '1111111111',
      phone: '0221001000',
      registered_address: '서울시 종로구 종로 1',
      delivery_address: '서울시 종로구 종로 1',
      same_address: 1,
      notes: '국내 주요 판매처',
      remarks: null,
    },
    {
      company_name: '대한 IT 솔루션',
      business_number: '2222222222',
      phone: '03155005500',
      registered_address: '경기도 수원시 영통구 광교로 100',
      delivery_address: '경기도 수원시 영통구 광교로 100',
      same_address: 1,
      notes: '기업 대상 B2B 고객',
      remarks: '세금계산서 필수',
    },
  ];

  const insertSample = async (table, v) => {
    const exists = await adapter.getAsync(
      `SELECT id FROM ${table} WHERE company_name = ? AND is_deleted = 0`,
      [v.company_name]
    );
    if (exists) return;
    await adapter.runAsync(
      `INSERT INTO ${table}
         (id, company_name, business_number, phone, registered_address,
          delivery_address, same_address, notes, remarks, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), v.company_name, v.business_number, v.phone,
       v.registered_address, v.delivery_address, v.same_address,
       v.notes, v.remarks, now()]
    );
  };

  for (const v of purchaseSamples) await insertSample('purchase_vendors', v);
  for (const v of salesSamples)    await insertSample('sales_vendors',    v);
  console.log('[DB] 샘플 거래처 생성 완료 (매입/출고)');
}

// ── 메인 초기화 ─────────────────────────────────────────────────
async function initDB() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    db = makePgAdapter(pool);
    console.log('[DB] PostgreSQL 연결 완료');
  } else {
    // node:sqlite — Node.js v22+ 빌트인 (npm 패키지 불필요)
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(__dirname, '..', 'inventory.db');
    const sqlite = new DatabaseSync(dbPath);
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA foreign_keys = ON');
    db = makeSqliteAdapter(sqlite);
    console.log(`[DB] SQLite 연결 완료: ${dbPath}`);
  }

  await initSchema(db);
  await runMigrations(db);
  await migrateInbound(db);
  await migrateInventory(db);
  await migrateOutbound2(db);
  await migrateCompanyInfo(db);
  await migrateInventory2(db);
  await migrateReturns2(db);
  await migrateSales8(db);
  await migrateExchangeOutbound(db);
  await seedAdmin(db);
  await seedTestAccounts(db);
  await seedVendors(db);
  return db;
}

function getDB() {
  if (!db) throw new Error('DB가 초기화되지 않았습니다. initDB()를 먼저 호출하세요.');
  return db;
}

function nowStr() { return now(); }

module.exports = { initDB, getDB, nowStr };
