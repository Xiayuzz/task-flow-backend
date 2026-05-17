# TaskFlow Backend

基于 **Express + Prisma + Socket.IO + MySQL** 的任务管理系统后端，提供 REST API 与 WebSocket 实时通信能力，覆盖任务协作、提醒、统计、团队/分组、通知中心等完整业务模块。

## 技术栈

- **运行时**：Node.js ≥ 18，ES Module
- **Web 框架**：Express 4 + `express-async-errors`
- **ORM**：Prisma 5（MySQL 8）
- **实时通信**：Socket.IO 4（路径 `/ws`）
- **鉴权**：JWT（`jsonwebtoken`） + `bcryptjs`
- **校验**：Zod
- **安全/日志**：Helmet、CORS、Morgan
- **文件上传**：Multer（头像与任务附件）
- **API 文档**：Swagger UI（基于 `docs/openapi.yaml`）

## 目录结构

```
task-flow-backend/
├── src/
│   ├── server.js            # 入口：HTTP + Socket.IO
│   ├── db.js                # Prisma Client 单例
│   ├── routes/              # 17 个业务路由模块
│   ├── services/            # 提醒等后台任务
│   ├── middleware/          # 校验中间件
│   └── utils/               # JWT、错误处理、Socket 鉴权等
├── prisma/schema.prisma     # 数据库模型定义
├── scripts/
│   ├── full-schema.sql      # 完整建表 SQL
│   └── seed-admin.js        # 初始化默认管理员
├── docs/                    # OpenAPI 与接口文档
├── public/uploads/          # 静态资源（头像、附件）
└── .env                     # 环境变量
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 准备数据库

使用 Navicat 或 mysql 命令行执行 `scripts/full-schema.sql` 创建数据库与全部表结构（默认库名 `taskflow_app`）。

### 3. 配置环境变量

项目根目录已包含 `.env`，按需修改：

```env
PORT=3000
NODE_ENV=development
DATABASE_URL="mysql://root:123456@localhost:3306/taskflow_app?charset=utf8mb4"
JWT_SECRET=change_me_dev_secret
JWT_EXPIRES=7d
BCRYPT_SALT_ROUNDS=10
```

可选：`PASSWORD_RESET_EXPIRES_MINUTES`（密码重置 token 有效期，默认 30 分钟）、`ADMIN_EMAIL`（种子管理员邮箱）。

### 4. 生成 Prisma Client 并初始化管理员

```bash
npx prisma generate
npm run seed:admin     # 默认账号：admin@example.com / 123456
```

### 5. 启动服务

```bash
npm run dev            # 开发模式（node --watch 热重载）
# 或
npm start              # 生产模式
```

访问 [http://localhost:3000/docs](http://localhost:3000/docs) 查看 Swagger UI，[http://localhost:3000/healthz](http://localhost:3000/healthz) 做健康检查。

## NPM 脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务（带 `--watch` 热重载） |
| `npm start` | 生产模式启动 |
| `npm run lint` | ESLint 代码检查 |
| `npm run prisma:gen` | 生成 Prisma Client |
| `npm run prisma:migrate` | 开发环境迁移 |
| `npm run prisma:deploy` | 生产环境部署迁移 |
| `npm run seed:admin` | 创建默认管理员账号 |

## 业务模块

REST API 同时挂载在 `/api/*` 与 `/*` 两个前缀下，便于新旧客户端兼容。主要模块：

| 模块 | 前缀 | 主要能力 |
|------|------|----------|
| 认证 | `/auth` | 注册、登录、忘记/重置密码、个人资料 |
| 用户 | `/users` | 个人信息、头像上传、用户搜索、CRUD、通知偏好、负载查询 |
| 任务 | `/tasks` | 增删改查、批量操作、指派、进度、标签、附件、提醒、评论、历史 |
| 评论 | `/comments` | 评论删除（创建在任务模块下） |
| 标签 | `/tags`、`/task-tags` | CRUD、统计、合并、批量操作 |
| 分组 | `/groups` | 项目/分组管理、成员管理、分组下任务 |
| 团队 | `/team` | 团队成员视图 |
| 通知中心 | `/inbox` | 通知列表、标记已读、未读数 |
| 提醒 | `/reminders` | 用户级提醒查询/创建/删除 |
| 设置 | `/settings` | 用户偏好（主题、语言等） |
| 菜单/权限 | `/menus`、`/roles`、`/users/:id/permissions` | 菜单与角色权限管理 |
| 统计 | `/stats` | 任务概览、趋势、完成耗时、优先级、标签分布、用户绩效 |
| 报表 | `/reports` | 综合报表、趋势、团队绩效 |
| 已存筛选 | `/saved-filters` | 用户自定义筛选方案 |
| 活动流 | `/activities` | 系统活动日志 |

详细接口请查看 Swagger UI 或 [`docs/openapi.yaml`](docs/openapi.yaml)。

## 鉴权

- 所有受保护接口需在 `Authorization` 头中携带 `Bearer <token>`
- 中间件：`authMiddleware()` 验签、`requireAdmin` 限管理员、`canModifyUser` 限本人或管理员
- WebSocket 连接需在握手时通过 `auth: { token }` 传入 JWT，由 `verifySocketAuth` 校验

## WebSocket 实时通信

- 路径：`/ws`
- 连接成功后，用户自动加入 `user:${userId}` 房间，便于精准推送
- **入站事件**：`task:update`（更新任务）、`comment:create`（创建评论）
- **出站事件**：`task:update`、`comment:new`、`task:deleted`、`comment:deleted`、`reminder:notify`

服务端通过 `app.set('io', io)` 暴露 Socket.IO 实例，路由内可用 `req.app.get('io')` 获取并主动推送。

## 提醒调度

`src/services/reminderService.js` 在服务启动时通过 `setInterval` 每 **30 秒** 扫描一次 `taskreminder` 表中到期的待发送提醒，命中后通过 Socket.IO 向对应用户房间发送 `reminder:notify`，并更新提醒状态。

## 数据访问与软删除

- Prisma Client 在 [`src/db.js`](src/db.js) 中导出为 `prisma`
- 所有 ID 字段为 `BigInt`，已通过 `BigInt.prototype.toJSON` 全局序列化为 number（见 [`src/server.js:21`](src/server.js#L21)）
- 任务（`task`）与评论（`comment`）使用 `deleted_at` 字段实现软删除，查询时需手动过滤 `deleted_at: null`

## 文件上传

- 静态目录：`public/uploads`
- 访问 URL：`/uploads/<文件名>`
- 已配置 `Cross-Origin-Resource-Policy: cross-origin`，便于前端跨域加载头像与附件

## 错误处理

- `express-async-errors` 自动捕获 async 错误
- 自定义错误类 [`AppError`](src/utils/error.js) 统一抛出业务异常
- 错误响应格式：`{ code, message }`

## 开发约定

- 所有协作沟通使用中文
- 数据库连接默认：`mysql://root:123456@localhost:3306/taskflow_app?charset=utf8mb4`
- 密码重置 token 默认 30 分钟过期，可通过环境变量 `PASSWORD_RESET_EXPIRES_MINUTES` 调整

## 相关文档

- Swagger UI：[`/docs`](http://localhost:3000/docs)（运行时）
- OpenAPI 规范：[`docs/openapi.yaml`](docs/openapi.yaml)
- 接口说明：[`docs/api-interface.md`](docs/api-interface.md) 等
- 提醒系统事故复盘：[`docs/incident-report-reminders.md`](docs/incident-report-reminders.md)
- 后端问题清单：[`docs/后端问题清单.md`](docs/后端问题清单.md)
