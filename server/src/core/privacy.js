'use strict';

/** 敏感数据脱敏（12.4 / NFR-SEC-008）：手机号 138****8888、地址保留省市区 */

function maskPhone(phone) {
  const s = String(phone || '');
  if (s.length < 7) return s;
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

function maskAddress(snapshot) {
  if (!snapshot) return '';
  const { province = '', city = '', district = '', detail = '' } = snapshot;
  return `${province}${city}${district}${detail ? '****' : ''}`;
}

function maskName(name) {
  const s = String(name || '');
  if (s.length <= 1) return s;
  return `${s[0]}${'*'.repeat(Math.min(s.length - 1, 3))}`;
}

module.exports = { maskPhone, maskAddress, maskName };
