'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { initDB } = require('./db/database');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 정적 파일 서빙
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API 라우트
app.use('/api/auth',      require('./routes/auth'));
const makeVendorRouter = require('./routes/vendorFactory');
app.use('/api/purchase-vendors', makeVendorRouter('purchase_vendors'));
app.use('/api/sales-vendors',    makeVendorRouter('sales_vendors'));
app.use('/api/inbound',   require('./routes/inbound'));
app.use('/api/outbound',  require('./routes/outbound'));
app.use('/api/returns',   require('./routes/returns'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/sales',      require('./routes/sales'));
app.use('/api/company',         require('./routes/company'));
app.use('/api/dashboard',       require('./routes/dashboard'));

// 헬스체크 (Railway 배포용)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    env: process.env.NODE_ENV || 'development',
    db:  process.env.DATABASE_URL ? 'postgresql' : 'sqlite',
    timestamp: new Date().toISOString(),
  });
});

// SPA 폴백 (모든 미정의 경로 → index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 서버 시작
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`\n✅ 재고관리 서버 실행 중: http://localhost:${PORT}`);
      console.log(`   환경: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   DB : ${process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite'}\n`);
    });
  } catch (err) {
    console.error('❌ 서버 시작 실패:', err);
    process.exit(1);
  }
})();
