import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../utils/auth.js';
import { AppError } from '../utils/error.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { logAudit } from '../utils/audit.js';
import {
  notifyTaskAssigned,
  notifyTaskCommented,
  notifyTaskCompleted
} from '../services/notificationService.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

function canAccessTask(user, task) {
  return user.role === 'admin' || user.id === Number(task.creator_id) || (task.assignee_id && user.id === Number(task.assignee_id));
}

const commentUserSelect = {
  id: true,
  name: true,
  username: true,
  avatar: true
};

const toCommentResponse = (comment) => ({
  id: Number(comment.id),
  taskId: Number(comment.task_id),
  userId: Number(comment.user_id),
  content: comment.content,
  parentId: comment.parent_id ? Number(comment.parent_id) : null,
  createdAt: comment.created_at,
  updatedAt: comment.updated_at,
  user: comment.user ? {
    id: Number(comment.user.id),
    name: comment.user.name,
    username: comment.user.username,
    avatar: comment.user.avatar
  } : undefined
});

const notifyTaskStatusChanged = async ({ task, oldStatus, newStatus, actorId, io }) => {
  if (oldStatus !== 'done' && newStatus === 'done') {
    await notifyTaskCompleted({ task, actorId, io });
  }
};

export function taskRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // 配置文件上传
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'task-attachments');
  fs.mkdirSync(uploadDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.bin';
      const name = `task-${req.params.taskId}-${Date.now()}${ext}`;
      cb(null, name);
    }
  });
  const upload = multer({ 
    storage, 
    limits: { 
      fileSize: 100 * 1024 * 1024 // 100MB 最大文件大小
    }
  });

  const createSchema = z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    assigneeId: z.string().optional(),
    groupId: z.string().optional(),
    priority: z.enum(['low','medium','high']).optional(),
    dueDate: z.string().optional(),
    tags: z.array(z.string()).optional(),
    estimatedHours: z.number().int().nonnegative().optional(),
    actualHours: z.number().int().nonnegative().optional(),
    isReminderOn: z.boolean().optional(),
    reminderTime: z.string().optional()
  });

  router.post('/', validate(createSchema), async (req, res) => {
    const { title, description, assigneeId, groupId, priority, dueDate, tags, estimatedHours, actualHours, isReminderOn, reminderTime } = req.body;
    const data = {
      title,
      description,
      creator_id: BigInt(req.user.id),
      assignee_id: assigneeId ? BigInt(assigneeId) : undefined,
      group_id: groupId ? BigInt(groupId) : undefined,
      priority,
      due_date: dueDate ? new Date(dueDate) : undefined,
      tags,
      estimated_hours: estimatedHours,
      actual_hours: actualHours,
      is_reminder_on: isReminderOn,
      reminder_time: reminderTime ? new Date(reminderTime) : undefined,
      updated_at: new Date()
    };
    const task = await prisma.task.create({  
      data,
      include: {
        user_task_assignee_idTouser: {
          select: { id: true, name: true, username: true, avatar: true }
        },
        user_task_creator_idTouser: {
          select: { id: true, name: true, username: true, avatar: true }
        },
        group: {
          select: { id: true, name: true }
        }
      }
    });
    await prisma.taskhistory.create({ data: { task_id: task.id, user_id: BigInt(req.user.id), field: 'create', old_value: null, new_value: JSON.stringify({ title: task.title }) } });
    const io = req.app.get('io');
    
    const { user_task_assignee_idTouser, user_task_creator_idTouser, group, ...rest } = task;
    const formattedTask = {
      ...rest,
      assignee: user_task_assignee_idTouser ? {
        id: Number(user_task_assignee_idTouser.id),
        name: user_task_assignee_idTouser.name,
        username: user_task_assignee_idTouser.username,
        avatar: user_task_assignee_idTouser.avatar
      } : undefined,
      creator: user_task_creator_idTouser ? {
        id: Number(user_task_creator_idTouser.id),
        name: user_task_creator_idTouser.name,
        username: user_task_creator_idTouser.username,
        avatar: user_task_creator_idTouser.avatar
      } : undefined,
      group: group ? {
        id: Number(group.id),
        name: group.name
      } : undefined
    };

    io.emit('task:new', formattedTask);
    if (task.assignee_id) {
      await notifyTaskAssigned({
        task,
        assigneeId: task.assignee_id,
        actorId: req.user.id,
        io
      });
    }
    res.status(201).json(formattedTask);
  });

  // 通用任务查询和搜索处理函数
  const handleTaskQuery = async (req, res) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const { 
      status, priority, assigneeId, creatorId, groupId, keyword, 
      dueDateFrom, dueDateTo, createdFrom, createdTo, updatedFrom, updatedTo,
      tags, minProgress, maxProgress, hasReminder, sort, order 
    } = req.query;
    const where = { deleted_at: null };
    
    // 基本过滤
    if (status) {
      where.status = Array.isArray(status) ? { in: status } : status;
    }
    if (priority) {
      where.priority = Array.isArray(priority) ? { in: priority } : priority;
    }
    if (assigneeId) {
      const assigneeIds = Array.isArray(assigneeId) ? assigneeId.map(id => BigInt(id)) : [BigInt(assigneeId)];
      where.assignee_id = { in: assigneeIds };
    }
    if (creatorId) where.creator_id = BigInt(creatorId);
    if (groupId) {
      const groupIds = Array.isArray(groupId) ? groupId.map(id => BigInt(id)) : [BigInt(groupId)];
      where.group_id = { in: groupIds };
    }
    
    // 关键词搜索
    if (keyword) {
      where.OR = [
        { title: { contains: keyword } },
        { description: { contains: keyword } }
      ];
    }
    
    // 日期范围过滤
    if (dueDateFrom || dueDateTo) {
      where.due_date = {};
      if (dueDateFrom) where.due_date.gte = new Date(dueDateFrom);
      if (dueDateTo) where.due_date.lte = new Date(dueDateTo);
    }
    if (createdFrom || createdTo) {
      where.created_at = {};
      if (createdFrom) where.created_at.gte = new Date(createdFrom);
      if (createdTo) where.created_at.lte = new Date(createdTo);
    }
    if (updatedFrom || updatedTo) {
      where.updated_at = {};
      if (updatedFrom) where.updated_at.gte = new Date(updatedFrom);
      if (updatedTo) where.updated_at.lte = new Date(updatedTo);
    }
    
    // 进度范围过滤
    if (minProgress !== undefined || maxProgress !== undefined) {
      where.progress = {};
      if (minProgress !== undefined) where.progress.gte = Number(minProgress);
      if (maxProgress !== undefined) where.progress.lte = Number(maxProgress);
    }
    
    // 提醒过滤
    if (hasReminder !== undefined) {
      where.is_reminder_on = hasReminder === 'true';
    }
    
    // 排序
    const sortWhitelist = { 
      createdAt: 'created_at', 
      updatedAt: 'updated_at', 
      dueDate: 'due_date', 
      priority: 'priority', 
      progress: 'progress' 
    };
    // 处理前端使用的下划线命名
    const normalizedSort = sort === 'updated_at' ? 'updatedAt' : sort;
    const orderBy = normalizedSort && sortWhitelist[normalizedSort] ? { [sortWhitelist[normalizedSort]]: (order === 'asc' ? 'asc' : 'desc') } : { created_at: 'desc' };
    
    const [items, total] = await Promise.all([
      prisma.task.findMany({ 
        where, 
        skip: (page - 1) * pageSize, 
        take: pageSize, 
        orderBy,
        include: {
          user_task_assignee_idTouser: {
            select: { id: true, name: true, username: true, avatar: true }
          },
          user_task_creator_idTouser: {
            select: { id: true, name: true, username: true, avatar: true }
          },
          group: {
            select: { id: true, name: true }
          }
        }
      }),
      prisma.task.count({ where })
    ]);
    
    // 获取可用的过滤选项
    const availableFilters = {
      status: ['pending', 'in_progress', 'done'],
      priority: ['low', 'medium', 'high']
    };

    const formattedItems = items.map(item => {
      const { user_task_assignee_idTouser, user_task_creator_idTouser, group, ...rest } = item;
      return {
        ...rest,
        assignee: user_task_assignee_idTouser ? {
          id: Number(user_task_assignee_idTouser.id),
          name: user_task_assignee_idTouser.name,
          username: user_task_assignee_idTouser.username,
          avatar: user_task_assignee_idTouser.avatar
        } : undefined,
        creator: user_task_creator_idTouser ? {
          id: Number(user_task_creator_idTouser.id),
          name: user_task_creator_idTouser.name,
          username: user_task_creator_idTouser.username,
          avatar: user_task_creator_idTouser.avatar
        } : undefined,
        group: group ? {
          id: Number(group.id),
          name: group.name
        } : undefined
      };
    });
    
    res.json({ 
      items: formattedItems, 
      total, 
      page, 
      pageSize,
      filters: {
        applied: {
          status: Array.isArray(status) ? status : status ? [status] : undefined,
          priority: Array.isArray(priority) ? priority : priority ? [priority] : undefined,
          tags: Array.isArray(tags) ? tags : tags ? [tags] : undefined
        },
        available: availableFilters
      }
    });
  };

  // 支持两种路由：/tasks 和 /tasks/search
  router.get('/', handleTaskQuery);
  router.get('/search', handleTaskQuery);

  router.get('/:id', async (req, res) => {
    const task = await prisma.task.findFirst({ 
      where: { id: BigInt(req.params.id), deleted_at: null },
      include: {
        user_task_assignee_idTouser: {
          select: { id: true, name: true, username: true, avatar: true }
        },
        user_task_creator_idTouser: {
          select: { id: true, name: true, username: true, avatar: true }
        },
        group: {
          select: { id: true, name: true }
        }
      }
    });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');

    const { user_task_assignee_idTouser, user_task_creator_idTouser, group, ...rest } = task;
    const formattedTask = {
      ...rest,
      assignee: user_task_assignee_idTouser ? {
        id: Number(user_task_assignee_idTouser.id),
        name: user_task_assignee_idTouser.name,
        username: user_task_assignee_idTouser.username,
        avatar: user_task_assignee_idTouser.avatar
      } : undefined,
      creator: user_task_creator_idTouser ? {
        id: Number(user_task_creator_idTouser.id),
        name: user_task_creator_idTouser.name,
        username: user_task_creator_idTouser.username,
        avatar: user_task_creator_idTouser.avatar
      } : undefined,
      group: group ? {
        id: Number(group.id),
        name: group.name
      } : undefined
    };
    
    res.json(formattedTask);
  });

  router.get('/:taskId/comments', async (req, res) => {
    const taskId = BigInt(req.params.taskId);
    const task = await prisma.task.findFirst({ where: { id: taskId, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    const page = Number(req.query.page) || 1;
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const where = { task_id: taskId, deleted_at: null };
    const [items, total] = await Promise.all([
      prisma.comment.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { created_at: 'asc' },
        include: { user: { select: commentUserSelect } }
      }),
      prisma.comment.count({ where })
    ]);
    res.json({ items: items.map(toCommentResponse), total, page, pageSize });
  });

  const commentCreateSchema = z.object({ 
    content: z.string().min(1), 
    parentId: z.union([z.string(), z.number()]).optional() 
  });

  router.post('/:taskId/comments', validate(commentCreateSchema), async (req, res) => {
    const taskId = BigInt(req.params.taskId);
    const task = await prisma.task.findFirst({ where: { id: taskId, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    const { content, parentId } = req.body;
    if (!content) throw new AppError(400, 'BAD_REQUEST', '内容必填');
    let parent = null;
    if (parentId) {
      parent = await prisma.comment.findFirst({ where: { id: BigInt(parentId), deleted_at: null } });
      if (!parent) throw new AppError(400, 'BAD_REQUEST', '父评论不存在');
    }
    const now = new Date();
    const comment = await prisma.comment.create({
      data: { task_id: taskId, user_id: BigInt(req.user.id), content, parent_id: parentId ? BigInt(parentId) : undefined, created_at: now, updated_at: now },
      include: { user: { select: commentUserSelect } }
    });
    const formattedComment = toCommentResponse(comment);
    const io = req.app.get('io');
    io.emit('comment:new', formattedComment);
    await notifyTaskCommented({
      task,
      actorId: req.user.id,
      recipientIds: parent ? [parent.user_id] : [],
      io
    });
    res.status(201).json(formattedComment);
  });

  const patchSchema = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    assigneeId: z.string().optional(),
    groupId: z.string().optional(),
    status: z.enum(['pending','in_progress','done']).optional(),
    priority: z.enum(['low','medium','high']).optional(),
    dueDate: z.string().optional(),
    progress: z.number().int().min(0).max(100).optional(),
    tags: z.array(z.string()).optional(),
    estimatedHours: z.number().int().nonnegative().optional(),
    actualHours: z.number().int().nonnegative().optional(),
    isReminderOn: z.boolean().optional(),
    reminderTime: z.string().optional()
  });

  router.patch('/:id', validate(patchSchema), async (req, res) => {
    const id = BigInt(req.params.id);
    const task = await prisma.task.findFirst({ where: { id, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    
    // 权限校验：必须是 admin
    if (req.user.role !== 'admin') {
      await logAudit(
        req.user.id,
        'update_task_failed',
        'task',
        id,
        'Permission denied: Admin access required',
        req.ip
      );
      throw new AppError(403, 'FORBIDDEN', 'Permission denied: Admin access required');
    }

    const updatable = ['title', 'description', 'assigneeId', 'groupId', 'status', 'priority', 'dueDate', 'progress', 'tags', 'estimatedHours', 'actualHours', 'isReminderOn', 'reminderTime'];
    const data = {};
    for (const k of updatable) {
      if (req.body[k] !== undefined) {
        if (k === 'assigneeId') data.assignee_id = req.body[k] ? BigInt(req.body[k]) : null;
        else if (k === 'groupId') data.group_id = req.body[k] ? BigInt(req.body[k]) : null;
        else if (k === 'dueDate') data.due_date = req.body[k] ? new Date(req.body[k]) : null;
        else if (k === 'reminderTime') data.reminder_time = req.body[k] ? new Date(req.body[k]) : null;
        else if (k === 'estimatedHours') data.estimated_hours = req.body[k];
        else if (k === 'actualHours') data.actual_hours = req.body[k];
        else if (k === 'isReminderOn') data.is_reminder_on = req.body[k];
        else data[k] = req.body[k];
      }
    }
    const before = task;
    const updated = await prisma.task.update({ 
      where: { id }, 
      data,
      include: {
        user_task_assignee_idTouser: {
          select: { id: true, name: true, username: true, avatar: true }
        },
        user_task_creator_idTouser: {
          select: { id: true, name: true, username: true, avatar: true }
        },
        group: {
          select: { id: true, name: true }
        }
      }
    });
    // record changes
    for (const k of Object.keys(data)) {
      const fieldMap = {
        assignee_id: 'assigneeId',
        group_id: 'groupId',
        due_date: 'dueDate',
        reminder_time: 'reminderTime',
        estimated_hours: 'estimatedHours',
        actual_hours: 'actualHours',
        is_reminder_on: 'isReminderOn'
      };
      const fieldName = fieldMap[k] || k;
      await prisma.taskhistory.create({ data: { task_id: id, user_id: BigInt(req.user.id), field: fieldName, old_value: before[k] ? String(before[k]) : null, new_value: updated[k] ? String(updated[k]) : null } });
    }
    const io = req.app.get('io');

    const { user_task_assignee_idTouser, user_task_creator_idTouser, group, ...rest } = updated;
    const formattedTask = {
      ...rest,
      assignee: user_task_assignee_idTouser ? {
        id: Number(user_task_assignee_idTouser.id),
        name: user_task_assignee_idTouser.name,
        username: user_task_assignee_idTouser.username,
        avatar: user_task_assignee_idTouser.avatar
      } : undefined,
      creator: user_task_creator_idTouser ? {
        id: Number(user_task_creator_idTouser.id),
        name: user_task_creator_idTouser.name,
        username: user_task_creator_idTouser.username,
        avatar: user_task_creator_idTouser.avatar
      } : undefined,
      group: group ? {
        id: Number(group.id),
        name: group.name
      } : undefined
    };

    io.emit('task:update', formattedTask);
    if (data.assignee_id !== undefined && updated.assignee_id && updated.assignee_id !== before.assignee_id) {
      await notifyTaskAssigned({
        task: updated,
        assigneeId: updated.assignee_id,
        actorId: req.user.id,
        io
      });
    }
    if (data.status !== undefined && updated.status !== before.status) {
      await notifyTaskStatusChanged({
        task: updated,
        oldStatus: before.status,
        newStatus: updated.status,
        actorId: req.user.id,
        io
      });
    }
    res.json(formattedTask);
  });

  router.delete('/:id', async (req, res) => {
    const id = BigInt(req.params.id);
    const task = await prisma.task.findFirst({ where: { id, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!(req.user.role === 'admin' || req.user.id === Number(task.creator_id))) throw new AppError(403, 'FORBIDDEN', '无权限');
    await prisma.task.update({ where: { id }, data: { deleted_at: new Date() } });
    await prisma.taskhistory.create({ data: { task_id: id, user_id: BigInt(req.user.id), field: 'deleted', old_value: null, new_value: null } });
    const io = req.app.get('io');
    io.emit('task:deleted', { id: Number(id) });
    res.status(204).end();
  });

  // 任务批量操作
  const batchSchema = z.object({
    ids: z.array(z.string()),
    action: z.enum(['update', 'delete', 'assign', 'tag']),
    data: z.union([
      // update action
      z.object({
        status: z.enum(['pending','in_progress','done']).optional(),
        assigneeId: z.string().optional(),
        priority: z.enum(['low','medium','high']).optional()
      }),
      // assign action
      z.object({
        assigneeId: z.string(),
        notify: z.boolean().optional(),
        message: z.string().optional()
      }),
      // tag action
      z.object({
        tagId: z.string(),
        operation: z.enum(['add'])
      })
    ]).optional()
  });

  router.post('/batch', validate(batchSchema), async (req, res) => {
    const { ids, action, data } = req.body;
    let successCount = 0;
    const failedIds = [];

    for (const idStr of ids) {
      try {
        const id = BigInt(idStr);
        const task = await prisma.task.findFirst({ where: { id, deleted_at: null } });
        if (!task) {
          failedIds.push(idStr);
          continue;
        }
        if (!canAccessTask(req.user, task)) {
          failedIds.push(idStr);
          continue;
        }

        if (action === 'update') {
          const updateData = {};
          if (data.status) updateData.status = data.status;
          if (data.assigneeId) updateData.assignee_id = BigInt(data.assigneeId);
          if (data.priority) updateData.priority = data.priority;

          const updatedTask = await prisma.task.update({ where: { id }, data: updateData });
          const io = req.app.get('io');
          io.emit('task:update', updatedTask);
          if (updateData.assignee_id && updateData.assignee_id !== task.assignee_id) {
            await notifyTaskAssigned({
              task: updatedTask,
              assigneeId: updateData.assignee_id,
              actorId: req.user.id,
              io
            });
          }
          if (updateData.status && updateData.status !== task.status) {
            await notifyTaskStatusChanged({
              task: updatedTask,
              oldStatus: task.status,
              newStatus: updateData.status,
              actorId: req.user.id,
              io
            });
          }
          successCount++;
        } 
        else if (action === 'delete') {
          // 批量删除任务
          if (!(req.user.role === 'admin' || req.user.id === Number(task.creator_id))) {
            failedIds.push(idStr);
            continue;
          }
          await prisma.task.update({ where: { id }, data: { deleted_at: new Date() } });
          await prisma.taskhistory.create({ data: { task_id: id, user_id: BigInt(req.user.id), field: 'deleted', old_value: null, new_value: null } });
          const io = req.app.get('io');
          io.emit('task:deleted', { id: Number(id) });
          successCount++;
        } 
        else if (action === 'assign') {
          // 批量分配任务
          if (!data.assigneeId) {
            failedIds.push(idStr);
            continue;
          }
          await prisma.task.update({
            where: { id },
            data: { assignee_id: BigInt(data.assigneeId) }
          });
          await prisma.taskhistory.create({
            data: {
              task_id: id,
              user_id: BigInt(req.user.id),
              field: 'assigneeId',
              old_value: String(task.assignee_id || ''),
              new_value: String(data.assigneeId)
            }
          });
          const io = req.app.get('io');
          io.emit('task:update', { ...task, assignee_id: BigInt(data.assigneeId) });
          io.emit('task:assigned', { ...task, assignee_id: BigInt(data.assigneeId) });
          if (BigInt(data.assigneeId) !== task.assignee_id) {
            await notifyTaskAssigned({
              task,
              assigneeId: data.assigneeId,
              actorId: req.user.id,
              io
            });
          }
          successCount++;
        } 
        else if (action === 'tag') {
          // 批量添加标签到任务
          if (!data.tagId || data.operation !== 'add') {
            failedIds.push(idStr);
            continue;
          }
          
          // 获取当前标签列表
          const currentTags = task.tags || [];
          
          // 检查标签是否已存在
          if (!currentTags.includes(data.tagId)) {
            await prisma.task.update({
              where: { id },
              data: {
                tags: [...currentTags, data.tagId]
              }
            });
          }
          successCount++;
        }
      } catch (error) {
        failedIds.push(idStr);
      }
    }

    res.json({
      success: true,
      data: {
        successCount,
        failedCount: failedIds.length,
        failedIds
      }
    });
  });

  // 分配任务给用户
  const assignSchema = z.object({
    assigneeId: z.union([z.string(), z.number()]),
    notify: z.boolean().optional(),
    message: z.string().optional()
  });

  router.post('/:id/assign', validate(assignSchema), async (req, res) => {
    const id = BigInt(req.params.id);
    const { assigneeId } = req.body;
    const task = await prisma.task.findFirst({ where: { id, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    
    // 权限校验：必须是 admin
    if (req.user.role !== 'admin') {
      await logAudit(
        req.user.id,
        'assign_task_failed',
        'task',
        id,
        'Permission denied: Admin access required',
        req.ip
      );
      throw new AppError(403, 'FORBIDDEN', 'Permission denied: Admin access required');
    }

    const updatedTask = await prisma.task.update({
      where: { id },
      data: { assignee_id: BigInt(assigneeId) }
    });

    await prisma.taskhistory.create({
      data: {
        task_id: id,
        user_id: BigInt(req.user.id),
        field: 'assigneeId',
        old_value: String(task.assignee_id || ''),
        new_value: String(assigneeId)
      }
    });

    const io = req.app.get('io');
    io.emit('task:update', updatedTask);
    io.emit('task:assigned', updatedTask);
    if (BigInt(assigneeId) !== task.assignee_id) {
      await notifyTaskAssigned({
        task: updatedTask,
        assigneeId,
        actorId: req.user.id,
        io
      });
    }

    res.json(updatedTask);
  });

  // 任务标签相关接口
  
  // 获取任务标签
  router.get('/:taskId/tags', async (req, res) => {
    const taskId = BigInt(req.params.taskId);
    
    // 检查任务是否存在
    const task = await prisma.task.findFirst({ where: { id: taskId, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    
    // 获取标签列表
    const tagIds = task.tags || [];
    const tags = await prisma.tasktag.findMany({
      where: {
        id: { in: tagIds.map(id => BigInt(id)) }
      }
    });
    
    res.json({
      success: true,
      data: tags
    });
  });
  
  // 为任务添加标签
  const addTagSchema = z.object({
    tagId: z.string()
  });
  
  router.post('/:taskId/tags', validate(addTagSchema), async (req, res) => {
    const taskId = BigInt(req.params.taskId);
    const { tagId } = req.body;
    
    // 检查任务是否存在
    const task = await prisma.task.findFirst({ where: { id: taskId, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    
    // 获取当前标签列表
    const currentTags = task.tags || [];
    
    // 检查标签是否已存在
    if (currentTags.includes(tagId)) {
      return res.json({
        success: true,
        message: '标签已存在'
      });
    }
    
    // 更新任务标签
    await prisma.task.update({
      where: { id: taskId },
      data: {
        tags: [...currentTags, tagId]
      }
    });
    
    res.json({
      success: true,
      message: '标签添加成功'
    });
  });
  
  // 从任务中移除标签
  router.delete('/:taskId/tags/:tagId', async (req, res) => {
    const taskId = BigInt(req.params.taskId);
    const tagId = req.params.tagId;
    
    // 检查任务是否存在
    const task = await prisma.task.findFirst({ where: { id: taskId, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    
    // 获取当前标签列表
    const currentTags = task.tags || [];
    
    // 检查标签是否存在
    if (!currentTags.includes(tagId)) {
      return res.json({
        success: true,
        message: '标签不存在'
      });
    }
    
    // 更新任务标签
    await prisma.task.update({
      where: { id: taskId },
      data: {
        tags: currentTags.filter(id => id !== tagId)
      }
    });
    
    res.json({
      success: true,
      message: '标签移除成功'
    });
  });
  
  // 更新任务标签
  const updateTaskTagsSchema = z.object({
    tagIds: z.array(z.string())
  });
  
  router.put('/:taskId/tags', validate(updateTaskTagsSchema), async (req, res) => {
    const taskId = BigInt(req.params.taskId);
    const { tagIds } = req.body;
    
    // 检查任务是否存在
    const task = await prisma.task.findFirst({ where: { id: taskId, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    
    // 更新任务标签
    await prisma.task.update({
      where: { id: taskId },
      data: {
        tags: tagIds
      }
    });
    
    res.json({
      success: true,
      message: '任务标签更新成功'
    });
  });

  // 任务进度汇报接口
  const progressSchema = z.object({
    progress: z.number().int().min(0).max(100),
    actualHours: z.number().nonnegative(),
    remark: z.string().max(500).optional()
  });

  router.post('/:id/progress', validate(progressSchema), async (req, res) => {
    const taskId = BigInt(req.params.id);
    const { progress, actualHours, remark } = req.body;
    const userId = BigInt(req.user.id);

    const task = await prisma.task.findFirst({ 
      where: { id: taskId, deleted_at: null } 
    });
    
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');

    // 鉴权：必须是指派人或群组成员
    let hasPermission = false;
    
    // 1. 检查是否为指派人
    if (task.assignee_id === userId) {
      hasPermission = true;
    } 
    // 2. 检查是否为群组成员 (如果任务有 group_id)
    else if (task.group_id) {
      const isMember = await prisma.group_member.findFirst({
        where: {
          group_id: task.group_id,
          user_id: userId
        }
      });
      if (isMember) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
       await logAudit(
        req.user.id,
        'update_progress_failed',
        'task',
        taskId,
        'Permission denied: Not assignee or group member',
        req.ip
      );
      throw new AppError(403, 'FORBIDDEN', 'Permission denied: Not assignee or group member');
    }

    // 更新任务
    const updatedTask = await prisma.task.update({
      where: { id: taskId },
      data: {
        progress,
        actual_hours: actualHours,
        updated_at: new Date()
      }
    });

    // 记录历史
    await prisma.taskhistory.create({
      data: {
        task_id: taskId,
        user_id: userId,
        field: 'progress_report',
        old_value: `progress:${task.progress}, hours:${task.actual_hours || 0}`,
        new_value: `progress:${progress}, hours:${actualHours}, remark:${remark || ''}`
      }
    });

    const io = req.app.get('io');
    io.emit('task:update', updatedTask);

    res.json({
      success: true,
      data: updatedTask
    });
  });
  
  // 任务提醒相关接口
  
  // 创建任务提醒
  const createReminderSchema = z.object({
    userId: z.string().optional(),
    user_id: z.string().optional(),
    reminderType: z.enum(['email', 'sms', 'in_app']).optional(),
    reminder_type: z.enum(['email', 'sms', 'in_app']).optional(),
    reminderTime: z.string().optional(),
    reminder_time: z.string().optional()
  }).refine(data => data.reminderType || data.reminder_type, {
    message: 'reminderType or reminder_type is required'
  }).refine(data => data.reminderTime || data.reminder_time, {
    message: 'reminderTime or reminder_time is required'
  });

  router.post('/:id/reminders', validate(createReminderSchema), async (req, res) => {
    const taskId = BigInt(req.params.id);
    const { user_id, userId, reminder_type, reminderType, reminder_time, reminderTime } = req.body;

    // 检查任务是否存在
    const task = await prisma.task.findFirst({ where: { id: taskId, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');

    // 支持驼峰和下划线两种命名
    const finalUserId = userId || user_id;
    const finalReminderType = reminderType || reminder_type;
    const finalReminderTime = reminderTime || reminder_time;

    // 验证提醒时间必须在未来
    const reminderDateTime = new Date(finalReminderTime);
    if (reminderDateTime <= new Date()) {
      throw new AppError(400, 'BAD_REQUEST', '提醒时间必须在未来');
    }

    // 创建提醒
    const reminder = await prisma.taskreminder.create({
      data: {
        task_id: taskId,
        user_id: finalUserId ? BigInt(finalUserId) : BigInt(req.user.id),
        reminder_type: finalReminderType,
        reminder_time: reminderDateTime,
        status: 'pending'
      }
    });

    const io = req.app.get('io');
    io.emit('task:reminder:created', reminder);

    res.status(201).json(reminder);
  });

  // 获取任务提醒列表
  router.get('/:id/reminders', async (req, res) => {
    const taskId = BigInt(req.params.id);
    
    // 检查任务是否存在
    const task = await prisma.task.findFirst({ where: { id: taskId, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    
    const reminders = await prisma.taskreminder.findMany({
      where: { task_id: taskId },
      orderBy: {
        reminder_time: 'asc'
      }
    });
    
    res.json({ items: reminders });
  });

  // 删除任务提醒
  router.delete('/reminders/:id', async (req, res) => {
    const id = BigInt(req.params.id);
    
    // 检查提醒是否存在
    const reminder = await prisma.taskreminder.findUnique({ where: { id } });
    if (!reminder) throw new AppError(404, 'NOT_FOUND', '提醒不存在');
    
    // 检查任务权限
    const task = await prisma.task.findFirst({ where: { id: reminder.task_id, deleted_at: null } });
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    
    await prisma.taskreminder.delete({ where: { id } });
    
    const io = req.app.get('io');
    io.emit('reminder:delete', { id: Number(id) });
    
    res.json({ message: '提醒已删除' });
  });

  // 任务附件相关接口

  // 上传附件
  router.post('/:taskId/attachments', upload.single('file'), async (req, res) => {
    const taskId = BigInt(req.params.taskId);
    const { description } = req.body;
    
    // 检查任务是否存在
    const task = await prisma.task.findFirst({ where: { id: taskId, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    
    if (!req.file) throw new AppError(400, 'BAD_REQUEST', '文件不能为空');
    
    const relPath = `/uploads/task-attachments/${req.file.filename}`;
    const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
    const fullUrl = `${baseUrl}${relPath}`;
    
    const attachment = await prisma.taskattachment.create({
      data: {
        task_id: taskId,
        name: req.file.filename,
        original_name: req.file.originalname,
        size: BigInt(req.file.size),
        mime_type: req.file.mimetype,
        url: relPath,
        description,
        uploaded_by: BigInt(req.user.id)
      }
    });
    
    res.json({
      success: true,
      data: {
        ...attachment,
        url: fullUrl,
        uploader_name: req.user.name
      }
    });
  });

  // 获取任务附件列表
  router.get('/:taskId/attachments', async (req, res) => {
    const taskId = BigInt(req.params.taskId);
    
    // 检查任务是否存在
    const task = await prisma.task.findFirst({ where: { id: taskId, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    
    const attachments = await prisma.taskattachment.findMany({
      where: { task_id: taskId },
      orderBy: { uploaded_at: 'desc' },
      include: {
        user: {
          select: {
            name: true,
            avatar: true
          }
        }
      }
    });
    
    // 构建完整URL
    const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
    const items = attachments.map(attachment => ({
      ...attachment,
      url: `${baseUrl}${attachment.url}`,
      uploader_name: attachment.user?.name,
      user: undefined
    }));
    
    res.json({
      success: true,
      items,
      total: items.length
    });
  });

  // 下载附件
  router.get('/attachments/:id/download', async (req, res) => {
    const id = BigInt(req.params.id);
    
    // 检查附件是否存在
    const attachment = await prisma.taskattachment.findUnique({ where: { id } });
    if (!attachment) throw new AppError(404, 'NOT_FOUND', '附件不存在');
    
    // 检查任务权限
    const task = await prisma.task.findFirst({ where: { id: attachment.task_id, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    
    const filePath = path.join(process.cwd(), 'public', attachment.url);
    
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      throw new AppError(404, 'NOT_FOUND', '文件不存在');
    }
    
    // 设置响应头，触发下载
    res.setHeader('Content-Disposition', `attachment; filename="${attachment.original_name}"`);
    res.setHeader('Content-Type', attachment.mime_type);
    res.setHeader('Content-Length', Number(attachment.size));
    
    // 读取文件并发送
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  });

  // 删除附件
  router.delete('/attachments/:id', async (req, res) => {
    const id = BigInt(req.params.id);
    
    // 检查附件是否存在
    const attachment = await prisma.taskattachment.findUnique({ where: { id } });
    if (!attachment) throw new AppError(404, 'NOT_FOUND', '附件不存在');
    
    // 检查任务权限
    const task = await prisma.task.findFirst({ where: { id: attachment.task_id, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    
    // 删除文件
    const filePath = path.join(process.cwd(), 'public', attachment.url);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // 删除数据库记录
    await prisma.taskattachment.delete({ where: { id } });
    
    res.json({
      success: true,
      message: '附件删除成功'
    });
  });

  // 更新附件描述
  const updateAttachmentSchema = z.object({
    description: z.string()
  });

  router.patch('/attachments/:id', validate(updateAttachmentSchema), async (req, res) => {
    const id = BigInt(req.params.id);
    const { description } = req.body;
    
    // 检查附件是否存在
    const attachment = await prisma.taskattachment.findUnique({ where: { id } });
    if (!attachment) throw new AppError(404, 'NOT_FOUND', '附件不存在');
    
    // 检查任务权限
    const task = await prisma.task.findFirst({ where: { id: attachment.task_id, deleted_at: null } });
    if (!task) throw new AppError(404, 'NOT_FOUND', '任务不存在');
    if (!canAccessTask(req.user, task)) throw new AppError(403, 'FORBIDDEN', '无权限');
    
    const updated = await prisma.taskattachment.update({
      where: { id },
      data: { description },
      include: {
        user: {
          select: {
            name: true
          }
        }
      }
    });
    
    const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
    
    res.json({
      success: true,
      data: {
        ...updated,
        url: `${baseUrl}${updated.url}`,
        uploader_name: updated.user?.name,
        user: undefined
      }
    });
  });

  return router;
}
