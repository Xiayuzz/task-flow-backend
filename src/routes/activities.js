import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../utils/auth.js';

export function activityRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // 7.1 获取全站/项目活动流
  router.get('/', async (req, res) => {
    try {
      const page = Number(req.query.page) || 1;
      const pageSize = Number(req.query.pageSize) || 20;
      const { userId, targetType, targetId } = req.query;

      const where = {};
      if (userId) where.user_id = BigInt(userId);
      if (targetType) where.target_type = targetType;
      if (targetId) where.target_id = BigInt(targetId);

      const [logs, total] = await Promise.all([
        prisma.activity_log.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: { created_at: 'desc' },
          include: {
            user: {
              select: { name: true }
            }
          }
        }),
        prisma.activity_log.count({ where })
      ]);

      const items = logs.map(log => ({
        id: log.id,
        userId: log.user_id,
        userName: log.user.name,
        action: log.action,
        targetType: log.target_type,
        targetId: log.target_id,
        details: log.details,
        createdAt: log.created_at
      }));

      res.json({
        success: true,
        items,
        total,
        page,
        pageSize
      });
    } catch (error) {
      console.error('获取活动日志失败:', error);
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  });

  return router;
}
