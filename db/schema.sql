-- ============================================================
-- 재고관리 시스템 DB 스키마
-- SQLite / PostgreSQL 공용
-- ============================================================

-- 1. 사용자
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT UNIQUE,                          -- 로그인 아이디
  phone         TEXT UNIQUE,                          -- 레거시 (하위 호환)
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (role IN ('pending', 'viewer', 'editor', 'admin')),
  created_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_by    TEXT,
  is_deleted    INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);

-- 2. 거래처 (레거시 — 사용 안 함, 하위 호환용)
CREATE TABLE IF NOT EXISTS vendors (
  id                  TEXT PRIMARY KEY,
  company_name        TEXT NOT NULL,
  business_number     TEXT,
  phone               TEXT,
  registered_address  TEXT,
  delivery_address    TEXT,
  same_address        INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  remarks             TEXT,
  created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_by          TEXT,
  updated_at          TEXT,
  updated_by          TEXT,
  is_deleted          INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT
);

-- 2b. 매입거래처 (입고 관련)
CREATE TABLE IF NOT EXISTS purchase_vendors (
  id                  TEXT PRIMARY KEY,
  company_name        TEXT NOT NULL,
  business_number     TEXT,
  phone               TEXT,
  registered_address  TEXT,
  delivery_address    TEXT,
  same_address        INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  remarks             TEXT,
  created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_by          TEXT,
  updated_at          TEXT,
  updated_by          TEXT,
  is_deleted          INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT
);

-- 2c. 출고거래처 (출고 관련)
CREATE TABLE IF NOT EXISTS sales_vendors (
  id                  TEXT PRIMARY KEY,
  company_name        TEXT NOT NULL,
  business_number     TEXT,
  phone               TEXT,
  registered_address  TEXT,
  delivery_address    TEXT,
  same_address        INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  remarks             TEXT,
  bank_name           TEXT,
  account_number      TEXT,
  account_holder      TEXT,
  is_important        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_by          TEXT,
  updated_at          TEXT,
  updated_by          TEXT,
  is_deleted          INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT
);

-- 3. 매입 주문 헤더
CREATE TABLE IF NOT EXISTS inbound_orders (
  id          TEXT PRIMARY KEY,
  order_date  TEXT NOT NULL,
  vendor_id   TEXT REFERENCES purchase_vendors(id),
  vendor_name TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_by  TEXT,
  updated_at  TEXT,
  updated_by  TEXT,
  is_deleted  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);

-- 4. 매입 품목
CREATE TABLE IF NOT EXISTS inbound (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES inbound_orders(id),
  category        TEXT,
  manufacturer    TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  product_type    TEXT NOT NULL DEFAULT 'general'
                    CHECK (product_type IN ('general', 'spec')),
  spec            TEXT NOT NULL DEFAULT '',
  condition_type  TEXT NOT NULL DEFAULT 'normal'
                    CHECK (condition_type IN ('normal', 'defective', 'disposal')),
  quantity        INTEGER NOT NULL DEFAULT 0,
  purchase_price  REAL NOT NULL DEFAULT 0,
  total_price     REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'priority')),
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_by      TEXT,
  updated_at      TEXT,
  updated_by      TEXT,
  is_deleted      INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT
);

-- 5. 매입가 수정이력
CREATE TABLE IF NOT EXISTS inbound_price_history (
  id          TEXT PRIMARY KEY,
  inbound_id  TEXT NOT NULL REFERENCES inbound(id),
  old_price   REAL NOT NULL,
  new_price   REAL NOT NULL,
  changed_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  changed_by  TEXT
);

-- 5. 출고
CREATE TABLE IF NOT EXISTS outbound (
  id                  TEXT PRIMARY KEY,
  outbound_date       TEXT NOT NULL,
  category            TEXT,
  manufacturer        TEXT NOT NULL,
  model_name          TEXT NOT NULL,
  product_type        TEXT NOT NULL DEFAULT 'general'
                        CHECK (product_type IN ('general', 'spec')),
  spec                TEXT NOT NULL DEFAULT '',
  quantity            INTEGER NOT NULL DEFAULT 0,
  sale_price          REAL NOT NULL DEFAULT 0,
  total_price         REAL NOT NULL DEFAULT 0,
  vendor_id           TEXT REFERENCES vendors(id),
  avg_purchase_price  REAL NOT NULL DEFAULT 0,
  profit_per_unit     REAL NOT NULL DEFAULT 0,
  total_profit        REAL NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_by          TEXT,
  updated_at          TEXT,
  updated_by          TEXT,
  is_deleted          INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT
);

-- 6. 반품불량
CREATE TABLE IF NOT EXISTS returns (
  id               TEXT PRIMARY KEY,
  return_date      TEXT NOT NULL,
  vendor_id        TEXT REFERENCES vendors(id),
  category         TEXT,
  manufacturer     TEXT NOT NULL,
  model_name       TEXT NOT NULL,
  quantity         INTEGER NOT NULL DEFAULT 0,
  reason           TEXT NOT NULL DEFAULT 'other'
                     CHECK (reason IN ('change_of_mind', 'wrong_delivery', 'defect_suspected', 'other')),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'testing', 'normal', 'defective')),
  test_result_date TEXT,
  test_result_by   TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_by       TEXT,
  updated_at       TEXT,
  updated_by       TEXT,
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT
);

-- 7. 재고 (모델별 집계)
CREATE TABLE IF NOT EXISTS inventory (
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
  updated_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  -- UNIQUE는 migrateInventoryCategoryKey 마이그레이션에서 (manufacturer, model_name, spec, condition_type, category) 로 생성
);

-- 8. 재고조정
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id               TEXT PRIMARY KEY,
  adjustment_date  TEXT NOT NULL,
  manufacturer     TEXT NOT NULL,
  model_name       TEXT NOT NULL,
  adjustment_type  TEXT NOT NULL
                     CHECK (adjustment_type IN ('shortage', 'surplus', 'temp_purchase', 'confirm_purchase')),
  quantity         INTEGER NOT NULL DEFAULT 0,
  temp_price       REAL,
  confirmed_price  REAL,
  reason           TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'temp'
                     CHECK (status IN ('temp', 'confirmed')),
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_by       TEXT,
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT
);

-- 9. 평균매입가 변동이력
CREATE TABLE IF NOT EXISTS avg_price_history (
  id           TEXT PRIMARY KEY,
  manufacturer TEXT NOT NULL,
  model_name   TEXT NOT NULL,
  spec         TEXT NOT NULL DEFAULT '',
  old_avg      REAL NOT NULL,
  new_avg      REAL NOT NULL,
  changed_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  reason       TEXT
);

-- 10. 휴지통
CREATE TABLE IF NOT EXISTS trash (
  id            TEXT PRIMARY KEY,
  table_name    TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  deleted_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  deleted_by    TEXT,
  auto_delete_at TEXT NOT NULL
);

-- 11. 감사로그
CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  table_name   TEXT NOT NULL,
  record_id    TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  old_data     TEXT,
  new_data     TEXT,
  performed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  performed_by TEXT,
  performer_name TEXT
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_purchase_vendors_name ON purchase_vendors(company_name);
CREATE INDEX IF NOT EXISTS idx_sales_vendors_name    ON sales_vendors(company_name);

CREATE INDEX IF NOT EXISTS idx_inbound_orders_date ON inbound_orders(order_date);
CREATE INDEX IF NOT EXISTS idx_outbound_date       ON outbound(outbound_date);
CREATE INDEX IF NOT EXISTS idx_outbound_model      ON outbound(manufacturer, model_name);
CREATE INDEX IF NOT EXISTS idx_returns_status      ON returns(status);
CREATE INDEX IF NOT EXISTS idx_inventory_model     ON inventory(manufacturer, model_name, spec);
CREATE INDEX IF NOT EXISTS idx_audit_table_record  ON audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_trash_auto_delete   ON trash(auto_delete_at);
CREATE INDEX IF NOT EXISTS idx_users_phone         ON users(phone);
