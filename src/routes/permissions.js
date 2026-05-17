import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../utils/auth.js';
import { AppError } from '../utils/error.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

export function permissionRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // 获取角色列表
  router.get('/roles', async (req, res) => {
    const roles = await prisma.role.findMany();
    
    res.json({
      success: true,
      data: roles
    });
  });

  // 获取用户权限
  router.get('/users/:id/permissions', async (req, res) => {
    const userId = BigInt(req.params.id);
    
    // 检查用户是否存在
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', '用户不存在');
    }
    
    const userPermissions = await prisma.userpermission.findMany({
      where: { user_id: userId }
    });
    
    const permissions = userPermissions.map(up => up.permission);
    
    res.json({
      success: true,
      data: {
        userId: Number(userId),
        permissions
      }
    });
  });

  // 更新用户权限
  const updateUserPermissionSchema = z.object({
    permissions: z.array(z.string())
  });

  router.put('/users/:id/permissions', validate(updateUserPermissionSchema), async (req, res) => {
    const userId = BigInt(req.params.id);
    const { permissions } = req.body;
    
    // 检查用户是否存在
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', '用户不存在');
    }
    
    // 删除现有的权限
    await prisma.userpermission.deleteMany({
      where: { user_id: userId }
    });
    
    // 创建新的权限
    if (permissions && permissions.length > 0) {
      await prisma.userpermission.createMany({
        data: permissions.map(permission => ({
          user_id: userId,
          permission,
          updated_at: new Date()
        }))
      });
    }
    
    res.json({
      success: true,
      data: {
        userId: Number(userId),
        permissions
      }
    });
  });

  return router;
}