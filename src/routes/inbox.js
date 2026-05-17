import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware, requireAdmin } from '../utils/auth.js';
import { createNotification, toNotificationResponse } from '../services/notificationService.js';

export function inboxRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // 获取通知列表
  router.get('/notifications', async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 20;
      const type = req.query.type;
      const status = req.query.status;
      const userId = BigInt(req.user.id);

      // 构建查询条件
      const where = { user_id: userId };

      if (type) {
        where.type = type;
      }

      if (status === 'read') {
        where.is_read = true;
      } else if (status === 'unread') {
        where.is_read = false;
      } else if (status && status !== 'all') {
        return res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          message: 'status 只能是 read、unread 或 all'
        });
      }

      const notifications = await prisma.notification.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: {
          created_at: 'desc'
        }
      });

      const total = await prisma.notification.count({ where });

      const items = notifications.map(toNotificationResponse);

      res.json({
        success: true,
        code: 200,
        message: 'success',
        data: {
          items,
          total,
          page,
          pageSize,
          totalPages: Math.ceil(Number(total) / pageSize)
        }
      });
    } catch (error) {
      console.error('获取通知列表失败:', error);
      res.status(500).json({
        success: false,
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务器内部错误'
      });
    }
  });

  // 标记通知为已读
  router.put('/notifications/:id/read', async (req, res) => {
    try {
      const { id } = req.params;
      const userId = BigInt(req.user.id);

      // 检查通知是否存在
      const notification = await prisma.notification.findUnique({
        where: { id: BigInt(id) }
      });

      if (!notification) {
        return res.status(404).json({
          success: false,
          code: 'NOTIFICATION_NOT_FOUND',
          message: '通知不存在'
        });
      }

      // 检查通知是否属于当前用户
      if (notification.user_id !== userId) {
        return res.status(403).json({
          success: false,
          code: 'FORBIDDEN',
          message: '无权操作此通知'
        });
      }

      // 标记为已读
      await prisma.notification.update({
        where: { id: BigInt(id) },
        data: { is_read: true }
      });

      res.json({
        success: true,
        code: 200,
        message: '已标记为已读'
      });
    } catch (error) {
      console.error('标记通知为已读失败:', error);
      res.status(500).json({
        success: false,
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务器内部错误'
      });
    }
  });

  // 标记所有通知为已读
  router.put('/notifications/read-all', async (req, res) => {
    try {
      const userId = BigInt(req.user.id);

      // 标记所有未读通知为已读
      const result = await prisma.notification.updateMany({
        where: {
          user_id: userId,
          is_read: false
        },
        data: { is_read: true }
      });

      res.json({
        success: true,
        code: 200,
        message: '全部标记成功',
        data: {
          count: result.count
        }
      });
    } catch (error) {
      console.error('标记所有通知为已读失败:', error);
      res.status(500).json({
        success: false,
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务器内部错误'
      });
    }
  });

  // 删除通知
  router.delete('/notifications/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const userId = BigInt(req.user.id);

      // 检查通知是否存在
      const notification = await prisma.notification.findUnique({
        where: { id: BigInt(id) }
      });

      if (!notification) {
        return res.status(404).json({
          success: false,
          code: 'NOTIFICATION_NOT_FOUND',
          message: '通知不存在'
        });
      }

      // 检查通知是否属于当前用户
      if (notification.user_id !== userId) {
        return res.status(403).json({
          success: false,
          code: 'FORBIDDEN',
          message: '无权操作此通知'
        });
      }

      // 删除通知
      await prisma.notification.delete({
        where: { id: BigInt(id) }
      });

      // 获取剩余通知总数
      const remainingTotal = await prisma.notification.count({
        where: { user_id: userId }
      });

      res.json({
        success: true,
        code: 200,
        message: '删除成功',
        data: {
          remainingTotal
        }
      });
    } catch (error) {
      console.error('删除通知失败:', error);
      res.status(500).json({
        success: false,
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务器内部错误'
      });
    }
  });

  // 获取未读通知数量
  router.get('/notifications/unread-count', async (req, res) => {
    try {
      const userId = BigInt(req.user.id);

      const count = await prisma.notification.count({
        where: {
          user_id: userId,
          is_read: false
        }
      });
      
      res.json({
        success: true,
        code: 200,
        message: 'success',
        data: {
          count
        }
      });
    } catch (error) {
      console.error('获取未读通知数量失败:', error);
      res.status(500).json({
        success: false,
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务器内部错误'
      });
    }
  });

  // 发送通知（内部 API）
  router.post('/notifications', requireAdmin, async (req, res) => {
    try {
      const { userId, type, title, content, relatedId, relatedType } = req.body;

      // 验证必要参数
      if (!userId || !type || !title || !content) {
        return res.status(400).json({
          success: false,
          code: 'VALIDATION_ERROR',
          message: '缺少必要的通知参数'
        });
      }

      const uId = BigInt(userId);
      const rId = relatedId ? BigInt(relatedId) : null;

      // 检查用户是否存在
      const user = await prisma.user.findUnique({
        where: { id: uId }
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          code: 'NOT_FOUND',
          message: '接收通知的用户不存在'
        });
      }

      const notification = await createNotification({
        userId: uId,
        type,
        title,
        content,
        relatedId: rId,
        relatedType,
        io: req.app.get('io')
      });

      res.status(201).json({
        success: true,
        code: 201,
        message: '发送成功',
        data: {
          ...toNotificationResponse(notification)
        }
      });
    } catch (error) {
      console.error('发送通知失败:', error);
      res.status(500).json({
        success: false,
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务器内部错误'
      });
    }
  });

  return router;
}
