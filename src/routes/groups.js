import express from 'express';
import { PrismaClient } from '@prisma/client';
import { createNotification, NOTIFICATION_TYPES } from '../services/notificationService.js';
const prisma = new PrismaClient();

export function groupRoutes() {
  const router = express.Router();

  // 4.1 获取所有群组任务 (聚合)
  router.get('/tasks/all', async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 10;
      const status = req.query.status;
      const groupId = req.query.groupId;
      const userId = req.user.id;

      // 1. 获取用户所在的所有群组 (或者指定群组)
      const userGroups = await prisma.group_member.findMany({
        where: { 
          user_id: userId,
          ...(groupId ? { group_id: BigInt(groupId) } : {})
        },
        select: { group_id: true }
      });

      const userGroupIds = userGroups.map(ug => ug.group_id);

      if (userGroupIds.length === 0) {
        return res.json({
          success: true,
          items: [],
          total: 0,
          page,
          pageSize
        });
      }

      // 2. 获取这些群组的所有成员 (去重)
      // 注意：这可能是一个较大的集合，但为了满足"群组任务"定义(分配给群组成员的任务)是必要的
      // 如果数据量过大，建议优化数据模型，在 task 上直接关联 group_id
      const groupMembers = await prisma.group_member.findMany({
        where: {
          group_id: { in: userGroupIds }
        },
        select: { 
          user_id: true,
          group_id: true,
          group: { select: { name: true } }
        }
      });

      // 建立 user_id -> group info 的映射 (用于返回 groupName)
      // 注意：一个用户可能在多个群组，这里简化处理，取其中一个群组，或者需要返回任务所属的特定上下文
      // 由于现有 task 模型没有 group_id，我们只能推断。
      // 这里的逻辑是：找到分配给这些用户的任务。
      const assigneeIds = [...new Set(groupMembers.map(gm => gm.user_id))];

      const where = {
        assignee_id: { in: assigneeIds },
        deleted_at: null
      };

      if (status) where.status = status;

      const tasks = await prisma.task.findMany({
        where,
        include: {
          user_task_assignee_idTouser: {
            select: { name: true }
          }
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { created_at: 'desc' }
      });

      const total = await prisma.task.count({ where });

      // Helper to find group for a task's assignee
      // 优先匹配当前用户所在的群组中，包含该 assignee 的群组
      const findGroupForAssignee = (assigneeId) => {
        if (!assigneeId) return null;
        // 找到该 assignee 所在的群组，且该群组在本次查询范围(userGroupIds)内
        const match = groupMembers.find(gm => gm.user_id === assigneeId && userGroupIds.includes(gm.group_id));
        return match ? { id: match.group_id, name: match.group.name } : null;
      };

      const items = tasks.map(task => {
        const groupInfo = findGroupForAssignee(task.assignee_id);
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          groupName: groupInfo?.name,
          groupId: groupInfo?.id,
          assigneeName: task.user_task_assignee_idTouser?.name,
          createdAt: task.created_at
        };
      });

      res.json({
        success: true,
        items,
        total,
        page,
        pageSize
      });
    } catch (error) {
      console.error('获取聚合群组任务失败:', error);
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  });

  // 获取群组列表
  router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const keyword = req.query.keyword || '';
    
    const where = keyword ? {
      name: {
        contains: keyword
      }
    } : {};
    
    const groups = await prisma.group.findMany({
      where,
      include: {
        group_member: true
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: {
        created_at: 'desc'
      }
    });
    
    const total = await prisma.group.count({ where });
    
    const items = groups.map(group => ({
      id: group.id,
      name: group.name,
      description: group.description,
      createdAt: group.created_at,
      updatedAt: group.updated_at,
      createdBy: group.created_by,
      memberCount: group.group_member.length
    }));
    
    res.json({
      success: true,
      items,
      total,
      page,
      pageSize
    });
  } catch (error) {
    console.error('获取群组列表失败:', error);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误'
    });
  }
});

// 获取群组详情
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // 排除特殊路径如 'members'
    if (isNaN(parseInt(id))) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '无效的群组ID'
      });
    }

    const group = await prisma.group.findUnique({
      where: { id: parseInt(id) },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        },
        _count: {
          select: { group_member: true }
        }
      }
    });
    
    if (!group) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '群组不存在'
      });
    }
    
    res.json({
      success: true,
      data: {
        id: group.id,
        name: group.name,
        description: group.description,
        createdAt: group.created_at,
        updatedAt: group.updated_at,
        createdBy: group.created_by,
        creator: group.user,
        memberCount: group._count.group_member
      }
    });
  } catch (error) {
    console.error('获取群组详情失败:', error);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误'
    });
  }
});

// 创建群组
router.post('/', async (req, res) => {
  try {
    const { name, description } = req.body;
    const userId = req.user.id;
    
    if (!name) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: '群组名称不能为空'
      });
    }
    
    const group = await prisma.group.create({
      data: {
        name,
        description,
        created_by: userId,
        created_at: new Date(),
        updated_at: new Date()
      }
    });
    
    // 创建群组后，自动将创建者添加为群组成员（owner 角色）
    await prisma.group_member.create({
      data: {
        group_id: group.id,
        user_id: userId,
        role: 'owner',
        joined_at: new Date()
      }
    });
    
    res.status(201).json({
      success: true,
      data: {
        id: group.id,
        name: group.name,
        description: group.description,
        createdAt: group.created_at,
        updatedAt: group.updated_at,
        createdBy: group.created_by
      }
    });
  } catch (error) {
    console.error('创建群组失败:', error);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误'
    });
  }
});

// 更新群组
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    const userId = req.user.id;
    
    // 排除特殊路径如 'members'
    if (isNaN(parseInt(id))) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '无效的群组ID'
      });
    }

    // 排除特殊路径如 'members'
    if (isNaN(parseInt(id))) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '无效的群组ID'
      });
    }

    // 排除特殊路径如 'members'
    if (isNaN(parseInt(id))) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '无效的群组ID'
      });
    }
    
    // 排除特殊路径如 'members'
    if (isNaN(parseInt(id))) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '无效的群组ID'
      });
    }
    
    // 排除特殊路径如 'members'
    if (isNaN(parseInt(id))) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '无效的群组ID'
      });
    }
    
    // 检查群组是否存在
    const group = await prisma.group.findUnique({
      where: { id: parseInt(id) }
    });
    
    if (!group) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '群组不存在'
      });
    }
    
    // 检查用户是否为群组所有者
    const member = await prisma.group_member.findFirst({
      where: {
        group_id: parseInt(id),
        user_id: userId,
        role: 'owner'
      }
    });
    
    if (!member) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: '只有群组所有者可以更新群组信息'
      });
    }
    
    if (!name) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: '群组名称不能为空'
      });
    }
    
    const updatedGroup = await prisma.group.update({
      where: { id: parseInt(id) },
      data: {
        name,
        description,
        updated_at: new Date()
      }
    });
    
    res.json({
      success: true,
      data: {
        id: updatedGroup.id,
        name: updatedGroup.name,
        description: updatedGroup.description,
        createdAt: updatedGroup.created_at,
        updatedAt: updatedGroup.updated_at,
        createdBy: updatedGroup.created_by
      }
    });
  } catch (error) {
    console.error('更新群组失败:', error);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误'
    });
  }
});

// 删除群组
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // 排除特殊路径如 'members'
    if (isNaN(parseInt(id))) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '无效的群组ID'
      });
    }

    // 检查群组是否存在
    const group = await prisma.group.findUnique({
      where: { id: parseInt(id) }
    });
    
    if (!group) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '群组不存在'
      });
    }
    
    // 检查用户是否为群组所有者
    const member = await prisma.group_member.findFirst({
      where: {
        group_id: parseInt(id),
        user_id: userId,
        role: 'owner'
      }
    });
    
    if (!member) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: '只有群组所有者可以删除群组'
      });
    }
    
    // 删除群组成员关系
    await prisma.group_member.deleteMany({
      where: { group_id: parseInt(id) }
    });
    
    // 删除群组
    await prisma.group.delete({
      where: { id: parseInt(id) }
    });
    
    res.json({
      success: true,
      message: '群组删除成功'
    });
  } catch (error) {
    console.error('删除群组失败:', error);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误'
    });
  }
});

// 获取群组成员
router.get('/:id/members', async (req, res) => {
  try {
    const { id } = req.params;
    
    // 检查群组是否存在
    const group = await prisma.group.findUnique({
      where: { id: parseInt(id) }
    });
    
    if (!group) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '群组不存在'
      });
    }
    
    const members = await prisma.group_member.findMany({
      where: { group_id: parseInt(id) },
      include: {
        user: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });
    
    const items = members.map(member => ({
      id: member.id,
      userId: member.user_id,
      userName: member.user.name,
      role: member.role,
      joinedAt: member.joined_at
    }));
    
    res.json({
      success: true,
      items,
      total: items.length
    });
  } catch (error) {
    console.error('获取群组成员失败:', error);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误'
    });
  }
});

// 添加群组成员
router.post('/:id/members', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, role } = req.body;
    const currentUserId = req.user.id;
    
    // 检查群组是否存在
    const group = await prisma.group.findUnique({
      where: { id: parseInt(id) }
    });
    
    if (!group) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '群组不存在'
      });
    }
    
    // 检查当前用户是否为群组所有者或管理员
    const currentMember = await prisma.group_member.findFirst({
      where: {
        group_id: parseInt(id),
        user_id: currentUserId,
        role: {
          in: ['owner', 'admin']
        }
      }
    });
    
    if (!currentMember) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: '只有群组所有者或管理员可以添加成员'
      });
    }
    
    // 检查要添加的用户是否已经是群组成员
    const existingMember = await prisma.group_member.findFirst({
      where: {
        group_id: parseInt(id),
        user_id: userId
      }
    });
    
    if (existingMember) {
      return res.status(400).json({
        success: false,
        code: 'GROUP_MEMBER_EXISTS',
        message: '该用户已经是群组成员'
      });
    }
    
    // 检查要添加的用户是否存在
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '要添加的用户不存在'
      });
    }
    
    const newMember = await prisma.group_member.create({
      data: {
        group_id: parseInt(id),
        user_id: userId,
        role: role || 'member',
        joined_at: new Date()
      },
      include: {
        user: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    await createNotification({
      userId,
      type: NOTIFICATION_TYPES.GROUP_INVITATION,
      title: '群组邀请',
      content: `你已加入群组 "${group.name}"`,
      relatedId: group.id,
      relatedType: 'group',
      io: req.app.get('io')
    });
    
    res.json({
      success: true,
      message: '成员添加成功',
      data: {
        id: newMember.id,
        userId: newMember.user_id,
        userName: newMember.user.name,
        role: newMember.role,
        joinedAt: newMember.joined_at
      }
    });
  } catch (error) {
    console.error('添加群组成员失败:', error);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误'
    });
  }
});

// 移除群组成员
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const { id, userId } = req.params;
    const currentUserId = req.user.id;
    
    // 检查群组是否存在
    const group = await prisma.group.findUnique({
      where: { id: parseInt(id) }
    });
    
    if (!group) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '群组不存在'
      });
    }
    
    // 检查当前用户是否为群组所有者或管理员，或者要移除的是自己
    const currentMember = await prisma.group_member.findFirst({
      where: {
        group_id: parseInt(id),
        user_id: currentUserId
      }
    });
    
    if (!currentMember) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: '您不是该群组成员'
      });
    }
    
    // 检查是否有权限移除成员
    const canRemove = 
      currentMember.role === 'owner' || 
      currentMember.role === 'admin' || 
      currentUserId === parseInt(userId);
    
    if (!canRemove) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: '只有群组所有者或管理员可以移除成员，或者您只能移除自己'
      });
    }
    
    // 检查要移除的成员是否存在
    const memberToRemove = await prisma.group_member.findFirst({
      where: {
        group_id: parseInt(id),
        user_id: parseInt(userId)
      }
    });
    
    if (!memberToRemove) {
      return res.status(404).json({
        success: false,
        code: 'GROUP_MEMBER_NOT_FOUND',
        message: '该成员不是群组成员'
      });
    }
    
    // 群组所有者不能被移除
    if (memberToRemove.role === 'owner') {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: '群组所有者不能被移除'
      });
    }
    
    await prisma.group_member.delete({
      where: { id: memberToRemove.id }
    });
    
    res.json({
      success: true,
      message: '成员移除成功'
    });
  } catch (error) {
    console.error('移除群组成员失败:', error);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误'
    });
  }
});

// 获取群组任务
router.get('/:id/tasks', async (req, res) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const status = req.query.status;
    const priority = req.query.priority;
    
    // 排除特殊路径
    if (isNaN(parseInt(id))) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '无效的群组ID'
      });
    }

    // 检查群组是否存在
    const group = await prisma.group.findUnique({
      where: { id: parseInt(id) }
    });
    
    if (!group) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: '群组不存在'
      });
    }
    
    // 构建查询条件
    const where = {
      group_id: parseInt(id),
      deleted_at: null
    };

    if (status) {
      where.status = status;
    }

    if (priority) {
      where.priority = priority;
    }
    
    const tasks = await prisma.task.findMany({
      where,
      include: {
        user_task_assignee_idTouser: {
          select: {
            name: true
          }
        }
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: {
        created_at: 'desc'
      }
    });
    
    const total = await prisma.task.count({ where });
    
    const items = tasks.map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      assigneeId: task.assignee_id,
      assigneeName: task.user_task_assignee_idTouser?.name,
      createdAt: task.created_at,
      updatedAt: task.updated_at
    }));
    
    res.json({
      success: true,
      items,
      total,
      page,
      pageSize
    });
  } catch (error) {
    console.error('获取群组任务失败:', error);
    res.status(500).json({
      success: false,
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误'
    });
  }
});

  return router;
}
