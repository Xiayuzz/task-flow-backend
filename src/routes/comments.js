import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../utils/auth.js';
import { AppError } from '../utils/error.js';
// ...existing code...

export function commentRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  router.delete('/:id', async (req, res) => {
    const id = BigInt(req.params.id);
    const comment = await prisma.comment.findFirst({ where: { id, deleted_at: null } });
    if (!comment) throw new AppError(404, 'NOT_FOUND', '评论不存在');
    if (!(req.user.role === 'admin' || req.user.id === Number(comment.user_id))) throw new AppError(403, 'FORBIDDEN', '无权限');
    await prisma.comment.update({ where: { id }, data: { deleted_at: new Date() } });
    const io = req.app.get('io');
    io.emit('comment:deleted', { id: Number(id) });
    res.status(204).end();
  });

  return router;
}
