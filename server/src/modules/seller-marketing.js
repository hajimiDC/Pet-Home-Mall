'use strict';

const { get, all, run } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, addDays } = require('../core/money');
const { encrypt, decrypt, maskAccount } = require('../core/crypto');
const v = require('../core/validate');
const config = require('../core/config');
const activitySvc = require('../services/activity-service');
const couponSvc = require('../services/coupon-service');
const S = require('../services/seller-service');

/**
 * 商家端 · 营销管理
 * API-081 ~ API-087 + 收款账户绑定（FR-SLR-080 ~ 088、Q-016、9.3.9）
 */

const ACTIVITY_TYPES = ['满减', '折扣', '满赠', '秒杀'];
const ACTIVITY_STATUS = { 0: '待审核', 1: '进行中', 2: '已驳回', 3: '已结束', 4: '已下线' };
const COUPON_TYPE = { 1: '满减', 2: '折扣' };
const ACCOUNT_TYPES = ['对公银行账户', '个人银行账户', '支付宝', '微信'];

/* ============================ 商家活动 ============================ */

function ownActivity(shopId, id) {
  const row = get('SELECT * FROM activities WHERE id = ? AND shop_id = ?', Number(id), shopId);
  if (!row) throw Errors.notFound('活动不存在');
  return row;
}

function activityApi(row) {
  const shop = get('SELECT id, name, logo FROM shops WHERE id = ?', row.shop_id);
  return activitySvc.toApi({ ...row, shop_name: shop?.name, shop_logo: shop?.logo });
}

/** API-081 商家活动列表 */
function activityList(ctx) {
  const shop = S.shopOf(ctx);
  const { page, pageSize, offset } = S.pageOf(ctx);
  const where = ['shop_id = ?'];
  const params = [shop.id];
  if (ctx.query.status !== undefined && ctx.query.status !== '') {
    if (String(ctx.query.status) === 'running') {
      where.push('status = 1 AND start_at <= ? AND end_at > ?');
      params.push(now(), now());
    } else {
      where.push('status = ?');
      params.push(Number(ctx.query.status));
    }
  }
  const keyword = String(ctx.query.keyword || ctx.query.title || '').trim();
  if (keyword) { where.push('title LIKE ?'); params.push(`%${keyword}%`); }
  S.pushTimeRange(where, params, 'start_at', ctx.query.startAt || ctx.query.dateStart, ctx.query.endAt || ctx.query.dateEnd);
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT COUNT(*) AS c FROM activities ${whereSql}`, ...params).c;
  const rows = all(`SELECT * FROM activities ${whereSql} ORDER BY start_at DESC, id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset);
  return S.listResult(rows.map(activityApi), total, {
    page, pageSize,
    counts: {
      pending: get('SELECT COUNT(*) AS c FROM activities WHERE shop_id = ? AND status = 0', shop.id).c,
      running: get('SELECT COUNT(*) AS c FROM activities WHERE shop_id = ? AND status = 1', shop.id).c,
      ended: get('SELECT COUNT(*) AS c FROM activities WHERE shop_id = ? AND status = 3', shop.id).c,
    },
  });
}

function parseActivityPayload(body) {
  const title = v.str(body.title, 'title', { min: 2, max: 100 });
  S.assertNoBlockWord(title, 'title');
  const type = String(body.type || '').trim();
  if (!ACTIVITY_TYPES.includes(type)) {
    throw Errors.badRequest(`活动类型仅支持 ${ACTIVITY_TYPES.join(' / ')}`, { field: 'type' });
  }
  const startAt = S.timeBound(body.startAt, false);
  const endAt = S.timeBound(body.endAt, true);
  if (!startAt) throw Errors.badRequest('活动开始时间不能为空', { field: 'startAt' });
  if (!endAt) throw Errors.badRequest('活动结束时间不能为空', { field: 'endAt' });
  if (new Date(endAt.replace(' ', 'T')).getTime() <= new Date(startAt.replace(' ', 'T')).getTime()) {
    throw Errors.badRequest('活动结束时间须晚于开始时间', { field: 'endAt' });
  }

  const productIds = S.asArray(body.productIds).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
  if (!productIds.length) throw Errors.badRequest('请选择活动关联商品', { field: 'productIds' });

  let ruleJson = null;
  if (body.ruleJson !== undefined && body.ruleJson !== null && body.ruleJson !== '') {
    if (typeof body.ruleJson === 'object') ruleJson = JSON.stringify(body.ruleJson);
    else {
      try { JSON.parse(String(body.ruleJson)); } catch (_) { throw Errors.badRequest('活动规则 JSON 格式不正确', { field: 'ruleJson' }); }
      ruleJson = String(body.ruleJson);
    }
  } else if (type === '满减') {
    const threshold = require('../core/money').toCents(body.threshold ?? 0) || 0;
    const discount = require('../core/money').toCents(body.discount ?? 0) || 0;
    if (threshold <= 0 || discount <= 0) {
      throw Errors.badRequest('满减活动需提供门槛与优惠金额', { field: 'ruleJson' });
    }
    ruleJson = JSON.stringify({ threshold, discount });
  } else if (type === '折扣' || type === '秒杀') {
    const rate = Number(body.discountRate ?? body.rate);
    if (!(rate > 0 && rate < 1)) throw Errors.badRequest('折扣率须在 0 ~ 1 之间（如 0.9 表示 9 折）', { field: 'ruleJson' });
    ruleJson = JSON.stringify({ rate });
  }

  return {
    title, type, startAt, endAt, productIds, ruleJson,
    image: body.image !== undefined ? String(body.image || '') : null,
    content: body.content !== undefined ? String(body.content || '') : '',
    ruleDesc: body.ruleDesc !== undefined ? String(body.ruleDesc || '') : '',
  };
}

/** API-082 保存活动（新增 / 更新） */
function activitySave(ctx) {
  const shop = S.activeShop(ctx);
  const body = ctx.body || {};
  const data = parseActivityPayload(body);

  const productRows = data.productIds.map((pid) => {
    const p = get('SELECT id, name FROM products WHERE id = ? AND shop_id = ? AND is_deleted = 0', pid, shop.id);
    if (!p) throw Errors.notFound('商品不存在');
    return p;
  });

  const status = config.getBool('activity_audit_enabled') ? 0 : 1;
  const id = body.id ? Number(body.id) : null;
  let activityId;
  if (id) {
    const exist = ownActivity(shop.id, id);
    // BR-SLR-024：已产生订单的活动不允许修改时间与规则，只能提前结束
    if (exist.order_count > 0
      && (exist.start_at !== data.startAt || exist.end_at !== data.endAt || String(exist.rule_json || '') !== String(data.ruleJson || ''))) {
      throw Errors.badRequest('该活动已产生订单，不允许修改活动时间与规则，仅可提前结束');
    }
    run(
      `UPDATE activities SET title = ?, type = ?, image = ?, content = ?, rule_desc = ?, rule_json = ?, start_at = ?,
          end_at = ?, status = ?, audit_reason = NULL, updated_at = ?
       WHERE id = ? AND shop_id = ?`,
      data.title, data.type, data.image ?? exist.image, data.content, data.ruleDesc, data.ruleJson,
      data.startAt, data.endAt, exist.order_count > 0 ? exist.status : status, now(), exist.id, shop.id,
    );
    run('DELETE FROM activity_products WHERE activity_id = ?', exist.id);
    activityId = exist.id;
  } else {
    activityId = run(
      `INSERT INTO activities (shop_id, title, type, image, content, rule_desc, rule_json, start_at, end_at,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      shop.id, data.title, data.type, data.image, data.content, data.ruleDesc, data.ruleJson,
      data.startAt, data.endAt, status, now(), now(),
    ).lastInsertRowid;
  }
  for (const p of productRows) {
    run('INSERT OR IGNORE INTO activity_products (activity_id, product_id) VALUES (?, ?)', activityId, p.id);
  }
  S.audit(ctx, '营销', id ? '更新商家活动' : '发布商家活动', 'activity', activityId,
    `${data.title}；类型 ${data.type}；关联商品 ${productRows.length} 个；状态 ${ACTIVITY_STATUS[status]}`);
  return activityApi(get('SELECT * FROM activities WHERE id = ?', activityId));
}

/** API-083 活动提前结束 */
function activityClose(ctx) {
  const shop = S.activeShop(ctx);
  const row = ownActivity(shop.id, ctx.params.id);
  if (row.status === 3) throw Errors.badRequest('活动已结束');
  if (row.status === 4) throw Errors.badRequest('活动已被平台下线');
  run('UPDATE activities SET status = 3, end_at = CASE WHEN end_at > ? THEN ? ELSE end_at END, updated_at = ? WHERE id = ? AND shop_id = ?',
    now(), now(), now(), row.id, shop.id);
  S.audit(ctx, '营销', '提前结束活动', 'activity', row.id, row.title);
  return {
    ...activityApi(get('SELECT * FROM activities WHERE id = ?', row.id)),
    tip: '活动已提前结束，已产生的订单继续履约',
  };
}

/* ============================ 店铺优惠券 ============================ */

function toCouponApi(row) {
  const used = get('SELECT COUNT(*) AS c FROM user_coupons WHERE coupon_id = ? AND status = 1', row.id).c;
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    type: row.type,
    typeName: COUPON_TYPE[row.type] || '未知',
    threshold: toYuan(row.threshold),
    amount: toYuan(row.amount),
    discountRate: row.discount_rate,
    scopeType: row.scope_type,
    scopeIds: S.parseJson(row.scope_ids, []) || [],
    startAt: row.start_at,
    endAt: row.end_at,
    validDays: row.valid_days,
    stock: row.stock,
    received: row.received,
    remain: Math.max(0, row.stock - row.received),
    used,
    limitPerUser: row.limit_per_user,
    status: row.status,
    statusName: row.status === 1 ? '上架' : '下架',
    createdAt: row.created_at,
  };
}

/** API-084 店铺券列表 */
function couponList(ctx) {
  const shop = S.shopOf(ctx);
  const { page, pageSize, offset } = S.pageOf(ctx);
  const where = ['shop_id = ?'];
  const params = [shop.id];
  if (ctx.query.status !== undefined && ctx.query.status !== '') {
    where.push('status = ?'); params.push(Number(ctx.query.status));
  }
  if (ctx.query.type !== undefined && ctx.query.type !== '') {
    where.push('type = ?'); params.push(Number(ctx.query.type));
  }
  const keyword = String(ctx.query.keyword || ctx.query.name || '').trim();
  if (keyword) { where.push('name LIKE ?'); params.push(`%${keyword}%`); }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT COUNT(*) AS c FROM coupons ${whereSql}`, ...params).c;
  const rows = all(`SELECT * FROM coupons ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
  return S.listResult(rows.map(toCouponApi), total, { page, pageSize });
}

/** API-085 保存店铺券 */
function couponSave(ctx) {
  const shop = S.activeShop(ctx);
  const body = ctx.body || {};
  v.requireFields(body, ['name', 'type', 'startAt', 'endAt']);

  const name = v.str(body.name, 'name', { min: 2, max: 60 });
  S.assertNoBlockWord(name, 'name');
  let type = body.type;
  if (type === '满减') type = 1;
  if (type === '折扣') type = 2;
  type = v.int(type, 'type', { min: 1, max: 2 });

  const threshold = body.threshold === undefined || body.threshold === ''
    ? 0
    : v.money(body.threshold, 'threshold', { min: 0, allowZero: true });

  let amount = 0;
  let discountRate = null;
  if (type === 1) {
    amount = v.money(body.amount, 'amount', { min: 1 });
    if (threshold > 0 && amount >= threshold) {
      throw Errors.badRequest('券面额不得大于等于使用门槛，请调整面额或门槛', { field: 'amount' });
    }
  } else {
    discountRate = Number(body.discountRate ?? body.rate);
    if (!(discountRate > 0 && discountRate < 1)) {
      throw Errors.badRequest('折扣率须在 0 ~ 1 之间（如 0.9 表示 9 折）', { field: 'discountRate' });
    }
  }

  const startAt = S.timeBound(body.startAt, false);
  const endAt = S.timeBound(body.endAt, true);
  if (new Date(endAt.replace(' ', 'T')).getTime() <= new Date(startAt.replace(' ', 'T')).getTime()) {
    throw Errors.badRequest('有效期结束时间须晚于开始时间', { field: 'endAt' });
  }

  const validDays = body.validDays === undefined || body.validDays === ''
    ? null
    : v.int(body.validDays, 'validDays', { min: 1, max: 365 });
  const stock = body.stock === undefined || body.stock === ''
    ? 0
    : v.int(body.stock, 'stock', { min: 0, max: 1000000 });
  const limitPerUser = body.limitPerUser === undefined || body.limitPerUser === ''
    ? 1
    : v.int(body.limitPerUser, 'limitPerUser', { min: 1, max: 99 });
  const scopeType = body.scopeType === undefined || body.scopeType === ''
    ? 1
    : v.int(body.scopeType, 'scopeType', { min: 1, max: 4 });
  const scopeIds = S.asArray(body.scopeIds).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
  if (scopeType !== 1 && !scopeIds.length) {
    throw Errors.badRequest('请选择券的适用范围', { field: 'scopeIds' });
  }
  if (scopeType === 3) {
    for (const pid of scopeIds) {
      const p = get('SELECT id FROM products WHERE id = ? AND shop_id = ? AND is_deleted = 0', pid, shop.id);
      if (!p) throw Errors.notFound('商品不存在');
    }
  }

  const id = body.id ? Number(body.id) : null;
  let couponId;
  if (id) {
    const exist = get('SELECT * FROM coupons WHERE id = ? AND shop_id = ?', id, shop.id);
    if (!exist) throw Errors.notFound('优惠券不存在');
    run(
      `UPDATE coupons SET name = ?, type = ?, threshold = ?, amount = ?, discount_rate = ?, scope_type = ?, scope_ids = ?,
          start_at = ?, end_at = ?, valid_days = ?, stock = ?, limit_per_user = ?, updated_at = ?
       WHERE id = ? AND shop_id = ?`,
      name, type, threshold, amount, discountRate, scopeType, JSON.stringify(scopeIds),
      startAt, endAt, validDays, stock, limitPerUser, now(), exist.id, shop.id,
    );
    couponId = exist.id;
  } else {
    couponId = run(
      `INSERT INTO coupons (shop_id, name, type, threshold, amount, discount_rate, scope_type, scope_ids,
          start_at, end_at, valid_days, stock, received, limit_per_user, claim_type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '主动领取', 1, ?, ?)`,
      shop.id, name, type, threshold, amount, discountRate, scopeType, JSON.stringify(scopeIds),
      startAt, endAt, validDays, stock, limitPerUser, now(), now(),
    ).lastInsertRowid;
  }
  S.audit(ctx, '营销', id ? '更新店铺券' : '新增店铺券', 'coupon', couponId,
    `${name}；${COUPON_TYPE[type]}；门槛 ${toYuan(threshold)} 元；发放 ${stock} 张`);
  return toCouponApi(get('SELECT * FROM coupons WHERE id = ?', couponId));
}

/** API-086 店铺券统计（领取量 / 使用量 / 核销量） */
function couponStat(ctx) {
  const shop = S.shopOf(ctx);
  const params = [shop.id];
  let where = 'WHERE c.shop_id = ?';
  if (ctx.query.couponId) {
    const cid = Number(ctx.query.couponId);
    if (Number.isInteger(cid) && cid > 0) { where += ' AND c.id = ?'; params.push(cid); }
  }
  const rows = all(
    `SELECT c.*,
        (SELECT COUNT(*) FROM user_coupons uc WHERE uc.coupon_id = c.id) AS claim_count,
        (SELECT COUNT(*) FROM user_coupons uc WHERE uc.coupon_id = c.id AND uc.status = 1) AS use_count,
        (SELECT COUNT(*) FROM user_coupons uc JOIN orders o ON o.id = uc.order_id
           WHERE uc.coupon_id = c.id AND uc.status = 1 AND o.status NOT IN (0, 4)) AS verify_count
       FROM coupons c ${where} ORDER BY c.id DESC`,
    ...params,
  );
  const totals = rows.reduce((acc, r) => ({
    received: acc.received + r.received,
    claimCount: acc.claimCount + r.claim_count,
    useCount: acc.useCount + r.use_count,
    verifyCount: acc.verifyCount + r.verify_count,
  }), { received: 0, claimCount: 0, useCount: 0, verifyCount: 0 });
  totals.useRate = totals.claimCount ? Number((totals.useCount / totals.claimCount * 100).toFixed(1)) : 0;
  return {
    totals,
    rows: rows.map((r) => ({
      couponId: r.id,
      name: r.name,
      type: r.type,
      typeName: COUPON_TYPE[r.type] || '',
      stock: r.stock,
      received: r.received,
      claimCount: r.claim_count,
      useCount: r.use_count,
      verifyCount: r.verify_count,
      remain: Math.max(0, r.stock - r.received),
      startAt: r.start_at,
      endAt: r.end_at,
      status: r.status,
    })),
  };
}

/* ============================ 拼团报名 ============================ */

/** API-087 拼团报名（拼团价 ≤ SKU 商城价；成团人数 10~99） */
function groupBuyApply(ctx) {
  const shop = S.activeShop(ctx);
  const body = ctx.body || {};
  v.requireFields(body, ['productId', 'skuId', 'groupPrice', 'requiredCount']);

  const product = get('SELECT * FROM products WHERE id = ? AND shop_id = ? AND is_deleted = 0',
    Number(body.productId), shop.id);
  if (!product) throw Errors.notFound('商品不存在');
  const sku = get('SELECT * FROM skus WHERE id = ? AND product_id = ?', Number(body.skuId), product.id);
  if (!sku) throw Errors.notFound('规格不存在');

  const groupPrice = v.money(body.groupPrice, 'groupPrice', { min: 1 });
  if (groupPrice > sku.price) throw Errors.badRequest('拼团价不得高于该 SKU 商城价', { field: 'groupPrice' });

  const minQty = config.getNumber('group_buy_min_qty');
  const maxQty = config.getNumber('group_buy_max_qty');
  const requiredCount = v.int(body.requiredCount, 'requiredCount', { min: 1 });
  if (requiredCount < minQty || requiredCount > maxQty) {
    throw Errors.badRequest(`成团人数须在 ${minQty}~${maxQty} 人之间`, { field: 'requiredCount' });
  }

  const validDays = config.getNumber('group_buy_valid_days') || 3;
  const startAt = body.startAt ? S.timeBound(body.startAt, false) : now();
  const endAt = body.endAt ? S.timeBound(body.endAt, true) : addDays(validDays);
  if (new Date(endAt.replace(' ', 'T')).getTime() <= new Date(startAt.replace(' ', 'T')).getTime()) {
    throw Errors.badRequest('拼团结束时间须晚于开始时间', { field: 'endAt' });
  }

  const id = run(
    `INSERT INTO group_buys (shop_id, product_id, sku_id, title, group_price, required_count, joined_count,
        start_at, end_at, valid_days, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?)`,
    shop.id, product.id, sku.id, `${product.name}（${sku.spec_name}）拼团`, groupPrice, requiredCount,
    startAt, endAt, validDays, now(), now(),
  ).lastInsertRowid;
  S.audit(ctx, '营销', '拼团报名', 'group_buy', id,
    `${product.name} / ${sku.spec_name}；拼团价 ${toYuan(groupPrice)} 元（商城价 ${toYuan(sku.price)} 元）；成团 ${requiredCount} 人`);
  return {
    id,
    shopId: shop.id,
    productId: product.id,
    productName: product.name,
    skuId: sku.id,
    specName: sku.spec_name,
    skuPrice: toYuan(sku.price),
    groupPrice: toYuan(groupPrice),
    requiredCount,
    joinedCount: 0,
    startAt,
    endAt,
    validDays,
    status: 0,
    statusName: '待审核',
    auditTip: '拼团报名已提交，待平台运营审核',
  };
}

/* ============================ 收款账户（Q-016） ============================ */

const ACCOUNT_NO_RE = /^\d{8,32}$/;
const ID_TAIL_RE = /^\d{4}$|^\d{3}[Xx]$/;

function toAccountApi(row) {
  const plain = decrypt(row.account_no);
  let verifyStatus = '未验证';
  if (row.verified === 1) verifyStatus = '已验证';
  else if (row.verify_locked_until && row.verify_locked_until > now()) verifyStatus = '验证锁定';
  return {
    id: row.id,
    shopId: row.shop_id,
    accountType: row.account_type,
    accountName: row.account_name,
    bankName: row.bank_name,
    accountMask: maskAccount(plain),
    idCardTail: row.id_card_tail,
    verified: row.verified === 1,
    verifyStatus,
    verifyFailCount: row.verify_fail_count,
    verifyLockedUntil: row.verify_locked_until,
    effectiveAt: row.effective_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** POST /api/seller/accounts 绑定收款账户（加密存储 + 掩码返回） */
function accountCreate(ctx) {
  const shop = S.activeShop(ctx);
  const body = ctx.body || {};
  v.requireFields(body, ['accountType', 'accountName', 'accountNo']);
  const accountType = String(body.accountType).trim();
  if (!ACCOUNT_TYPES.includes(accountType)) {
    throw Errors.badRequest(`收款账户类型仅支持 ${ACCOUNT_TYPES.join(' / ')}`, { field: 'accountType' });
  }
  const accountName = v.str(body.accountName, 'accountName', { min: 2, max: 60 });
  const accountNo = String(body.accountNo).replace(/\s|-/g, '');
  if (!ACCOUNT_NO_RE.test(accountNo)) {
    throw Errors.badRequest('账号须为 8~32 位数字', { field: 'accountNo' });
  }
  let idCardTail = null;
  if (accountType === '个人银行账户') {
    idCardTail = String(body.idCardTail || '').trim();
    if (!ID_TAIL_RE.test(idCardTail)) throw Errors.badRequest('请填写身份证后 4 位', { field: 'idCardTail' });
  }
  const bankName = accountType.includes('银行') ? String(body.bankName || '').trim() : null;
  if (accountType.includes('银行') && !bankName) throw Errors.badRequest('请填写开户银行', { field: 'bankName' });

  // Q-016 规则 1：收款户名须与店铺主体一致（存在已通过的入驻申请时强校验）
  const apply = get(
    `SELECT a.* FROM shop_applies a JOIN shops s ON s.owner_id = a.user_id
      WHERE s.id = ? AND a.status = 1 ORDER BY a.id DESC LIMIT 1`, shop.id,
  );
  if (apply && String(apply.subject_name).trim() !== accountName) {
    throw Errors.badRequest('收款户名须与店铺入驻主体名称一致', { field: 'accountName' });
  }

  const verifyAmount = 1 + Math.floor(Math.random() * 100); // 0.01 ~ 1.00 元
  const id = run(
    `INSERT INTO shop_accounts (shop_id, account_type, account_name, bank_name, account_no, id_card_tail,
        verified, verify_amount, verify_fail_count, effective_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 1, ?, ?)`,
    shop.id, accountType, accountName, bankName, encrypt(accountNo), idCardTail,
    verifyAmount, addDays(1), now(), now(),
  ).lastInsertRowid;
  S.audit(ctx, '结算', '绑定收款账户', 'shop_account', id,
    `${accountType} / ${accountName} / ${maskAccount(accountNo)}`);
  return {
    ...toAccountApi(get('SELECT * FROM shop_accounts WHERE id = ?', id)),
    verifyTip: `已向该账户打入 ${toYuan(verifyAmount)} 元随机小额验证款，请回填金额完成验证`,
  };
}

/** GET /api/seller/accounts 收款账户列表（掩码） */
function accountList(ctx) {
  const shop = S.shopOf(ctx);
  const rows = all('SELECT * FROM shop_accounts WHERE shop_id = ? AND status = 1 ORDER BY id DESC', shop.id);
  return { total: rows.length, rows: rows.map(toAccountApi) };
}

/** POST /api/seller/accounts/:id/verify 回填小额打款金额（连续 3 次错误锁定 24 小时） */
function accountVerify(ctx) {
  const shop = S.activeShop(ctx);
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM shop_accounts WHERE id = ? AND shop_id = ?', id, shop.id);
  if (!row) throw Errors.notFound('收款账户不存在');
  if (row.verify_locked_until && row.verify_locked_until > now()) {
    throw Errors.badRequest(`验证已锁定，请于 ${row.verify_locked_until} 后重试`);
  }
  if (row.verified === 1) throw Errors.badRequest('该账户已验证通过');

  const body = ctx.body || {};
  const cents = require('../core/money').toCents(body.amount ?? body.verifyAmount);
  if (!Number.isInteger(cents) || cents <= 0) {
    throw Errors.badRequest('请回填收到的小额打款金额', { field: 'amount' });
  }
  if (cents === row.verify_amount) {
    run('UPDATE shop_accounts SET verified = 1, verify_fail_count = 0, verify_locked_until = NULL, updated_at = ? WHERE id = ?',
      now(), row.id);
    S.audit(ctx, '结算', '收款账户验证通过', 'shop_account', row.id, maskAccount(decrypt(row.account_no)));
    return { ...toAccountApi(get('SELECT * FROM shop_accounts WHERE id = ?', row.id)), tip: '收款账户验证通过' };
  }
  const failCount = row.verify_fail_count + 1;
  if (failCount >= 3) {
    const lockedUntil = addDays(1);
    run('UPDATE shop_accounts SET verify_fail_count = 0, verify_locked_until = ?, updated_at = ? WHERE id = ?',
      lockedUntil, now(), row.id);
    S.audit(ctx, '结算', '收款账户验证失败锁定', 'shop_account', row.id, `连续 3 次回填错误，锁定至 ${lockedUntil}`);
    throw Errors.badRequest(`小额打款金额连续 3 次错误，账户验证锁定 24 小时（至 ${lockedUntil}）`);
  }
  run('UPDATE shop_accounts SET verify_fail_count = ?, updated_at = ? WHERE id = ?', failCount, now(), row.id);
  S.audit(ctx, '结算', '收款账户验证失败', 'shop_account', row.id, `第 ${failCount} 次回填错误`);
  throw Errors.badRequest(`回填金额不正确，还可尝试 ${3 - failCount} 次`);
}

module.exports = function register(api) {
  api.get('/api/seller/activities', { auth: 'seller' }, activityList);
  api.post('/api/seller/activities', { auth: 'seller' }, activitySave);
  api.post('/api/seller/activities/:id/close', { auth: 'seller' }, activityClose);

  api.get('/api/seller/coupons', { auth: 'seller' }, couponList);
  api.get('/api/seller/coupons/stat', { auth: 'seller' }, couponStat);
  api.post('/api/seller/coupons', { auth: 'seller' }, couponSave);

  api.post('/api/seller/group-buys/apply', { auth: 'seller' }, groupBuyApply);

  api.get('/api/seller/accounts', { auth: 'seller' }, accountList);
  api.post('/api/seller/accounts', { auth: 'seller' }, accountCreate);
  api.post('/api/seller/accounts/:id/verify', { auth: 'seller' }, accountVerify);
};
