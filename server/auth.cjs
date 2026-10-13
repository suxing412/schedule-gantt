'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const PROJECT_ID = /^[a-f0-9]{32}$/;
const CODE_HASH = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function displayName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, 'INVALID_DISPLAY_NAME', '用户名必须是 1–64 个字符，且不能包含控制字符');
  }
  return value.trim();
}

function editCode(value) {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) {
    throw new HttpError(400, 'INVALID_EDIT_CODE', '编辑码必须是四位数字');
  }
  return value;
}

async function hashEditCode(code) {
  editCode(code);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(code, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

async function verifyEditCode(code, encoded) {
  editCode(code);
  const match = typeof encoded === 'string' && CODE_HASH.exec(encoded);
  if (!match) throw new Error('Stored edit-code hash is invalid');
  const expected = Buffer.from(match[2], 'hex');
  const actual = await scrypt(code, match[1], expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(expected, actual);
}

function createAuth({ secret, now = Date.now, ttlMs = 12 * 60 * 60 * 1000 } = {}) {
  const key = secret === undefined ? crypto.randomBytes(32) : Buffer.from(secret);
  if (key.length < 32) throw new Error('SESSION_SECRET must contain at least 32 bytes');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 7 * 24 * 60 * 60 * 1000) throw new Error('Invalid session duration');
  const sign = value => crypto.createHmac('sha256', key).update(value).digest('base64url');
  return {
    issue(projectId, name) {
      const issuedAt = now(), expiresAt = issuedAt + ttlMs;
      const payload = Buffer.from(JSON.stringify({ version: 1, projectId, displayName: displayName(name), issuedAt,
        expiresAt, nonce: crypto.randomBytes(16).toString('hex') })).toString('base64url');
      return { token: `${payload}.${sign(payload)}`, displayName: name, expiresAt: new Date(expiresAt).toISOString() };
    },
    verify(token, projectId) {
      if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
        throw new HttpError(401, 'UNAUTHORIZED', '请先输入用户名和编辑码');
      }
      const [payload, signature] = token.split('.');
      const expected = Buffer.from(sign(payload), 'base64url'), actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        throw new HttpError(401, 'UNAUTHORIZED', '编辑会话无效，请重新登录');
      }
      let claims;
      try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch {
        throw new HttpError(401, 'UNAUTHORIZED', '编辑会话无效，请重新登录');
      }
      if (!claims || claims.version !== 1 || !PROJECT_ID.test(claims.projectId) || claims.projectId !== projectId ||
          !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt) ||
          claims.expiresAt <= claims.issuedAt || !/^[a-f0-9]{32}$/.test(claims.nonce)) {
        throw new HttpError(401, 'UNAUTHORIZED', '编辑会话无效，请重新登录');
      }
      try { displayName(claims.displayName); } catch {
        throw new HttpError(401, 'UNAUTHORIZED', '编辑会话无效，请重新登录');
      }
      if (claims.expiresAt <= now()) throw new HttpError(401, 'SESSION_EXPIRED', '编辑会话已过期，请重新登录');
      return { displayName: claims.displayName };
    }
  };
}

// Attempts are reserved synchronously before scrypt so parallel failures cannot bypass the limit.
function createRateLimiter({ limit, windowMs, now = Date.now, maxKeys = 10000 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error('Invalid rate limit');
  }
  const entries = new Map();
  return {
    consume(key) {
      const time = now();
      let entry = entries.get(key);
      if (!entry || entry.until <= time) {
        if (entries.size >= maxKeys) {
          for (const [oldKey, old] of entries) if (old.until <= time) entries.delete(oldKey);
          if (entries.size >= maxKeys && !entries.has(key)) {
            throw new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
          }
        }
        entry = { count: 0, until: time + windowMs };
        entries.set(key, entry);
      }
      if (entry.count >= limit) {
        const error = new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
        error.retryAfter = Math.max(1, Math.ceil((entry.until - time) / 1000));
        throw error;
      }
      entry.count++;
    },
    clear(key) { entries.delete(key); }
  };
}

module.exports = { HttpError, displayName, editCode, hashEditCode, verifyEditCode, createAuth, createRateLimiter };
