'use strict';

const { get, all, run, transaction, parseJson } = require('../core/db');
const { now, addDays, addMinutes, toCents } = require('../core/money');
const { hashPassword } = require('../core/auth');
const config = require('../core/config');

/**
 * 初始化种子数据
 * 依据《需求文档》附录 C（7 个一级 / 50 个二级 / 约 263 个三级词条）、
 * 《测试文档》4. 测试环境与测试数据（会员 A/B、商家 S1/S2、平台五角色、商品 P1/P2/P3、券 C1/C2/C3、拼团 G1、门店 M1、服务 T1）。
 */

const CATEGORY_TREE = [
  {
    name: '狗狗', icon: 'dog', children: {
      主粮: ['进口粮', '国产粮', '处方粮', '冻干粮', '烘焙粮', '幼犬粮', '成犬粮', '老年犬粮'],
      零食: ['肉干肉条', '冻干零食', '洁齿骨', '磨牙棒', '狗罐头', '训练零食', '营养膏'],
      保健: ['关节养护', '肠胃调理', '补钙美毛', '益生菌', '营养粉', '驱虫保健'],
      医疗: ['体外驱虫', '体内驱虫', '皮肤用药', '眼部护理', '耳部护理', '伤口护理', '处方药品'],
      日用: ['食盆水碗', '狗窝垫子', '尿垫', '牵引绳', '项圈胸背', '航空箱围栏', '除味清洁'],
      玩具: ['磨牙玩具', '互动玩具', '球类', '绳结玩具', '发声玩具'],
      美容: ['洗发沐浴', '吹水机', '梳子开结', '指甲剪', '浴巾', '剃毛器'],
      出行: ['便携背包', '车载垫', '宠物推车', '外出饮水器', '雨衣'],
      服饰: ['服装', '鞋袜', '饰品', '围巾'],
    },
  },
  {
    name: '猫猫', icon: 'cat', children: {
      主粮: ['进口粮', '国产粮', '处方粮', '冻干粮', '主食罐头', '幼猫粮', '成猫粮', '老年猫粮'],
      零食: ['猫条', '冻干零食', '猫罐头', '猫草', '营养膏', '化毛膏'],
      保健: ['化毛球', '肠胃调理', '补钙美毛', '益生菌', '关节养护', '泌尿道护理'],
      医疗: ['体外驱虫', '体内驱虫', '皮肤用药', '眼部护理', '耳部护理', '口腔护理', '处方药品'],
      日用: ['猫砂', '猫砂盆', '猫抓板', '猫窝', '饮水机', '自动喂食器', '除味清洁'],
      玩具: ['逗猫棒', '激光笔', '猫隧道', '球类', '自动玩具', '猫爬架'],
      美容: ['洗浴液', '梳毛工具', '指甲剪', '剃毛器', '浴巾'],
      出行: ['航空箱', '外出背包', '牵引绳', '便携猫包'],
    },
  },
  {
    name: '小宠', icon: 'small', children: {
      主粮: ['兔粮', '豚鼠粮', '龙猫粮', '仓鼠粮', '混合粮', '营养颗粒'],
      零食: ['磨牙零食', '果蔬干', '草砖', '谷物零食', '面包虫干'],
      牧草: ['提摩西草', '苜蓿草', '燕麦草', '果树草', '黑麦草'],
      保健: ['营养补充', '肠胃调理', '复合维生素', '美毛粉', '驱虫护理'],
      笼具: ['兔笼', '仓鼠笼', '龙猫柜笼', '跑轮', '躲避屋', '笼内平台'],
      日用: ['饮水器', '食盆', '木屑垫材', '尿垫', '磨牙石', '除味清洁'],
      外出: ['外带包', '便携笼', '牵引绳', '外出垫'],
      清洁护理: ['沙浴粉', '洗澡沙', '梳毛刷', '指甲剪'],
    },
  },
  {
    name: '爬宠', icon: 'reptile', children: {
      饲料: ['昆虫冻干', '果泥饲料', '专用粮', '钙粉拌粮'],
      活体饲料: ['面包虫', '大麦虫', '蟋蟀', '杜比亚', '樱桃蟑螂', '小白鼠'],
      饲养设备: ['饲养箱', '加热垫', '加热灯', 'UVB 灯', '温控器', '加湿器'],
      造景: ['底材', '躲避穴', '水盆', '树枝藤条', '背景板', '假山'],
      保健: ['钙粉', '复合维生素', '驱虫药', '电解质'],
      清洁: ['清洁剂', '消毒液', '粪铲', '除味剂'],
    },
  },
  {
    name: '鸟类', icon: 'bird', children: {
      鸟粮: ['混合粮', '滋养丸', '专用粮', '滋补品'],
      零食: ['蛋小米', '果蔬干', '坚果零食', '钙块'],
      笼具: ['鸟笼', '鸟架', '站杆', '巢箱', '笼内配件'],
      日用: ['食盒水盒', '垫纸', '栖木', '浴盆', '笼内玩具'],
      保健: ['钙粉', '复合维生素', '驱虫药', '窝垫'],
      外出: ['外出笼', '便携包', '放飞绳'],
    },
  },
  {
    name: '水族', icon: 'aquarium', children: {
      鱼粮饲料: ['热带鱼粮', '金鱼粮', '锦鲤粮', '虾粮', '龟粮', '饲料添加剂'],
      水族箱: ['鱼缸', '水族箱套装', '加热棒', '过滤器', '水泵', '气泵'],
      造景: ['底砂', '水草', '造景石沉木', '水族装饰', '背景板'],
      水质处理: ['水质稳定剂', '硝化细菌', '除藻剂', '水质测试剂'],
      器材配件: ['照明灯', 'CO2 设备', '温度计', '软管配件'],
      鱼药保健: ['杀菌消毒', '营养液', '寄生虫药', '外伤处理'],
      清洁工具: ['吸污器', '磁力刷', '换水器', '捞网'],
    },
  },
  {
    name: '到店', icon: 'store', isStore: true, children: {
      洗护美容: ['基础洗澡', '造型美容', '深层 SPA', '药浴', '剪指甲清洁耳朵', '吹干护理'],
      寄养托管: ['短期寄养', '长期寄养', '日间托管', '节假日寄养', '宠物酒店'],
      医疗健康: ['疫苗注射', '健康体检', '体内外驱虫', '绝育手术', '口腔洁治', '康复理疗'],
      行为训练: ['基础礼仪', '定点排便', '笼养适应', '社会化训练', '攻击行为矫正'],
      上门服务: ['上门喂养', '上门遛狗', '上门洗澡', '上门护理'],
      宠物摄影: ['棚拍写真', '外景写真', '节日主题', '视频拍摄'],
    },
  },
];

const PERMISSIONS = [
  ['menu.ops.category', '类目管理', 'menu'],
  ['menu.ops.content', '内容位管理', 'menu'],
  ['menu.ops.product-audit', '商品审核', 'menu'],
  ['menu.ops.shop-audit', '商家与入驻审核', 'menu'],
  ['menu.ops.activity-audit', '营销审核', 'menu'],
  ['menu.ops.coupon', '平台优惠券', 'menu'],
  ['menu.ops.group-buy', '拼团规则', 'menu'],
  ['menu.ops.store-service', '到店服务', 'menu'],
  ['menu.whs.stock', '库存总览', 'menu'],
  ['menu.whs.inout', '出入库', 'menu'],
  ['menu.whs.take', '盘点', 'menu'],
  ['menu.whs.ship', '拣货发货', 'menu'],
  ['menu.cs.work-order', '咨询工单', 'menu'],
  ['menu.cs.aftersale', '售后处理', 'menu'],
  ['menu.cs.review-appeal', '评价申诉', 'menu'],
  ['menu.fin.reconcile', '订单对账', 'menu'],
  ['menu.fin.payment', '支付流水', 'menu'],
  ['menu.fin.refund', '退款管理', 'menu'],
  ['menu.fin.settlement', '商家结算', 'menu'],
  ['menu.sys.user', '用户管理', 'menu'],
  ['menu.sys.seller', '商家账号', 'menu'],
  ['menu.sys.role', '角色权限', 'menu'],
  ['menu.sys.config', '系统配置', 'menu'],
  ['menu.sys.log', '操作日志', 'menu'],
  ['menu.sys.dashboard', '数据看板', 'menu'],
  ['action.refund.audit', '退款审核', 'action'],
  ['action.settlement.generate', '生成结算单', 'action'],
  ['action.withdrawal.audit', '提现审核', 'action'],
  ['action.aftersale.intervene', '售后介入', 'action'],
  ['action.log.export', '日志导出', 'action'],
  ['action.order.export', '订单导出', 'action'],
];

const ROLES = [
  ['超级管理员', 'super_admin', 1, ['*']],
  ['运营', 'ops', 1, ['menu.ops.category', 'menu.ops.content', 'menu.ops.product-audit', 'menu.ops.shop-audit',
    'menu.ops.activity-audit', 'menu.ops.coupon', 'menu.ops.group-buy', 'menu.ops.store-service',
    'menu.sys.dashboard', 'action.order.export']],
  ['仓库', 'warehouse', 1, ['menu.whs.stock', 'menu.whs.inout', 'menu.whs.take', 'menu.whs.ship',
    'menu.sys.dashboard', 'action.order.export']],
  ['客服', 'customer_service', 1, ['menu.cs.work-order', 'menu.cs.aftersale', 'menu.cs.review-appeal',
    'action.aftersale.intervene', 'action.refund.audit']],
  ['财务', 'finance', 1, ['menu.fin.reconcile', 'menu.fin.payment', 'menu.fin.refund', 'menu.fin.settlement',
    'menu.sys.dashboard', 'action.refund.audit', 'action.settlement.generate', 'action.withdrawal.audit']],
];

function insertCategoryTree() {
  for (const top of CATEGORY_TREE) {
    const topRes = run('INSERT INTO categories (name, parent_id, level, icon, sort, status, created_at, updated_at) VALUES (?, 0, 1, ?, ?, 1, ?, ?)',
      top.name, top.icon, CATEGORY_TREE.indexOf(top), now(), now());
    const topId = topRes.lastInsertRowid;
    let l2 = 0;
    for (const [l2Name, l3List] of Object.entries(top.children)) {
      const l2Res = run('INSERT INTO categories (name, parent_id, level, icon, sort, status, created_at, updated_at) VALUES (?, ?, 2, NULL, ?, 1, ?, ?)',
        l2Name, topId, l2, now(), now());
      let l3 = 0;
      for (const l3Name of l3List) {
        run('INSERT INTO categories (name, parent_id, level, icon, sort, status, created_at, updated_at) VALUES (?, ?, 3, NULL, ?, 1, ?, ?)',
          l3Name, l2Res.lastInsertRowid, l3, now(), now());
        l3 += 1;
      }
      l2 += 1;
    }
  }
}

function categoryIdByName(name) {
  const row = get('SELECT id FROM categories WHERE name = ? ORDER BY level ASC LIMIT 1', name);
  return row?.id;
}

function insertPermissionsAndRoles() {
  for (const [code, name, type] of PERMISSIONS) {
    run('INSERT INTO permissions (code, name, type) VALUES (?, ?, ?)', code, name, type);
  }
  for (const [name, code, builtin, perms] of ROLES) {
    const res = run('INSERT INTO roles (name, code, builtin, created_at) VALUES (?, ?, ?, ?)', name, code, builtin, now());
    const roleId = res.lastInsertRowid;
    for (const perm of perms) {
      if (perm === '*') {
        // 超级管理员：绑定全部权限，鉴权时亦按 super_admin 直接放行
        for (const p of all('SELECT id FROM permissions')) {
          run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', roleId, p.id);
        }
      } else {
        const p = get('SELECT id FROM permissions WHERE code = ?', perm);
        if (p) run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', roleId, p.id);
      }
    }
  }
}

function insertDicts() {
  const dicts = {
    logistics_company: [['SF', '顺丰速运'], ['JD', '京东物流'], ['YTO', '圆通速递'], ['ZTO', '中通快递'], ['STO', '申通快递'], ['EMS', '中国邮政']],
    unit: [['bag', '袋'], ['box', '盒'], ['bottle', '瓶'], ['piece', '件'], ['kg', '千克']],
    brand: [['royal', '皇家'], ['myfoodie', '麦富迪'], ['wanpy', '顽皮'], ['pidan', 'pidan'], ['lorde', '里兜']],
    pay_channel: [['alipay', '支付宝'], ['wechat', '微信支付']],
    aftersale_type: [['1', '仅退款'], ['2', '退货退款']],
    order_status: [['0', '待付款'], ['1', '待发货'], ['2', '已发货'], ['3', '已完成'], ['4', '已取消'], ['5', '已退款'], ['6', '待成团']],
  };
  for (const [type, items] of Object.entries(dicts)) {
    items.forEach(([code, name], i) => run('INSERT INTO dict_items (type, code, name, sort, status) VALUES (?, ?, ?, ?, 1)', type, code, name, i));
  }
}

function seed() {
  const pwd = (p) => hashPassword(p);
  transaction(() => {
    insertCategoryTree();
    insertPermissionsAndRoles();
    insertDicts();

    // ---- 会员 ----
    const u1 = run('INSERT INTO users (username, password_hash, phone, email, nickname, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      'petuser01', pwd('Pet123456'), '13800008888', 'petuser01@example.com', '会员A', now(), now()).lastInsertRowid;
    const u2 = run('INSERT INTO users (username, password_hash, phone, email, nickname, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      'petuser02', pwd('Pet123456'), '13800008889', 'petuser02@example.com', '会员B', now(), now()).lastInsertRowid;
    const sellerOwner1 = run('INSERT INTO users (username, password_hash, phone, email, nickname, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      'owner_s1', pwd('Seller123456'), '13900000001', 'owner_s1@example.com', '宠爱之家店主', now(), now()).lastInsertRowid;
    const sellerOwner2 = run('INSERT INTO users (username, password_hash, phone, email, nickname, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      'owner_s2', pwd('Seller123456'), '13900000002', 'owner_s2@example.com', '毛孩子店主', now(), now()).lastInsertRowid;

    for (const u of [u1, u2, sellerOwner1, sellerOwner2]) run('INSERT INTO carts (user_id, updated_at) VALUES (?, ?)', u, now());

    // 收货地址（会员 A 默认地址）
    run(`INSERT INTO addresses (user_id, receiver, phone, province, city, district, detail, is_default, created_at, updated_at)
         VALUES (?, '张三', '13800008888', '上海市', '上海市', '浦东新区', '张江路 100 号 1 栋 101 室', 1, ?, ?)`, u1, now(), now());

    // ---- 店铺 ----
    const catDog = categoryIdByName('狗狗');
    const shop1 = run(`INSERT INTO shops (owner_id, name, logo, banner, description, notice, phone, category_ids, score, status, created_at, updated_at)
      VALUES (?, '宠爱之家旗舰店', 'https://picsum.photos/seed/shop1logo/120/120', 'https://picsum.photos/seed/shop1banner/1200/300',
              '专注宠物主粮与用品十年，正品保障，全场满 99 包邮。', '新店开业，进店领券立减 5 元。', '021-88880001', ?, 48, 1, ?, ?)`,
      sellerOwner1, JSON.stringify([catDog]), now(), now()).lastInsertRowid;
    const shop2 = run(`INSERT INTO shops (owner_id, name, logo, banner, description, notice, phone, category_ids, score, status, created_at, updated_at)
      VALUES (?, '毛孩子生活馆', 'https://picsum.photos/seed/shop2logo/120/120', 'https://picsum.photos/seed/shop2banner/1200/300',
              '猫咪用品精选，猫砂猫粮一站购齐。', '每周三会员日双倍积分。', '021-88880002', ?, 47, 1, ?, ?)`,
      sellerOwner2, JSON.stringify([categoryIdByName('猫猫')]), now(), now()).lastInsertRowid;

    // ---- 后台账号 ----
    const role = (code) => get('SELECT id FROM roles WHERE code = ?', code).id;
    const insAdmin = (account, password, name, type, shopId, roleCode) => run(
      `INSERT INTO admin_users (account, password_hash, name, type, shop_id, role_id, status, must_change_pwd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      account, pwd(password), name, type, shopId, roleCode ? role(roleCode) : null, now(), now(),
    ).lastInsertRowid;
    insAdmin('admin', 'Admin123456', '平台管理员', 'admin', null, 'super_admin');
    insAdmin('ops01', 'Ops123456', '运营小运', 'admin', null, 'ops');
    insAdmin('whs01', 'Whs123456', '仓库小仓', 'admin', null, 'warehouse');
    insAdmin('cs01', 'Cs123456', '客服小服', 'admin', null, 'customer_service');
    insAdmin('fin01', 'Fin123456', '财务小财', 'admin', null, 'finance');
    insAdmin('s1', 'Seller123456', '宠爱之家', 'seller', shop1, null);
    insAdmin('s2', 'Seller123456', '毛孩子', 'seller', shop2, null);
    insAdmin('s3', 'Seller123456', '待入驻商家', 'seller', null, null);

    // ---- 商品 ----
    // P1：多规格（颜色 × 尺寸），SKU 可售库存 50
    const p1Category = categoryIdByName('成犬粮');
    const p1 = run(`INSERT INTO products (shop_id, category_id, name, main_image, images, detail_html, brand, unit, product_code,
        price, origin_price, sales, total_stock, locked_stock, warn_stock, status, created_at, updated_at)
      VALUES (?, ?, 'P1 全阶段天然成犬粮 2kg', 'https://picsum.photos/seed/p1/600/600', ?, '<p>高蛋白低敏配方，适口性好。</p>',
        '皇家', '袋', 'P1-CODE', 9800, 12800, 320, 50, 0, 10, 2, ?, ?)`,
      shop1, p1Category, JSON.stringify(['https://picsum.photos/seed/p1/600/600', 'https://picsum.photos/seed/p1b/600/600']), now(), now()).lastInsertRowid;
    const p1Skus = [['红色 / M', { 颜色: '红色', 尺寸: 'M' }, 9800], ['红色 / L', { 颜色: '红色', 尺寸: 'L' }, 10800],
      ['蓝色 / M', { 颜色: '蓝色', 尺寸: 'M' }, 9800], ['蓝色 / L', { 颜色: '蓝色', 尺寸: 'L' }, 10800]];
    const skuIdOf = {};
    for (const [spec, json, price] of p1Skus) {
      const skuId = run(`INSERT INTO skus (product_id, spec_name, spec_json, price, origin_price, stock, locked_stock, warn_stock, barcode, image, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 50, 0, 10, ?, ?, 1, ?, ?)`,
        p1, spec, JSON.stringify(json), price, 12800, `P1${spec}`, 'https://picsum.photos/seed/p1/200/200', now(), now()).lastInsertRowid;
      skuIdOf[spec] = skuId;
    }
    run('UPDATE products SET total_stock = 200 WHERE id = ?', p1);

    // P2：单规格，库存 0（已售罄）
    const p2 = run(`INSERT INTO products (shop_id, category_id, name, main_image, images, detail_html, brand, unit, product_code,
        price, origin_price, sales, total_stock, locked_stock, warn_stock, status, created_at, updated_at)
      VALUES (?, ?, 'P2 冻干鸡肉粒 300g', 'https://picsum.photos/seed/p2/600/600', ?, '<p>纯肉冻干，训练奖励首选。</p>',
        '麦富迪', '袋', 'P2-CODE', 4900, 5900, 88, 0, 0, 5, 2, ?, ?)`,
      shop1, categoryIdByName('冻干零食'), JSON.stringify(['https://picsum.photos/seed/p2/600/600']), now(), now()).lastInsertRowid;
    run(`INSERT INTO skus (product_id, spec_name, price, origin_price, stock, locked_stock, warn_stock, status, created_at, updated_at)
         VALUES (?, '默认', 4900, 5900, 0, 0, 5, 1, ?, ?)`, p2, now(), now());

    // P3：已下架
    const p3 = run(`INSERT INTO products (shop_id, category_id, name, main_image, images, detail_html, brand, unit, product_code,
        price, origin_price, sales, total_stock, locked_stock, warn_stock, status, created_at, updated_at)
      VALUES (?, ?, 'P3 宠物自动饮水机 2L', 'https://picsum.photos/seed/p3/600/600', ?, '<p>循环过滤，静音设计。</p>',
        'pidan', '件', 'P3-CODE', 12900, 15900, 45, 30, 0, 5, 3, ?, ?)`,
      shop1, categoryIdByName('饮水机'), JSON.stringify(['https://picsum.photos/seed/p3/600/600']), now(), now()).lastInsertRowid;
    run(`INSERT INTO skus (product_id, spec_name, price, origin_price, stock, locked_stock, warn_stock, status, created_at, updated_at)
         VALUES (?, '默认', 12900, 15900, 30, 0, 5, 1, ?, ?)`, p3, now(), now());

    // 更多在售商品（分类页、搜索、优选、拼团与活动数据源）
    const more = [
      ['渴望六种鱼全犬粮 2kg', '进口粮', 26800, 32900, 40, shop1],
      ['爱肯拿海洋盛宴犬粮 2kg', '进口粮', 23800, 28900, 26, shop1],
      ['麦富迪肉干肉条 500g', '肉干肉条', 3900, 4900, 120, shop1],
      ['洁齿骨洁牙棒 10 支', '洁齿骨', 2900, 3500, 200, shop1],
      ['关节养护营养片 120 片', '关节养护', 8900, 9900, 60, shop1],
      ['体内驱虫药 3 粒装', '体内驱虫', 6800, 7800, 80, shop1],
      ['牵引绳反光款 1.5m', '牵引绳', 5900, 6900, 90, shop1],
      ['耐咬磨牙玩具', '磨牙玩具', 1900, 2500, 150, shop1],
      ['豆腐猫砂 6L 除臭型', '猫砂', 2900, 3900, 300, shop2],
      ['膨润土猫砂 10kg', '猫砂', 3900, 4900, 200, shop2],
      ['猫条 30 支装', '猫条', 4900, 5900, 180, shop2],
      ['冻干三文鱼粒 200g', '冻干零食', 5900, 6900, 70, shop2],
      ['自动喂食器 4L', '自动喂食器', 19900, 25900, 25, shop2],
      ['猫爬架剑麻款', '猫爬架', 15900, 19900, 15, shop2],
      ['逗猫棒羽毛款', '逗猫棒', 990, 1290, 260, shop2],
      ['提摩西草 1kg', '提摩西草', 3900, 4500, 110, shop2],
    ];
    for (const [name, catName, price, origin, stock, shopId] of more) {
      const code = `SKU-${Buffer.from(name).toString('hex').slice(0, 10).toUpperCase()}`;
      const pid = run(`INSERT INTO products (shop_id, category_id, name, main_image, images, detail_html, brand, unit, product_code,
          price, origin_price, sales, total_stock, locked_stock, warn_stock, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '<p>宠物之家精选正品。</p>', '精选', '件', ?, ?, ?, 0, ?, 0, 5, 2, ?, ?)`,
        shopId, categoryIdByName(catName), name, `https://picsum.photos/seed/${encodeURIComponent(name)}/600/600`,
        JSON.stringify([`https://picsum.photos/seed/${encodeURIComponent(name)}/600/600`]), code,
        price, origin, stock, now(), now()).lastInsertRowid;
      run(`INSERT INTO skus (product_id, spec_name, price, origin_price, stock, locked_stock, warn_stock, status, created_at, updated_at)
           VALUES (?, '默认', ?, ?, ?, 0, 5, 1, ?, ?)`, pid, price, origin, stock, now(), now());
    }

    // ---- 优惠券：C1 平台满 100 减 10、C2 店铺券满 50 减 5（限 S1）、C3 平台满 200 减 20 ----
    const day = (n) => addDays(n);
    run(`INSERT INTO coupons (shop_id, name, type, threshold, amount, discount_rate, scope_type, scope_ids, start_at, end_at,
        valid_days, stock, received, limit_per_user, claim_type, status, created_at, updated_at)
      VALUES (0, '平台满 100 减 10', 1, 10000, 1000, NULL, 1, '[]', ?, ?, 30, 1000, 0, 1, '主动领取', 1, ?, ?)`,
      day(-1), day(60), now(), now());
    run(`INSERT INTO coupons (shop_id, name, type, threshold, amount, discount_rate, scope_type, scope_ids, start_at, end_at,
        valid_days, stock, received, limit_per_user, claim_type, status, created_at, updated_at)
      VALUES (?, '店铺满 50 减 5', 1, 5000, 500, NULL, 4, ?, ?, ?, 30, 500, 0, 1, '主动领取', 1, ?, ?)`,
      shop1, JSON.stringify([shop1]), day(-1), day(60), now(), now());
    run(`INSERT INTO coupons (shop_id, name, type, threshold, amount, discount_rate, scope_type, scope_ids, start_at, end_at,
        valid_days, stock, received, limit_per_user, claim_type, status, created_at, updated_at)
      VALUES (0, '平台满 200 减 20', 1, 20000, 2000, NULL, 1, '[]', ?, ?, 30, 500, 0, 1, '主动领取', 1, ?, ?)`,
      day(-1), day(60), now(), now());
    run(`INSERT INTO coupons (shop_id, name, type, threshold, amount, discount_rate, scope_type, scope_ids, start_at, end_at,
        valid_days, stock, received, limit_per_user, claim_type, status, created_at, updated_at)
      VALUES (0, '平台 9 折券（满 50 可用）', 2, 5000, 0, 0.9, 1, '[]', ?, ?, 30, 200, 0, 1, '主动领取', 1, ?, ?)`,
      day(-1), day(60), now(), now());

    // ---- 商家活动（命中「进口粮」类商品，用于活动生效与审核演示）----
    const actP = get("SELECT id FROM products WHERE name = '渴望六种鱼全犬粮 2kg'");
    const act = run(`INSERT INTO activities (shop_id, title, type, image, content, rule_desc, rule_json, start_at, end_at,
        status, views, join_count, order_count, deal_amount, created_at, updated_at)
      VALUES (?, '进口主粮满 200 减 20', '满减', 'https://picsum.photos/seed/act1/1200/400', '<p>活动期间进口主粮满 200 减 20。</p>',
        '满 200 元减 20 元', ?, ?, ?, 1, 128, 0, 0, 0, ?, ?)`,
      shop1, JSON.stringify({ threshold: 20000, discount: 2000 }), day(-1), day(15), now(), now()).lastInsertRowid;
    run('INSERT INTO activity_products (activity_id, product_id) VALUES (?, ?)', act, actP.id);
    const act2 = run(`INSERT INTO activities (shop_id, title, type, image, content, rule_desc, rule_json, start_at, end_at,
        status, views, join_count, order_count, deal_amount, created_at, updated_at)
      VALUES (?, '猫砂 9 折周', '折扣', 'https://picsum.photos/seed/act2/1200/400', '<p>猫砂类商品 9 折优惠。</p>',
        '全场猫砂 9 折', ?, ?, ?, 1, 88, 0, 0, 0, ?, ?)`,
      shop2, JSON.stringify({ rate: 0.9 }), day(-2), day(5), now(), now()).lastInsertRowid;
    const catLitter = get("SELECT id FROM products WHERE name = '豆腐猫砂 6L 除臭型'");
    run('INSERT INTO activity_products (activity_id, product_id) VALUES (?, ?)', act2, catLitter.id);

    // ---- 拼团 G1（成团 10 人、3 天、拼团价 79.00，共用 P1 SKU 库存池）----
    run(`INSERT INTO group_buys (shop_id, product_id, sku_id, title, group_price, required_count, joined_count,
        start_at, end_at, valid_days, status, created_at, updated_at)
      VALUES (?, ?, ?, 'P1 全阶段天然成犬粮 2kg 拼团', 7900, 10, 0, ?, ?, 3, 1, ?, ?)`,
      shop1, p1, skuIdOf['红色 / M'], day(-1), day(30), now(), now());

    // ---- 门店 M1 + 到店服务 T1 ----
    const store1 = run(`INSERT INTO stores (shop_id, name, phone, address, lng, lat, business_hours, image, status, created_at, updated_at)
      VALUES (?, '宠爱之家·张江店', '021-88880001', '上海市浦东新区张江路 88 号', 121.5996, 31.2047, '09:00-21:00',
              'https://picsum.photos/seed/store1/800/500', 1, ?, ?)`, shop1, now(), now()).lastInsertRowid;
    run(`INSERT INTO stores (shop_id, name, phone, address, lng, lat, business_hours, image, status, created_at, updated_at)
      VALUES (?, '宠爱之家·徐汇店', '021-88880003', '上海市徐汇区漕溪北路 66 号', 121.4374, 31.1956, '09:00-20:00',
              'https://picsum.photos/seed/store2/800/500', 1, ?, ?)`, shop1, now(), now());
    const service1 = run(`INSERT INTO store_services (shop_id, name, image, origin_price, store_price, valid_start, valid_end,
        description, booking_slots, slot_capacity, status, created_at, updated_at)
      VALUES (?, '基础洗澡（小型犬）', 'https://picsum.photos/seed/service1/800/500', 12900, 8900, ?, ?,
              '含基础洗护、吹干、剪指甲、清洁耳朵，服务时长约 60 分钟。',
              ?, 10, 1, ?, ?)`,
      shop1, day(-5), day(90), JSON.stringify(['09:00-10:00', '10:00-11:00', '14:00-15:00', '15:00-16:00', '19:00-20:00']),
      now(), now()).lastInsertRowid;
    run('INSERT INTO store_service_stores (store_service_id, store_id) VALUES (?, ?)', service1, store1);
    run(`INSERT INTO store_services (shop_id, name, image, origin_price, store_price, valid_start, valid_end,
        description, booking_slots, slot_capacity, status, created_at, updated_at)
      VALUES (?, '深层 SPA 药浴', 'https://picsum.photos/seed/service2/800/500', 29900, 25900, ?, ?,
              '深层清洁 + 药浴护理，适合皮肤敏感宠物。', ?, 6, 0, ?, ?)`,
      shop1, day(-5), day(90), JSON.stringify(['10:00-11:00', '14:00-15:00']), now(), now());

    // ---- 内容位：轮播 / 推荐位 / 精选 / 店铺街 / 页尾 ----
    run(`INSERT INTO banners (title, position, image, link, sort, start_at, end_at, status, created_at, updated_at)
         VALUES ('主图 1', 'home', 'https://picsum.photos/seed/banner1/1600/500', '/brand_good_33_603.html', 0, ?, ?, 1, ?, ?)`,
      day(-10), day(60), now(), now());
    run(`INSERT INTO banners (title, position, image, link, sort, start_at, end_at, status, created_at, updated_at)
         VALUES ('主图 2', 'home', 'https://picsum.photos/seed/banner2/1600/500', '/brand_good_33_603.html', 1, ?, ?, 1, ?, ?)`,
      day(-10), day(60), now(), now());
    run(`INSERT INTO recommend_slots (tab_type, target_id, sort, start_at, end_at, created_at, updated_at)
         VALUES ('shop', ?, 0, ?, ?, ?, ?)`, shop1, day(-10), day(60), now(), now());
    run(`INSERT INTO recommend_slots (tab_type, target_id, sort, start_at, end_at, created_at, updated_at)
         VALUES ('product', ?, 0, ?, ?, ?, ?)`, p1, day(-10), day(60), now(), now());
    run(`INSERT INTO recommend_slots (tab_type, target_id, sort, start_at, end_at, created_at, updated_at)
         VALUES ('activity', ?, 0, ?, ?, ?, ?)`, act, day(-10), day(60), now(), now());
    run('INSERT INTO featured_products (product_id, sort, start_at, end_at, status, created_at) VALUES (?, 0, ?, ?, 1, ?)', p1, day(-10), day(60), now());
    run('INSERT INTO featured_products (product_id, sort, start_at, end_at, status, created_at) VALUES (?, 1, ?, ?, 1, ?)', get("SELECT id FROM products WHERE name = '豆腐猫砂 6L 除臭型'").id, day(-10), day(60), now());
    run('INSERT INTO shop_recommends (shop_id, sort, start_at, end_at, created_at) VALUES (?, 0, ?, ?, ?)', shop1, day(-10), day(60), now());
    run('INSERT INTO shop_recommends (shop_id, sort, start_at, end_at, created_at) VALUES (?, 1, ?, ?, ?)', shop2, day(-10), day(60), now());
    const footer = [['购物指南', '购物流程', '/help/flow'], ['购物指南', '会员介绍', '/help/member'],
      ['配送方式', '上门自提', '/help/pickup'], ['配送方式', '配送服务查询', '/help/delivery'],
      ['支付方式', '在线支付', '/help/pay'], ['售后服务', '售后政策', '/help/aftersale'],
      ['售后服务', '价格保护', '/help/price'], ['商家服务', '商家入驻', '/seller/apply']];
    footer.forEach(([group, title, url], i) => run('INSERT INTO footer_links (group_name, title, url, sort, status) VALUES (?, ?, ?, ?, 1)', group, title, url, i));
    run("INSERT INTO search_words (word, type, sort, created_at) VALUES ('狗粮', 'hot', 0, ?)", now());
    run("INSERT INTO search_words (word, type, sort, created_at) VALUES ('猫砂', 'hot', 1, ?)", now());
    run("INSERT INTO search_words (word, type, sort, created_at) VALUES ('冻干', 'hot', 2, ?)", now());
    run("INSERT INTO search_words (word, type, sort, created_at) VALUES ('违禁词', 'block', 0, ?)", now());

    // ---- 评价：给 P1 造 3 条评价（含 1 条用于申诉）----
    const reviewScores = [[5, '狗狗很爱吃，物流也快！'], [4, '分量足，包装完好。'], [1, '差评，疑似假货（用于申诉演示）。']];
    reviewScores.forEach(([score, content], i) => {
      const orderId = run(`INSERT INTO orders (order_no, user_id, shop_id, goods_amount, freight_amount, coupon_amount,
          activity_amount, pay_amount, pay_channel, status, remark, receiver_snapshot, expire_at, paid_at, finished_at, created_at, updated_at)
        VALUES (?, ?, ?, 9800, 0, 0, 0, 9800, 'alipay', 3, '', ?, ?, ?, ?, ?, ?)`,
        `PO${Date.now()}R${i}`, i === 2 ? u2 : u1, shop1,
        JSON.stringify({ receiver: '张三', phone: '13800008888', province: '上海市', city: '上海市', district: '浦东新区', detail: '张江路 100 号' }),
        addMinutes(15), day(-20 - i), day(-18 - i), day(-20 - i), now()).lastInsertRowid;
      const orderItemId = run(`INSERT INTO order_items (order_id, product_id, sku_id, product_name, spec_name, image, price, quantity, subtotal, created_at)
        VALUES (?, ?, ?, 'P1 全阶段天然成犬粮 2kg', '红色 / M', 'https://picsum.photos/seed/p1/200/200', 9800, 1, 9800, ?)`,
        orderId, p1, skuIdOf['红色 / M'], day(-20 - i)).lastInsertRowid;
      run(`INSERT INTO shop_reviews (shop_id, product_id, order_id, order_item_id, user_id, score, content, images, hidden, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, ?)`,
        shop1, p1, orderId, orderItemId, i === 2 ? u2 : u1, score, content, day(-10 + i), now());
    });
    run('UPDATE shops SET score = 45 WHERE id = ?', shop1);

    // ---- 客服工单样例 ----
    run(`INSERT INTO work_orders (work_no, user_id, source, type, content, status, created_at, updated_at)
         VALUES (?, ?, '在线咨询', '咨询', '请问 P1 狗粮适合 2 岁金毛吗？', 1, ?, ?)`,
      `WO${Date.now()}`, u2, now(), now());
  });
  config.ensureDefaults();
  return true;
}

function seedIfEmpty() {
  const count = get('SELECT COUNT(*) AS c FROM users').c;
  if (count > 0) { config.ensureDefaults(); return false; }
  seed();
  return true;
}

module.exports = { seed, seedIfEmpty, CATEGORY_TREE, PERMISSIONS, ROLES };
