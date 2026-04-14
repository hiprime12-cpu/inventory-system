'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const cron    = require('node-cron');

const { initDB, getDB, nowStr } = require('./db/database');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 헬스체크 (Railway 배포용 — 인증 미들웨어 적용 전에 등록)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    env: process.env.NODE_ENV || 'development',
    db:  process.env.DATABASE_URL ? 'postgresql' : 'sqlite',
    timestamp: new Date().toISOString(),
  });
});

// 정적 파일 서빙
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API 라우트
app.use('/api/auth',           require('./routes/auth'));
const makeVendorRouter = require('./routes/vendorFactory');
app.use('/api/purchase-vendors', makeVendorRouter('purchase_vendors'));
app.use('/api/sales-vendors',    makeVendorRouter('sales_vendors'));
app.use('/api/inbound',          require('./routes/inbound'));
app.use('/api/outbound',         require('./routes/outbound'));
app.use('/api/returns',          require('./routes/returns'));
app.use('/api/inventory',        require('./routes/inventory'));
app.use('/api/sales',            require('./routes/sales'));
app.use('/api/company',          require('./routes/company'));
app.use('/api/dashboard',        require('./routes/dashboard'));
app.use('/api/trash',            require('./routes/trash'));
app.use('/api/audit-log',        require('./routes/auditLog'));

// SPA 폴백 (모든 미정의 경로 → index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 휴지통 만료 항목 자동 영구삭제 ────────────────────
async function purgeExpiredTrash() {
  try {
    const db   = getDB();
    const now  = nowStr();
    const rows = await db.allAsync(
      `SELECT * FROM trash WHERE auto_delete_at <= ?`, [now]
    );
    if (!rows.length) return;

    for (const t of rows) {
      try {
        await db.runAsync(`DELETE FROM ${t.table_name} WHERE id=?`, [t.record_id]);
      } catch (_) { /* 이미 삭제된 레코드는 무시 */ }
      await db.runAsync('DELETE FROM trash WHERE id=?', [t.id]);
    }
    console.log(`[Trash] 만료 항목 ${rows.length}개 영구 삭제 완료 (${now})`);
  } catch (err) {
    console.error('[Trash] 자동 삭제 실패:', err.message);
  }
}

// 서버 시작
const PORT = process.env.PORT || 3000;

(async () => {
  // DB 초기화 — 실패해도 서버는 시작 (healthcheck 통과 가능)
  try {
    await initDB();
    await purgeExpiredTrash();
    cron.schedule('0 15 * * *', purgeExpiredTrash, { timezone: 'Asia/Seoul' });
    console.log('[DB] 초기화 완료');
  } catch (err) {
    console.error('❌ DB 초기화 오류 (서버는 계속 실행):', err.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ 재고관리 서버 실행 중: http://localhost:${PORT}`);
    console.log(`   환경: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   DB : ${process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite'}\n`);
  });
})();
