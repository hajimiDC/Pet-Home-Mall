'use strict';

const crypto = require('node:crypto');

/** 敏感字段加解密（12.4：账户信息加密存储，页面掩码展示） */
const KEY = crypto.createHash('sha256').update(process.env.PET_ENC_KEY || 'pet-home-mall-enc-key-2026').digest();

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(payload) {
  if (!payload) return '';
  if (!String(payload).startsWith('v1:')) return String(payload);
  try {
    const [, ivB64, tagB64, dataB64] = String(payload).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (_) {
    return '';
  }
}

function maskAccount(account) {
  const s = String(account || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}****${s.slice(-4)}`;
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

module.exports = { encrypt, decrypt, maskAccount, sha256 };
