-- 宠物之家商城 · 数据库结构（SQLite 运行时方言）
-- 字段语义与《需求文档》10.4 ER 图一一对应；
-- 差异说明：ER 中 order/user 为 SQL 保留字，物理表名分别落为 orders/users（详见 docs/02-数据库设计.md）。
-- 金额统一以“分”为单位存 INTEGER（对应 MySQL decimal(10,2)），由应用层统一换算，杜绝浮点误差。
-- 时间统一存 'YYYY-MM-DD HH:MM:SS'（UTC）文本，便于排序与跨库迁移。

PRAGMA foreign_keys = ON;

-- ========== 用户与会员 ==========
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  phone         TEXT    UNIQUE,
  email         TEXT    UNIQUE,
  nickname      TEXT,
  avatar        TEXT,
  status        INTEGER NOT NULL DEFAULT 1,          -- 1 正常 / 0 禁用
  fail_count    INTEGER NOT NULL DEFAULT 0,          -- 连续登录失败次数
  locked_until  TEXT,                                -- 锁定截止时间
  last_login_at TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS addresses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  receiver   TEXT    NOT NULL,
  phone      TEXT    NOT NULL,
  province   TEXT    NOT NULL,
  city       TEXT    NOT NULL,
  district   TEXT    NOT NULL,
  detail     TEXT    NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);

CREATE TABLE IF NOT EXISTS favorites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  shop_id    INTEGER NOT NULL REFERENCES shops(id),
  created_at TEXT    NOT NULL,
  UNIQUE (user_id, shop_id)
);

-- ========== 购物车 ==========
CREATE TABLE IF NOT EXISTS carts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id),
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id    INTEGER NOT NULL REFERENCES carts(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  sku_id     INTEGER NOT NULL REFERENCES skus(id),
  quantity   INTEGER NOT NULL DEFAULT 1,
  checked    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  UNIQUE (cart_id, sku_id)
);

-- ========== 类目 ==========
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  parent_id  INTEGER NOT NULL DEFAULT 0,
  level      INTEGER NOT NULL DEFAULT 1,            -- 1/2/3，最多三级
  icon       TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  status     INTEGER NOT NULL DEFAULT 1,            -- 1 启用 / 0 停用
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  UNIQUE (parent_id, name)
);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

-- ========== 店铺 / 门店 / 到店服务 ==========
CREATE TABLE IF NOT EXISTS shops (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id       INTEGER NOT NULL REFERENCES users(id),
  name           TEXT    NOT NULL UNIQUE,
  logo           TEXT,
  banner         TEXT,
  description    TEXT,
  notice         TEXT,
  phone          TEXT,
  category_ids   TEXT,                               -- JSON 数组：主营类目
  score          INTEGER NOT NULL DEFAULT 50,        -- 店铺评分 ×10（50 = 5.0）
  status         INTEGER NOT NULL DEFAULT 1,         -- 1 营业中 / 0 停用
  disable_reason TEXT,
  name_pending   TEXT,                               -- 待审核的新名称
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id        INTEGER NOT NULL REFERENCES shops(id),
  name           TEXT    NOT NULL,
  phone          TEXT,
  address        TEXT    NOT NULL,
  lng            REAL,
  lat            REAL,
  business_hours TEXT    NOT NULL DEFAULT '09:00-21:00',
  image          TEXT,
  status         INTEGER NOT NULL DEFAULT 1,         -- 1 启用 / 0 停用
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stores_shop ON stores(shop_id);

CREATE TABLE IF NOT EXISTS store_services (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id       INTEGER NOT NULL REFERENCES shops(id),
  name          TEXT    NOT NULL,
  image         TEXT,
  origin_price  INTEGER NOT NULL,                    -- 分
  store_price   INTEGER NOT NULL,                    -- 分，须 <= origin_price
  valid_start   TEXT    NOT NULL,
  valid_end     TEXT    NOT NULL,
  description   TEXT,
  booking_slots TEXT,                                -- JSON: ["09:00-10:00", ...]
  slot_capacity INTEGER NOT NULL DEFAULT 10,
  status        INTEGER NOT NULL DEFAULT 0,          -- 0 待审核 / 1 已通过 / 2 已驳回 / 3 已下线
  audit_reason  TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_services_shop ON store_services(shop_id);

CREATE TABLE IF NOT EXISTS store_service_stores (
  store_service_id INTEGER NOT NULL REFERENCES store_services(id),
  store_id         INTEGER NOT NULL REFERENCES stores(id),
  PRIMARY KEY (store_service_id, store_id)
);

CREATE TABLE IF NOT EXISTS store_bookings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_no       TEXT    NOT NULL UNIQUE,
  store_service_id INTEGER NOT NULL REFERENCES store_services(id),
  store_id         INTEGER NOT NULL REFERENCES stores(id),
  user_id          INTEGER NOT NULL REFERENCES users(id),
  booking_date     TEXT    NOT NULL,                 -- YYYY-MM-DD
  slot             TEXT    NOT NULL,                 -- HH:MM-HH:MM
  booking_time     TEXT    NOT NULL,                 -- 开始时刻
  contact          TEXT    NOT NULL,
  phone            TEXT    NOT NULL,
  remark           TEXT,
  verify_code      TEXT    NOT NULL UNIQUE,
  status           INTEGER NOT NULL DEFAULT 1,       -- 1 待到店 / 2 已核销 / 3 已取消 / 4 已过期
  pay_method       TEXT,                             -- 固定 '到店付款'
  paid_amount      INTEGER NOT NULL DEFAULT 0,
  verified_by      INTEGER,
  verified_at      TEXT,
  canceled_at      TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON store_bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON store_bookings(store_id, booking_date, slot);

CREATE TABLE IF NOT EXISTS store_verifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id   INTEGER NOT NULL REFERENCES store_bookings(id),
  verify_code  TEXT    NOT NULL,
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  shop_id      INTEGER NOT NULL REFERENCES shops(id),
  verified_by  INTEGER NOT NULL,
  paid_amount  INTEGER NOT NULL,
  pay_method   TEXT    NOT NULL DEFAULT '到店付款',
  created_at   TEXT    NOT NULL
);

-- ========== 商品 / SKU / 库存 ==========
CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id        INTEGER NOT NULL REFERENCES shops(id),
  category_id    INTEGER NOT NULL REFERENCES categories(id),
  name           TEXT    NOT NULL,
  main_image     TEXT,
  images         TEXT,                               -- JSON 数组
  detail_html    TEXT,
  brand          TEXT,
  unit           TEXT,
  product_code   TEXT,
  price          INTEGER NOT NULL,                   -- 分：最低售价（冗余，便于列表）
  origin_price   INTEGER,
  sales          INTEGER NOT NULL DEFAULT 0,
  total_stock    INTEGER NOT NULL DEFAULT 0,         -- 总库存 = 各 SKU stock 之和（冗余）
  locked_stock   INTEGER NOT NULL DEFAULT 0,         -- 锁定库存
  warn_stock     INTEGER NOT NULL DEFAULT 0,         -- 预警值
  status         INTEGER NOT NULL DEFAULT 0,         -- 0 草稿 / 1 待审核 / 2 已上架 / 3 已下架 / 4 审核驳回
  audit_reason   TEXT,
  is_deleted     INTEGER NOT NULL DEFAULT 0,
  sales_volume   INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  UNIQUE (shop_id, name)
);
CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status, is_deleted);

CREATE TABLE IF NOT EXISTS skus (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  spec_name     TEXT    NOT NULL,                    -- 如 “红色 / M”，无规格时为 “默认”
  spec_json     TEXT,                                -- {"颜色":"红","尺寸":"M"}
  price         INTEGER NOT NULL,
  origin_price  INTEGER,
  stock         INTEGER NOT NULL DEFAULT 0,          -- 总库存
  locked_stock  INTEGER NOT NULL DEFAULT 0,          -- 锁定库存
  warn_stock    INTEGER NOT NULL DEFAULT 0,
  barcode       TEXT,
  image         TEXT,
  status        INTEGER NOT NULL DEFAULT 1,
  version       INTEGER NOT NULL DEFAULT 1,          -- 乐观锁版本号
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skus_product ON skus(product_id);

CREATE TABLE IF NOT EXISTS stock_logs (            -- 只增不改
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_id        INTEGER NOT NULL REFERENCES skus(id),
  product_id    INTEGER NOT NULL,
  shop_id       INTEGER NOT NULL,
  source        TEXT    NOT NULL,                   -- 下单锁定/支付扣减/取消回滚/超时回滚/手工调整/退货入库/出入库/盘点
  change_qty    INTEGER NOT NULL,                   -- 总库存变动量
  before_qty    INTEGER NOT NULL,
  after_qty     INTEGER NOT NULL,
  locked_before INTEGER NOT NULL DEFAULT 0,
  locked_after  INTEGER NOT NULL DEFAULT 0,
  ref_no        TEXT,                               -- 关联订单号/单据号
  operator_id   INTEGER,
  operator_name TEXT,
  remark        TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_logs_sku ON stock_logs(sku_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_logs_shop ON stock_logs(shop_id, created_at);

CREATE TABLE IF NOT EXISTS stock_orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_order_no TEXT    NOT NULL UNIQUE,
  type           INTEGER NOT NULL,                  -- 1 入库 / 2 出库
  shop_id        INTEGER NOT NULL,
  source_type    TEXT    NOT NULL,                  -- 采购入库/退货入库/盘盈/销售出库/报损/盘亏
  status         INTEGER NOT NULL DEFAULT 0,        -- 0 草稿 / 1 已提交 / 2 已作废
  operator_id    INTEGER,
  remark         TEXT,
  created_at     TEXT    NOT NULL,
  submitted_at   TEXT
);

CREATE TABLE IF NOT EXISTS stock_order_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_order_id INTEGER NOT NULL REFERENCES stock_orders(id),
  sku_id         INTEGER NOT NULL,
  quantity       INTEGER NOT NULL,
  before_qty     INTEGER,
  after_qty      INTEGER
);

CREATE TABLE IF NOT EXISTS stock_takes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  take_no      TEXT    NOT NULL UNIQUE,
  shop_id      INTEGER NOT NULL,
  scope        TEXT    NOT NULL,
  status       INTEGER NOT NULL DEFAULT 0,          -- 0 草稿 / 1 已确认
  operator_id  INTEGER,
  created_at   TEXT    NOT NULL,
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_take_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_take_id INTEGER NOT NULL REFERENCES stock_takes(id),
  sku_id        INTEGER NOT NULL,
  book_qty      INTEGER NOT NULL,
  actual_qty    INTEGER NOT NULL,
  diff_qty      INTEGER NOT NULL
);

-- ========== 营销：活动 / 券 / 拼团 ==========
CREATE TABLE IF NOT EXISTS activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id       INTEGER NOT NULL REFERENCES shops(id),
  title         TEXT    NOT NULL,
  type          TEXT    NOT NULL,                   -- 满减 / 折扣 / 满赠 / 秒杀
  image         TEXT,
  content       TEXT,
  rule_desc     TEXT,
  rule_json     TEXT,                               -- {"threshold":10000,"discount":1000} / {"rate":0.9}
  start_at      TEXT    NOT NULL,
  end_at        TEXT    NOT NULL,
  status        INTEGER NOT NULL DEFAULT 1,         -- 0 待审核 / 1 已通过 / 2 已驳回 / 3 已结束 / 4 强制下线
  audit_reason  TEXT,
  views         INTEGER NOT NULL DEFAULT 0,
  join_count    INTEGER NOT NULL DEFAULT 0,
  order_count   INTEGER NOT NULL DEFAULT 0,
  deal_amount   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_shop ON activities(shop_id);

CREATE TABLE IF NOT EXISTS activity_products (
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  PRIMARY KEY (activity_id, product_id)
);

CREATE TABLE IF NOT EXISTS coupons (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id        INTEGER NOT NULL DEFAULT 0,        -- 0 = 平台券
  name           TEXT    NOT NULL,
  type           INTEGER NOT NULL,                  -- 1 满减 / 2 折扣
  threshold      INTEGER NOT NULL DEFAULT 0,        -- 使用门槛（分）
  amount         INTEGER NOT NULL DEFAULT 0,        -- 满减面额（分）
  discount_rate  REAL,                              -- 折扣率，如 0.9
  scope_type     INTEGER NOT NULL DEFAULT 1,        -- 1 全场 / 2 指定类目 / 3 指定商品 / 4 指定店铺
  scope_ids      TEXT,                              -- JSON 数组
  start_at       TEXT    NOT NULL,
  end_at         TEXT    NOT NULL,
  valid_days     INTEGER,                           -- 领取后 N 天有效（可空）
  stock          INTEGER NOT NULL DEFAULT 0,
  received       INTEGER NOT NULL DEFAULT 0,
  limit_per_user INTEGER NOT NULL DEFAULT 1,
  claim_type     TEXT    NOT NULL DEFAULT '主动领取',
  status         INTEGER NOT NULL DEFAULT 1,        -- 1 上架 / 0 下架
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS user_coupons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  coupon_id   INTEGER NOT NULL REFERENCES coupons(id),
  status      INTEGER NOT NULL DEFAULT 0,           -- 0 未使用 / 1 已使用 / 2 已过期
  order_id    INTEGER,
  expire_at   TEXT    NOT NULL,
  received_at TEXT    NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_coupons_user ON user_coupons(user_id, status);

CREATE TABLE IF NOT EXISTS group_buys (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id        INTEGER NOT NULL REFERENCES shops(id),
  product_id     INTEGER NOT NULL REFERENCES products(id),
  sku_id         INTEGER NOT NULL REFERENCES skus(id),
  title          TEXT    NOT NULL,
  group_price    INTEGER NOT NULL,                  -- 分
  required_count INTEGER NOT NULL,
  joined_count   INTEGER NOT NULL DEFAULT 0,
  start_at       TEXT    NOT NULL,
  end_at         TEXT    NOT NULL,
  valid_days     INTEGER NOT NULL DEFAULT 3,
  status         INTEGER NOT NULL DEFAULT 0,        -- 0 待审核 / 1 进行中 / 2 已成团 / 3 未成团 / 4 已驳回 / 5 已下线
  audit_reason   TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS group_teams (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  group_buy_id   INTEGER NOT NULL REFERENCES group_buys(id),
  leader_user_id INTEGER NOT NULL,
  required_count INTEGER NOT NULL,
  joined_count   INTEGER NOT NULL DEFAULT 0,
  expire_at      TEXT    NOT NULL,
  status         INTEGER NOT NULL DEFAULT 1,        -- 1 进行中 / 2 已成团 / 3 未成团
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL REFERENCES group_teams(id),
  user_id    INTEGER NOT NULL,
  order_id   INTEGER,
  status     INTEGER NOT NULL DEFAULT 1,            -- 1 待支付 / 2 已支付 / 3 已退款
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_members_team ON group_members(team_id);

-- ========== 订单 / 支付 / 物流 ==========
CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no         TEXT    NOT NULL UNIQUE,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  shop_id          INTEGER NOT NULL REFERENCES shops(id),
  user_coupon_id   INTEGER,                          -- 平台券
  shop_coupon_id   INTEGER,                          -- 店铺券
  goods_amount     INTEGER NOT NULL DEFAULT 0,
  freight_amount   INTEGER NOT NULL DEFAULT 0,
  coupon_amount    INTEGER NOT NULL DEFAULT 0,
  activity_amount  INTEGER NOT NULL DEFAULT 0,       -- 活动优惠（记录，已计入 coupon_amount 口径之外仅展示）
  pay_amount       INTEGER NOT NULL DEFAULT 0,
  pay_channel      TEXT,
  status           INTEGER NOT NULL DEFAULT 0,       -- 0 待付款 / 1 已付款 / 2 已发货 / 3 已完成 / 4 已取消 / 5 已退款 / 6 待成团
  remark           TEXT,
  receiver_snapshot TEXT NOT NULL,                   -- JSON
  group_buy_id     INTEGER,
  group_team_id    INTEGER,
  idempotency_key  TEXT,
  expire_at        TEXT    NOT NULL,
  paid_at          TEXT,
  shipped_at       TEXT,
  finished_at      TEXT,
  closed_at        TEXT,
  cancel_reason    TEXT,
  seller_remark    TEXT,
  settled          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, expire_at);

CREATE TABLE IF NOT EXISTS order_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES orders(id),
  product_id     INTEGER NOT NULL,
  sku_id         INTEGER NOT NULL,
  product_name   TEXT    NOT NULL,
  spec_name      TEXT,
  image          TEXT,
  price          INTEGER NOT NULL,
  quantity       INTEGER NOT NULL,
  subtotal       INTEGER NOT NULL,
  refunded_qty   INTEGER NOT NULL DEFAULT 0,
  aftersale_id   INTEGER,
  created_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES orders(id),
  pay_no         TEXT    NOT NULL UNIQUE,
  channel        TEXT    NOT NULL,                  -- alipay / wechat
  amount         INTEGER NOT NULL,
  status         INTEGER NOT NULL DEFAULT 0,        -- 0 待支付 / 1 成功 / 2 失败 / 3 已退款
  channel_no     TEXT,
  paid_at        TEXT,
  notify_payload TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS logistics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  company       TEXT    NOT NULL,
  tracking_no   TEXT    NOT NULL,
  shipped_at    TEXT    NOT NULL,
  operator_id   INTEGER,
  operator_type TEXT,
  updated_at    TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logistics_order ON logistics(order_id);
CREATE INDEX IF NOT EXISTS idx_logistics_tracking ON logistics(tracking_no);

-- ========== 售后 / 退款 / 评价 ==========
CREATE TABLE IF NOT EXISTS aftersales (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  aftersale_no     TEXT    NOT NULL UNIQUE,
  order_id         INTEGER NOT NULL REFERENCES orders(id),
  order_item_id    INTEGER NOT NULL,
  user_id          INTEGER NOT NULL,
  shop_id          INTEGER NOT NULL,
  type             INTEGER NOT NULL,                -- 1 仅退款 / 2 退货退款
  refund_amount    INTEGER NOT NULL,
  reason           TEXT    NOT NULL,
  evidence         TEXT,
  status           INTEGER NOT NULL DEFAULT 1,      -- 1 待处理 / 2 已同意 / 3 待买家寄回 / 4 已收货待退款 / 5 已完成 / 6 已驳回 / 7 客服介入
  reject_reason    TEXT,
  return_logistics TEXT,
  respond_deadline TEXT    NOT NULL,
  handled_by       INTEGER,
  handled_at       TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aftersales_shop ON aftersales(shop_id, created_at);

CREATE TABLE IF NOT EXISTS refund_orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_no      TEXT    NOT NULL UNIQUE,
  aftersale_id   INTEGER,
  order_id       INTEGER NOT NULL,
  shop_id        INTEGER NOT NULL,
  channel        TEXT    NOT NULL,
  amount         INTEGER NOT NULL,
  status         INTEGER NOT NULL DEFAULT 0,        -- 0 待审核 / 1 退款中 / 2 已退款 / 3 已驳回
  auditor_id     INTEGER,
  audited_at     TEXT,
  refunded_at    TEXT,
  reject_reason  TEXT,
  retry_count    INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  UNIQUE (aftersale_id)
);
CREATE INDEX IF NOT EXISTS idx_refund_orders_order ON refund_orders(order_id);

CREATE TABLE IF NOT EXISTS shop_reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id       INTEGER NOT NULL,
  product_id    INTEGER NOT NULL,
  order_id      INTEGER NOT NULL,
  order_item_id INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  score         INTEGER NOT NULL,
  content       TEXT,
  images        TEXT,
  reply         TEXT,
  replied_at    TEXT,
  reply_deleted INTEGER NOT NULL DEFAULT 0,
  hidden        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  UNIQUE (order_item_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON shop_reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_shop ON shop_reviews(shop_id);

CREATE TABLE IF NOT EXISTS review_appeals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id     INTEGER NOT NULL REFERENCES shop_reviews(id),
  shop_id       INTEGER NOT NULL,
  reason        TEXT    NOT NULL,
  evidence      TEXT,
  status        INTEGER NOT NULL DEFAULT 0,         -- 0 待审核 / 1 通过 / 2 驳回
  auditor_id    INTEGER,
  audited_at    TEXT,
  reject_reason TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_appeals_review ON review_appeals(review_id, status);

-- ========== 后台：入驻 / 账号 / 权限 ==========
CREATE TABLE IF NOT EXISTS shop_applies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  subject_type   TEXT    NOT NULL,                  -- 个人 / 企业
  subject_name   TEXT    NOT NULL,
  contact        TEXT    NOT NULL,
  phone          TEXT    NOT NULL,
  license_urls   TEXT,                              -- JSON 数组
  category_ids   TEXT,                              -- JSON 数组
  shop_name      TEXT    NOT NULL,
  status         INTEGER NOT NULL DEFAULT 0,        -- 0 待审核 / 1 通过 / 2 驳回
  reject_reason  TEXT,
  audited_by     INTEGER,
  audited_at     TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_applies_user ON shop_applies(user_id);
CREATE INDEX IF NOT EXISTS idx_shop_applies_phone ON shop_applies(phone);

CREATE TABLE IF NOT EXISTS admin_users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account         TEXT    NOT NULL UNIQUE,
  password_hash   TEXT    NOT NULL,
  name            TEXT,
  type            TEXT    NOT NULL,                 -- seller / admin
  shop_id         INTEGER,                          -- 商家端数据权限隔离字段
  role_id         INTEGER,
  status          INTEGER NOT NULL DEFAULT 1,
  must_change_pwd INTEGER NOT NULL DEFAULT 0,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  last_login_at   TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  code       TEXT    NOT NULL UNIQUE,
  builtin    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  code      TEXT    NOT NULL UNIQUE,
  name      TEXT    NOT NULL,
  type      TEXT    NOT NULL,                       -- menu / action
  parent_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  permission_id INTEGER NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT    NOT NULL UNIQUE,
  subject_type TEXT    NOT NULL,                    -- user / seller / admin
  subject_id   INTEGER NOT NULL,
  issued_at    TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  last_active_at TEXT  NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_subject ON auth_tokens(subject_type, subject_id);

-- ========== 运营内容 / 配置 ==========
CREATE TABLE IF NOT EXISTS banners (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT,
  position   TEXT    NOT NULL DEFAULT 'home',
  image      TEXT    NOT NULL,
  link       TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  start_at   TEXT,
  end_at     TEXT,
  status     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS recommend_slots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_type   TEXT    NOT NULL,                      -- shop / product / activity
  target_id  INTEGER NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  start_at   TEXT,
  end_at     TEXT,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS featured_products (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL UNIQUE REFERENCES products(id),
  sort       INTEGER NOT NULL DEFAULT 0,
  start_at   TEXT,
  end_at     TEXT,
  status     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_recommends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id    INTEGER NOT NULL UNIQUE REFERENCES shops(id),
  sort       INTEGER NOT NULL DEFAULT 0,
  start_at   TEXT,
  end_at     TEXT,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS search_words (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  word       TEXT    NOT NULL,
  type       TEXT    NOT NULL DEFAULT 'hot',        -- hot / block
  sort       INTEGER NOT NULL DEFAULT 0,
  start_at   TEXT,
  end_at     TEXT,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS footer_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  status     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS dict_items (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  type    TEXT    NOT NULL,                         -- logistics_company / unit / brand / pay_channel ...
  code    TEXT    NOT NULL,
  name    TEXT    NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0,
  status  INTEGER NOT NULL DEFAULT 1,
  UNIQUE (type, code)
);

CREATE TABLE IF NOT EXISTS system_configs (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL,
  updated_by  INTEGER
);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT    NOT NULL,                     -- user / seller
  target_id   INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  content     TEXT,
  is_read     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_logs (         -- 只增不改
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id    INTEGER,
  admin_name  TEXT,
  role_code   TEXT,
  module      TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operation_logs_admin ON operation_logs(admin_id, created_at);
CREATE INDEX IF NOT EXISTS idx_operation_logs_module ON operation_logs(module, created_at);

-- ========== 结算 / 提现（FR-SLR-090~095、FR-FIN-011~014、Q-016） ==========
CREATE TABLE IF NOT EXISTS settlements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id        INTEGER NOT NULL REFERENCES shops(id),
  period         TEXT    NOT NULL,                   -- YYYY-MM
  deal_amount    INTEGER NOT NULL DEFAULT 0,         -- 成交额（实付，含运费、已扣优惠）
  commission     INTEGER NOT NULL DEFAULT 0,         -- 平台佣金 5%
  service_fee    INTEGER NOT NULL DEFAULT 0,         -- 服务费（本期 0）
  payable_amount INTEGER NOT NULL DEFAULT 0,         -- 应结金额
  status         INTEGER NOT NULL DEFAULT 1,         -- 1 待确认 / 2 已结算 / 3 已打款
  created_at     TEXT    NOT NULL,
  UNIQUE (shop_id, period)
);
CREATE INDEX IF NOT EXISTS idx_settlements_shop ON settlements(shop_id, period);

CREATE TABLE IF NOT EXISTS settlement_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_id  INTEGER NOT NULL REFERENCES settlements(id),
  order_id       INTEGER NOT NULL REFERENCES orders(id),
  deal_amount    INTEGER NOT NULL DEFAULT 0,
  commission     INTEGER NOT NULL DEFAULT 0,
  refund_amount  INTEGER NOT NULL DEFAULT 0,
  payable_amount INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_settlement_items_sid ON settlement_items(settlement_id);

CREATE TABLE IF NOT EXISTS withdrawals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id       INTEGER NOT NULL REFERENCES shops(id),
  settlement_id INTEGER,
  amount        INTEGER NOT NULL,
  account_info  TEXT,                                -- 关联 shop_accounts.id
  status        INTEGER NOT NULL DEFAULT 0,          -- 0 待审核 / 1 已打款 / 2 已驳回
  reject_reason TEXT,
  auditor_id    INTEGER,
  audited_at    TEXT,
  paid_at       TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_shop ON withdrawals(shop_id, created_at);

CREATE TABLE IF NOT EXISTS reconciliations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_date     TEXT    NOT NULL,
  channel      TEXT    NOT NULL,
  total_amount INTEGER NOT NULL DEFAULT 0,
  paid_amount  INTEGER NOT NULL DEFAULT 0,
  refund_amount INTEGER NOT NULL DEFAULT 0,
  diff_amount  INTEGER NOT NULL DEFAULT 0,
  diff_detail  TEXT,
  status       INTEGER NOT NULL DEFAULT 0,          -- 0 待核对 / 1 已锁定
  locked_by    INTEGER,
  locked_at    TEXT,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reconciliations_date ON reconciliations(biz_date, channel);

CREATE TABLE IF NOT EXISTS seller_apply_bindings (
  admin_id   INTEGER PRIMARY KEY,                     -- 商家后台账号
  apply_id   INTEGER NOT NULL,                        -- 入驻申请
  user_id    INTEGER NOT NULL,                        -- 绑定会员（申请电话对应的会员账号）
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_accounts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id             INTEGER NOT NULL REFERENCES shops(id),
  account_type        TEXT    NOT NULL,             -- 对公银行账户 / 个人银行账户 / 支付宝 / 微信
  account_name        TEXT    NOT NULL,             -- 收款户名（须与店铺主体一致）
  bank_name           TEXT,
  account_no          TEXT    NOT NULL,             -- 加密存储（core/crypto.js）
  id_card_tail        TEXT,                         -- 个人账户：身份证后 4 位
  verified            INTEGER NOT NULL DEFAULT 0,   -- 小额打款验证是否通过
  verify_amount       INTEGER,                      -- 随机打款金额（分）
  verify_fail_count   INTEGER NOT NULL DEFAULT 0,
  verify_locked_until TEXT,
  effective_at        TEXT,                         -- 变更 T+1 生效
  status              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_accounts_shop ON shop_accounts(shop_id);

-- ========== 工单 ==========
CREATE TABLE IF NOT EXISTS work_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  work_no     TEXT    NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL,
  order_id    INTEGER,
  source      TEXT    NOT NULL DEFAULT '在线咨询',
  type        TEXT    NOT NULL DEFAULT '咨询',
  content     TEXT    NOT NULL,
  status      INTEGER NOT NULL DEFAULT 1,           -- 1 待受理 / 2 处理中 / 3 已解决 / 4 已关闭
  assignee_id INTEGER,
  replies     TEXT,                                 -- JSON 数组
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  closed_at   TEXT
);
