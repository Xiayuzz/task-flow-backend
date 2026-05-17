import express from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../utils/auth.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

export function settingsRoutes() {
  const router = express.Router();
  router.use(authMiddleware());

  // 获取用户偏好设置
  router.get('/preferences', async (req, res) => {
    const userId = BigInt(req.user.id);
    const settings = await prisma.user_settings.findUnique({
      where: { user_id: userId }
    });

    if (!settings) {
      // Return defaults if not found
      return res.json({
        success: true,
        data: {
          theme: "light",
          language: "zh-CN",
          timezone: "Asia/Shanghai",
          notifications: {
            email: true,
            browser: true,
            dailyDigest: false
          },
          defaultView: "list"
        }
      });
    }

    res.json({
      success: true,
      data: settings.preferences
    });
  });

  // 更新用户偏好设置
  const updatePreferencesSchema = z.object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    language: z.string().optional(),
    timezone: z.string().optional(),
    notifications: z.object({
      email: z.boolean().optional(),
      browser: z.boolean().optional(),
      dailyDigest: z.boolean().optional()
    }).optional(),
    defaultView: z.enum(['list', 'board', 'calendar']).optional()
  });

  router.put('/preferences', validate(updatePreferencesSchema), async (req, res) => {
    const userId = BigInt(req.user.id);
    const updates = req.body;

    // Get existing or create default
    let settings = await prisma.user_settings.findUnique({
      where: { user_id: userId }
    });

    let currentPreferences = settings ? settings.preferences : {
      theme: "light",
      language: "zh-CN",
      timezone: "Asia/Shanghai",
      notifications: {
        email: true,
        browser: true,
        dailyDigest: false
      },
      defaultView: "list"
    };

    // Deep merge for notifications
    const newPreferences = {
      ...currentPreferences,
      ...updates,
      notifications: {
        ...(currentPreferences.notifications || {}),
        ...(updates.notifications || {})
      }
    };

    if (settings) {
      await prisma.user_settings.update({
        where: { user_id: userId },
        data: { preferences: newPreferences }
      });
    } else {
      await prisma.user_settings.create({
        data: {
          user_id: userId,
          preferences: newPreferences
        }
      });
    }

    res.json({
      success: true,
      message: "设置已更新",
      data: newPreferences
    });
  });

  return router;
}
