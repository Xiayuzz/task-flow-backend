import jwt from 'jsonwebtoken';
import { AppError } from './error.js';

export function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || '7d' });
}

export function authMiddleware(required = true) {
  return (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth) {
      if (required) return next(new AppError(401, 'UNAUTHORIZED', '未认证'));
      return next();
    }
    const [, token] = auth.split(' ');
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      next();
    } catch (e) {
      next(new AppError(401, 'UNAUTHORIZED', 'Token 无效或过期'));
    }
  };
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return next(new AppError(403, 'FORBIDDEN', '需要管理员权限'));
  }
  next();
}

export function canModifyUser(req, res, next) {
  if (req.user.role === 'admin' || req.user.id === Number(req.params.id)) return next();
  return next(new AppError(403, 'FORBIDDEN', '无权限'));
}
