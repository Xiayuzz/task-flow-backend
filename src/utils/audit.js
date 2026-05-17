import { prisma } from '../db.js';

/**
 * 记录审计日志
 * @param {string|number|BigInt} userId 用户ID
 * @param {string} action 操作类型
 * @param {string} targetType 目标类型
 * @param {string|number|BigInt} targetId 目标ID
 * @param {string} details 详细信息
 * @param {string} ip IP地址
 */
export async function logAudit(userId, action, targetType, targetId, details, ip) {
  try {
    await prisma.activity_log.create({
      data: {
        user_id: BigInt(userId),
        action,
        target_type: targetType,
        target_id: BigInt(targetId),
        details,
        ip_address: ip
      }
    });
  } catch (error) {
    console.error('Failed to log audit:', error);
  }
}
