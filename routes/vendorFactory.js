'use strict';

const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDB, nowStr } = require('../db/database');
const auth  = require('../middleware/auth');
const { writeAuditLog, moveToTrash } = require('../middleware/audit');

// ── 사업자등록증 업로드 multer 설정 ─────────────────────────────
const LICENSE_DIR = path.join(__dirname, '..', 'uploads', 'business-license');
fs.mkdirSync(LICENSE_DIR, { recursive: true });

const licenseStorage = multer.diskStorage({
  destination: LICENSE_DIR,
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.id}_${Date.now()}${ext}`);
  },
});

const uploadLicense = multer({
  storage: licenseStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter(req, file, cb) {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('jpg, jpeg, png, pdf 파일만 업로드 가능합니다.'));
  },
});

/**
 * 매입거래처(purchase_vendors) / 출고거래처(sales_vendors) 공용 CRUD 라우터 팩토리
 * @param {string} tableName - 'purchase_vendors' | 'sales_vendors'
 */
function makeVendorRouter(tableName) {
  const router = require('express').Router();

  const isSales = tableName === 'sales_vendors';
  const isPurchase = tableName === 'purchase_vendors';

  // ── GET / ──
  router.get('/', auth('editor'), async (req, res) => {
    try {
      const orderBy = isSales
        ? 'ORDER BY v.is_important DESC, v.company_name'
        : 'ORDER BY COALESCE(v.company_name, v.individual_name)';
      const rows = await getDB().allAsync(
        `SELECT v.*,
           u1.name AS created_by_name,
           u2.name AS updated_by_name
         FROM ${tableName} v
         LEFT JOIN users u1 ON v.created_by = u1.id
         LEFT JOIN users u2 ON v.updated_by = u2.id
         WHERE v.is_deleted = 0
         ${orderBy}`
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── GET /:id ──
  router.get('/:id', auth('editor'), async (req, res) => {
    try {
      const row = await getDB().getAsync(
        `SELECT v.*,
           u1.name AS created_by_name,
           u2.name AS updated_by_name
         FROM ${tableName} v
         LEFT JOIN users u1 ON v.created_by = u1.id
         LEFT JOIN users u2 ON v.updated_by = u2.id
         WHERE v.id = ? AND v.is_deleted = 0`,
        [req.params.id]
      );
      if (!row) return res.status(404).json({ error: '거래처를 찾을 수 없습니다.' });
      res.json(row);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── POST / ──
  router.post('/', auth('editor'), async (req, res) => {
    try {
      const {
        company_name, business_number, phone,
        registered_address, delivery_address, same_address,
        notes, remarks, contact_person, name,
        bank_name, account_number, account_holder, is_important,
        // 매입거래처 전용
        vendor_type, individual_name, individual_phone, individual_notes, individual_account,
        manager_name, manager_phone,
      } = req.body;

      if (isPurchase) {
        const vt = vendor_type || 'company';
        if (vt === 'individual' && !individual_name?.trim())
          return res.status(400).json({ error: '이름은 필수입니다.' });
        if (vt === 'company' && !company_name?.trim())
          return res.status(400).json({ error: '회사명은 필수입니다.' });
      } else {
        if (!company_name?.trim())
          return res.status(400).json({ error: '상호명은 필수입니다.' });
      }

      const bizDigits   = (business_number || '').replace(/\D/g, '');
      const phoneDigits = (phone           || '').replace(/\D/g, '');

      if (bizDigits && bizDigits.length !== 10)
        return res.status(400).json({ error: '사업자번호는 숫자 10자리여야 합니다.' });
      if (phoneDigits && (phoneDigits.length < 10 || phoneDigits.length > 11))
        return res.status(400).json({ error: '전화번호는 숫자 10~11자리여야 합니다.' });

      const db  = getDB();
      const id  = uuidv4();
      const n   = nowStr();
      const del = same_address ? (registered_address || null) : (delivery_address || null);
      const accDigits = (account_number || '').replace(/\D/g, '') || null;

      let extraCols = '', extraPlaceholders = '', extraArgs = [];
      if (isSales) {
        extraCols = ', contact_person, name, bank_name, account_number, account_holder, is_important';
        extraPlaceholders = ', ?, ?, ?, ?, ?, ?';
        extraArgs = [contact_person?.trim() || null, name?.trim() || null, bank_name?.trim() || null, accDigits, account_holder?.trim() || null, is_important ? 1 : 0];
      } else if (isPurchase) {
        const vt = vendor_type || 'company';
        extraCols = ', vendor_type, individual_name, individual_phone, individual_notes, individual_account, manager_name, manager_phone';
        extraPlaceholders = ', ?, ?, ?, ?, ?, ?, ?';
        extraArgs = [
          vt,
          individual_name?.trim() || null,
          (individual_phone || '').replace(/\D/g, '') || null,
          individual_notes?.trim() || null,
          (individual_account || '').replace(/\D/g, '') || null,
          manager_name?.trim() || null,
          (manager_phone || '').replace(/\D/g, '') || null,
        ];
      }

      await db.runAsync(
        `INSERT INTO ${tableName}
           (id, company_name, business_number, phone,
            registered_address, delivery_address, same_address,
            notes, remarks, created_at, created_by${extraCols})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${extraPlaceholders})`,
        [id, company_name?.trim() || (isPurchase && (vendor_type||'company') === 'individual' ? '' : null),
         bizDigits   || null,
         phoneDigits || null,
         registered_address?.trim() || null,
         del?.trim() || null,
         same_address ? 1 : 0,
         notes?.trim()   || null,
         remarks?.trim() || null,
         n, req.user.id, ...extraArgs]
      );

      const created = await db.getAsync(`SELECT * FROM ${tableName} WHERE id = ?`, [id]);
      await writeAuditLog(tableName, id, 'create', null, created, req.user.id);
      res.status(201).json(created);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── PUT /:id ──
  router.put('/:id', auth('editor'), async (req, res) => {
    try {
      const db  = getDB();
      const old = await db.getAsync(
        `SELECT * FROM ${tableName} WHERE id = ? AND is_deleted = 0`, [req.params.id]
      );
      if (!old) return res.status(404).json({ error: '거래처를 찾을 수 없습니다.' });

      const {
        company_name, business_number, phone,
        registered_address, delivery_address, same_address,
        notes, remarks, contact_person, name,
        bank_name, account_number, account_holder, is_important,
        // 매입거래처 전용
        vendor_type, individual_name, individual_phone, individual_notes, individual_account,
        manager_name, manager_phone,
      } = req.body;

      if (isPurchase && vendor_type) {
        const vt = vendor_type;
        if (vt === 'individual' && individual_name !== undefined && !individual_name?.trim())
          return res.status(400).json({ error: '이름은 필수입니다.' });
        if (vt === 'company' && company_name !== undefined && !company_name?.trim())
          return res.status(400).json({ error: '회사명은 필수입니다.' });
      } else if (!isPurchase) {
        if (company_name !== undefined && !company_name?.trim())
          return res.status(400).json({ error: '상호명은 필수입니다.' });
      }

      const bizDigits   = business_number !== undefined
        ? (business_number || '').replace(/\D/g, '') : null;
      const phoneDigits = phone !== undefined
        ? (phone           || '').replace(/\D/g, '') : null;

      if (bizDigits   !== null && bizDigits   && bizDigits.length !== 10)
        return res.status(400).json({ error: '사업자번호는 숫자 10자리여야 합니다.' });
      if (phoneDigits !== null && phoneDigits && (phoneDigits.length < 10 || phoneDigits.length > 11))
        return res.status(400).json({ error: '전화번호는 숫자 10~11자리여야 합니다.' });

      const n       = nowStr();
      const newSame = same_address !== undefined ? (same_address ? 1 : 0) : old.same_address;
      const newReg  = registered_address !== undefined
        ? registered_address?.trim() || null : old.registered_address;
      const newDel  = newSame
        ? newReg
        : (delivery_address !== undefined ? delivery_address?.trim() || null : old.delivery_address);
      const accDigits = account_number !== undefined
        ? (account_number || '').replace(/\D/g, '') || null : null;

      let extraSet = '', extraArgs = [];
      if (isSales) {
        extraSet = ', contact_person=?, name=?, bank_name=?, account_number=?, account_holder=?, is_important=?';
        extraArgs = [
          contact_person !== undefined ? (contact_person?.trim() || null) : old.contact_person,
          name           !== undefined ? (name?.trim()           || null) : old.name,
          bank_name    !== undefined ? (bank_name?.trim()    || null) : old.bank_name,
          account_number !== undefined ? accDigits : old.account_number,
          account_holder !== undefined ? (account_holder?.trim() || null) : old.account_holder,
          is_important !== undefined ? (is_important ? 1 : 0) : old.is_important,
        ];
      } else if (isPurchase) {
        extraSet = ', vendor_type=?, individual_name=?, individual_phone=?, individual_notes=?, individual_account=?, manager_name=?, manager_phone=?';
        extraArgs = [
          vendor_type         !== undefined ? (vendor_type || 'company') : old.vendor_type,
          individual_name     !== undefined ? (individual_name?.trim()   || null) : old.individual_name,
          individual_phone    !== undefined ? ((individual_phone||'').replace(/\D/g,'')||null) : old.individual_phone,
          individual_notes    !== undefined ? (individual_notes?.trim()  || null) : old.individual_notes,
          individual_account  !== undefined ? ((individual_account||'').replace(/\D/g,'')||null) : old.individual_account,
          manager_name        !== undefined ? (manager_name?.trim()      || null) : old.manager_name,
          manager_phone       !== undefined ? ((manager_phone||'').replace(/\D/g,'')||null) : old.manager_phone,
        ];
      }

      await db.runAsync(
        `UPDATE ${tableName}
         SET company_name=?, business_number=?, phone=?,
             registered_address=?, delivery_address=?, same_address=?,
             notes=?, remarks=?, updated_at=?, updated_by=?${extraSet}
         WHERE id=?`,
        [
          company_name !== undefined ? (company_name?.trim() || (isPurchase && (vendor_type||old.vendor_type||'company') === 'individual' ? '' : null)) : old.company_name,
          bizDigits   !== null ? (bizDigits   || null) : old.business_number,
          phoneDigits !== null ? (phoneDigits || null) : old.phone,
          newReg, newDel, newSame,
          notes   !== undefined ? (notes?.trim()   || null) : old.notes,
          remarks !== undefined ? (remarks?.trim() || null) : old.remarks,
          n, req.user.id, ...extraArgs, req.params.id,
        ]
      );

      const updated = await db.getAsync(`SELECT * FROM ${tableName} WHERE id = ?`, [req.params.id]);
      await writeAuditLog(tableName, req.params.id, 'update', old, updated, req.user.id);
      res.json(updated);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── POST /:id/license (사업자등록증 업로드) ──
  router.post('/:id/license', auth('editor'), uploadLicense.single('license'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '파일을 선택해주세요.' });
      const db  = getDB();
      const row = await db.getAsync(
        `SELECT * FROM ${tableName} WHERE id = ? AND is_deleted = 0`, [req.params.id]
      );
      if (!row) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: '거래처를 찾을 수 없습니다.' });
      }
      // 기존 파일 삭제
      if (row.business_license_file) {
        fs.unlink(path.join(LICENSE_DIR, row.business_license_file), () => {});
      }
      await db.runAsync(
        `UPDATE ${tableName} SET business_license_file=?, updated_at=?, updated_by=? WHERE id=?`,
        [req.file.filename, nowStr(), req.user.id, req.params.id]
      );
      const updated = await db.getAsync(`SELECT * FROM ${tableName} WHERE id=?`, [req.params.id]);
      res.json(updated);
    } catch (err) {
      if (req.file) fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: err.message });
    }
  });

  // ── DELETE /:id/license (사업자등록증 삭제) ──
  router.delete('/:id/license', auth('editor'), async (req, res) => {
    try {
      const db  = getDB();
      const row = await db.getAsync(
        `SELECT * FROM ${tableName} WHERE id = ? AND is_deleted = 0`, [req.params.id]
      );
      if (!row) return res.status(404).json({ error: '거래처를 찾을 수 없습니다.' });
      if (row.business_license_file) {
        fs.unlink(path.join(LICENSE_DIR, row.business_license_file), () => {});
      }
      await db.runAsync(
        `UPDATE ${tableName} SET business_license_file=NULL, updated_at=?, updated_by=? WHERE id=?`,
        [nowStr(), req.user.id, req.params.id]
      );
      const updated = await db.getAsync(`SELECT * FROM ${tableName} WHERE id=?`, [req.params.id]);
      res.json(updated);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── DELETE /:id (admin only) ──
  router.delete('/:id', auth('admin'), async (req, res) => {
    try {
      const db  = getDB();
      const row = await db.getAsync(
        `SELECT * FROM ${tableName} WHERE id = ? AND is_deleted = 0`, [req.params.id]
      );
      if (!row) return res.status(404).json({ error: '거래처를 찾을 수 없습니다.' });

      await db.runAsync(
        `UPDATE ${tableName} SET is_deleted = 1, deleted_at = ? WHERE id = ?`,
        [nowStr(), req.params.id]
      );
      await moveToTrash(tableName, req.params.id, req.user.id);
      await writeAuditLog(tableName, req.params.id, 'delete', row, null, req.user.id);
      res.json({ message: '거래처가 삭제되었습니다.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}

module.exports = makeVendorRouter;
