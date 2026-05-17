import { authRoutes } from './auth.js';
import { userRoutes } from './users.js';
import { taskRoutes } from './tasks.js';
import { commentRoutes } from './comments.js';
import { historyRoutes } from './history.js';
import { statsRoutes } from './stats.js';
import { tagRoutes } from './tags.js';
import { menuRoutes } from './menus.js';
import { permissionRoutes } from './permissions.js';
import { groupRoutes } from './groups.js';
import { inboxRoutes } from './inbox.js';
import { settingsRoutes } from './settings.js';
import { reportRoutes } from './reports.js';
import { activityRoutes } from './activities.js';
import { filterRoutes } from './filters.js';
import { teamRoutes } from './team.js';
import { reminderRoutes } from './reminders.js';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import path from 'path';

export function registerRoutes(app) {
  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Swagger UI
  const specPath = path.join(process.cwd(), 'docs', 'openapi.yaml');
  try {
    const spec = YAML.load(specPath);
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
  } catch (e) {
    console.warn('[swagger] 无法加载 openapi.yaml:', e.message);
  }

  // API前缀路由
  app.use('/api/auth', authRoutes());
  app.use('/api/users', userRoutes());
  app.use('/api/tasks', taskRoutes());
  app.use('/api/comments', commentRoutes());
  app.use('/api/tasks', historyRoutes());
  app.use('/api/stats', statsRoutes());
  app.use('/api/task-tags', tagRoutes());
  app.use('/api/tags', tagRoutes());
  app.use('/api/menus', menuRoutes());
  app.use('/api', permissionRoutes());
  app.use('/api/groups', groupRoutes());
  app.use('/api/inbox', inboxRoutes());
  app.use('/api/settings', settingsRoutes());
  app.use('/api/reports', reportRoutes());
  app.use('/api/activities', activityRoutes());
  app.use('/api/saved-filters', filterRoutes());
  app.use('/api/team', teamRoutes());
  app.use('/api/reminders', reminderRoutes());
  // 保持原有路由兼容
  app.use('/auth', authRoutes());
  app.use('/users', userRoutes());
  app.use('/tasks', taskRoutes());
  app.use('/comments', commentRoutes());
  app.use('/tasks', historyRoutes());
  app.use('/stats', statsRoutes());
  app.use('/task-tags', tagRoutes());
  app.use('/tags', tagRoutes());
  app.use('/menus', menuRoutes());
  app.use('/', permissionRoutes());
  app.use('/groups', groupRoutes());
  app.use('/inbox', inboxRoutes());
  app.use('/settings', settingsRoutes());
  app.use('/reports', reportRoutes());
  app.use('/activities', activityRoutes());
  app.use('/saved-filters', filterRoutes());
  app.use('/team', teamRoutes());
  app.use('/reminders', reminderRoutes());
}
