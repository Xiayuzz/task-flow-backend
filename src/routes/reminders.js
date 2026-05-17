import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../utils/auth.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

export function reminderRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // 3.1 获取提醒列表
  router.get('/', async (req, res) => {
    try {
      const userId = BigInt(req.user.id);
      
      const reminders = await prisma.taskreminder.findMany({
        where: { user_id: userId },
        orderBy: { reminder_time: 'asc' },
        include: {
          task: {
            select: {
              title: true
            }
          }
        }
      });

      const items = reminders.map(r => ({
        id: r.id,
        taskId: r.task_id,
        taskTitle: r.task.title,
        remindAt: r.reminder_time,
        isSent: r.status === 'sent',
        createdAt: r.created_at
      }));

      res.json({
        success: true,
        items
      });
    } catch (error) {
      console.error('获取提醒列表失败:', error);
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  });

  // 3.2 创建提醒
  const createReminderSchema = z.object({
    taskId: z.number().or(z.string()),
    remindAt: z.string().datetime()
  });

  router.post('/', validate(createReminderSchema), async (req, res) => {
    try {
      const userId = BigInt(req.user.id);
      const { taskId, remindAt } = req.body;
      const tId = BigInt(taskId);

      // 验证提醒时间必须在未来
      const reminderTime = new Date(remindAt);
      if (reminderTime <= new Date()) {
        return res.status(400).json({ success: false, message: '提醒时间必须在未来' });
      }

      // 检查任务是否存在
      const task = await prisma.task.findUnique({ where: { id: tId } });
      if (!task) {
        return res.status(404).json({ success: false, message: '任务不存在' });
      }

      // 验证用户是否有权限访问该任务
      const canAccess = req.user.role === 'admin' ||
                        req.user.id === Number(task.creator_id) ||
                        (task.assignee_id && req.user.id === Number(task.assignee_id));
      if (!canAccess) {
        return res.status(403).json({ success: false, message: '无权限为此任务创建提醒' });
      }

      const reminder = await prisma.taskreminder.create({
        data: {
          user_id: userId,
          task_id: tId,
          reminder_time: reminderTime,
          reminder_type: 'in_app', // 默认类型
          status: 'pending'
        }
      });

      res.status(201).json({
        success: true,
        data: {
          id: reminder.id,
          taskId: Number(reminder.task_id),
          remindAt: reminder.reminder_time,
          isSent: false,
          createdAt: reminder.created_at
        }
      });
    } catch (error) {
      console.error('创建提醒失败:', error);
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  });

  // 3.3 删除提醒
  router.delete('/:id', async (req, res) => {
    try {
      const id = BigInt(req.params.id);
      const userId = BigInt(req.user.id);

      const reminder = await prisma.taskreminder.findUnique({ where: { id } });
      
      if (!reminder) {
        return res.status(404).json({ success: false, message: '提醒不存在' });
      }

      if (reminder.user_id !== userId) {
        return res.status(403).json({ success: false, message: '无权限删除此提醒' });
      }

      await prisma.taskreminder.delete({ where: { id } });

      res.json({ success: true, message: '提醒已删除' });
    } catch (error) {
      console.error('删除提醒失败:', error);
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  });

  return router;
}
