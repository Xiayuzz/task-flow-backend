import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware, requireAdmin, canModifyUser } from '../utils/auth.js';
import { AppError } from '../utils/error.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

export function userRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // ensure upload dir
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'avatars');
  fs.mkdirSync(uploadDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      const name = `user-${req.user.id}-${Date.now()}${ext}`;
      cb(null, name);
    }
  });
  const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

  // GET /users/me - compact current user
  router.get('/me', async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: BigInt(req.user.id) }, select: { id: true, name: true, email: true, role: true, avatar: true, created_at: true, updated_at: true } });
    res.json(user);
  });

  const updateProfileSchema = z.object({ name: z.string().optional(), bio: z.string().optional(), avatar: z.string().optional() });
  // PUT /users/me - update own profile (note: bio is accepted but not persisted unless DB is migrated)
  router.put('/me', validate(updateProfileSchema), async (req, res) => {
    const { name, avatar } = req.body;
    const id = BigInt(req.user.id);
    const data = {};
    if (name !== undefined) data.name = name;
    if (avatar !== undefined) data.avatar = avatar;
    const user = await prisma.user.update({ where: { id }, data, select: { id: true, name: true, email: true, role: true, avatar: true, created_at: true, updated_at: true } });
    res.json(user);
  });

  // POST /users/me/avatar - upload avatar
  router.post('/me/avatar', upload.single('avatar'), async (req, res) => {
    if (!req.file) throw new AppError(400, 'BAD_REQUEST', 'avatar required');
    const relPath = `/uploads/avatars/${req.file.filename}`;
    const id = BigInt(req.user.id);
    await prisma.user.update({ where: { id }, data: { avatar: relPath } });
    // build absolute URL for the client. Prefer an explicit BACKEND_URL env var in dev/proxy setups.
    const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
    const full = `${baseUrl}${relPath}`;
    res.json({ url: full });
  });

  // GET /api/users/search - Advanced user search
  router.get('/search', async (req, res) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const { keyword, role, status, sortField, sortOrder, excludeIds } = req.query;
    const departmentId = req.query.departmentId ? BigInt(req.query.departmentId) : undefined;

    const where = {};
    if (keyword) {
      where.OR = [
        { username: { contains: keyword } },
        { name: { contains: keyword } },
        { email: { contains: keyword } }
      ];
    }
    if (departmentId) where.department_id = departmentId;
    if (role) where.role = role;
    if (status) where.status = status;

    // 排除指定用户ID
    if (excludeIds) {
      const ids = excludeIds.split(',').map(id => BigInt(id.trim())).filter(id => id);
      if (ids.length > 0) {
        where.id = { notIn: ids };
      }
    }

    // Sorting
    const orderBy = {};
    const validSortFields = ['created_at', 'name', 'username'];
    const field = validSortFields.includes(sortField) ? sortField : 'created_at';
    const dir = sortOrder === 'asc' ? 'asc' : 'desc';
    orderBy[field] = dir;

    const select = {
      id: true,
      username: true,
      name: true,
      email: true,
      avatar: true,
      department: {
        select: { id: true, name: true }
      },
      role: true,
      status: true,
      updated_at: true
    };

    try {
      const [items, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy,
          select
        }),
        prisma.user.count({ where })
      ]);

      const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
      
      const mappedItems = items.map(u => ({
        id: u.id,
        username: u.username,
        name: u.name,
        email: u.email,
        avatar: u.avatar ? (u.avatar.startsWith('http') ? u.avatar : `${baseUrl}${u.avatar}`) : null,
        department: u.department,
        role: u.role,
        status: u.status,
        lastActiveAt: u.updated_at
      }));

      res.json({
        success: true,
        code: 200,
        message: 'success',
        data: {
          items: mappedItems,
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize)
        }
      });
    } catch (error) {
      // Handle potential errors like invalid BigInt for departmentId
      throw new AppError(500, 'INTERNAL_ERROR', error.message);
    }
  });

  // 获取用户列表 - 支持分页、搜索、状态和角色筛选
  router.get('/', requireAdmin, async (req, res) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Math.min(Number(req.query.pageSize) || 10, 100);
    const keyword = req.query.keyword?.trim();
    const status = req.query.status;
    const role = req.query.role;
    
    const where = {};
    if (keyword) {
      where.OR = [ 
        { username: { contains: keyword } }, 
        { name: { contains: keyword } }, 
        { email: { contains: keyword } } 
      ];
    }
    if (status) where.status = status;
    if (role) where.role = role;
    
    const [items, total] = await Promise.all([
      prisma.user.findMany({ 
        where, 
        skip: (page - 1) * pageSize, 
        take: pageSize, 
        select: { 
          id: true, 
          username: true,
          name: true, 
          email: true, 
          role: true, 
          status: true,
          created_at: true, 
          updated_at: true 
        } 
      }),
      prisma.user.count({ where })
    ]);
    
    res.json({
      success: true,
      items,
      total,
      page,
      pageSize
    });
  });

  // 获取单个用户
  router.get('/:id', async (req, res) => {
    const id = BigInt(req.params.id);
    const user = await prisma.user.findUnique({ 
      where: { id }, 
      select: { 
        id: true, 
        username: true,
        name: true, 
        email: true, 
        role: true, 
        status: true,
        created_at: true, 
        updated_at: true 
      } 
    });
    if (!user) throw new AppError(404, 'NOT_FOUND', '用户不存在');
    
    res.json({
      success: true,
      data: user
    });
  });

  // 创建用户
  const createUserSchema = z.object({
    username: z.string().min(3).max(50),
    email: z.string().email(),
    name: z.string().min(1).max(50),
    password: z.string().min(6),
    role: z.enum(['admin', 'user', 'guest']).default('user'),
    status: z.enum(['active', 'inactive']).default('active')
  });
  
  router.post('/', requireAdmin, validate(createUserSchema), async (req, res) => {
    const { username, email, name, password, role, status } = req.body;
    
    // 检查用户名和邮箱是否已存在
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { username },
          { email }
        ]
      }
    });
    
    if (existingUser) {
      if (existingUser.username === username) {
        throw new AppError(400, 'VALIDATION_ERROR', '用户名已存在');
      }
      throw new AppError(400, 'VALIDATION_ERROR', '邮箱已存在');
    }
    
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 10);
    const now = new Date();
    const user = await prisma.user.create({
      data: {
        username,
        email,
        name,
        password_hash: hash,
        role,
        status,
        created_at: now,
        updated_at: now
      },
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        role: true,
        status: true,
        created_at: true,
        updated_at: true
      }
    });
    
    res.json({
      success: true,
      data: user
    });
  });

  // 更新用户
  const updateUserSchema = z.object({
    username: z.string().min(3).max(50).optional(),
    name: z.string().min(1).max(50).optional(),
    email: z.string().email().optional(),
    role: z.enum(['admin', 'user', 'guest']).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    password: z.string().min(6).optional()
  });
  
  router.put('/:id', canModifyUser, validate(updateUserSchema), async (req, res) => {
    const id = BigInt(req.params.id);
    const { username, name, email, role, status, password } = req.body;
    
    if (role && req.user.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN', '不能修改角色');
    }

    // 检查用户名是否已存在
    if (username) {
      const existingUser = await prisma.user.findFirst({
        where: {
          username,
          id: { not: id }
        }
      });
      if (existingUser) {
        throw new AppError(400, 'VALIDATION_ERROR', '用户名已存在');
      }
    }
    
    const data = {};
    if (username !== undefined) data.username = username;
    if (name !== undefined) data.name = name;
    if (email !== undefined) data.email = email;
    if (role !== undefined) data.role = role;
    if (status !== undefined) data.status = status;
    if (password !== undefined) data.password_hash = await require('bcryptjs').hash(password, 10);
    
    const user = await prisma.user.update({ 
      where: { id }, 
      data, 
      select: { 
        id: true,
        username: true,
        email: true, 
        name: true, 
        role: true, 
        status: true,
        created_at: true, 
        updated_at: true 
      } 
    });
    
    res.json({
      success: true,
      data: user
    });
  });

  // 删除用户
  router.delete('/:id', requireAdmin, async (req, res) => {
    const id = BigInt(req.params.id);
    
    // 检查用户是否存在
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', '用户不存在');
    }
    
    // 不能删除自己
    if (BigInt(req.user.id) === id) {
      throw new AppError(400, 'VALIDATION_ERROR', '不能删除自己');
    }
    
    await prisma.user.delete({ where: { id } });
    
    res.json({
      success: true,
      message: '用户删除成功'
    });
  });

  // 用户通知设置接口
  
  // 获取用户通知设置
  router.get('/:id/notification-settings', canModifyUser, async (req, res) => {
    const id = BigInt(req.params.id);
    const user = await prisma.user.findUnique({ 
      where: { id }, 
      select: {
        notificationSettings: true,
        timezone: true
      }
    });
    if (!user) throw new AppError(404, 'NOT_FOUND', '用户不存在');
    
    // 默认通知设置
    const defaultSettings = {
      email: {
        task_assigned: true,
        task_updated: true,
        task_completed: true,
        comment_created: false,
        reminders: true
      },
      sms: {
        task_assigned: false,
        reminders: true
      },
      in_app: {
        all: true
      }
    };
    
    const settings = {
      ...defaultSettings,
      ...(user.notificationSettings || {}),
      timezone: user.timezone
    };
    
    res.json(settings);
  });

  // 更新用户通知设置
  router.patch('/:id/notification-settings', canModifyUser, async (req, res) => {
    const id = BigInt(req.params.id);
    const { email, sms, in_app, timezone } = req.body;
    
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new AppError(404, 'NOT_FOUND', '用户不存在');
    
    // 获取当前设置
    const currentSettings = user.notificationSettings || {};
    
    // 更新设置
    const updatedSettings = {
      ...currentSettings,
      email: { ...currentSettings.email, ...email },
      sms: { ...currentSettings.sms, ...sms },
      in_app: { ...currentSettings.in_app, ...in_app }
    };
    
    const data = {
      notificationSettings: updatedSettings
    };
    
    if (timezone) {
      data.timezone = timezone;
    }
    
    const updatedUser = await prisma.user.update({ 
      where: { id }, 
      data,
      select: {
        notificationSettings: true,
        timezone: true
      }
    });
    
    const finalSettings = {
      ...updatedUser.notificationSettings,
      timezone: updatedUser.timezone
    };
    
    const io = req.app.get('io');
    io.emit('user:notification-settings:updated', finalSettings);
    
    res.json(finalSettings);
  });

  // 获取用户任务负载
  router.get('/:id/load', async (req, res) => {
    const id = BigInt(req.params.id);
    const { period = 'week', type = 'assigned' } = req.query;
    
    // 检查用户是否存在
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new AppError(404, 'NOT_FOUND', '用户不存在');
    
    // 构建时间范围
    let startDate;
    const now = new Date();
    
    if (period === 'day') {
      startDate = new Date(now.setHours(0, 0, 0, 0));
    } else if (period === 'week') {
      startDate = new Date(now.setDate(now.getDate() - now.getDay()));
      startDate.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    
    // 任务查询条件
    const where = {
      deleted_at: null,
      created_at: { gte: startDate }
    };
    
    if (type === 'assigned') {
      where.assignee_id = id;
    } else if (type === 'created') {
      where.creator_id = id;
    }
    
    // 查询任务
    const tasks = await prisma.task.findMany({ where });
    
    // 统计数据
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(task => task.status === 'done').length;
    const inProgressTasks = tasks.filter(task => task.status === 'in_progress').length;
    
    // 按状态分组
    const byStatus = {
      pending: tasks.filter(task => task.status === 'pending').length,
      in_progress: inProgressTasks,
      done: completedTasks
    };
    
    // 按优先级分组
    const byPriority = {
      low: tasks.filter(task => task.priority === 'low').length,
      medium: tasks.filter(task => task.priority === 'medium').length,
      high: tasks.filter(task => task.priority === 'high').length
    };
    
    res.json({
      user_id: Number(id),
      period,
      total_tasks: totalTasks,
      completed_tasks: completedTasks,
      in_progress_tasks: inProgressTasks,
      by_status: byStatus,
      by_priority: byPriority
    });
  });

  return router;
}
