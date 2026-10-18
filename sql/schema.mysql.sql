-- 宠物之家商城 · MySQL 8 版数据库结构（交付 / 迁移用）
-- 说明：
--   1. 运行时以 server/src/db/schema.sqlite.sql 为准（金额以“分”INTEGER 存储，服务层整数运算）；
--      本文件为等价 MySQL 设计稿，金额改为 DECIMAL(12,2) 元、时间改为 DATETIME。
--   2. 表名沿用 ER 图语义，其中 order / user 为 SQL 保留字，物理表名落为 orders / users。
--   3. 字符集统一 utf8mb4；引擎 InnoDB；主键 bigint；金额 decimal；日志类表只增不改。

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(128) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `phone` VARCHAR(20) UNIQUE,
  `email` VARCHAR(255) UNIQUE,
  `nickname` VARCHAR(128),
  `avatar` VARCHAR(255),
  `status` INT NOT NULL DEFAULT 1,
  `fail_count` INT NOT NULL DEFAULT 0,
  `locked_until` DATETIME,
  `last_login_at` DATETIME,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `addresses`;
CREATE TABLE `addresses` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` BIGINT NOT NULL,
  `receiver` VARCHAR(255) NOT NULL,
  `phone` VARCHAR(20) NOT NULL,
  `province` VARCHAR(255) NOT NULL,
  `city` VARCHAR(255) NOT NULL,
  `district` VARCHAR(255) NOT NULL,
  `detail` TEXT NOT NULL,
  `is_default` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `favorites`;
CREATE TABLE `favorites` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` BIGINT NOT NULL,
  `shop_id` BIGINT NOT NULL,
  `created_at` DATETIME NOT NULL,
  UNIQUE (user_id, shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `carts`;
CREATE TABLE `carts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` BIGINT NOT NULL UNIQUE,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `cart_items`;
CREATE TABLE `cart_items` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `cart_id` BIGINT NOT NULL,
  `product_id` BIGINT NOT NULL,
  `sku_id` BIGINT NOT NULL,
  `quantity` INT NOT NULL DEFAULT 1,
  `checked` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  UNIQUE (cart_id, sku_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `categories`;
CREATE TABLE `categories` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(128) NOT NULL,
  `parent_id` BIGINT NOT NULL DEFAULT 0,
  `level` INT NOT NULL DEFAULT 1,
  `icon` VARCHAR(255),
  `sort` INT NOT NULL DEFAULT 0,
  `status` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  UNIQUE (parent_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `shops`;
CREATE TABLE `shops` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `owner_id` BIGINT NOT NULL,
  `name` VARCHAR(128) NOT NULL UNIQUE,
  `logo` VARCHAR(255),
  `banner` VARCHAR(255),
  `description` TEXT,
  `notice` TEXT,
  `phone` VARCHAR(20),
  `category_ids` JSON,
  `score` INT NOT NULL DEFAULT 50,
  `status` INT NOT NULL DEFAULT 1,
  `disable_reason` TEXT,
  `name_pending` VARCHAR(255),
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `stores`;
CREATE TABLE `stores` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `shop_id` BIGINT NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `phone` VARCHAR(20),
  `address` VARCHAR(255) NOT NULL,
  `lng` DECIMAL(10,6),
  `lat` DECIMAL(10,6),
  `business_hours` VARCHAR(64) NOT NULL DEFAULT '09:00-21:00',
  `image` VARCHAR(255),
  `status` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `store_services`;
CREATE TABLE `store_services` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `shop_id` BIGINT NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `image` VARCHAR(255),
  `origin_price` DECIMAL(12,2) NOT NULL,
  `store_price` DECIMAL(12,2) NOT NULL,
  `valid_start` VARCHAR(255) NOT NULL,
  `valid_end` VARCHAR(255) NOT NULL,
  `description` TEXT,
  `booking_slots` JSON,
  `slot_capacity` INT NOT NULL DEFAULT 10,
  `status` INT NOT NULL DEFAULT 0,
  `audit_reason` TEXT,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `store_service_stores`;
CREATE TABLE `store_service_stores` (
  `store_service_id` BIGINT NOT NULL,
  `store_id` BIGINT NOT NULL,
  PRIMARY KEY (store_service_id, store_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `store_bookings`;
CREATE TABLE `store_bookings` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `booking_no` VARCHAR(64) NOT NULL UNIQUE,
  `store_service_id` BIGINT NOT NULL,
  `store_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `booking_date` VARCHAR(255) NOT NULL,
  `slot` VARCHAR(255) NOT NULL,
  `booking_time` VARCHAR(255) NOT NULL,
  `contact` VARCHAR(255) NOT NULL,
  `phone` VARCHAR(20) NOT NULL,
  `remark` TEXT,
  `verify_code` VARCHAR(64) NOT NULL UNIQUE,
  `status` INT NOT NULL DEFAULT 1,
  `pay_method` VARCHAR(255),
  `paid_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `verified_by` INT,
  `verified_at` DATETIME,
  `canceled_at` DATETIME,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `store_verifications`;
CREATE TABLE `store_verifications` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `booking_id` BIGINT NOT NULL,
  `verify_code` VARCHAR(64) NOT NULL,
  `store_id` BIGINT NOT NULL,
  `shop_id` BIGINT NOT NULL,
  `verified_by` INT NOT NULL,
  `paid_amount` DECIMAL(12,2) NOT NULL,
  `pay_method` VARCHAR(255) NOT NULL DEFAULT '到店付款',
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `products`;
CREATE TABLE `products` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `shop_id` BIGINT NOT NULL,
  `category_id` BIGINT NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `main_image` VARCHAR(255),
  `images` JSON,
  `detail_html` JSON,
  `brand` VARCHAR(255),
  `unit` VARCHAR(255),
  `product_code` VARCHAR(255),
  `price` DECIMAL(12,2) NOT NULL,
  `origin_price` DECIMAL(12,2),
  `sales` INT NOT NULL DEFAULT 0,
  `total_stock` INT NOT NULL DEFAULT 0,
  `locked_stock` INT NOT NULL DEFAULT 0,
  `warn_stock` INT NOT NULL DEFAULT 0,
  `status` INT NOT NULL DEFAULT 0,
  `audit_reason` TEXT,
  `is_deleted` INT NOT NULL DEFAULT 0,
  `sales_volume` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  UNIQUE (shop_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `skus`;
CREATE TABLE `skus` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `product_id` BIGINT NOT NULL,
  `spec_name` VARCHAR(255) NOT NULL,
  `spec_json` JSON,
  `price` DECIMAL(12,2) NOT NULL,
  `origin_price` DECIMAL(12,2),
  `stock` INT NOT NULL DEFAULT 0,
  `locked_stock` INT NOT NULL DEFAULT 0,
  `warn_stock` INT NOT NULL DEFAULT 0,
  `barcode` VARCHAR(255),
  `image` VARCHAR(255),
  `status` INT NOT NULL DEFAULT 1,
  `version` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `stock_logs`;
CREATE TABLE `stock_logs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `sku_id` BIGINT NOT NULL,
  `product_id` BIGINT NOT NULL,
  `shop_id` BIGINT NOT NULL,
  `source` VARCHAR(255) NOT NULL,
  `change_qty` INT NOT NULL,
  `before_qty` INT NOT NULL,
  `after_qty` INT NOT NULL,
  `locked_before` INT NOT NULL DEFAULT 0,
  `locked_after` INT NOT NULL DEFAULT 0,
  `ref_no` VARCHAR(64),
  `operator_id` BIGINT,
  `operator_name` VARCHAR(255),
  `remark` TEXT,
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `stock_orders`;
CREATE TABLE `stock_orders` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `stock_order_no` VARCHAR(64) NOT NULL UNIQUE,
  `type` INT NOT NULL,
  `shop_id` BIGINT NOT NULL,
  `source_type` VARCHAR(255) NOT NULL,
  `status` INT NOT NULL DEFAULT 0,
  `operator_id` BIGINT,
  `remark` TEXT,
  `created_at` DATETIME NOT NULL,
  `submitted_at` DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `stock_order_items`;
CREATE TABLE `stock_order_items` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `stock_order_id` BIGINT NOT NULL,
  `sku_id` BIGINT NOT NULL,
  `quantity` INT NOT NULL,
  `before_qty` INT,
  `after_qty` INT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `stock_takes`;
CREATE TABLE `stock_takes` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `take_no` VARCHAR(64) NOT NULL UNIQUE,
  `shop_id` BIGINT NOT NULL,
  `scope` VARCHAR(255) NOT NULL,
  `status` INT NOT NULL DEFAULT 0,
  `operator_id` BIGINT,
  `created_at` DATETIME NOT NULL,
  `confirmed_at` DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `stock_take_items`;
CREATE TABLE `stock_take_items` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `stock_take_id` BIGINT NOT NULL,
  `sku_id` BIGINT NOT NULL,
  `book_qty` INT NOT NULL,
  `actual_qty` INT NOT NULL,
  `diff_qty` INT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `activities`;
CREATE TABLE `activities` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `shop_id` BIGINT NOT NULL,
  `title` VARCHAR(128) NOT NULL,
  `type` VARCHAR(255) NOT NULL,
  `image` VARCHAR(255),
  `content` JSON,
  `rule_desc` VARCHAR(255),
  `rule_json` JSON,
  `start_at` DATETIME NOT NULL,
  `end_at` DATETIME NOT NULL,
  `status` INT NOT NULL DEFAULT 1,
  `audit_reason` TEXT,
  `views` INT NOT NULL DEFAULT 0,
  `join_count` INT NOT NULL DEFAULT 0,
  `order_count` INT NOT NULL DEFAULT 0,
  `deal_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `activity_products`;
CREATE TABLE `activity_products` (
  `activity_id` BIGINT NOT NULL,
  `product_id` BIGINT NOT NULL,
  PRIMARY KEY (activity_id, product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `coupons`;
CREATE TABLE `coupons` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `shop_id` BIGINT NOT NULL DEFAULT 0,
  `name` VARCHAR(128) NOT NULL,
  `type` INT NOT NULL,
  `threshold` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `discount_rate` DECIMAL(10,6),
  `scope_type` INT NOT NULL DEFAULT 1,
  `scope_ids` JSON,
  `start_at` DATETIME NOT NULL,
  `end_at` DATETIME NOT NULL,
  `valid_days` INT,
  `stock` INT NOT NULL DEFAULT 0,
  `received` INT NOT NULL DEFAULT 0,
  `limit_per_user` INT NOT NULL DEFAULT 1,
  `claim_type` VARCHAR(255) NOT NULL DEFAULT '主动领取',
  `status` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `user_coupons`;
CREATE TABLE `user_coupons` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` BIGINT NOT NULL,
  `coupon_id` BIGINT NOT NULL,
  `status` INT NOT NULL DEFAULT 0,
  `order_id` BIGINT,
  `expire_at` DATETIME NOT NULL,
  `received_at` DATETIME NOT NULL,
  `used_at` DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `group_buys`;
CREATE TABLE `group_buys` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `shop_id` BIGINT NOT NULL,
  `product_id` BIGINT NOT NULL,
  `sku_id` BIGINT NOT NULL,
  `title` VARCHAR(128) NOT NULL,
  `group_price` DECIMAL(12,2) NOT NULL,
  `required_count` INT NOT NULL,
  `joined_count` INT NOT NULL DEFAULT 0,
  `start_at` DATETIME NOT NULL,
  `end_at` DATETIME NOT NULL,
  `valid_days` INT NOT NULL DEFAULT 3,
  `status` INT NOT NULL DEFAULT 0,
  `audit_reason` TEXT,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `group_teams`;
CREATE TABLE `group_teams` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `group_buy_id` BIGINT NOT NULL,
  `leader_user_id` BIGINT NOT NULL,
  `required_count` INT NOT NULL,
  `joined_count` INT NOT NULL DEFAULT 0,
  `expire_at` DATETIME NOT NULL,
  `status` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `group_members`;
CREATE TABLE `group_members` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `team_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `order_id` BIGINT,
  `status` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `orders`;
CREATE TABLE `orders` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_no` VARCHAR(64) NOT NULL UNIQUE,
  `user_id` BIGINT NOT NULL,
  `shop_id` BIGINT NOT NULL,
  `user_coupon_id` BIGINT,
  `shop_coupon_id` BIGINT,
  `goods_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `freight_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `coupon_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `activity_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `pay_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `pay_channel` VARCHAR(255),
  `status` INT NOT NULL DEFAULT 0,
  `remark` TEXT,
  `receiver_snapshot` JSON NOT NULL,
  `group_buy_id` BIGINT,
  `group_team_id` BIGINT,
  `idempotency_key` VARCHAR(255),
  `expire_at` DATETIME NOT NULL,
  `paid_at` DATETIME,
  `shipped_at` DATETIME,
  `finished_at` DATETIME,
  `closed_at` DATETIME,
  `cancel_reason` TEXT,
  `seller_remark` TEXT,
  `settled` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  UNIQUE (user_id, idempotency_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `order_items`;
CREATE TABLE `order_items` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_id` BIGINT NOT NULL,
  `product_id` BIGINT NOT NULL,
  `sku_id` BIGINT NOT NULL,
  `product_name` VARCHAR(255) NOT NULL,
  `spec_name` VARCHAR(255),
  `image` VARCHAR(255),
  `price` DECIMAL(12,2) NOT NULL,
  `quantity` INT NOT NULL,
  `subtotal` INT NOT NULL,
  `refunded_qty` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `aftersale_id` BIGINT,
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `payments`;
CREATE TABLE `payments` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_id` BIGINT NOT NULL,
  `pay_no` VARCHAR(64) NOT NULL UNIQUE,
  `channel` VARCHAR(255) NOT NULL,
  `amount` DECIMAL(12,2) NOT NULL,
  `status` INT NOT NULL DEFAULT 0,
  `channel_no` VARCHAR(64),
  `paid_at` DATETIME,
  `notify_payload` JSON,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `logistics`;
CREATE TABLE `logistics` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_id` BIGINT NOT NULL,
  `company` VARCHAR(255) NOT NULL,
  `tracking_no` VARCHAR(64) NOT NULL,
  `shipped_at` DATETIME NOT NULL,
  `operator_id` BIGINT,
  `operator_type` VARCHAR(255),
  `updated_at` DATETIME,
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `aftersales`;
CREATE TABLE `aftersales` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `aftersale_no` VARCHAR(64) NOT NULL UNIQUE,
  `order_id` BIGINT NOT NULL,
  `order_item_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `shop_id` BIGINT NOT NULL,
  `type` INT NOT NULL,
  `refund_amount` DECIMAL(12,2) NOT NULL,
  `reason` TEXT NOT NULL,
  `evidence` JSON,
  `status` INT NOT NULL DEFAULT 1,
  `reject_reason` TEXT,
  `return_logistics` JSON,
  `respond_deadline` DATETIME NOT NULL,
  `handled_by` INT,
  `handled_at` DATETIME,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `refund_orders`;
CREATE TABLE `refund_orders` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `refund_no` VARCHAR(64) NOT NULL UNIQUE,
  `aftersale_id` BIGINT,
  `order_id` BIGINT NOT NULL,
  `shop_id` BIGINT NOT NULL,
  `channel` VARCHAR(255) NOT NULL,
  `amount` DECIMAL(12,2) NOT NULL,
  `status` INT NOT NULL DEFAULT 0,
  `auditor_id` BIGINT,
  `audited_at` DATETIME,
  `refunded_at` DATETIME,
  `reject_reason` TEXT,
  `retry_count` INT NOT NULL DEFAULT 0,
  `idempotency_key` VARCHAR(255),
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  UNIQUE (aftersale_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `shop_reviews`;
CREATE TABLE `shop_reviews` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `shop_id` BIGINT NOT NULL,
  `product_id` BIGINT NOT NULL,
  `order_id` BIGINT NOT NULL,
  `order_item_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `score` INT NOT NULL,
  `content` JSON,
  `images` JSON,
  `reply` VARCHAR(255),
  `replied_at` DATETIME,
  `reply_deleted` INT NOT NULL DEFAULT 0,
  `hidden` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  UNIQUE (order_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `review_appeals`;
CREATE TABLE `review_appeals` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `review_id` BIGINT NOT NULL,
  `shop_id` BIGINT NOT NULL,
  `reason` TEXT NOT NULL,
  `evidence` JSON,
  `status` INT NOT NULL DEFAULT 0,
  `auditor_id` BIGINT,
  `audited_at` DATETIME,
  `reject_reason` TEXT,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `shop_applies`;
CREATE TABLE `shop_applies` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` BIGINT NOT NULL,
  `subject_type` VARCHAR(255) NOT NULL,
  `subject_name` VARCHAR(255) NOT NULL,
  `contact` VARCHAR(255) NOT NULL,
  `phone` VARCHAR(20) NOT NULL,
  `license_urls` JSON,
  `category_ids` JSON,
  `shop_name` VARCHAR(255) NOT NULL,
  `status` INT NOT NULL DEFAULT 0,
  `reject_reason` TEXT,
  `audited_by` INT,
  `audited_at` DATETIME,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `admin_users`;
CREATE TABLE `admin_users` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `account` VARCHAR(128) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `name` VARCHAR(128),
  `type` VARCHAR(255) NOT NULL,
  `shop_id` BIGINT,
  `role_id` BIGINT,
  `status` INT NOT NULL DEFAULT 1,
  `must_change_pwd` INT NOT NULL DEFAULT 0,
  `fail_count` INT NOT NULL DEFAULT 0,
  `locked_until` DATETIME,
  `last_login_at` DATETIME,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `roles`;
CREATE TABLE `roles` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(128) NOT NULL,
  `code` VARCHAR(255) NOT NULL UNIQUE,
  `builtin` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `permissions`;
CREATE TABLE `permissions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(255) NOT NULL UNIQUE,
  `name` VARCHAR(128) NOT NULL,
  `type` VARCHAR(255) NOT NULL,
  `parent_id` BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `role_permissions`;
CREATE TABLE `role_permissions` (
  `role_id` BIGINT NOT NULL,
  `permission_id` BIGINT NOT NULL,
  PRIMARY KEY (role_id, permission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `auth_tokens`;
CREATE TABLE `auth_tokens` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `token_hash` VARCHAR(255) NOT NULL UNIQUE,
  `subject_type` VARCHAR(255) NOT NULL,
  `subject_id` BIGINT NOT NULL,
  `issued_at` DATETIME NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `last_active_at` DATETIME NOT NULL,
  `revoked` INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `banners`;
CREATE TABLE `banners` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `title` VARCHAR(128),
  `position` VARCHAR(255) NOT NULL DEFAULT 'home',
  `image` VARCHAR(255) NOT NULL,
  `link` VARCHAR(255),
  `sort` INT NOT NULL DEFAULT 0,
  `start_at` DATETIME,
  `end_at` DATETIME,
  `status` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `recommend_slots`;
CREATE TABLE `recommend_slots` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `tab_type` VARCHAR(255) NOT NULL,
  `target_id` BIGINT NOT NULL,
  `sort` INT NOT NULL DEFAULT 0,
  `start_at` DATETIME,
  `end_at` DATETIME,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `featured_products`;
CREATE TABLE `featured_products` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `product_id` BIGINT NOT NULL UNIQUE,
  `sort` INT NOT NULL DEFAULT 0,
  `start_at` DATETIME,
  `end_at` DATETIME,
  `status` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `shop_recommends`;
CREATE TABLE `shop_recommends` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `shop_id` BIGINT NOT NULL UNIQUE,
  `sort` INT NOT NULL DEFAULT 0,
  `start_at` DATETIME,
  `end_at` DATETIME,
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `search_words`;
CREATE TABLE `search_words` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `word` VARCHAR(255) NOT NULL,
  `type` VARCHAR(255) NOT NULL DEFAULT 'hot',
  `sort` INT NOT NULL DEFAULT 0,
  `start_at` DATETIME,
  `end_at` DATETIME,
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `footer_links`;
CREATE TABLE `footer_links` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `group_name` VARCHAR(255) NOT NULL,
  `title` VARCHAR(128) NOT NULL,
  `url` VARCHAR(255) NOT NULL,
  `sort` INT NOT NULL DEFAULT 0,
  `status` INT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `dict_items`;
CREATE TABLE `dict_items` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `type` VARCHAR(255) NOT NULL,
  `code` VARCHAR(255) NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `sort` INT NOT NULL DEFAULT 0,
  `status` INT NOT NULL DEFAULT 1,
  UNIQUE (type, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `system_configs`;
CREATE TABLE `system_configs` (
  `key` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `value` VARCHAR(255) NOT NULL,
  `description` TEXT,
  `updated_at` DATETIME NOT NULL,
  `updated_by` INT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `notifications`;
CREATE TABLE `notifications` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `target_type` VARCHAR(255) NOT NULL,
  `target_id` BIGINT NOT NULL,
  `title` VARCHAR(128) NOT NULL,
  `content` JSON,
  `is_read` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `operation_logs`;
CREATE TABLE `operation_logs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `admin_id` BIGINT,
  `admin_name` VARCHAR(255),
  `role_code` VARCHAR(255),
  `module` VARCHAR(255) NOT NULL,
  `action` VARCHAR(255) NOT NULL,
  `target_type` VARCHAR(255),
  `target_id` VARCHAR(255),
  `detail` TEXT,
  `ip` VARCHAR(255),
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `settlements`;
CREATE TABLE `settlements` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `shop_id` BIGINT NOT NULL,
  `period` VARCHAR(20) NOT NULL,
  `deal_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `commission` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `service_fee` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `payable_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `status` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  UNIQUE (shop_id, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `settlement_items`;
CREATE TABLE `settlement_items` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `settlement_id` BIGINT NOT NULL,
  `order_id` BIGINT NOT NULL,
  `deal_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `commission` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `refund_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `payable_amount` DECIMAL(12,2) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `withdrawals`;
CREATE TABLE `withdrawals` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `shop_id` BIGINT NOT NULL,
  `settlement_id` BIGINT,
  `amount` DECIMAL(12,2) NOT NULL,
  `account_info` JSON,
  `status` INT NOT NULL DEFAULT 0,
  `reject_reason` TEXT,
  `auditor_id` BIGINT,
  `audited_at` DATETIME,
  `paid_at` DATETIME,
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `reconciliations`;
CREATE TABLE `reconciliations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `biz_date` VARCHAR(255) NOT NULL,
  `channel` VARCHAR(255) NOT NULL,
  `total_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `paid_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `refund_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `diff_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `diff_detail` TEXT,
  `status` INT NOT NULL DEFAULT 0,
  `locked_by` INT,
  `locked_at` DATETIME,
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `seller_apply_bindings`;
CREATE TABLE `seller_apply_bindings` (
  `admin_id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `apply_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `created_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `shop_accounts`;
CREATE TABLE `shop_accounts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `shop_id` BIGINT NOT NULL,
  `account_type` VARCHAR(255) NOT NULL,
  `account_name` VARCHAR(255) NOT NULL,
  `bank_name` VARCHAR(255),
  `account_no` VARCHAR(64) NOT NULL,
  `id_card_tail` VARCHAR(255),
  `verified` INT NOT NULL DEFAULT 0,
  `verify_amount` DECIMAL(12,2),
  `verify_fail_count` INT NOT NULL DEFAULT 0,
  `verify_locked_until` DATETIME,
  `effective_at` DATETIME,
  `status` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `work_orders`;
CREATE TABLE `work_orders` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `work_no` VARCHAR(64) NOT NULL UNIQUE,
  `user_id` BIGINT NOT NULL,
  `order_id` BIGINT,
  `source` VARCHAR(255) NOT NULL DEFAULT '在线咨询',
  `type` VARCHAR(255) NOT NULL DEFAULT '咨询',
  `content` JSON NOT NULL,
  `status` INT NOT NULL DEFAULT 1,
  `assignee_id` BIGINT,
  `replies` JSON,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  `closed_at` DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 关键索引（与 SQLite 版一致：订单/商品/流水分页与过滤）
CREATE INDEX idx_orders_user_time ON orders(user_id, created_at);
CREATE INDEX idx_orders_shop_time ON orders(shop_id, created_at);
CREATE INDEX idx_orders_status_expire ON orders(status, expire_at);
CREATE INDEX idx_products_status ON products(status, is_deleted);
CREATE INDEX idx_products_shop ON products(shop_id);
CREATE INDEX idx_skus_product ON skus(product_id);
CREATE INDEX idx_stock_logs_sku_time ON stock_logs(sku_id, created_at);
CREATE INDEX idx_operation_logs_admin_time ON operation_logs(admin_id, created_at);
CREATE INDEX idx_user_coupons_user_status ON user_coupons(user_id, status);
CREATE INDEX idx_bookings_slot ON store_bookings(store_id, booking_date, slot);
SET FOREIGN_KEY_CHECKS = 1;
