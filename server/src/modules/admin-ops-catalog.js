'use strict';

const db = require('../core/db');
const { get, all, run, transaction, parseJson } = db;
const { now } = require('../core/money');
const { Errors } = require('../core/errors');
const v = require('../core/validate');
const config = require('../core/config');
const svc = require('../services/admin-ops-service');

/**
 * 平台后台 · 运营域：类目管理 + 搜索热词 / 屏蔽词 / 索引重建
 * 覆盖 API-092 ~ API-095、API-102、API-103（FR-OPS-001 ~ FR-OPS-008）
 *
 * 权限码：menu.ops.category（类目）、menu.ops.content（搜索内容位，运营域无独立搜索权限码）
 * 约定：列表统一 { total, rows }；金额分存储；写操作落 operation_logs；超级管理员由 auth.js 直接放行。
 */

const PERM_CATEGORY = 'menu.ops.category';
const PERM_CONTENT = 'menu.ops.content';

// ==================== API-092 类目树 ====================

/**
 * GET /api/admin/categories
 * 完整类目树（含停用）；?flat=1 返回扁平列表。
 * 返回 { total, rows }，树形时 rows 为一级类目数组（children 递归）。
 */
function listCategories(ctx) {
  const rows = all('SELECT * FROM categories ORDER BY level ASC, sort ASC, id ASC');
  const countMap = new Map();
  for (const r of all('SELECT category_id, COUNT(*) AS c FROM products GROUP BY category_id')) {
    countMap.set(Number(r.category_id), Number(r.c));
  }
  const items = rows.map((r) => svc.categoryOut(r, countMap.get(Number(r.id)) || 0));
  const flat = String(ctx.query.flat || '') === '1' || String(ctx.query.flat || '').toLowerCase() === 'true';
  if (flat) return { total: items.length, rows: items, flat: true };
  const tree = svc.buildCategoryTree(items);
  return { total: items.length, rows: tree, flat: false };
}

// ==================== API-093 类目保存 / 排序 / 批量导入 ====================

/**
 * POST /api/admin/categories
 * 三种载荷（同一接口，按载荷形态分派，返回体 mode 字段说明）：
 *  1) 单条新增 / 更新 / 排序：{ id?, name, parentId, icon, sort, status }
 *  2) 批量导入（附录 C 词条）：{ items: [{ name, icon?, children? }] } 或直接数组
 *     children 可为字符串数组、[{ name, children }] 数组，或 { 二级名: [三级...] } 对象映射；
 *  3) 批量排序：{ orders: [{ id, sort }] }
 */
function saveCategories(ctx) {
  const body = ctx.body;
  if (Array.isArray(body)) return importCategoryNodes(ctx, body);
  const payload = body || {};
  if (Array.isArray(payload.items)) return importCategoryNodes(ctx, payload.items);
  if (Array.isArray(payload.orders)) return reorderCategories(ctx, payload.orders);
  return saveOneCategory(ctx, payload);
}

function reorderCategories(ctx, orders) {
  if (!orders.length) throw Errors.badRequest('排序列表不能为空');
  const updated = [];
  transaction(() => {
    for (const item of orders) {
      const id = v.int(item?.id, 'id', { min: 1 });
      const sort = svc.intOr(item?.sort, 'sort', 0);
      const res = run('UPDATE categories SET sort = ?, updated_at = ? WHERE id = ?', sort, now(), id);
      if (res.changes === 0) throw Errors.notFound(`类目不存在（id=${id}）`);
      updated.push({ id, sort });
    }
  });
  svc.writeLog(ctx, { module: '类目', action: '排序', targetType: 'category', targetId: updated.map((u) => u.id).join(','), detail: { count: updated.length, orders: updated } });
  return { mode: 'reorder', updated: updated.length, rows: updated };
}

function saveOneCategory(ctx, body) {
  const id = body.id === undefined || body.id === null || body.id === '' ? null : v.int(body.id, 'id', { min: 1 });
  const existing = id ? get('SELECT * FROM categories WHERE id = ?', id) : null;
  if (id && !existing) throw Errors.notFound('类目不存在');

  const name = v.str(body.name !== undefined ? body.name : existing?.name, 'name', { min: 1, max: 30 });
  const parentId = body.parentId !== undefined || body.parent_id !== undefined
    ? svc.uintOr(body.parentId !== undefined ? body.parentId : body.parent_id, 'parentId', 0)
    : Number(existing?.parent_id || 0);

  // 层级校验：最多三级（FR-OPS-001 / BR-CAT-003）
  let parent = null;
  if (parentId > 0) {
    parent = get('SELECT * FROM categories WHERE id = ?', parentId);
    if (!parent) throw Errors.badRequest('上级类目不存在');
    if (Number(parent.level) >= 3) throw Errors.badRequest('类目层级最多三级');
  }
  const level = parent ? Number(parent.level) + 1 : 1;

  // 防环：不能把类目挂到自身或其后代下
  if (id && parentId > 0) {
    const subtree = svc.categorySubtreeIds(id);
    if (subtree.includes(parentId)) throw Errors.badRequest('不能将类目移动到其自身或子类目下');
    // 移动后子树深度不得超过三级
    const maxDepth = subtreeDepth(id);
    if (level + maxDepth - 1 > 3) throw Errors.badRequest('类目层级最多三级');
  }

  // 同一父级下名称唯一（FR-OPS-004）
  const dup = get(
    'SELECT id FROM categories WHERE parent_id = ? AND name = ? AND id <> ?',
    parentId, name, id || 0,
  );
  if (dup) throw Errors.badRequest('同一父级下名称不能重复');

  const icon = body.icon !== undefined ? String(body.icon ?? '').trim() : (existing?.icon ?? null);
  const sort = body.sort !== undefined ? svc.intOr(body.sort, 'sort', 0) : Number(existing?.sort || 0);
  const status = body.status !== undefined ? Number(v.oneOf(body.status, ['0', '1'], 'status')) : Number(existing?.status ?? 1);

  let categoryId;
  let created = false;
  transaction(() => {
    if (id) {
      run('UPDATE categories SET name = ?, parent_id = ?, level = ?, icon = ?, sort = ?, status = ?, updated_at = ? WHERE id = ?',
        name, parentId, level, icon, sort, status, now(), id);
      categoryId = id;
      // 层级可能变化，级联刷新后代 level
      refreshDescendantLevels(id, level);
    } else {
      categoryId = Number(run(
        'INSERT INTO categories (name, parent_id, level, icon, sort, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        name, parentId, level, icon, sort, status, now(), now(),
      ).lastInsertRowid);
      created = true;
    }
  });

  const row = get('SELECT * FROM categories WHERE id = ?', categoryId);
  svc.writeLog(ctx, {
    module: '类目', action: created ? '新增' : '更新', targetType: 'category', targetId: categoryId,
    detail: { name, parentId, level, sort, status },
  });
  return { mode: created ? 'create' : 'update', created, ...svc.categoryOut(row), path: svc.categoryPath(categoryId) };
}

/** 类目子树的相对深度（自身为 1） */
function subtreeDepth(categoryId) {
  const row = get(
    `WITH RECURSIVE sub(id, depth) AS (
       SELECT id, 1 FROM categories WHERE id = ?
       UNION ALL
       SELECT c.id, s.depth + 1 FROM categories c JOIN sub s ON c.parent_id = s.id
     ) SELECT MAX(depth) AS d FROM sub`,
    categoryId,
  );
  return Number(row?.d || 1);
}

/** 级联刷新后代 level */
function refreshDescendantLevels(parentId, parentLevel) {
  const children = all('SELECT id FROM categories WHERE parent_id = ?', parentId);
  for (const child of children) {
    const level = parentLevel + 1;
    if (level > 3) throw Errors.badRequest('类目层级最多三级');
    run('UPDATE categories SET level = ?, updated_at = ? WHERE id = ?', level, now(), child.id);
    refreshDescendantLevels(child.id, level);
  }
}

/**
 * 批量导入附录 C 词条（幂等：按「父级 + 名称」复用已存在节点）。
 */
function importCategoryNodes(ctx, nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw Errors.badRequest('导入词条不能为空');
  const stat = { created: 0, updated: 0, skipped: 0, levels: { 1: 0, 2: 0, 3: 0 } };
  const applied = [];

  const walk = (items, parentId, depth) => {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      let name; let icon; let sort; let children;
      if (typeof raw === 'string' || typeof raw === 'number') {
        name = String(raw).trim();
        children = [];
      } else if (raw && typeof raw === 'object') {
        name = String(raw.name ?? raw.title ?? '').trim();
        icon = raw.icon;
        sort = raw.sort;
        children = raw.children !== undefined ? raw.children : (raw.items !== undefined ? raw.items : []);
      } else {
        stat.skipped += 1;
        continue;
      }
      if (!name) { stat.skipped += 1; continue; }
      if (depth > 3) throw Errors.badRequest('类目层级最多三级');
      if (name.length > 30) throw Errors.badRequest(`类目名称过长：${name}`);

      let row = get('SELECT * FROM categories WHERE parent_id = ? AND name = ?', parentId, name);
      if (row) {
        const nextSort = sort !== undefined ? svc.intOr(sort, 'sort', 0) : Number(row.sort || 0);
        const nextIcon = icon !== undefined ? String(icon ?? '').trim() : row.icon;
        run('UPDATE categories SET level = ?, sort = ?, icon = ?, updated_at = ? WHERE id = ?',
          depth, nextSort, nextIcon, now(), row.id);
        stat.updated += 1;
      } else {
        const nextSort = sort !== undefined ? svc.intOr(sort, 'sort', 0) : countSiblings(parentId);
        const newId = run(
          'INSERT INTO categories (name, parent_id, level, icon, sort, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
          name, parentId, depth, icon !== undefined ? String(icon ?? '').trim() : null, nextSort, now(), now(),
        ).lastInsertRowid;
        row = get('SELECT * FROM categories WHERE id = ?', newId);
        stat.created += 1;
      }
      stat.levels[depth] = (stat.levels[depth] || 0) + 1;
      applied.push({ id: Number(row.id), name, parentId: Number(parentId), level: depth });

      // children 支持数组 / 对象映射（{ 二级名: [三级词条] }）
      if (Array.isArray(children)) {
        walk(children, Number(row.id), depth + 1);
      } else if (children && typeof children === 'object') {
        walk(Object.entries(children).map(([key, value]) => ({ name: key, children: value })), Number(row.id), depth + 1);
      }
    }
  };

  transaction(() => walk(nodes, 0, 1));

  svc.writeLog(ctx, {
    module: '类目', action: '批量导入', targetType: 'category', targetId: 'batch',
    detail: { created: stat.created, updated: stat.updated, skipped: stat.skipped, levels: stat.levels },
  });
  return { mode: 'import', ...stat, total: stat.created + stat.updated, rows: applied.slice(0, 200) };
}

function countSiblings(parentId) {
  return Number(get('SELECT COUNT(*) AS c FROM categories WHERE parent_id = ?', parentId).c);
}

// ==================== API-094 类目删除 ====================

/**
 * DELETE /api/admin/categories/:id
 * 存在子类目或商品时拒绝，并提示影响条数（FR-OPS-002）。
 */
function deleteCategory(ctx) {
  const id = v.int(ctx.params.id, 'id', { min: 1 });
  const cat = get('SELECT * FROM categories WHERE id = ?', id);
  if (!cat) throw Errors.notFound('类目不存在');

  const childCount = Number(get('SELECT COUNT(*) AS c FROM categories WHERE parent_id = ?', id).c);
  const ids = svc.categorySubtreeIds(id);
  const placeholders = ids.map(() => '?').join(',');
  const productCount = Number(get(`SELECT COUNT(*) AS c FROM products WHERE category_id IN (${placeholders})`, ...ids).c);

  if (childCount > 0 || productCount > 0) {
    // 提示影响条数（含已逻辑删除商品，避免外键约束报错）
    throw Errors.badRequest(`该类目下存在子类目或商品，不能删除（子类目 ${childCount} 个 / 商品 ${productCount} 个）`);
  }

  run('DELETE FROM categories WHERE id = ?', id);
  svc.writeLog(ctx, { module: '类目', action: '删除', targetType: 'category', targetId: id, detail: { name: cat.name } });
  return { deleted: true, id, name: cat.name };
}

// ==================== API-095 类目启用 / 停用 ====================

/**
 * PATCH /api/admin/categories/:id/status
 * 停用：该类目及后代下的商品自动下架（status=3），并给相关商家推送站内通知；
 * 启用：恢复类目展示，商品不自动上架（需商家重新提交审核，FR-OPS-003）。
 */
function updateCategoryStatus(ctx) {
  const id = v.int(ctx.params.id, 'id', { min: 1 });
  const cat = get('SELECT * FROM categories WHERE id = ?', id);
  if (!cat) throw Errors.notFound('类目不存在');

  const body = ctx.body || {};
  const status = Number(v.oneOf(body.status !== undefined ? body.status : body.enabled, ['0', '1'], 'status'));
  const substatus = status === 1 ? '启用' : '停用';
  const affectedCategoryIds = svc.categorySubtreeIds(id);
  let offShelfProducts = 0;
  const notifiedShops = [];

  transaction(() => {
    run('UPDATE categories SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);

    if (status === 0) {
      const placeholders = affectedCategoryIds.map(() => '?').join(',');
      const products = all(
        `SELECT id, shop_id FROM products WHERE is_deleted = 0 AND category_id IN (${placeholders}) AND status IN (1, 2)`,
        ...affectedCategoryIds,
      );
      if (products.length) {
        const productIds = products.map((p) => Number(p.id));
        run(
          `UPDATE products SET status = 3, audit_reason = ?, updated_at = ? WHERE id IN (${productIds.map(() => '?').join(',')})`,
          `所属类目「${cat.name}」已停用，商品自动下架`, now(), ...productIds,
        );
        offShelfProducts = products.length;
      }
      const shopCount = new Map();
      for (const p of products) shopCount.set(Number(p.shop_id), (shopCount.get(Number(p.shop_id)) || 0) + 1);
      for (const [shopId, count] of shopCount) {
        svc.notifySeller(
          shopId,
          '类目停用，商品已自动下架',
          `平台已将类目「${cat.name}」停用，您店铺下 ${count} 个商品已自动下架。请调整商品类目后重新提交审核，审核通过后可再次上架。`,
        );
        notifiedShops.push(shopId);
      }
    }
  });

  svc.writeLog(ctx, {
    module: '类目', action: status === 1 ? '启用' : '停用', targetType: 'category', targetId: id,
    detail: { name: cat.name, status, level: cat.level, affectedCategories: affectedCategoryIds.length, offShelfProducts, notifiedShops },
  });

  return {
    id, name: cat.name, status, statusName: substatus,
    affectedCategories: affectedCategoryIds.length,
    offShelfProducts,
    notifiedShops,
    note: status === 0 ? '该类目及后代下的在售/待审核商品已自动下架，并已通知相关商家' : '类目已恢复启用，商品需商家重新提交审核后上架（不自动上架）',
  };
}

// ==================== API-102 搜索热词 / 屏蔽词 ====================

const SEARCH_WORD_TYPES = ['hot', 'block'];
const SEARCH_WORD_TYPE_NAMES = { hot: '热词', block: '屏蔽词' };

/** GET /api/admin/search-words（API-102 的查询面，便于维护页展示） */
function listSearchWords(ctx) {
  const params = [];
  let where = 'WHERE 1 = 1';
  if (ctx.query.type) {
    const type = v.oneOf(ctx.query.type, SEARCH_WORD_TYPES, 'type');
    where += ' AND type = ?';
    params.push(type);
  }
  const total = Number(get(`SELECT COUNT(*) AS c FROM search_words ${where}`, ...params).c);
  const rows = all(`SELECT * FROM search_words ${where} ORDER BY type ASC, sort ASC, id ASC`, ...params).map(searchWordOut);
  return {
    total,
    rows,
    types: SEARCH_WORD_TYPES.map((t) => ({ value: t, name: SEARCH_WORD_TYPE_NAMES[t] })),
  };
}

function searchWordOut(r) {
  return {
    id: Number(r.id),
    word: r.word,
    type: r.type,
    typeName: SEARCH_WORD_TYPE_NAMES[r.type] || r.type,
    sort: Number(r.sort || 0),
    startAt: r.start_at,
    endAt: r.end_at,
    createdAt: r.created_at,
  };
}

/**
 * POST /api/admin/search-words
 * 两种模式（返回体 mode 字段说明）：
 *  - 整体覆盖（replace）：{ words: [...] } 或直接数组；可带 type 限定覆盖范围（不带则覆盖全部）。
 *    每个元素 { word, type, sort, startAt, endAt }，用于前端"保存整张词库表"。
 *  - 单条新增 / 更新（single）：{ id?, word, type, sort, startAt, endAt }。
 * 屏蔽词命中后由前台搜索返回空结果并提示（FR-OPS-006），此处仅维护词库。
 */
function saveSearchWords(ctx) {
  const body = ctx.body;
  const list = Array.isArray(body) ? body : (Array.isArray(body?.words) ? body.words : null);
  if (list) return replaceSearchWords(ctx, list, body);
  return saveOneSearchWord(ctx, body || {});
}

function replaceSearchWords(ctx, list, body) {
  let scopeType = null;
  const rawType = Array.isArray(body) ? null : body?.type;
  if (rawType) scopeType = v.oneOf(rawType, SEARCH_WORD_TYPES, 'type');

  const normalized = [];
  const seen = new Set();
  let sort = 0;
  for (const item of list) {
    let word; let type; let itemSort; let startAt; let endAt;
    if (typeof item === 'string') {
      word = item.trim();
      type = scopeType || 'hot';
    } else if (item && typeof item === 'object') {
      word = String(item.word ?? '').trim();
      type = item.type ? v.oneOf(item.type, SEARCH_WORD_TYPES, 'type') : (scopeType || 'hot');
      itemSort = item.sort;
      startAt = item.startAt !== undefined ? item.startAt : item.start_at;
      endAt = item.endAt !== undefined ? item.endAt : item.end_at;
    } else {
      continue;
    }
    if (!word) throw Errors.badRequest('词条不能为空');
    if (word.length > 30) throw Errors.badRequest(`词条过长（最多 30 字）：${word}`);
    const key = `${type}:${word}`;
    if (seen.has(key)) continue; // 同类型重复词条去重
    seen.add(key);
    normalized.push({
      word,
      type,
      sort: itemSort !== undefined ? svc.intOr(itemSort, 'sort', 0) : sort,
      startAt: svc.normTime(startAt, { field: 'startAt' }),
      endAt: svc.normTime(endAt, { field: 'endAt', endOfDay: true }),
    });
    sort += 1;
  }

  transaction(() => {
    if (scopeType) run('DELETE FROM search_words WHERE type = ?', scopeType);
    else run('DELETE FROM search_words');
    for (const item of normalized) {
      run(
        'INSERT INTO search_words (word, type, sort, start_at, end_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        item.word, item.type, item.sort, item.startAt, item.endAt, now(),
      );
    }
  });

  svc.writeLog(ctx, {
    module: '搜索', action: '保存词库', targetType: 'search_word', targetId: 'batch',
    detail: { mode: 'replace', scopeType: scopeType || 'all', total: normalized.length },
  });

  return {
    mode: 'replace',
    scopeType: scopeType || 'all',
    total: normalized.length,
    rows: all('SELECT * FROM search_words ORDER BY type ASC, sort ASC, id ASC').map(searchWordOut),
    note: '整体覆盖保存：先清空目标范围旧词条再写入，用于运营整表维护；如只需新增单条，请提交 { word, type } 形态。',
  };
}

function saveOneSearchWord(ctx, body) {
  const id = body.id === undefined || body.id === null || body.id === '' ? null : v.int(body.id, 'id', { min: 1 });
  const existing = id ? get('SELECT * FROM search_words WHERE id = ?', id) : null;
  if (id && !existing) throw Errors.notFound('词条不存在');

  const word = v.str(body.word !== undefined ? body.word : existing?.word, 'word', { min: 1, max: 30 });
  const type = body.type !== undefined
    ? v.oneOf(body.type, SEARCH_WORD_TYPES, 'type')
    : (existing?.type || 'hot');
  const sort = body.sort !== undefined ? svc.intOr(body.sort, 'sort', 0) : Number(existing?.sort || 0);
  const startAt = body.startAt !== undefined ? svc.normTime(body.startAt, { field: 'startAt' }) : (existing?.start_at ?? null);
  const endAt = body.endAt !== undefined ? svc.normTime(body.endAt, { field: 'endAt', endOfDay: true }) : (existing?.end_at ?? null);
  if (startAt && endAt && startAt >= endAt) throw Errors.badRequest('生效结束时间须晚于开始时间');

  const dup = get('SELECT id FROM search_words WHERE type = ? AND word = ? AND id <> ?', type, word, id || 0);
  if (dup) throw Errors.badRequest('同一类型下词条不能重复');

  let wordId;
  let created = false;
  if (id) {
    run('UPDATE search_words SET word = ?, type = ?, sort = ?, start_at = ?, end_at = ? WHERE id = ?',
      word, type, sort, startAt, endAt, id);
    wordId = id;
  } else {
    wordId = Number(run(
      'INSERT INTO search_words (word, type, sort, start_at, end_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      word, type, sort, startAt, endAt, now(),
    ).lastInsertRowid);
    created = true;
  }

  svc.writeLog(ctx, {
    module: '搜索', action: created ? '新增词条' : '更新词条', targetType: 'search_word', targetId: wordId,
    detail: { word, type, sort },
  });

  return {
    mode: 'single',
    created,
    row: searchWordOut(get('SELECT * FROM search_words WHERE id = ?', wordId)),
    note: '单条新增 / 更新；如需整表覆盖保存请提交 { words: [...] } 形态。',
  };
}

// ==================== API-103 搜索索引重建 ====================

/**
 * POST /api/admin/search/reindex
 * 轻量重建（不引入外部搜索引擎）：
 *  - 真实统计可检索的商品 / 店铺 / 活动 / 券数量（SQL 口径见下）；
 *  - 把口径快照与重建时间写入 system_configs（search_index_snapshot / search_index_built_at），
 *    前台搜索读取快照展示"索引已更新至 xx:xx"，检索本身仍走参数化的 SQL LIKE 查询；
 *  - 返回 { indexed, costMs, progress: 1 }，progress 用于前端进度条（轻量重建一次到位）。
 */
function reindex(ctx) {
  const startedAt = Date.now();
  const indexed = {
    product: Number(get('SELECT COUNT(*) AS c FROM products WHERE is_deleted = 0 AND status = 2').c),
    shop: Number(get('SELECT COUNT(*) AS c FROM shops WHERE status = 1').c),
    activity: Number(get('SELECT COUNT(*) AS c FROM activities WHERE status = 1').c),
    coupon: Number(get('SELECT COUNT(*) AS c FROM coupons WHERE status = 1').c),
  };
  const snapshot = {
    at: now(),
    operatorId: ctx.admin?.id ?? null,
    indexed,
    scopes: parseJson(config.getString('search_scopes'), ['shop', 'product', 'activity', 'coupon']),
    mode: 'lightweight',
  };
  config.set('search_index_snapshot', JSON.stringify(snapshot), '搜索索引快照（轻量重建，非外部索引）', ctx.admin?.id ?? null);
  config.set('search_index_built_at', now(), '搜索索引最近重建时间', ctx.admin?.id ?? null);
  const costMs = Date.now() - startedAt;

  svc.writeLog(ctx, {
    module: '搜索', action: '重建索引', targetType: 'search_index', targetId: 'all',
    detail: { indexed, costMs },
  });

  return {
    indexed,
    costMs,
    progress: 1,
    mode: 'lightweight',
    builtAt: now(),
    note: '轻量重建：未引入外部搜索引擎，基于 SQLite 现有业务表真实统计可检索数据量并落库索引快照；检索仍走参数化 SQL，重建为幂等操作。',
  };
}

module.exports = function register(api) {
  // API-092 / 093 / 094 / 095 类目管理（FR-OPS-001 ~ 004）
  api.get('/api/admin/categories', { auth: 'admin', perm: PERM_CATEGORY }, listCategories);
  api.post('/api/admin/categories', { auth: 'admin', perm: PERM_CATEGORY }, saveCategories);
  api.delete('/api/admin/categories/:id', { auth: 'admin', perm: PERM_CATEGORY }, deleteCategory);
  api.patch('/api/admin/categories/:id/status', { auth: 'admin', perm: PERM_CATEGORY }, updateCategoryStatus);

  // API-102 / 103 热词 / 屏蔽词 / 索引重建（FR-OPS-005 ~ 008）
  api.get('/api/admin/search-words', { auth: 'admin', perm: PERM_CONTENT }, listSearchWords);
  api.post('/api/admin/search-words', { auth: 'admin', perm: PERM_CONTENT }, saveSearchWords);
  api.post('/api/admin/search/reindex', { auth: 'admin', perm: PERM_CONTENT }, reindex);
};
