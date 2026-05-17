import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { AppError } from '../utils/error.js';
import { signToken, authMiddleware } from '../utils/auth.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { createCaptcha, verifyCaptcha, cleanupCaptchas } from '../services/captchaService.js';

export function authRoutes() {
  const router = express.Router();

  const registerSchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(6),
    role: z.union([z.literal('admin'), z.literal('user')]).optional(),
    captchaId: z.string().min(1),
    captchaCode: z.string().min(1)
  });

  router.get('/captcha', async (req, res) => {
    cleanupCaptchas().catch(() => {});
    const result = await createCaptcha();
    res.json(result);
  });

  router.post('/register', validate(registerSchema), async (req, res) => {
    const { name, email, password, role, captchaId, captchaCode } = req.body;
    await verifyCaptcha(captchaId, captchaCode);
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) throw new AppError(400, 'BAD_REQUEST', '邮箱已存在');
    const hash = await bcrypt.hash(password, Number(process.env.BCRYPT_SALT_ROUNDS) || 10);
    const now = new Date();
    const user = await prisma.user.create({ data: { name, email, password_hash: hash, role: role === 'admin' ? 'admin' : 'user', created_at: now, updated_at: now }, select: { id: true, name: true, email: true, role: true, avatar: true, created_at: true, updated_at: true } });
    res.status(201).json(user);
  });

  const loginSchema = z
    .object({
      email: z.string().email().optional(),
      username: z.string().email().optional(),
      password: z.string().min(1),
      captchaId: z.string().min(1),
      captchaCode: z.string().min(1)
    })
    .superRefine((data, ctx) => {
      if (!data.email && !data.username) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '邮箱或用户名不能为空',
          path: ['email']
        });
      }
    });

  router.post('/login', validate(loginSchema), async (req, res) => {
    const { email, username, password, captchaId, captchaCode } = req.body;
    await verifyCaptcha(captchaId, captchaCode);
    const loginEmail = email ?? username;
    const user = await prisma.user.findUnique({ where: { email: loginEmail } });
    if (!user) throw new AppError(401, 'UNAUTHORIZED', '邮箱或密码错误');
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw new AppError(401, 'UNAUTHORIZED', '邮箱或密码错误');
    const token = signToken({ id: Number(user.id), role: user.role, name: user.name });
    const safe = { id: Number(user.id), name: user.name, email: user.email, role: user.role, avatar: user.avatar, created_at: user.created_at, updated_at: user.updated_at };
    res.json({ token, user: safe });
  });

  const forgotSchema = z.object({ email: z.string().email() });
  router.post('/forgot-password', validate(forgotSchema), async (req, res) => {
    const email = req.body.email.trim();
    const message = { message: '如果邮箱存在，我们已发送重置邮件' };
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.json(message);

    const expiresMinutes = Number(process.env.PASSWORD_RESET_EXPIRES_MINUTES) || 30;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000);

    await prisma.$transaction([
      prisma.passwordresettoken.updateMany({
        where: { user_id: user.id, used: false },
        data: { used: true }
      }),
      prisma.passwordresettoken.create({ data: { token, user_id: user.id, expires_at: expiresAt } })
    ]);

    if (process.env.NODE_ENV !== 'production') {
      console.info(`[password-reset] generated token for ${email}: ${token}`);
    }

    res.json(message);
  });

  const resetSchema = z.object({ token: z.string().min(1), password: z.string().min(6) });
  router.post('/reset-password', validate(resetSchema), async (req, res) => {
    const token = req.body.token.trim();
    const { password } = req.body;
    const record = await prisma.passwordresettoken.findUnique({ where: { token } });
    if (!record) throw new AppError(404, 'NOT_FOUND', '重置链接无效');

    const now = new Date();
    if (record.used || record.expires_at <= now) {
      await prisma.passwordresettoken.update({ where: { id: record.id }, data: { used: true } }).catch(() => {});
      throw new AppError(410, 'GONE', '重置链接已失效');
    }

    const hash = await bcrypt.hash(password, Number(process.env.BCRYPT_SALT_ROUNDS) || 10);

    await prisma.$transaction([
      prisma.user.update({ where: { id: record.user_id }, data: { password_hash: hash } }),
      prisma.passwordresettoken.update({ where: { id: record.id }, data: { used: true } }),
      prisma.passwordresettoken.updateMany({
        where: {
          user_id: record.user_id,
          used: false,
          expires_at: { gt: now },
          NOT: { id: record.id }
        },
        data: { used: true }
      })
    ]);

    res.json({ message: '密码已成功重置，请重新登录' });
  });

  router.get('/profile', authMiddleware(), async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: BigInt(req.user.id) }, select: { id: true, name: true, email: true, role: true, avatar: true, created_at: true, updated_at: true } });
    res.json(user);
  });

  return router;
}
