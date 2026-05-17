import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../utils/auth.js';
import { z } from 'zod';

export function reportRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // 6.1 获取任务概览统计
  router.get('/overview', async (req, res) => {
    try {
      const { startDate, endDate, userId, groupId } = req.query;
      
      if (!startDate || !endDate) {
        return res.status(400).json({ success: false, message: '开始日期和结束日期必填' });
      }

      const start = new Date(startDate);
      const end = new Date(endDate);
      
      const where = {
        created_at: {
          gte: start,
          lte: end
        },
        deleted_at: null
      };

      if (userId) where.assignee_id = BigInt(userId);
      // groupId handling would require joining user/group tables, omitting for simplicity or assuming userId filter is enough for now
      // If groupId is provided, we first find all users in that group
      if (groupId) {
        const groupMembers = await prisma.group_member.findMany({
          where: { group_id: BigInt(groupId) },
          select: { user_id: true }
        });
        const memberIds = groupMembers.map(m => m.user_id);
        where.assignee_id = { in: memberIds };
      }

      const [totalCreated, statusStats, priorityStats, completedStats] = await Promise.all([
        prisma.task.count({ where }),
        prisma.task.groupBy({
          by: ['status'],
          where,
          _count: true
        }),
        prisma.task.groupBy({
          by: ['priority'],
          where,
          _count: true
        }),
        prisma.task.aggregate({
          where: {
            ...where,
            status: 'done'
          },
          _avg: {
            actual_hours: true // Simplistic approximation for "completion time" if we track hours
          },
          _count: true
        })
      ]);

      const totalCompleted = completedStats._count;
      const completionRate = totalCreated > 0 ? totalCompleted / totalCreated : 0;
      
      const statusDistribution = statusStats.reduce((acc, curr) => {
        acc[curr.status] = curr._count;
        return acc;
      }, {});

      const priorityDistribution = priorityStats.reduce((acc, curr) => {
        acc[curr.priority] = curr._count;
        return acc;
      }, {});

      res.json({
        success: true,
        data: {
          totalCreated,
          totalCompleted,
          completionRate,
          avgCompletionTime: completedStats._avg.actual_hours || 0,
          statusDistribution,
          priorityDistribution
        }
      });
    } catch (error) {
      console.error('获取概览报表失败:', error);
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  });

  // 6.2 获取任务趋势图数据
  router.get('/trend', async (req, res) => {
    try {
      const { startDate, endDate, dimension = 'day' } = req.query;
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      // Fetch all relevant tasks and aggregate in memory
      const tasks = await prisma.task.findMany({
        where: {
          created_at: { gte: start, lte: end },
          deleted_at: null
        },
        select: {
          created_at: true,
          status: true,
          updated_at: true // Assuming updated_at as completion time for done tasks
        }
      });

      const map = new Map();

      const getKey = (date) => {
        const d = new Date(date);
        if (dimension === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (dimension === 'week') {
           // Simple week key
           const onejan = new Date(d.getFullYear(), 0, 1);
           const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
           return `${d.getFullYear()}-W${week}`;
        }
        return d.toISOString().split('T')[0];
      };

      tasks.forEach(task => {
        const key = getKey(task.created_at);
        if (!map.has(key)) map.set(key, { date: key, created: 0, completed: 0 });
        map.get(key).created++;
        
        if (task.status === 'done') {
          const completeKey = getKey(task.updated_at); // Use updated_at for completion
          // Ensure completeKey is within range if we want strict range (optional)
          if (!map.has(completeKey)) map.set(completeKey, { date: completeKey, created: 0, completed: 0 });
          map.get(completeKey).completed++;
        }
      });

      const items = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));

      res.json({
        success: true,
        items
      });
    } catch (error) {
      console.error('获取趋势报表失败:', error);
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  });

  // 6.3 获取团队工时/绩效统计
  router.get('/team-performance', async (req, res) => {
    try {
       // Fetch all users or filter by group
       const users = await prisma.user.findMany({
         where: { status: 'active' },
         select: { id: true, name: true }
       });

       const items = await Promise.all(users.map(async user => {
         const stats = await prisma.task.aggregate({
           where: {
             assignee_id: user.id,
             deleted_at: null
           },
           _count: {
             id: true // total assigned
           },
           _sum: {
             estimated_hours: true,
             actual_hours: true
           }
         });

         const completedCount = await prisma.task.count({
           where: {
             assignee_id: user.id,
             status: 'done',
             deleted_at: null
           }
         });

         const estimated = Number(stats._sum.estimated_hours || 0);
         const actual = Number(stats._sum.actual_hours || 0);
         const efficiency = actual > 0 ? estimated / actual : 0;

         return {
           userId: user.id,
           userName: user.name,
           assignedTasks: stats._count.id,
           completedTasks: completedCount,
           totalEstimatedHours: estimated,
           totalActualHours: actual,
           efficiency: parseFloat(efficiency.toFixed(2))
         };
       }));

       res.json({
         success: true,
         items
       });
    } catch (error) {
      console.error('获取团队绩效失败:', error);
      res.status(500).json({ success: false, message: '服务器内部错误' });
    }
  });

  return router;
}
