'use strict';

const db = require('../core/db');
const { get, all, run, transaction } = db;
const { now, toYuan, parseTime } = require('../core/money');
const { Errors } = require('../core/errors');
const v = require('../core/validate');
const config = require('../core/config');
const svc = require('../services/admin-ops-service');

/**
 * 平台后台 · 运营域：内容位（首页轮播 / 楼层位、右侧推荐位、页尾配置）
 * 覆盖 API-096 ~ API-101（FR-OPS-009 ~ FR-OPS-016）
 *
 * 权限码：menu.ops.content
 * 约定：列表 { total, rows }；分页默认 20 / 上限 50；写操作落 operation_logs。
 */

const PERM_CONTENT = 'menu.ops.content';

const BANNER_POSITIONS = {
  home: '首页主图轮播',
  floor: '首页楼层位',
  category: '分类页轮播',
  activity: '活动页轮播',
};

const RECOMMEND_TABS = { shop: '推荐商家', product: '推荐商品', activity: '最新活动' };

// ==================== 内容位通用：生效状态 ====================

/**
 * 线上状态判定（FR-OPS-011 / FR-OPS-013）：
 * status=0 → 已下线；未到 start_at → 未开始；已过 end_at → 已过期；其余 → 进行中。
 */
function liveState(row, at = now()) {
  if (Number(row.status ?? 1) !== 1) return { code: 'offline', name: '已下线' };
  const start = row.start_at || row.startAt;
  const end = row.end_at || row.endAt;
  if (start && parseTime(start) > parseTime(at)) return { code: 'pending', name: '未开始' };
  if (end && parseTime(end) <= parseTime(at)) return { code: 'expired', name: '已过期' };
  return { code: 'online', name: '进行中' };
}

// ==================== API-096 轮播 / 楼层位列表 ====================

/**
 * GET /api/admin/banners
 * ?position=home&status=1&page=&pageSize=
 * 返回 { total, rows }，rows 含 effective（进行中 / 未开始 / 已过期 / 已下线）。
 */
function listBanners(ctx) {
  const params = [];
  let where = 'WHERE 1 = 1';
  if (ctx.query.position) {
    where += ' AND position = ?';
    params.push(String(ctx.query.position).trim());
  }
  if (ctx.query.status !== undefined && ctx.query.status !== '') {
    where += ' AND status = ?';
    params.push(Number(v.oneOf(ctx.query.status, ['0', '1'], 'status')));
  }
  if (ctx.query.keyword) {
    where += ' AND (title LIKE ? OR link LIKE ?)';
    params.push(`%${ctx.query.keyword}%`, `%${ctx.query.keyword}%`);
  }
  const { page, pageSize, offset } = db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
  const total = Number(get(`SELECT COUNT(*) AS c FROM banners ${where}`, ...params).c);
  const rows = all(
    `SELECT * FROM banners ${where} ORDER BY position ASC, sort ASC, id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset,
  ).map(bannerOut);
  return {
    total,
    rows,
    page,
    pageSize,
    positions: Object.entries(BANNER_POSITIONS).map(([value, name]) => ({ value, name })),
  };
}

function bannerOut(r) {
  const state = liveState(r);
  return {
    id: Number(r.id),
    title: r.title || '',
    position: r.position,
    positionName: BANNER_POSITIONS[r.position] || r.position,
    image: r.image,
    link: r.link || '',
    sort: Number(r.sort || 0),
    startAt: r.start_at,
    endAt: r.end_at,
    status: Number(r.status),
    statusName: Number(r.status) === 1 ? '启用' : '停用',
    effective: state.code,
    effectiveName: state.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ==================== API-097 轮播 / 楼层位保存 ====================

/**
 * POST /api/admin/banners
 * { id?, title, position, image, link, sort, startAt, endAt, status }
 * id 存在 → 更新；否则新增。position 默认 home；status 默认 1（上线）。
 */
function saveBanner(ctx) {
  const body = ctx.body || {};
  const id = body.id === undefined || body.id === null || body.id === '' ? null : v.int(body.id, 'id', { min: 1 });
  const existing = id ? get('SELECT * FROM banners WHERE id = ?', id) : null;
  if (id && !existing) throw Errors.notFound('轮播位不存在');

  const title = v.str(body.title !== undefined ? body.title : (existing?.title || ''), 'title', { min: 1, max: 60 });
  const position = body.position !== undefined
    ? v.str(body.position, 'position', { min: 1, max: 30 })
    : (existing?.position || 'home');
  const image = v.str(body.image !== undefined ? body.image : existing?.image, 'image', { min: 1, max: 500 });
  const link = body.link !== undefined ? String(body.link ?? '').trim() : (existing?.link || '');
  if (link && !/^(https?:\/\/|\/)/i.test(link)) throw Errors.badRequest('跳转链接须为 http(s) 地址或站内路由（以 / 开头）');
  const sort = body.sort !== undefined ? svc.intOr(body.sort, 'sort', 0) : Number(existing?.sort || 0);
  const startAt = body.startAt !== undefined ? svc.normTime(body.startAt, { field: 'startAt' }) : (existing?.start_at ?? null);
  const endAt = body.endAt !== undefined ? svc.normTime(body.endAt, { field: 'endAt', endOfDay: true }) : (existing?.end_at ?? null);
  if (startAt && endAt && startAt >= endAt) throw Errors.badRequest('生效结束时间须晚于开始时间');
  const status = body.status !== undefined
    ? Number(v.oneOf(body.status, ['0', '1'], 'status'))
    : Number(existing?.status ?? 1);

  let bannerId;
  let created = false;
  if (id) {
    run(
      `UPDATE banners SET title = ?, position = ?, image = ?, link = ?, sort = ?, start_at = ?, end_at = ?, status = ?, updated_at = ?
        WHERE id = ?`,
      title, position, image, link, sort, startAt, endAt, status, now(), id,
    );
    bannerId = id;
  } else {
    bannerId = Number(run(
      `INSERT INTO banners (title, position, image, link, sort, start_at, end_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      title, position, image, link, sort, startAt, endAt, status, now(), now(),
    ).lastInsertRowid);
    created = true;
  }

  svc.writeLog(ctx, {
    module: '内容位', action: created ? '新增轮播位' : '更新轮播位', targetType: 'banner', targetId: bannerId,
    detail: { title, position, sort, status, startAt, endAt },
  });

  return { created, row: bannerOut(get('SELECT * FROM banners WHERE id = ?', bannerId)) };
}

// ==================== API-098 推荐位列表 ====================

/**
 * GET /api/admin/recommend-slots
 * ?tabType=shop|product|activity&page=&pageSize=
 * 返回 { total, rows }；rows 含目标快照（名称 / 状态）与 targetValid 死链标记（FR-OPS-014）。
 */
function listRecommendSlots(ctx) {
  const params = [];
  let where = 'WHERE 1 = 1';
  if (ctx.query.tabType) {
    where += ' AND tab_type = ?';
    params.push(v.oneOf(ctx.query.tabType, Object.keys(RECOMMEND_TABS), 'tabType'));
  }
  const { page, pageSize, offset } = db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
  const total = Number(get(`SELECT COUNT(*) AS c FROM recommend_slots ${where}`, ...params).c);
  const rows = all(
    `SELECT * FROM recommend_slots ${where} ORDER BY tab_type ASC, sort ASC, id ASC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset,
  ).map(recommendOut);
  return {
    total,
    rows,
    page,
    pageSize,
    tabs: Object.entries(RECOMMEND_TABS).map(([value, name]) => ({ value, name })),
  };
}

/** 推荐位目标快照（店铺 / 商品 / 活动） */
function targetOf(tabType, targetId) {
  if (tabType === 'shop') {
    const s = get('SELECT id, name, logo, status FROM shops WHERE id = ?', targetId);
    if (!s) return { exists: false, name: '', valid: false, status: null, reason: '店铺已删除' };
    return {
      exists: true, name: s.name, image: s.logo, status: Number(s.status),
      valid: Number(s.status) === 1, reason: Number(s.status) === 1 ? '' : '店铺已停用',
    };
  }
  if (tabType === 'product') {
    const p = get('SELECT id, name, main_image, status, is_deleted FROM products WHERE id = ?', targetId);
    if (!p) return { exists: false, name: '', valid: false, status: null, reason: '商品已删除' };
    return {
      exists: true, name: p.name, image: p.main_image, status: Number(p.status),
      valid: Number(p.status) === 2 && Number(p.is_deleted) === 0,
      reason: Number(p.is_deleted) === 1 ? '商品已删除' : (Number(p.status) === 2 ? '' : '商品未上架'),
    };
  }
  const a = get('SELECT id, title, image, status FROM activities WHERE id = ?', targetId);
  if (!a) return { exists: false, name: '', valid: false, status: null, reason: '活动已删除' };
  return {
    exists: true, name: a.title, image: a.image, status: Number(a.status),
    valid: Number(a.status) === 1, reason: Number(a.status) === 1 ? '' : '活动非进行中',
  };
}

function recommendOut(r) {
  const tabType = r.tab_type;
  const target = targetOf(tabType, Number(r.target_id));
  const state = liveState({ status: 1, start_at: r.start_at, end_at: r.end_at });
  return {
    id: Number(r.id),
    tabType,
    tabTypeName: RECOMMEND_TABS[tabType] || tabType,
    targetId: Number(r.target_id),
    targetName: target.name,
    targetImage: target.image || '',
    targetExists: target.exists,
    targetValid: target.valid,
    invalidReason: target.reason || '',
    sort: Number(r.sort || 0),
    startAt: r.start_at,
    endAt: r.end_at,
    effective: state.code,
    effectiveName: state.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ==================== API-099 推荐位保存 ====================

/**
 * POST /api/admin/recommend-slots
 * 单条：{ id?, tabType, targetId, sort, startAt, endAt }
 * 批量覆盖：{ tabType, items: [{ targetId, sort, startAt, endAt }] }
 * 校验目标存在（避免前台死链）；目标当前不可用仅作为 warnings 返回，不阻塞保存。
 */
function saveRecommendSlot(ctx) {
  const body = ctx.body || {};
  if (Array.isArray(body.items)) return replaceRecommendSlots(ctx, body);
  return saveOneRecommendSlot(ctx, body);
}

function saveOneRecommendSlot(ctx, body) {
  const id = body.id === undefined || body.id === null || body.id === '' ? null : v.int(body.id, 'id', { min: 1 });
  const existing = id ? get('SELECT * FROM recommend_slots WHERE id = ?', id) : null;
  if (id && !existing) throw Errors.notFound('推荐位不存在');

  const tabType = body.tabType !== undefined
    ? v.oneOf(body.tabType, Object.keys(RECOMMEND_TABS), 'tabType')
    : existing?.tab_type;
  if (!tabType) throw Errors.badRequest('推荐位类型（tabType）不能为空');
  const targetId = body.targetId !== undefined
    ? v.int(body.targetId, 'targetId', { min: 1 })
    : Number(existing?.target_id);
  if (!targetId) throw Errors.badRequest('推荐目标（targetId）不能为空');
  const target = targetOf(tabType, targetId);
  if (!target.exists) throw Errors.badRequest(`推荐目标不存在（${RECOMMEND_TABS[tabType]} id=${targetId}）`);

  const sort = body.sort !== undefined ? svc.intOr(body.sort, 'sort', 0) : Number(existing?.sort || 0);
  const startAt = body.startAt !== undefined ? svc.normTime(body.startAt, { field: 'startAt' }) : (existing?.start_at ?? null);
  const endAt = body.endAt !== undefined ? svc.normTime(body.endAt, { field: 'endAt', endOfDay: true }) : (existing?.end_at ?? null);
  if (startAt && endAt && startAt >= endAt) throw Errors.badRequest('生效结束时间须晚于开始时间');

  let slotId;
  let created = false;
  if (id) {
    run('UPDATE recommend_slots SET tab_type = ?, target_id = ?, sort = ?, start_at = ?, end_at = ?, updated_at = ? WHERE id = ?',
      tabType, targetId, sort, startAt, endAt, now(), id);
    slotId = id;
  } else {
    slotId = Number(run(
      'INSERT INTO recommend_slots (tab_type, target_id, sort, start_at, end_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      tabType, targetId, sort, startAt, endAt, now(), now(),
    ).lastInsertRowid);
    created = true;
  }

  svc.writeLog(ctx, {
    module: '内容位', action: created ? '新增推荐位' : '更新推荐位', targetType: 'recommend_slot', targetId: slotId,
    detail: { tabType, targetId, sort, startAt, endAt },
  });

  return {
    created,
    row: recommendOut(get('SELECT * FROM recommend_slots WHERE id = ?', slotId)),
    warnings: target.valid ? [] : [`推荐目标当前不可用：${target.reason}，前台将自动隐藏该条目`],
  };
}

/** 按 tabType 整体覆盖保存（运营页"保存整组推荐位"） */
function replaceRecommendSlots(ctx, body) {
  const tabType = v.oneOf(body.tabType, Object.keys(RECOMMEND_TABS), 'tabType');
  if (body.items.length > 20) throw Errors.badRequest('单个推荐位最多配置 20 条');
  const warnings = [];
  const normalized = [];
  const seen = new Set();
  body.items.forEach((item, index) => {
    const targetId = v.int(item?.targetId, 'targetId', { min: 1 });
    if (seen.has(targetId)) return;
    seen.add(targetId);
    const target = targetOf(tabType, targetId);
    if (!target.exists) {
      warnings.push({ targetId, reason: `目标不存在，已跳过` });
      return;
    }
    if (!target.valid) warnings.push({ targetId, reason: `${target.reason}，前台将自动隐藏` });
    normalized.push({
      targetId,
      sort: item?.sort !== undefined ? svc.intOr(item.sort, 'sort', 0) : index,
      startAt: svc.normTime(item?.startAt, { field: 'startAt' }),
      endAt: svc.normTime(item?.endAt, { field: 'endAt', endOfDay: true }),
    });
  });

  transaction(() => {
    run('DELETE FROM recommend_slots WHERE tab_type = ?', tabType);
    for (const item of normalized) {
      run(
        'INSERT INTO recommend_slots (tab_type, target_id, sort, start_at, end_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        tabType, item.targetId, item.sort, item.startAt, item.endAt, now(), now(),
      );
    }
  });

  svc.writeLog(ctx, {
    module: '内容位', action: '批量保存推荐位', targetType: 'recommend_slot', targetId: tabType,
    detail: { tabType, total: normalized.length, skipped: warnings.length },
  });

  return {
    mode: 'replace',
    tabType,
    tabTypeName: RECOMMEND_TABS[tabType],
    saving: normalized.length,
    skipped: warnings,
    rows: all('SELECT * FROM recommend_slots WHERE tab_type = ? ORDER BY sort ASC, id ASC', tabType).map(recommendOut),
  };
}

// ==================== API-100 / 101 页尾配置 ====================

const FOOTER_SITE_KEYS = {
  servicePhone: { key: 'footer_service_phone', label: '客服电话', fallback: () => config.getString('service_phone') },
  serviceUrl: { key: 'footer_service_url', label: '客服入口链接', fallback: () => '/help/service' },
  serviceQr: { key: 'footer_service_qr', label: '客服二维码图片', fallback: () => '' },
  copyright: { key: 'footer_copyright', label: '版权信息', fallback: () => '© 2026 宠物之家商城 PetHomeMall 版权所有' },
  icp: { key: 'footer_icp', label: '备案信息', fallback: () => '沪ICP备2026000000号' },
};

/**
 * GET /api/admin/footer
 * 返回 footer_links 分组 + 站点信息（客服入口 / 二维码 / 版权信息）。
 * 站点信息落在 system_configs（FR-OPS-016），未配置时回退系统默认值。
 */
function getFooter(ctx) {
  const links = all('SELECT * FROM footer_links ORDER BY group_name ASC, sort ASC, id ASC');
  const groups = [];
  const groupMap = new Map();
  for (const link of links) {
    let group = groupMap.get(link.group_name);
    if (!group) {
      group = { groupName: link.group_name, items: [] };
      groupMap.set(link.group_name, group);
      groups.push(group);
    }
    group.items.push({
      id: Number(link.id),
      groupName: link.group_name,
      title: link.title,
      url: link.url,
      sort: Number(link.sort || 0),
      status: Number(link.status),
      statusName: Number(link.status) === 1 ? '显示' : '隐藏',
    });
  }

  const site = {};
  for (const [field, meta] of Object.entries(FOOTER_SITE_KEYS)) {
    const row = get('SELECT value, updated_at FROM system_configs WHERE key = ?', meta.key);
    site[field] = row ? row.value : meta.fallback();
    site[`${field}UpdatedAt`] = row ? row.updated_at : null;
  }

  return {
    links,
    groups,
    total: links.length,
    site,
    siteFields: Object.entries(FOOTER_SITE_KEYS).map(([field, meta]) => ({ field, key: meta.key, label: meta.label })),
    updatedAt: get('SELECT MAX(updated_at) AS at FROM system_configs WHERE key LIKE ?', 'footer_%')?.at || null,
  };
}

/**
 * PUT /api/admin/footer
 * { links?: [{ groupName, title, url, sort, status }], site?: { servicePhone, serviceUrl, serviceQr, copyright, icp } }
 * links 提供时整体覆盖 footer_links（分组 + 条目）；site 提供时逐项写 system_configs。
 */
function updateFooter(ctx) {
  const body = ctx.body || {};
  const hasLinks = Array.isArray(body.links) || Array.isArray(body.groups);
  const rawLinks = Array.isArray(body.links) ? body.links : (Array.isArray(body.groups) ? body.groups : null);
  if (!hasLinks && (!body.site || typeof body.site !== 'object')) {
    throw Errors.badRequest('请提供 links（页尾链接）或 site（站点信息）');
  }

  let linkCount = 0;
  if (rawLinks) {
    const normalized = [];
    let sort = 0;
    for (const item of rawLinks) {
      const groupName = v.str(item?.groupName ?? item?.group_name, 'groupName', { min: 1, max: 30 });
      const title = v.str(item?.title, 'title', { min: 1, max: 50 });
      const url = v.str(item?.url, 'url', { min: 1, max: 300 });
      if (!/^(https?:\/\/|\/)/i.test(url)) throw Errors.badRequest('页尾链接须为 http(s) 地址或站内路由（以 / 开头）');
      const status = item?.status !== undefined ? Number(v.oneOf(item.status, ['0', '1'], 'status')) : 1;
      normalized.push({
        groupName,
        title,
        url,
        sort: item?.sort !== undefined ? svc.intOr(item.sort, 'sort', 0) : sort,
        status,
      });
      sort += 1;
    }
    transaction(() => {
      run('DELETE FROM footer_links');
      for (const item of normalized) {
        run('INSERT INTO footer_links (group_name, title, url, sort, status) VALUES (?, ?, ?, ?, ?)',
          item.groupName, item.title, item.url, item.sort, item.status);
      }
    });
    linkCount = normalized.length;
  }

  const siteUpdated = [];
  if (body.site && typeof body.site === 'object') {
    for (const [field, value] of Object.entries(body.site)) {
      const meta = FOOTER_SITE_KEYS[field];
      if (!meta) continue;
      const text = String(value ?? '').trim();
      if (text.length > 500) throw Errors.badRequest(`${meta.label}长度不能超过 500 个字符`);
      config.set(meta.key, text, `页尾配置：${meta.label}`, ctx.admin?.id ?? null);
      siteUpdated.push({ field, key: meta.key, value: text });
    }
  }

  svc.writeLog(ctx, {
    module: '内容位', action: '更新页尾配置', targetType: 'footer', targetId: 'footer',
    detail: { linkCount: rawLinks ? linkCount : 'unchanged', site: siteUpdated.map((s) => s.field) },
  });

  const result = getFooter(ctx);
  return { savedLinks: rawLinks ? linkCount : null, savedSiteFields: siteUpdated.map((s) => s.field), ...result };
}

module.exports = function register(api) {
  // API-096 / 097 首页轮播与楼层位（FR-OPS-009 ~ 011）
  api.get('/api/admin/banners', { auth: 'admin', perm: PERM_CONTENT }, listBanners);
  api.post('/api/admin/banners', { auth: 'admin', perm: PERM_CONTENT }, saveBanner);

  // API-098 / 099 推荐位（FR-OPS-012 ~ 014）
  api.get('/api/admin/recommend-slots', { auth: 'admin', perm: PERM_CONTENT }, listRecommendSlots);
  api.post('/api/admin/recommend-slots', { auth: 'admin', perm: PERM_CONTENT }, saveRecommendSlot);

  // API-100 / 101 页尾与站点内容（FR-OPS-015 ~ 016）
  api.get('/api/admin/footer', { auth: 'admin', perm: PERM_CONTENT }, getFooter);
  api.put('/api/admin/footer', { auth: 'admin', perm: PERM_CONTENT }, updateFooter);
};
