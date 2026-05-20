import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { Server } from 'socket.io';
import './utils/asyncErrorPatch.js';
import { registerRoutes } from './routes/index.js';
import { errorHandler, notFound } from './utils/error.js';
import { verifySocketAuth } from './utils/socketAuth.js';
import { prisma } from './db.js';
import { processReminders } from './services/reminderService.js';
import {
  notifyTaskAssigned,
  notifyTaskCommented,
  notifyTaskCompleted
} from './services/notificationService.js';
import path from 'path';
import expressStatic from 'express';

const app = express();

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

// BigInt JSON serialization
// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function() { return Number(this.toString()); };
app.use(helmet());
app.use(cors());
app.use(express.json());
// serve uploaded static files (avatars)
app.use('/uploads', (req, res, next) => {
  // allow cross-origin image/resource loads and simple CORS for image fetches
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}, expressStatic.static(path.join(process.cwd(), 'public', 'uploads')));
app.use(morgan('dev'));

registerRoutes(app);
app.use(notFound);
app.use(errorHandler);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  path: '/ws'
});

io.use(verifySocketAuth);

io.on('connection', (socket) => {
  // Join user room for targeted notifications
  if (socket.user && socket.user.id) {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);
    // console.log(`User ${userId} joined room user:${userId}`);
  }

  // simple hooks placeholder
  socket.on('disconnect', () => {});

  // inbound: client requests to update a task (partial)
  socket.on('task:update', async (payload, ack) => {
    try {
      const user = socket.user;
      const id = BigInt(payload.id);
      const task = await prisma.task.findFirst({ where: { id, deleted_at: null } });
      if (!task) return ack && ack({ error: 'NOT_FOUND' });
      const canAccess = user.role === 'admin' || user.id === Number(task.creator_id) || (task.assignee_id && user.id === Number(task.assignee_id));
      if (!canAccess) return ack && ack({ error: 'FORBIDDEN' });
      const updatable = ['title', 'description', 'assignee_id', 'status', 'priority', 'due_date', 'progress'];
      const data = {};
      for (const k of updatable) {
        if (payload[k] !== undefined) {
          if (k === 'assignee_id') data.assignee_id = payload[k] ? BigInt(payload[k]) : null;
          else if (k === 'due_date') data.due_date = payload[k] ? new Date(payload[k]) : null;
          else data[k] = payload[k];
        }
      }
      const updated = await prisma.task.update({ where: { id }, data });
      // record simple history
      await prisma.taskhistory.create({ data: { task_id: id, user_id: BigInt(user.id), field: 'socket_update', old_value: null, new_value: JSON.stringify(data) } });
      io.emit('task:update', updated);
      if (data.assignee_id !== undefined && updated.assignee_id && updated.assignee_id !== task.assignee_id) {
        await notifyTaskAssigned({
          task: updated,
          assigneeId: updated.assignee_id,
          actorId: user.id,
          io
        });
      }
      if (data.status !== undefined && task.status !== 'done' && updated.status === 'done') {
        await notifyTaskCompleted({
          task: updated,
          actorId: user.id,
          io
        });
      }
      ack && ack({ ok: true, task: updated });
    } catch (e) {
      ack && ack({ error: 'SERVER_ERROR', message: e.message });
    }
  });

  // inbound: client creates a comment
  socket.on('comment:create', async (payload, ack) => {
    try {
      const user = socket.user;
      const taskId = BigInt(payload.taskId);
      const task = await prisma.task.findFirst({ where: { id: taskId, deleted_at: null } });
      if (!task) return ack && ack({ error: 'NOT_FOUND' });
      const canAccess = user.role === 'admin' || user.id === Number(task.creator_id) || (task.assignee_id && user.id === Number(task.assignee_id));
      if (!canAccess) return ack && ack({ error: 'FORBIDDEN' });
      if (!payload.content) return ack && ack({ error: 'BAD_REQUEST', message: 'content required' });
      let parent = null;
      if (payload.parentId) {
        parent = await prisma.comment.findFirst({ where: { id: BigInt(payload.parentId), deleted_at: null } });
        if (!parent) return ack && ack({ error: 'BAD_REQUEST', message: 'parent comment not found' });
      }
      const now = new Date();
      const comment = await prisma.comment.create({
        data: { task_id: taskId, user_id: BigInt(user.id), content: payload.content, parent_id: payload.parentId ? BigInt(payload.parentId) : undefined, created_at: now, updated_at: now },
        include: { user: { select: commentUserSelect } }
      });
      const formattedComment = toCommentResponse(comment);
      io.emit('comment:new', formattedComment);
      await notifyTaskCommented({
        task,
        actorId: user.id,
        recipientIds: parent ? [parent.user_id] : [],
        io
      });
      ack && ack({ ok: true, comment: formattedComment });
    } catch (e) {
      ack && ack({ error: 'SERVER_ERROR', message: e.message });
    }
  });
});

app.set('io', io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`TaskFlow backend listening on :${PORT}`);
  
  // Start reminder scheduler (check every 30 seconds)
  console.log('Starting reminder scheduler...');
  setInterval(() => {
    processReminders(io);
  }, 30 * 1000);
});
