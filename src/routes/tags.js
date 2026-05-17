import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../utils/auth.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

export function tagRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // 获取标签列表
  router.get('/', async (req, res) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 10;
    const keyword = req.query.keyword;
    
    const where = {};
    if (keyword) {
      where.name = { contains: keyword };
    }
    
    const [items, total] = await Promise.all([
      prisma.tasktag.findMany({
        select: {
          id: true,
          name: true,
          color: true,
          created_at: true,
          updated_at: true,
          created_by: true
        },
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: {
          created_at: 'desc'
        }
      }),
      prisma.tasktag.count({ where })
    ]);
    
    res.json({ 
      success: true,
      items, 
      total, 
      page, 
      pageSize 
    });
  });

  // 创建标签
  const createTagSchema = z.object({
    name: z.string().min(1).max(50),
    color: z.string().optional().default('#4CAF50')
  });

  router.post('/', validate(createTagSchema), async (req, res) => {
    const { name, color } = req.body;
    const tag = await prisma.tasktag.create({
      data: {
        name,
        color,
        created_by: BigInt(req.user.id)
      },
      select: {
        id: true,
        name: true,
        color: true,
        created_at: true,
        updated_at: true,
        created_by: true
      }
    });
    res.status(201).json({ 
      success: true,
      data: tag 
    });
  });

  // 更新标签
  const updateTagSchema = z.object({
    name: z.string().min(1).max(50).optional(),
    color: z.string().optional()
  });

  router.put('/:id', validate(updateTagSchema), async (req, res) => {
    const id = BigInt(req.params.id);
    const { name, color } = req.body;
    
    const tag = await prisma.tasktag.update({
      where: { id },
      data: {
        name,
        color
      },
      select: {
        id: true,
        name: true,
        color: true,
        created_at: true,
        updated_at: true,
        created_by: true
      }
    });
    
    res.json({ 
      success: true,
      data: tag 
    });
  });

  // 删除标签
  router.delete('/:id', async (req, res) => {
    const id = BigInt(req.params.id);
    await prisma.tasktag.delete({ where: { id } });
    res.json({ 
      success: true,
      message: '标签删除成功' 
    });
  });

  // 批量删除标签
  const batchDeleteTagSchema = z.object({
    ids: z.array(z.string())
  });

  router.delete('/', validate(batchDeleteTagSchema), async (req, res) => {
    const { ids } = req.body;
    const bigIntIds = ids.map(id => BigInt(id));
    
    try {
      await prisma.tasktag.deleteMany({
        where: { id: { in: bigIntIds } }
      });
      
      res.json({
        success: true,
        message: '标签批量删除成功',
        data: {
          successCount: ids.length,
          failedCount: 0,
          failedIds: []
        }
      });
    } catch (error) {
      res.json({
        success: false,
        message: '标签批量删除失败',
        data: {
          successCount: 0,
          failedCount: ids.length,
          failedIds: ids
        }
      });
    }
  });

  // 获取标签使用统计
  router.get('/stats', async (req, res) => {
    try {
      const tags = await prisma.tasktag.findMany({
        include: {
          _count: {
            select: { tasktagrelationship: true }
          }
        }
      });
      
      const items = tags.map(tag => ({
        id: tag.id,
        name: tag.name,
        color: tag.color,
        usageCount: tag._count.tasktagrelationship,
        // lastUsedAt logic is complex without additional tracking, omitting for now or using updated_at
        lastUsedAt: tag.updated_at
      }));
      
      res.json({
        success: true,
        items
      });
    } catch (error) {
      console.error('获取标签统计失败:', error);
      res.status(500).json({
        success: false,
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务器内部错误'
      });
    }
  });

  // 合并标签
  const mergeTagSchema = z.object({
    sourceTagId: z.number().or(z.string()),
    targetTagId: z.number().or(z.string())
  });

  router.post('/merge', validate(mergeTagSchema), async (req, res) => {
    const { sourceTagId, targetTagId } = req.body;
    const sId = BigInt(sourceTagId);
    const tId = BigInt(targetTagId);
    
    if (sId === tId) {
      return res.status(400).json({ success: false, message: '源标签和目标标签不能相同' });
    }

    try {
      // 检查标签是否存在
      const sourceTag = await prisma.tasktag.findUnique({ where: { id: sId } });
      const targetTag = await prisma.tasktag.findUnique({ where: { id: tId } });
      
      if (!sourceTag || !targetTag) {
        return res.status(404).json({ success: false, message: '标签不存在' });
      }
      
      // 获取关联源标签的所有任务关系
      const sourceRelations = await prisma.tasktagrelationship.findMany({
        where: { tag_id: sId }
      });
      
      let mergedCount = 0;
      
      // 事务处理
      await prisma.$transaction(async (tx) => {
        for (const rel of sourceRelations) {
          // 检查该任务是否已有关联目标标签
          const exists = await tx.tasktagrelationship.findUnique({
            where: {
              task_id_tag_id: {
                task_id: rel.task_id,
                tag_id: tId
              }
            }
          });
          
          if (!exists) {
            // 如果没有，则将源关系改为目标标签
            // 注意：Prisma 不支持直接更新复合主键的一部分，需要先删后增，或者只增不删（如果源要保留）
            // 这里我们是合并，所以是新增目标关系
            await tx.tasktagrelationship.create({
              data: {
                task_id: rel.task_id,
                tag_id: tId
              }
            });
            
            // 更新 task 的 tags JSON 字段 (为了兼容性)
            const task = await tx.task.findUnique({ where: { id: rel.task_id } });
            if (task && task.tags) {
              const tags = Array.isArray(task.tags) ? task.tags : [];
              const newTags = tags.map(id => BigInt(id) === sId ? String(tId) : id).filter((v, i, a) => a.indexOf(v) === i);
              await tx.task.update({
                where: { id: rel.task_id },
                data: { tags: newTags }
              });
            }
            mergedCount++;
          }
        }
        
        // 删除源标签（级联删除关系）
        await tx.tasktag.delete({ where: { id: sId } });
      });
      
      res.json({
        success: true,
        message: `标签合并成功，共更新 ${mergedCount} 个任务`,
        data: { mergedCount }
      });
    } catch (error) {
      console.error('标签合并失败:', error);
      res.status(500).json({ success: false, message: '标签合并失败' });
    }
  });

  // 批量更新标签
  const batchUpdateTagSchema = z.object({
    ids: z.array(z.number().or(z.string())),
    data: z.object({
      color: z.string().optional(),
      name: z.string().optional()
    })
  });

  router.put('/batch', validate(batchUpdateTagSchema), async (req, res) => {
    const { ids, data } = req.body;
    const bigIntIds = ids.map(id => BigInt(id));
    
    try {
      const result = await prisma.tasktag.updateMany({
        where: { id: { in: bigIntIds } },
        data: {
          ...data,
          updated_at: new Date()
        }
      });
      
      res.json({
        success: true,
        message: `成功更新 ${result.count} 个标签`
      });
    } catch (error) {
      console.error('批量更新标签失败:', error);
      res.status(500).json({ success: false, message: '批量更新标签失败' });
    }
  });

  return router;
}