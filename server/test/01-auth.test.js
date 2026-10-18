'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.before(async () => { await h.start(); });
test.after(async () => { await h.stop(); });

test('TC-API-001 统一响应体与分页结构', async () => {
  const health = await h.api.get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.code, 1);
  assert.equal(health.msg, 'success');
  assert.ok(health.data.status === 'UP');

  const list = await h.api.get('/api/orders?page=1&pageSize=10', { token: await h.loginUser() });
  assert.equal(list.code, 1);
  assert.ok(Array.isArray(list.data.rows));
  assert.equal(typeof list.data.total, 'number');
});

test('TC-API-001 未携带 / 伪造 / 过期令牌均返回 401', async () => {
  const noToken = await h.api.get('/api/auth/me');
  assert.equal(noToken.status, 401);
  assert.equal(noToken.code, 0);

  const fake = await h.api.get('/api/auth/me', { token: 'aaa.bbb.ccc' });
  assert.equal(fake.status, 401);

  const token = await h.loginUser();
  const me = await h.api.get('/api/auth/me', { token });
  assert.equal(me.code, 1);
  // 令牌过期：直接改库让 expires_at 过期
  h.db.get("UPDATE auth_tokens SET expires_at = '2000-01-01 00:00:00' WHERE revoked = 0");
  const expired = await h.api.get('/api/auth/me', { token });
  assert.equal(expired.status, 401);
  assert.match(expired.msg, /过期|失效/);
});

test('TC-REG-001 注册字段校验、唯一性与自动登录', async () => {
  // 空表单
  const empty = await h.api.post('/api/auth/register', {});
  assert.equal(empty.status, 400);
  assert.equal(empty.data, null);

  const shortName = await h.api.post('/api/auth/register', { username: 'abc', password: 'abc12345', confirmPassword: 'abc12345', phone: '13700000001' });
  assert.equal(shortName.status, 400);
  assert.match(shortName.msg, /4-20/);

  const weak = await h.api.post('/api/auth/register', { username: 'tester01', password: '12345678', confirmPassword: '12345678', phone: '13700000002' });
  assert.equal(weak.status, 400);
  assert.match(weak.msg, /字母与数字/);

  const mismatch = await h.api.post('/api/auth/register', { username: 'tester02', password: 'abc12345', confirmPassword: 'abc12346', phone: '13700000003' });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.msg, /不一致/);

  // 用户名 / 手机号唯一
  const dupName = await h.api.post('/api/auth/register', { username: 'petuser01', password: 'abc12345', confirmPassword: 'abc12345', phone: '13700000004' });
  assert.equal(dupName.status, 400);
  assert.match(dupName.msg, /该账号已注册/);
  assert.equal(dupName.raw.details.field, 'username');

  const dupPhone = await h.api.post('/api/auth/register', { username: 'tester03', password: 'abc12345', confirmPassword: 'abc12345', phone: '13800008888' });
  assert.equal(dupPhone.status, 400);
  assert.match(dupPhone.msg, /该账号已注册/);

  // 合法注册：自动登录 + 密码 BCrypt 不可逆
  const ok = await h.api.post('/api/auth/register', { username: 'tester04', password: 'abc12345', confirmPassword: 'abc12345', phone: '13700000005' });
  assert.equal(ok.code, 1);
  assert.ok(ok.data.token);
  assert.equal(ok.data.user.username, 'tester04');
  const row = h.db.get('SELECT password_hash FROM users WHERE username = ?', 'tester04');
  assert.match(row.password_hash, /^\$2[aby]\$10\$/);
  assert.ok(!row.password_hash.includes('abc12345'));

  // 注册返回的手机号脱敏
  assert.equal(ok.data.user.phone, '137****0005');
});

test('TC-LOGIN-001 登录失败统一提示与防爆破锁定', async () => {
  const notExist = await h.api.post('/api/auth/login', { account: 'no_such_user', password: 'whatever1' });
  assert.equal(notExist.status, 400);
  assert.equal(notExist.msg, '账号或密码错误');

  const wrong = await h.api.post('/api/auth/login', { account: 'petuser02', password: 'Wrong1234' });
  assert.equal(wrong.msg, '账号或密码错误');

  // 连续 5 次错误后锁定
  for (let i = 0; i < 4; i += 1) {
    await h.api.post('/api/auth/login', { account: 'petuser02', password: 'Wrong1234' });
  }
  const locked = await h.api.post('/api/auth/login', { account: 'petuser02', password: 'Pet123456' });
  assert.equal(locked.status, 400);
  assert.match(locked.msg, /锁定/);

  // 测试夹具：解除锁定，避免影响后续用例
  h.db.get("UPDATE users SET fail_count = 0, locked_until = NULL WHERE username = 'petuser02'");

  // 其它账号不受影响
  const ok = await h.api.post('/api/auth/login', { account: 'petuser01', password: 'Pet123456' });
  assert.equal(ok.code, 1);
  assert.ok(ok.data.token);
  assert.equal(ok.data.user.nickname, '会员A');
});

test('TC-LOGIN-001 记住我延长令牌有效期', async () => {
  const normal = await h.api.post('/api/auth/login', { account: 'petuser01', password: 'Pet123456' });
  const remembered = await h.api.post('/api/auth/login', { account: 'petuser01', password: 'Pet123456', remember: true });
  assert.equal(normal.code, 1);
  assert.equal(remembered.code, 1);
  assert.ok(remembered.data.expiresIn > normal.data.expiresIn);
});

test('TC-SEC-001 水平越权：他人订单返回 404 不泄露信息', async () => {
  const tokenA = await h.loginUser('petuser01', 'Pet123456');
  const order = await h.createOrder(tokenA);
  const tokenB = await h.loginUser('petuser02', 'Pet123456');
  const res = await h.api.get(`/api/orders/${order.orderId}`, { token: tokenB });
  assert.equal(res.status, 404);
  assert.equal(res.msg, '订单不存在');
  const detail = await h.api.get(`/api/orders/${order.orderId}`, { token: tokenA });
  assert.equal(detail.code, 1);
  assert.equal(detail.data.orderNo, order.orderNo);
});

test('NFR-SEC-010 接口限流返回 429', async () => {
  let limited = null;
  for (let i = 0; i < 26; i += 1) {
    const res = await h.api.post('/api/auth/register', {
      username: `rl_user_${i}`, password: 'abc12345', confirmPassword: 'abc12345', phone: `1370000${String(1000 + i).slice(-4)}`,
    });
    if (res.status === 429) { limited = res; break; }
  }
  assert.ok(limited, '应触发注册接口限流');
  assert.match(limited.msg, /频繁/);
});
