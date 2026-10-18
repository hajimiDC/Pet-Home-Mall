'use strict';

/**
 * 金额与时间工具。
 * 金额：数据库 INTEGER 分，业务侧全整数运算，对外以元（number, 两位小数）返回，
 * 满足 NFR-CONS-004「使用 decimal 计算，禁止浮点」——整数分即定点数。
 */

/** 元 → 分；支持 '98.5' / 98.5 / '￥98.50' */
function toCents(input) {
  if (input === null || input === undefined || input === '') return null;
  const s = String(input).replace(/[￥$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

/** 分 → 元（number，去除浮点噪声） */
function toYuan(cents) {
  if (cents === null || cents === undefined) return null;
  return Number((cents / 100).toFixed(2));
}

/** 分 → 形如 "98.00" 的字符串（导出、报表用） */
function fmtYuan(cents) {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

function pad(n) { return n < 10 ? `0${n}` : `${n}`; }

/** 当前 UTC 时间，'YYYY-MM-DD HH:MM:SS' */
function now(offsetMs = 0) {
  const d = new Date(Date.now() + offsetMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** 解析数据库时间为 Date（按 UTC） */
function parseTime(s) {
  if (s instanceof Date) return s;
  if (!s) return null;
  const norm = String(s).replace('T', ' ').replace('Z', '');
  return new Date(`${norm}Z`);
}

function addMinutes(minutes, base = now()) {
  return now(parseTime(base).getTime() + minutes * 60000 - Date.now());
}

function addDays(days, base = now()) {
  return now(parseTime(base).getTime() + days * 86400000 - Date.now());
}

function isBefore(a, b) { return parseTime(a).getTime() < parseTime(b).getTime(); }
function isAfter(a, b) { return parseTime(a).getTime() > parseTime(b).getTime(); }

/** 两个时间点相差分钟数（b - a） */
function diffMinutes(a, b = now()) {
  return (parseTime(b).getTime() - parseTime(a).getTime()) / 60000;
}

/** 业务日（YYYY-MM-DD，UTC） */
function today(offsetDays = 0) {
  return now(offsetDays * 86400000).slice(0, 10);
}

module.exports = { toCents, toYuan, fmtYuan, now, parseTime, addMinutes, addDays, isBefore, isAfter, diffMinutes, today, pad };
