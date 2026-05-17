import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../utils/auth.js';

export function teamRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // 2.1 获取团队成员列表
  // 假设团队成员指的是系统中的所有活跃用户，或者是与当前用户在同一个群组的用户
  // 这里简化为获取所有非敏感信息的用户列表 (类似通讯录)
  router.get('/members', async (req, res) => {
    try {
      const users = await prisma.user.findMany({
        where: {
          status: 'active'
        },
        select: {
          id: true,
          name: true,
          email: true,
          avatar: true,
          role: true,
          status: true,
          created_at: true // 使用 created_at 或 updated_at 作为 lastActiveAt 的近似值，或者如果以后有 last_active_at 字段
        }
      });

      const items = users.map(user => ({
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
        status: user.status,
        lastActiveAt: user.updated_at || user.created_at
      }));

      res.json({
        success: true,
        items
      });
    } catch (error) {
      console.error('获取团队成员失败:', error);
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  });

  return router;
}
