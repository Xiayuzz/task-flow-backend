import svgCaptcha from 'svg-captcha';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { AppError } from '../utils/error.js';

const CAPTCHA_EXPIRES_MINUTES = Number(process.env.CAPTCHA_EXPIRES_MINUTES) || 5;

export async function createCaptcha() {
  const instance = svgCaptcha.create({
    size: 4,
    noise: 2,
    color: true,
    background: '#f0f0f0',
    width: 120,
    height: 40,
    fontSize: 40,
    charPreset: '0123456789'
  });

  const captchaId = crypto.randomBytes(16).toString('hex');
  const code = instance.text;
  const expiresAt = new Date(Date.now() + CAPTCHA_EXPIRES_MINUTES * 60 * 1000);

  await prisma.captcha.create({
    data: { captcha_id: captchaId, code, expires_at: expiresAt }
  });

  const image = `data:image/svg+xml;base64,${Buffer.from(instance.data).toString('base64')}`;
  return { captchaId, image };
}

export async function verifyCaptcha(captchaId, captchaCode) {
  if (!captchaId || !captchaCode) {
    throw new AppError(422, 'UNPROCESSABLE', '验证码不能为空');
  }

  const record = await prisma.captcha.findUnique({
    where: { captcha_id: captchaId }
  });

  if (!record) {
    throw new AppError(400, 'INVALID_CAPTCHA', '验证码无效');
  }

  const now = new Date();
  if (record.used || record.expires_at <= now) {
    await prisma.captcha.update({
      where: { id: record.id }, data: { used: true }
    }).catch(() => {});
    throw new AppError(400, 'CAPTCHA_EXPIRED', '验证码已过期，请重新获取');
  }

  if (record.code.toLowerCase() !== captchaCode.toLowerCase()) {
    throw new AppError(400, 'INVALID_CAPTCHA', '验证码错误');
  }

  await prisma.captcha.update({
    where: { id: record.id }, data: { used: true }
  });
}

export async function cleanupCaptchas() {
  const now = new Date();
  const { count } = await prisma.captcha.deleteMany({
    where: {
      OR: [{ used: true }, { expires_at: { lte: now } }]
    }
  });
  if (count > 0) console.log(`[captcha] cleaned up ${count} records`);
}
