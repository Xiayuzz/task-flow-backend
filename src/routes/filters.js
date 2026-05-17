import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../utils/auth.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

export function filterRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // 8.1 获取保存的视图列表
  router.get('/', async (req, res) => {
    try {
      const userId = BigInt(req.user.id);
      
      const filters = await prisma.saved_filter.findMany({
        where: {
          OR: [
            { user_id: userId },
            { is_public: true }
          ]
        },
        orderBy: { created_at: 'desc' }
      });

      const items = filters.map(f => ({
        id: f.id,
        name: f.name,
        config: f.config,
        isPublic: f.is_public,
        userId: f.user_id
      }));

      res.json({
        success: true,
        items
      });
    } catch (error) {
      console.error('获取筛选视图失败:', error);
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  });

  // 8.2 创建保存视图
  const createFilterSchema = z.object({
    name: z.string().min(1).max(100),
    config: z.record(z.any()),
    isPublic: z.boolean().optional().default(false)
  });

  router.post('/', validate(createFilterSchema), async (req, res) => {
    try {
      const { name, config, isPublic } = req.body;
      const userId = BigInt(req.user.id);
      
      // Check limit (optional, per spec error code FILTER_LIMIT_EXCEEDED)
      const count = await prisma.saved_filter.count({ where: { user_id: userId } });
      if (count >= 20) {
        return res.status(400).json({ 
          success: false, 
          code: 'FILTER_LIMIT_EXCEEDED', 
          message: '保存的筛选视图数量已达上限' 
        });
      }

      const filter = await prisma.saved_filter.create({
        data: {
          user_id: userId,
          name,
          config,
          is_public: isPublic
        }
      });

      res.status(201).json({
        success: true,
        data: {
          id: filter.id,
          name: filter.name,
          config: filter.config,
          isPublic: filter.is_public
        }
      });
    } catch (error) {
      console.error('创建筛选视图失败:', error);
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  });

  // 8.3 删除保存视图
  router.delete('/:id', async (req, res) => {
    try {
      const id = BigInt(req.params.id);
      const userId = BigInt(req.user.id);
      
      const filter = await prisma.saved_filter.findUnique({ where: { id } });
      
      if (!filter) {
        return res.status(404).json({ success: false, message: '视图不存在' });
      }

      if (filter.user_id !== userId && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: '无权限删除此视图' });
      }

      await prisma.saved_filter.delete({ where: { id } });

      res.json({ success: true, message: '视图已删除' });
    } catch (error) {
      console.error('删除筛选视图失败:', error);
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  });

  return router;
}
