'use strict';

/**
 * 统一业务异常。
 * 设计要点（NFR-MAINT-001 统一异常处理）：
 *  - 业务失败一律抛 AppError，由 HTTP 层统一转换为 { code: 0, msg, data: null }
 *  - httpStatus 用于表达语义（400 参数错误 / 401 未认证 / 403 无权限 / 404 不存在 / 409 冲突 / 429 限流）
 */
class AppError extends Error {
  constructor(msg, { httpStatus = 400, bizCode, details } = {}) {
    super(msg);
    this.name = 'AppError';
    this.httpStatus = httpStatus;
    this.bizCode = bizCode;
    this.details = details;
  }
}

const Errors = {
  badRequest: (msg = '参数错误', details) => new AppError(msg, { httpStatus: 400, details }),
  unauthorized: (msg = '未登录或登录已失效，请重新登录') => new AppError(msg, { httpStatus: 401, bizCode: 40100 }),
  forbidden: (msg = '无权访问该资源') => new AppError(msg, { httpStatus: 403, bizCode: 40300 }),
  notFound: (msg = '资源不存在') => new AppError(msg, { httpStatus: 404, bizCode: 40400 }),
  conflict: (msg = '操作冲突') => new AppError(msg, { httpStatus: 409, bizCode: 40900 }),
  tooMany: (msg = '操作过于频繁，请稍后再试') => new AppError(msg, { httpStatus: 429, bizCode: 42900 }),
  internal: (msg = '服务器内部错误') => new AppError(msg, { httpStatus: 500, bizCode: 50000 }),
};

module.exports = { AppError, Errors };
