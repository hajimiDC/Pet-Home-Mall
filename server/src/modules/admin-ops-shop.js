'use strict';

const db = require('../core/db');
const { get, all, run, transaction, parseJson } = db;
const { now, toYuan } = require('../core/money');
const { Errors } = require('../core/errors');
const { hashPassword } = require('../core/auth');
const { maskPhone } = require('../core/privacy');
const v = require('../core/validate');
const svc = require('../services/admin-ops-service');

/**
 * 平台后台 · 运营域：入驻审核、店铺管理、店铺街推荐位
 * 覆盖 API-108 ~ API-113（FR-OPS-022 ~ FR-OPS-027）
 *
 * 权限码：menu.ops.shop-audit
 * 关键约束：
 *  - 入驻通过时创建 shops（owner_id=申请 user_id，name=shop_name，status=1）；
 *  - 优先复用 type='seller' 且 shop_id 为空的 admin_user（取 id 最小一条）并绑定 shop_id；
 *    无空闲账号则自动开通（account=申请手机号，初始密码 Seller@+手机号后 4 位，must_change_pwd=1）；
 *  - 店铺停用：商品 status=3、活动 status=4，并通知商家（FR-OPS-025）；
 *  - 店铺名称变更须全局唯一（FR-OPS-024 / FR-SLR-012）。
 */

const PERM_SHOP_AUDIT = 'menu.ops.shop-audit';

// ==================== API-108 入驻申请列表 ====================

/**
 * GET /api/admin/shop-applies
 * ?status=0|1|2|all（默认全部）&keyword=&startAt=&endAt=&page=&pageSize=
 * 状态：0 待审核 / 1 已通过 / 2 已驳回（shop_applies.status）
 */
function listShopApplies(ctx) {
  const params = [];
  let where = 'WHERE 1 = 1';
  const rawStatus = ctx.query.status;
  if (rawStatus !== undefined && rawStatus !== '' && rawStatus !== null && String(rawStatus).toLowerCase() !== 'all') {
    where += ' AND sa.status = ?';
    params.push(Number(v.oneOf(rawStatus, ['0', '1', '2'], 'status')));
  }
  if (ctx.query.keyword) {
    where += ' AND (sa.subject_name LIKE ? OR sa.contact LIKE ? OR sa.phone LIKE ? OR sa.shop_name LIKE ?)';
    const kw = `%${String(ctx.query.keyword).trim()}%`;
    params.push(kw, kw, kw, kw);
  }
  const startAt = svc.normTime(ctx.query.startAt, { field: 'startAt' });
  const endAt = svc.normTime(ctx.query.endAt, { field: 'endAt', endOfDay: true });
  if (startAt) { where += ' AND sa.created_at >= ?'; params.push(startAt); }
  if (endAt) { where += ' AND sa.created_at <= ?'; params.push(endAt); }

  const { page, pageSize, offset } = db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
  const total = Number(get(`SELECT COUNT(*) AS c FROM shop_applies sa ${where}`, ...params).c);
  const rows = all(
    `SELECT sa.*, u.nickname AS user_nickname, u.username AS user_username,
            s.id AS shop_id, s.name AS shop_name_existing, s.status AS shop_status
       FROM shop_applies sa
       LEFT JOIN users u ON u.id = sa.user_id
       LEFT JOIN shops s ON s.owner_id = sa.user_id
       ${where}
      ORDER BY sa.status ASC, sa.created_at DESC, sa.id DESC
      LIMIT ? OFFSET ?`,
    ...params, pageSize, offset,
  ).map(shopApplyOut);

  return {
    total,
    rows,
    page,
    pageSize,
    pendingCount: Number(get('SELECT COUNT(*) AS c FROM shop_applies WHERE status = 0').c),
  };
}

function shopApplyOut(r) {
  const categoryIds = parseJson(r.category_ids, []) || [];
  const categoryNames = categoryIds.map((cid) => get('SELECT name FROM categories WHERE id = ?', cid)?.name).filter(Boolean);
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    userNickname: r.user_nickname || '',
    userUsername: r.user_username || '',
    subjectType: r.subject_type,
    subjectName: r.subject_name,
    contact: r.contact,
    phone: r.phone,
    phoneMasked: maskPhone(r.phone),
    licenseUrls: parseJson(r.license_urls, []) || [],
    categoryIds,
    categoryNames,
    shopName: r.shop_name,
    shopId: r.shop_id ? Number(r.shop_id) : null,
    shopStatus: r.shop_id ? Number(r.shop_status) : null,
    status: Number(r.status),
    statusName: svc.SHOP_APPLY_STATUS[r.status] || '',
    rejectReason: r.reject_reason || '',
    auditedBy: r.audited_by,
    auditedAt: r.audited_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ==================== API-109 入驻审核 ====================

/**
 * POST /api/admin/shop-applies/:id/audit
 * { action: 'approve' | 'reject', rejectReason? }
 * 通过 → 创建店铺 + 绑定/开通商家账号 + 通知商家 + 审计日志（FR-OPS-023 / FR-SLR-005）。
 */
function auditShopApply(ctx) {
  const id = v.int(ctx.params.id, 'id', { min: 1 });
  const body = ctx.body || {};
  const action = v.oneOf(body.action, ['approve', 'reject'], 'action');
  const reason = String(body.rejectReason ?? body.reason ?? '').trim();

  const apply = get('SELECT * FROM shop_applies WHERE id = ?', id);
  if (!apply) throw Errors.notFound('入驻申请不存在');
  if (Number(apply.status) !== 0) {
    throw Errors.badRequest(`该申请已${apply.status === 1 ? '通过' : '驳回'}审核，不能重复处理`);
  }
  if (action === 'reject' && !reason) throw Errors.badRequest('请填写驳回原因');

  if (action === 'reject') {
    run('UPDATE shop_applies SET status = 2, reject_reason = ?, audited_by = ?, audited_at = ?, updated_at = ? WHERE id = ?',
      reason, ctx.admin.id, now(), now(), id);
    svc.notifyUser(apply.user_id, '入驻申请未通过', `您提交的店铺「${apply.shop_name}」入驻申请未通过审核，原因：${reason}。您可以修改资料后重新提交。`);
    svc.writeLog(ctx, {
      module: '商家与入驻审核', action: '入驻驳回', targetType: 'shop_apply', targetId: id,
      detail: { shopName: apply.shop_name, userId: apply.user_id, reason },
    });
    return {
      id, action, status: 2, statusName: svc.SHOP_APPLY_STATUS[2],
      rejectReason: reason, shopId: null, sellerAccount: null,
    };
  }

  // ---- 通过：前置校验 ----
  const shopName = String(apply.shop_name || '').trim();
  if (!shopName) throw Errors.badRequest('申请的店铺名称为空，无法通过审核');
  const dupShop = get('SELECT id FROM shops WHERE name = ?', shopName);
  if (dupShop) throw Errors.badRequest('店铺名称已存在，请驳回并要求商家更换名称后重新提交');
  const ownedShop = get('SELECT id, name FROM shops WHERE owner_id = ?', apply.user_id);
  if (ownedShop) throw Errors.badRequest(`该会员已开通店铺「${ownedShop.name}」，一期仅支持 1 家店铺（BR-SLR-001）`);

  let shopId = null;
  let sellerAccount = null;
  let initialPassword = null;
  let accountCreated = false;
  let boundExistingAccount = false;

  transaction(() => {
    shopId = Number(run(
      `INSERT INTO shops (owner_id, name, logo, banner, description, notice, phone, category_ids, score, status, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?, 50, 1, ?, ?)`,
      apply.user_id, shopName, `${apply.subject_name} 的官方店铺`, apply.phone,
      apply.category_ids || '[]', now(), now(),
    ).lastInsertRowid);

    // 优先绑定空闲的商家账号（type='seller' 且 shop_id 为空，取 id 最小一条）
    const freeSeller = get(
      "SELECT * FROM admin_users WHERE type = 'seller' AND (shop_id IS NULL OR shop_id = 0) ORDER BY id ASC LIMIT 1",
    );
    if (freeSeller) {
      run('UPDATE admin_users SET shop_id = ?, name = ?, status = 1, updated_at = ? WHERE id = ?',
        shopId, shopName, now(), freeSeller.id);
      sellerAccount = freeSeller.account;
      boundExistingAccount = true;
    } else {
      // 无空闲账号 → 自动开通（account=申请手机号，初始密码 Seller@+手机号后 4 位，首登强制改密）
      const phone = String(apply.phone || '').trim();
      const suffix = phone.slice(-4) || String(apply.user_id).padStart(4, '0');
      initialPassword = `Seller@${suffix}`;
      sellerAccount = phone || `seller_${shopId}`;
      if (get('SELECT id FROM admin_users WHERE account = ?', sellerAccount)) {
        sellerAccount = `${sellerAccount}_s${shopId}`;
      }
      run(
        `INSERT INTO admin_users (account, password_hash, name, type, shop_id, role_id, status, must_change_pwd, created_at, updated_at)
         VALUES (?, ?, ?, 'seller', ?, NULL, 1, 1, ?, ?)`,
        sellerAccount, hashPassword(initialPassword), shopName, shopId, now(), now(),
      );
      accountCreated = true;
    }

    run('UPDATE shop_applies SET status = 1, reject_reason = NULL, audited_by = ?, audited_at = ?, updated_at = ? WHERE id = ?',
      ctx.admin.id, now(), now(), id);
  });

  // ---- 站内通知 ----
  const notice = `恭喜！店铺「${shopName}」已通过平台入驻审核并开通。商家账号：${sellerAccount}，首次登录须修改初始密码。请登录卖家中心完善店铺资料后上传商品。`;
  svc.notifySeller(shopId, '入驻审核通过，店铺已开通', notice);
  svc.notifyUser(apply.user_id, '入驻审核通过', notice);

  svc.writeLog(ctx, {
    module: '商家与入驻审核', action: '入驻通过', targetType: 'shop_apply', targetId: id,
    detail: {
      shopId, shopName, userId: apply.user_id, sellerAccount,
      accountCreated, boundExistingAccount, initialPasswordGenerated: Boolean(initialPassword),
    },
  });

  return {
    id,
    action,
    status: 1,
    statusName: svc.SHOP_APPLY_STATUS[1],
    shop: { id: shopId, name: shopName, ownerId: Number(apply.user_id), status: 1, statusName: '营业中' },
    sellerAccount,
    accountCreated,
    boundExistingAccount,
    initialPassword,
    note: initialPassword
      ? `已自动开通商家账号 ${sellerAccount}，初始密码 Seller@+手机号后 4 位，首次登录强制修改密码（BR-BE-002）`
      : `已复用空闲商家账号 ${sellerAccount} 并绑定新店铺`,
  };
}

// ==================== API-110 店铺列表 / 详情 ====================

/**
 * GET /api/admin/shops
 *  - 列表：?keyword=&status=&page=&pageSize= → { total, rows }（含经营数据概览）
 *  - 详情：?id=123 → 资料 + 经营数据 + 审核历史 + 门店 / 到店服务 + 违规处置记录
 */
function getShops(ctx) {
  const shopId = ctx.query.id !== undefined && ctx.query.id !== '' ? v.int(ctx.query.id, 'id', { min: 1 }) : null;
  if (shopId) return shopDetail(shopId);
  return shopList(ctx);
}

function shopList(ctx) {
  const params = [];
  let where = 'WHERE 1 = 1';
  if (ctx.query.status !== undefined && ctx.query.status !== '' && String(ctx.query.status).toLowerCase() !== 'all') {
    where += ' AND s.status = ?';
    params.push(Number(v.oneOf(ctx.query.status, ['0', '1'], 'status')));
  }
  if (ctx.query.keyword) {
    where += ' AND (s.name LIKE ? OR s.phone LIKE ?)';
    const kw = `%${String(ctx.query.keyword).trim()}%`;
    params.push(kw, kw);
  }
  const { page, pageSize, offset } = db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
  const total = Number(get(`SELECT COUNT(*) AS c FROM shops s ${where}`, ...params).c);
  const rows = all(
    `SELECT s.*, u.nickname AS owner_nickname, u.username AS owner_username,
            (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.is_deleted = 0) AS product_count,
            (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.is_deleted = 0 AND p.status = 2) AS on_sale_count,
            (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id) AS order_count,
            (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id AND o.status = 1) AS pending_ship_count,
            (SELECT COUNT(*) FROM stores st WHERE st.shop_id = s.id) AS store_count
       FROM shops s LEFT JOIN users u ON u.id = s.owner_id
       ${where}
      ORDER BY s.status ASC, s.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset,
  ).map(shopOut);
  return {
    total,
    rows,
    page,
    pageSize,
    summary: {
      shopCount: Number(get('SELECT COUNT(*) AS c FROM shops').c),
      activeCount: Number(get('SELECT COUNT(*) AS c FROM shops WHERE status = 1').c),
      disabledCount: Number(get('SELECT COUNT(*) AS c FROM shops WHERE status = 0').c),
      pendingApplyCount: Number(get('SELECT COUNT(*) AS c FROM shop_applies WHERE status = 0').c),
    },
  };
}

function shopOut(s) {
  const categoryIds = parseJson(s.category_ids, []) || [];
  return {
    id: Number(s.id),
    name: s.name,
    ownerId: Number(s.owner_id),
    ownerName: s.owner_nickname || s.owner_username || '',
    logo: s.logo,
    banner: s.banner,
    description: s.description,
    notice: s.notice,
    phone: s.phone,
    phoneMasked: maskPhone(s.phone),
    categoryIds,
    categoryNames: categoryIds.map((cid) => get('SELECT name FROM categories WHERE id = ?', cid)?.name).filter(Boolean),
    score: Number((Number(s.score || 0) / 10).toFixed(1)),
    status: Number(s.status),
    statusName: Number(s.status) === 1 ? '营业中' : '已停用',
    disableReason: s.disable_reason || '',
    namePending: s.name_pending || '',
    productCount: Number(s.product_count ?? 0),
    onSaleCount: Number(s.on_sale_count ?? 0),
    orderCount: Number(s.order_count ?? 0),
    pendingShipCount: Number(s.pending_ship_count ?? 0),
    storeCount: Number(s.store_count ?? 0),
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

function shopDetail(shopId) {
  const shop = get(
    `SELECT s.*, u.nickname AS owner_nickname, u.username AS owner_username, u.phone AS owner_phone
       FROM shops s LEFT JOIN users u ON u.id = s.owner_id WHERE s.id = ?`,
    shopId,
  );
  if (!shop) throw Errors.notFound('店铺不存在');

  const productStats = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS on_sale,
            SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS pending_audit,
            SUM(CASE WHEN status = 3 THEN 1 ELSE 0 END) AS off_shelf,
            COALESCE(SUM(total_stock), 0) AS stock
       FROM products WHERE shop_id = ? AND is_deleted = 0`,
    shopId,
  );
  const orderStats = get(
    `SELECT COUNT(*) AS order_count,
            COALESCE(SUM(CASE WHEN status IN (1, 2, 3) THEN pay_amount ELSE 0 END), 0) AS paid_amount,
            COUNT(DISTINCT user_id) AS buyer_count
       FROM orders WHERE shop_id = ?`,
    shopId,
  );
  const stores = all('SELECT * FROM stores WHERE shop_id = ? ORDER BY id ASC', shopId).map((st) => ({
    id: Number(st.id),
    name: st.name,
    phone: st.phone,
    address: st.address,
    lng: st.lng,
    lat: st.lat,
    businessHours: st.business_hours,
    status: Number(st.status),
    statusName: Number(st.status) === 1 ? '启用' : '停用',
  }));
  const services = all('SELECT * FROM store_services WHERE shop_id = ? ORDER BY id ASC', shopId).map((ss) => ({
    id: Number(ss.id),
    name: ss.name,
    originPrice: toYuan(ss.origin_price),
    storePrice: toYuan(ss.store_price),
    status: Number(ss.status),
    statusName: ['待审核', '已通过', '已驳回', '已下线'][ss.status] || '',
    validStart: ss.valid_start,
    validEnd: ss.valid_end,
    bookingCount: Number(get('SELECT COUNT(*) AS c FROM store_bookings WHERE store_service_id = ?', ss.id).c),
  }));

  // 审核历史：入驻申请记录（按 owner 关联）+ 该店相关操作日志（名称变更 / 状态处置 / 商品强制下架）
  const applies = all('SELECT * FROM shop_applies WHERE user_id = ? ORDER BY id DESC', shop.owner_id).map(shopApplyOut);
  const applyIds = applies.map((a) => String(a.id));
  const applyLogFilter = applyIds.length
    ? ` OR (target_type = 'shop_apply' AND target_id IN (${applyIds.map(() => '?').join(',')}))`
    : '';
  const auditLogs = all(
    `SELECT * FROM operation_logs
      WHERE (target_type = 'shop' AND target_id = ?)${applyLogFilter}
      ORDER BY id DESC LIMIT 50`,
    String(shopId), ...applyIds,
  ).map((log) => ({
    id: Number(log.id),
    module: log.module,
    action: log.action,
    adminName: log.admin_name,
    roleCode: log.role_code,
    detail: log.detail,
    createdAt: log.created_at,
  }));
  const violations = all(
    `SELECT * FROM operation_logs
      WHERE (target_type = 'shop' AND target_id = ?)
         OR (action IN ('强制下架', '活动强制下线') AND detail LIKE ?)
      ORDER BY id DESC LIMIT 20`,
    String(shopId), `%"shopId":${shopId}%`,
  ).map((log) => ({ id: Number(log.id), action: log.action, detail: log.detail, createdAt: log.created_at }));

  return {
    shop: shopOut({ ...shop, product_count: productStats.total, on_sale_count: productStats.on_sale, order_count: orderStats.order_count }),
    owner: {
      id: Number(shop.owner_id),
      nickname: shop.owner_nickname || '',
      username: shop.owner_username || '',
      phoneMasked: maskPhone(shop.owner_phone),
    },
    stats: {
      productCount: Number(productStats.total || 0),
      onSaleCount: Number(productStats.on_sale || 0),
      pendingAuditCount: Number(productStats.pending_audit || 0),
      offShelfCount: Number(productStats.off_shelf || 0),
      totalStock: Number(productStats.stock || 0),
      orderCount: Number(orderStats.order_count || 0),
      paidAmount: toYuan(orderStats.paid_amount || 0),
      buyerCount: Number(orderStats.buyer_count || 0),
      score: Number((Number(shop.score || 0) / 10).toFixed(1)),
      storeCount: stores.length,
      serviceCount: services.length,
    },
    stores,
    storeServices: services,
    applyHistory: applies,
    nameAuditHistory: auditLogs.filter((l) => /名称/.test(l.action)),
    auditHistory: auditLogs,
    violations,
    note: '违规记录取自操作日志中的强制下架 / 停用类操作（本期无独立违规档案表）',
  };
}

// ==================== API-111 店铺状态更新 ====================

/**
 * PATCH /api/admin/shops/:id/status
 * { status: 1|0, reason? } 或 { action: 'enable'|'disable', reason? }
 * 停用：店铺 status=0，该店商品 status=3、活动 status=4，写通知；启用不自动上架商品（FR-OPS-025）。
 */
function updateShopStatus(ctx) {
  const id = v.int(ctx.params.id, 'id', { min: 1 });
  const shop = get('SELECT * FROM shops WHERE id = ?', id);
  if (!shop) throw Errors.notFound('店铺不存在');

  const body = ctx.body || {};
  let status;
  if (body.action !== undefined) {
    status = v.oneOf(body.action, ['enable', 'disable'], 'action') === 'enable' ? 1 : 0;
  } else {
    status = Number(v.oneOf(body.status !== undefined ? body.status : body.enabled, ['0', '1'], 'status'));
  }
  const reason = String(body.reason ?? body.disableReason ?? '').trim();
  if (status === 0 && !reason) throw Errors.badRequest('请填写店铺停用原因');

  let offShelfProducts = 0;
  let offlineActivities = 0;

  transaction(() => {
    run('UPDATE shops SET status = ?, disable_reason = ?, updated_at = ? WHERE id = ?',
      status, status === 0 ? reason : null, now(), id);

    if (status === 0) {
      const products = all('SELECT id FROM products WHERE shop_id = ? AND is_deleted = 0 AND status = 2', id);
      if (products.length) {
        run(`UPDATE products SET status = 3, audit_reason = ?, updated_at = ? WHERE id IN (${products.map(() => '?').join(',')})`,
          `店铺被平台停用（${reason}）`, now(), ...products.map((p) => Number(p.id)));
        offShelfProducts = products.length;
      }
      const activities = all('SELECT id FROM activities WHERE shop_id = ? AND status = 1', id);
      if (activities.length) {
        run(`UPDATE activities SET status = 4, audit_reason = ?, updated_at = ? WHERE id IN (${activities.map(() => '?').join(',')})`,
          `店铺被平台停用（${reason}）`, now(), ...activities.map((a) => Number(a.id)));
        offlineActivities = activities.length;
      }
      svc.notifySeller(id, '店铺已被平台停用', `您的店铺「${shop.name}」已被平台停用，原因：${reason}。停用期间商家端为只读，商品与活动已自动下架。整改完成后请联系平台运营申请恢复。`);
    } else {
      svc.notifySeller(id, '店铺已恢复营业', `您的店铺「${shop.name}」已由平台恢复为「营业中」。商品与活动不会自动上架，请确认合规后重新提交审核。`);
    }
  });

  svc.writeLog(ctx, {
    module: '商家与入驻审核', action: status === 1 ? '启用店铺' : '停用店铺', targetType: 'shop', targetId: id,
    detail: { shopName: shop.name, status, reason: status === 0 ? reason : '', offShelfProducts, offlineActivities },
  });

  const updated = get('SELECT * FROM shops WHERE id = ?', id);
  return {
    id,
    status: Number(updated.status),
    statusName: Number(updated.status) === 1 ? '营业中' : '已停用',
    disableReason: updated.disable_reason || '',
    offShelfProducts,
    offlineActivities,
    notified: true,
    note: status === 1 ? '店铺已启用，商品与活动需商家重新提交审核后上架（不自动上架）' : '店铺已停用，商家端只读，商品与活动已自动下架',
  };
}

// ==================== API-112 店铺名称变更审核 ====================

/**
 * POST /api/admin/shops/:id/name-audit
 * { approve: true|false, rejectReason? } 或 { action: 'approve'|'reject', rejectReason? }
 * 通过：用 name_pending 覆盖 name（全局唯一校验），清空 pending；
 * 驳回：必填原因，清空 pending、保留原名（FR-OPS-024 / FR-SLR-012）。
 */
function auditShopName(ctx) {
  const id = v.int(ctx.params.id, 'id', { min: 1 });
  const shop = get('SELECT * FROM shops WHERE id = ?', id);
  if (!shop) throw Errors.notFound('店铺不存在');

  const body = ctx.body || {};
  let approve;
  if (body.action !== undefined) approve = v.oneOf(body.action, ['approve', 'reject'], 'action') === 'approve';
  else approve = svc.boolOf(body.approve, false);
  const reason = String(body.rejectReason ?? body.reason ?? '').trim();

  const pending = String(shop.name_pending || '').trim();
  if (!pending) throw Errors.badRequest('该店铺没有待审核的名称变更申请');
  if (!approve && !reason) throw Errors.badRequest('请填写驳回原因');

  const previousName = shop.name;
  let newName = previousName;

  if (approve) {
    const dup = get('SELECT id, name FROM shops WHERE name = ? AND id <> ?', pending, id);
    if (dup) throw Errors.badRequest(`店铺名称「${pending}」已存在，无法通过审核（店铺名称全局唯一）`);
    transaction(() => {
      run('UPDATE shops SET name = ?, name_pending = NULL, updated_at = ? WHERE id = ?', pending, now(), id);
    });
    newName = pending;
    svc.notifySeller(id, '店铺名称变更审核通过', `您申请的店铺名称「${pending}」已通过审核，前台展示将同步更新（原名称：${previousName}）。`);
  } else {
    transaction(() => {
      run('UPDATE shops SET name_pending = NULL, updated_at = ? WHERE id = ?', now(), id);
    });
    svc.notifySeller(id, '店铺名称变更审核未通过', `您申请的店铺名称「${pending}」未通过审核，原因：${reason}。店铺将继续展示原名称「${previousName}」。`);
  }

  svc.writeLog(ctx, {
    module: '商家与入驻审核', action: approve ? '店铺名称变更通过' : '店铺名称变更驳回', targetType: 'shop', targetId: id,
    detail: { shopId: id, previousName, pendingName: pending, newName, reason: approve ? '' : reason },
  });

  return {
    id,
    approved: approve,
    previousName,
    name: newName,
    pendingCleared: true,
    rejectReason: approve ? '' : reason,
    statusName: approve ? '名称变更已通过' : '名称变更已驳回',
  };
}

// ==================== API-113 店铺街推荐位 ====================

/**
 * POST /api/admin/shop-recommends
 *  - 整体保存：{ shopIds: [1,2,3], startAt?, endAt? }
 *  - 单条保存：{ shopId, sort, startAt, endAt }
 * 店铺不存在 / 已停用时跳过并返回 skipped（FR-OPS-026 / 8.3 店铺街）。
 */
function saveShopRecommends(ctx) {
  const body = ctx.body || {};
  const ids = Array.isArray(body.shopIds)
    ? body.shopIds
    : (Array.isArray(body.items) ? body.items.map((item) => (typeof item === 'object' ? item?.shopId : item)) : null);
  if (ids) return replaceShopRecommends(ctx, ids, body);
  return saveOneShopRecommend(ctx, body);
}

/** GET /api/admin/shop-recommends（API-113 的查询面） */
function listShopRecommends(ctx) {
  const rows = all(
    `SELECT sr.*, s.name AS shop_name, s.logo, s.status AS shop_status
       FROM shop_recommends sr LEFT JOIN shops s ON s.id = sr.shop_id
      ORDER BY sr.sort ASC, sr.id ASC`,
  ).map((r) => ({
    id: Number(r.id),
    shopId: Number(r.shop_id),
    shopName: r.shop_name || '',
    logo: r.logo || '',
    shopStatus: r.shop_status === null || r.shop_status === undefined ? null : Number(r.shop_status),
    shopValid: Number(r.shop_status) === 1,
    sort: Number(r.sort || 0),
    startAt: r.start_at,
    endAt: r.end_at,
    createdAt: r.created_at,
  }));
  return { total: rows.length, rows };
}

function checkRecommendShop(shopId) {
  const id = Number(shopId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, shopId, reason: '店铺 ID 非法' };
  const shop = get('SELECT id, name, status FROM shops WHERE id = ?', id);
  if (!shop) return { ok: false, shopId: id, reason: '店铺不存在' };
  if (Number(shop.status) !== 1) return { ok: false, shopId: id, reason: '店铺已停用' };
  return { ok: true, shopId: id, shop };
}

function replaceShopRecommends(ctx, rawIds, body) {
  if (!rawIds.length) throw Errors.badRequest('推荐店铺名单不能为空');
  if (rawIds.length > 100) throw Errors.badRequest('店铺街推荐位单次最多 100 个');
  const startAt = svc.normTime(body.startAt, { field: 'startAt' });
  const endAt = svc.normTime(body.endAt, { field: 'endAt', endOfDay: true });
  if (startAt && endAt && startAt >= endAt) throw Errors.badRequest('生效结束时间须晚于开始时间');

  const seen = new Set();
  const accepted = [];
  const skipped = [];
  rawIds.forEach((rawId, index) => {
    const check = checkRecommendShop(rawId);
    if (!check.ok) { skipped.push({ shopId: check.shopId, reason: check.reason }); return; }
    if (seen.has(check.shopId)) return;
    seen.add(check.shopId);
    accepted.push({ shopId: check.shopId, sort: index });
  });

  transaction(() => {
    run('DELETE FROM shop_recommends');
    for (const item of accepted) {
      run('INSERT INTO shop_recommends (shop_id, sort, start_at, end_at, created_at) VALUES (?, ?, ?, ?, ?)',
        item.shopId, item.sort, startAt, endAt, now());
    }
  });

  svc.writeLog(ctx, {
    module: '商家与入驻审核', action: '保存店铺街推荐位', targetType: 'shop_recommend', targetId: 'batch',
    detail: { saved: accepted.length, skipped, startAt, endAt },
  });

  return {
    mode: 'replace',
    saved: accepted.length,
    skipped,
    skippedCount: skipped.length,
    ...listShopRecommends(ctx),
    note: skipped.length ? `已跳过 ${skipped.length} 个不可用店铺（不存在 / 已停用）` : '店铺街推荐位已全量覆盖保存',
  };
}

function saveOneShopRecommend(ctx, body) {
  const shopId = v.int(body.shopId, 'shopId', { min: 1 });
  const check = checkRecommendShop(shopId);
  if (!check.ok) throw Errors.badRequest(check.reason);

  const sort = body.sort !== undefined
    ? svc.intOr(body.sort, 'sort', 0)
    : Number(get('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM shop_recommends').s);
  const startAt = svc.normTime(body.startAt, { field: 'startAt' });
  const endAt = svc.normTime(body.endAt, { field: 'endAt', endOfDay: true });
  if (startAt && endAt && startAt >= endAt) throw Errors.badRequest('生效结束时间须晚于开始时间');

  const existing = get('SELECT * FROM shop_recommends WHERE shop_id = ?', shopId);
  if (existing) {
    run('UPDATE shop_recommends SET sort = ?, start_at = ?, end_at = ? WHERE id = ?',
      sort, startAt ?? existing.start_at, endAt ?? existing.end_at, existing.id);
  } else {
    run('INSERT INTO shop_recommends (shop_id, sort, start_at, end_at, created_at) VALUES (?, ?, ?, ?, ?)',
      shopId, sort, startAt, endAt, now());
  }

  svc.writeLog(ctx, {
    module: '商家与入驻审核', action: existing ? '更新店铺街推荐位' : '新增店铺街推荐位',
    targetType: 'shop_recommend', targetId: shopId,
    detail: { shopId, sort, startAt, endAt },
  });

  return {
    mode: 'single',
    updated: Boolean(existing),
    row: listShopRecommends(ctx).rows.find((r) => r.shopId === shopId) || null,
  };
}

module.exports = function register(api) {
  // API-108 / 109 入驻申请与审核（FR-OPS-022 ~ 023）
  api.get('/api/admin/shop-applies', { auth: 'admin', perm: PERM_SHOP_AUDIT }, listShopApplies);
  api.post('/api/admin/shop-applies/:id/audit', { auth: 'admin', perm: PERM_SHOP_AUDIT }, auditShopApply);

  // API-110 / 111 / 112 店铺列表详情、状态、名称变更审核（FR-OPS-024 ~ 027）
  api.get('/api/admin/shops', { auth: 'admin', perm: PERM_SHOP_AUDIT }, getShops);
  api.patch('/api/admin/shops/:id/status', { auth: 'admin', perm: PERM_SHOP_AUDIT }, updateShopStatus);
  api.post('/api/admin/shops/:id/name-audit', { auth: 'admin', perm: PERM_SHOP_AUDIT }, auditShopName);

  // API-113 店铺街推荐位（FR-OPS-026）
  api.get('/api/admin/shop-recommends', { auth: 'admin', perm: PERM_SHOP_AUDIT }, listShopRecommends);
  api.post('/api/admin/shop-recommends', { auth: 'admin', perm: PERM_SHOP_AUDIT }, saveShopRecommends);
};
