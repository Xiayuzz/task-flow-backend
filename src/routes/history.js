import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../utils/auth.js';
import { AppError } from '../utils/error.js';

function canAccessTask(user, task) {
  return user.role === 'admin' || user.id === Number(task.creator_id) || (task.assignee_id && user.id === Number(task.assignee_id));
}

export function historyRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  router.get('/:taskId/history', async (req, res) => {
    const taskId = BigInt(req.params.taskId);
    const task = await prisma.task.findFirst({ where: { id: taskId, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    // access check minimal (could reuse helper)
  if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
  const items = await prisma.taskhistory.findMany({ where: { task_id: taskId }, orderBy: { created_at: 'asc' } });
    res.json({ items });
  });

  return router;
}
