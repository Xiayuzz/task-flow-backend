import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../utils/auth.js';
import { AppError } from '../utils/error.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

export function menuRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // 获取菜单列表
  router.get('/', async (req, res) => {
    const { parentId, status, type } = req.query;
    const where = {};
    
    if (parentId) where.parent_id = BigInt(parentId);
    if (status) where.status = status;
    if (type) where.type = type;
    
    // 1. 获取基础菜单列表
    const menus = await prisma.menu.findMany({
      where,
      orderBy: { order: 'asc' }
    });
    
    // 2. 获取当前用户权限
    let userPermissions = new Set();
    
    // 2.1 获取角色权限
    const role = await prisma.role.findUnique({ where: { name: req.user.role } });
    if (role && role.permissions) {
      // Prisma JSON 类型已经是解析好的对象/数组
      const perms = Array.isArray(role.permissions) ? role.permissions : [];
      perms.forEach(p => userPermissions.add(p));
    }
    
    // 2.2 获取用户特定权限
    const specificPermissions = await prisma.userpermission.findMany({
      where: { user_id: BigInt(req.user.id) }
    });
    specificPermissions.forEach(p => userPermissions.add(p.permission));
    
    // 3. 过滤菜单
    const allowedMenus = menus.filter(menu => {
      // 如果菜单没有定义权限，或者用户是 admin，则默认允许
      if (!menu.permission || req.user.role === 'admin') return true;
      return userPermissions.has(menu.permission);
    });
    
    // 4. 递归构建菜单树
    const buildMenuTree = (items, parentId = null) => {
      return items
        .filter(item => item.parent_id === parentId)
        .map(item => {
          const { parent_id, ...rest } = item;
          return {
            ...rest,
            parentId: parent_id,
            children: buildMenuTree(items, item.id)
          };
        });
    };
    
    const menuTree = buildMenuTree(allowedMenus);
    
    res.json({
      success: true,
      data: menuTree
    });
  });

  // 创建菜单
  const createMenuSchema = z.object({
    name: z.string().min(1),
    title: z.string().min(1),
    type: z.enum(['menu', 'button']),
    path: z.string().optional(),
    icon: z.string().optional(),
    parentId: z.string().optional(),
    order: z.number().optional().default(0),
    status: z.enum(['active', 'inactive']).optional().default('active')
  });

  router.post('/', validate(createMenuSchema), async (req, res) => {
    const { name, title, type, path, icon, parentId, order, status } = req.body;

    const menu = await prisma.menu.create({
      data: {
        name,
        title,
        type,
        path,
        icon,
        parent_id: parentId ? BigInt(parentId) : null,
        order,
        status,
        updated_at: new Date()
      }
    });

    res.json({
      success: true,
      data: menu
    });
  });

  // 更新菜单
  const updateMenuSchema = z.object({
    name: z.string().optional(),
    title: z.string().optional(),
    type: z.enum(['menu', 'button']).optional(),
    path: z.string().optional(),
    icon: z.string().optional(),
    parentId: z.string().optional(),
    order: z.number().optional(),
    status: z.enum(['active', 'inactive']).optional()
  });

  router.put('/:id', validate(updateMenuSchema), async (req, res) => {
    const id = BigInt(req.params.id);
    const { name, title, type, path, icon, parentId, order, status } = req.body;

    const menu = await prisma.menu.update({
      where: { id },
      data: {
        name,
        title,
        type,
        path,
        icon,
        parent_id: parentId ? BigInt(parentId) : null,
        order,
        status,
        updated_at: new Date()
      }
    });

    res.json({
      success: true,
      data: menu
    });
  });

  // 删除菜单
  router.delete('/:id', async (req, res) => {
    const id = BigInt(req.params.id);
    
    // 检查是否有子菜单
    const hasChildren = await prisma.menu.count({ where: { parent_id: id } });
    if (hasChildren > 0) {
      throw new AppError(400, 'VALIDATION_ERROR', '该菜单存在子菜单，无法删除');
    }
    
    await prisma.menu.delete({ where: { id } });
    
    res.json({
      success: true,
      message: '菜单删除成功'
    });
  });

  return router;
}