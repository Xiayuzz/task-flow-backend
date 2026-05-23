import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware, requireAdmin } from '../utils/auth.js';

export function statsRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // 辅助函数：获取日期范围
  const getDateRange = (period, startDate, endDate) => {
    const now = new Date();
    let start, end;
    
    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
    } else {
      end = now;
      start = new Date();
      
      switch (period) {
        case 'daily':
          start.setDate(start.getDate() - 6); // 最近7天
          break;
        case 'weekly':
          start.setDate(start.getDate() - 29); // 最近30天
          break;
        case 'monthly':
          start.setMonth(start.getMonth() - 11); // 最近12个月
          break;
        case 'yearly':
          start.setFullYear(start.getFullYear() - 4); // 最近5年
          break;
        default:
          start.setDate(start.getDate() - 6); // 默认最近7天
      }
    }
    
    return { start, end };
  };

  // 辅助函数：格式化日期
  const formatDate = (date, period) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    switch (period) {
      case 'daily':
        return `${year}-${month}-${day}`;
      case 'weekly':
        return `${year}-W${String(Math.ceil(date.getDate() / 7)).padStart(2, '0')}`;
      case 'monthly':
        return `${year}-${month}`;
      case 'yearly':
        return `${year}`;
      default:
        return `${year}-${month}-${day}`;
    }
  };

  // 任务概览统计
  router.get('/tasks/overview', async (req, res) => {
    const { startDate, endDate } = req.query;
    
    // 构建时间范围过滤条件
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);
    
    // 查询基本统计数据
    const [total, pending, inProgress, done] = await Promise.all([
      prisma.task.count({ where: { deleted_at: null, created_at: dateFilter } }),
      prisma.task.count({ where: { status: 'pending', deleted_at: null, created_at: dateFilter } }),
      prisma.task.count({ where: { status: 'in_progress', deleted_at: null, created_at: dateFilter } }),
      prisma.task.count({ where: { status: 'done', deleted_at: null, created_at: dateFilter } })
    ]);
    
    // 计算逾期任务
    const now = new Date();
    const overdue = await prisma.task.count({ 
      where: { 
        due_date: { lt: now }, 
        status: { not: 'done' },
        deleted_at: null 
      } 
    });
    
    // 按优先级统计
    const byPriorityCounts = await prisma.task.groupBy({ 
      by: ['priority'], 
      _count: { priority: true }, 
      where: { deleted_at: null, created_at: dateFilter } 
    });
    const byPriority = { low: 0, medium: 0, high: 0 };
    byPriorityCounts.forEach(r => { byPriority[r.priority] = r._count.priority; });
    
    // 按状态统计
    const byStatus = { pending, in_progress: inProgress, done };
    
    // 查询任务明细（复用于标签、趋势、分配统计）
    const tasks = await prisma.task.findMany({
      where: { deleted_at: null, created_at: dateFilter },
      select: { tags: true, created_at: true, status: true, assignee_id: true }
    });

    // 按标签统计
    const byTag = {};
    // 趋势统计
    const trendMap = {};
    // 分配统计
    const assignmentMap = {};

    tasks.forEach(task => {
      // 标签统计：兼容 Prisma Json 已解析为数组的情况
      if (task.tags) {
        let tagsArray;
        if (Array.isArray(task.tags)) {
          tagsArray = task.tags;
        } else if (typeof task.tags === 'string') {
          try {
            tagsArray = JSON.parse(task.tags);
          } catch (e) { return; }
        }
        if (tagsArray) {
          tagsArray.forEach(tag => {
            byTag[tag] = (byTag[tag] || 0) + 1;
          });
        }
      }

      // 趋势统计：按创建日期分组
      const dateKey = formatDate(task.created_at, 'daily');
      if (!trendMap[dateKey]) {
        trendMap[dateKey] = { date: dateKey, created: 0, completed: 0 };
      }
      trendMap[dateKey].created++;
      if (task.status === 'done') trendMap[dateKey].completed++;

      // 分配统计
      if (task.assignee_id) {
        if (!assignmentMap[task.assignee_id]) {
          assignmentMap[task.assignee_id] = { assigned: 0, completed: 0, inProgress: 0 };
        }
        assignmentMap[task.assignee_id].assigned++;
        if (task.status === 'done') assignmentMap[task.assignee_id].completed++;
        else if (task.status === 'in_progress') assignmentMap[task.assignee_id].inProgress++;
      }
    });

    const trend = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));

    // 查询用户信息补充分配数据
    const userIds = Object.keys(assignmentMap).map(id => BigInt(id));
    const users = userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, avatar: true }
        })
      : [];

    const byAssignment = users.map(u => ({
      id: Number(u.id),
      name: u.name,
      avatar: u.avatar,
      assigned: assignmentMap[u.id]?.assigned || 0,
      completed: assignmentMap[u.id]?.completed || 0,
      inProgress: assignmentMap[u.id]?.inProgress || 0
    })).filter(u => u.assigned > 0);

    res.json({
      overview: { total, pending, in_progress: inProgress, done, overdue },
      by_priority: byPriority,
      by_status: byStatus,
      trend,
      by_tag: byTag,
      by_assignment: byAssignment
    });
  });

  // 用户绩效统计
  router.get('/users/performance', requireAdmin, async (req, res) => {
    const { userId } = req.query;
    
    // 构建过滤条件
    const where = {};
    if (userId) where.id = BigInt(userId);
    
    // 获取用户列表
    const users = await prisma.user.findMany({ where });
    const results = [];
    
    for (const u of users) {
      const [assignedTasks, completedTasks, totalHours, overdueTasks] = await Promise.all([
        prisma.task.count({ where: { assignee_id: u.id, deleted_at: null } }),
        prisma.task.count({ where: { assignee_id: u.id, status: 'done', deleted_at: null } }),
        prisma.task.aggregate({ 
          _sum: { actual_hours: true }, 
          where: { assignee_id: u.id, status: 'done', deleted_at: null } 
        }),
        prisma.task.count({ 
          where: { 
            assignee_id: u.id, 
            due_date: { lt: new Date() }, 
            status: { not: 'done' },
            deleted_at: null 
          } 
        })
      ]);
      
      // 计算完成率
      const completionRate = assignedTasks > 0 ? Math.round((completedTasks / assignedTasks) * 100) : 0;
      
      // 计算平均完成时间 (简化版)
      const avgCompletionTime = 2.5; // 实际应该根据任务的created_at和completedAt计算
      
      results.push({
        user_id: Number(u.id),
        name: u.name,
        avatar: u.avatar,
        assigned_tasks: assignedTasks,
        completed_tasks: completedTasks,
        completion_rate: completionRate,
        avg_completion_time: avgCompletionTime,
        total_hours: totalHours._sum.actual_hours || 0,
        overdue_tasks: overdueTasks,
        trend: [] // 实际应该根据不同周期计算趋势
      });
    }
    
    res.json({ items: results, total: results.length });
  });
  // 获取任务完成时间统计
  router.get('/tasks/completion-time', async (req, res) => {
    const { period = 'daily', groupBy = 'priority' } = req.query;
    
    // 查询已汇报实际工时的任务。进度汇报接口更新 actual_hours，但不一定会把状态改为 done。
    const tasks = await prisma.task.findMany({
      where: {
        deleted_at: null,
        actual_hours: {
          gt: 0
        }
      },
      select: {
        priority: true,
        status: true,
        assignee_id: true,
        tags: true,
        created_at: true,
        updated_at: true,
        actual_hours: true
      }
    });
    
    // 计算平均和中位数完成时间
    const completionTimes = [];
    const byGroup = {};
    const trendMap = {};
    
    tasks.forEach(task => {
      const hours = Number(task.actual_hours || 0);
      if (hours <= 0) return;

      completionTimes.push(hours);
      
      let groupKey;
      switch (groupBy) {
        case 'priority':
          groupKey = task.priority;
          break;
        case 'status':
          groupKey = task.status;
          break;
        case 'assignee':
          groupKey = task.assignee_id || 'unassigned';
          break;
        case 'tag':
          groupKey = Array.isArray(task.tags) && task.tags.length > 0 ? task.tags[0] : 'untagged';
          break;
        default:
          groupKey = 'all';
      }
      
      if (!byGroup[groupKey]) {
        byGroup[groupKey] = [];
      }
      byGroup[groupKey].push(hours);

      const dateKey = formatDate(task.updated_at || task.created_at, period);
      if (!trendMap[dateKey]) {
        trendMap[dateKey] = [];
      }
      trendMap[dateKey].push(hours);
    });
    
    // 计算平均值
    const avgCompletionTime = completionTimes.length > 0 
      ? completionTimes.reduce((sum, time) => sum + time, 0) / completionTimes.length 
      : 0;
    
    // 计算中位数
    const sortedTimes = [...completionTimes].sort((a, b) => a - b);
    const medianIndex = Math.floor(sortedTimes.length / 2);
    const medianCompletionTime = sortedTimes.length > 0 
      ? sortedTimes.length % 2 === 0 
        ? (sortedTimes[medianIndex - 1] + sortedTimes[medianIndex]) / 2 
        : sortedTimes[medianIndex] 
      : 0;
    
    // 按组计算平均时间
    const byGroupAvg = {};
    Object.entries(byGroup).forEach(([group, times]) => {
      byGroupAvg[group] = times.length > 0 
        ? times.reduce((sum, time) => sum + time, 0) / times.length 
        : 0;
    });
    
    // 生成趋势数据
    const trend = [];
    const { start, end } = getDateRange(period);
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateKey = formatDate(d, period);
      const times = trendMap[dateKey] || [];
      trend.push({
        date: dateKey,
        avgTime: times.length > 0 
          ? times.reduce((sum, time) => sum + time, 0) / times.length 
          : 0
      });
    }
    
    res.json({
      success: true,
      data: {
        avgCompletionTime,
        medianCompletionTime,
        byGroup: { [groupBy]: byGroupAvg },
        trend
      }
    });
  });

  return router;
}
