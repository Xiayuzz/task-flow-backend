import { prisma } from '../db.js';

export const NOTIFICATION_TYPES = {
  TASK_ASSIGNED: 'task_assigned',
  TASK_DEADLINE: 'task_deadline',
  TASK_COMPLETED: 'task_completed',
  TASK_COMMENT: 'task_comment',
  GROUP_INVITATION: 'group_invitation',
  GROUP_TASK_ASSIGNED: 'group_task_assigned',
  SYSTEM_NOTIFICATION: 'system_notification'
};

export const toNotificationResponse = (notification) => ({
  id: notification.id,
  userId: Number(notification.user_id),
  type: notification.type,
  title: notification.title,
  content: notification.content,
  relatedId: notification.related_id ? Number(notification.related_id) : null,
  relatedType: notification.related_type,
  isRead: notification.is_read,
  createdAt: notification.created_at
});

export const toNotificationSocketPayload = (notification, extras = {}) => ({
  id: Number(notification.id),
  userId: Number(notification.user_id),
  type: notification.type,
  title: notification.title,
  content: notification.content,
  relatedId: notification.related_id ? Number(notification.related_id) : null,
  relatedType: notification.related_type,
  isRead: notification.is_read,
  createdAt: notification.created_at,
  ...extras
});

export const emitNotification = (io, notification, extras = {}) => {
  if (!io) return;
  io.to(`user:${notification.user_id}`).emit(
    'notification:new',
    toNotificationSocketPayload(notification, extras)
  );
};

export const createNotification = async ({
  userId,
  type,
  title,
  content,
  relatedId = null,
  relatedType = null,
  io = null,
  createdAt = new Date(),
  extras = {}
}) => {
  const notification = await prisma.notification.create({
    data: {
      user_id: BigInt(userId),
      type,
      title,
      content,
      related_id: relatedId ? BigInt(relatedId) : null,
      related_type: relatedType,
      is_read: false,
      created_at: createdAt
    }
  });

  emitNotification(io, notification, extras);
  return notification;
};

export const uniqueNotificationRecipients = (ids, actorId) => {
  const actor = actorId === undefined || actorId === null ? null : BigInt(actorId);
  return [
    ...new Set(
      ids
        .filter(Boolean)
        .map((id) => BigInt(id))
        .filter((id) => actor === null || id !== actor)
        .map(String)
    )
  ];
};

const taskTitle = (task) => `任务 "${task.title}"`;

export const notifyTaskAssigned = async ({ task, assigneeId, actorId, io }) => {
  const recipients = uniqueNotificationRecipients([assigneeId], actorId);
  const type = task.group_id
    ? NOTIFICATION_TYPES.GROUP_TASK_ASSIGNED
    : NOTIFICATION_TYPES.TASK_ASSIGNED;
  const title = task.group_id ? '群组任务分配' : '任务指派';

  await Promise.all(
    recipients.map((userId) =>
      createNotification({
        userId,
        type,
        title,
        content: `${taskTitle(task)} 已指派给你`,
        relatedId: task.id,
        relatedType: 'task',
        io
      })
    )
  );
};

export const notifyTaskCommented = async ({ task, actorId, io }) => {
  const recipients = uniqueNotificationRecipients([task.creator_id, task.assignee_id], actorId);
  await Promise.all(
    recipients.map((userId) =>
      createNotification({
        userId,
        type: NOTIFICATION_TYPES.TASK_COMMENT,
        title: '任务评论',
        content: `${taskTitle(task)} 有新评论`,
        relatedId: task.id,
        relatedType: 'task',
        io
      })
    )
  );
};

export const notifyTaskCompleted = async ({ task, actorId, io }) => {
  const recipients = uniqueNotificationRecipients([task.creator_id, task.assignee_id], actorId);
  await Promise.all(
    recipients.map((userId) =>
      createNotification({
        userId,
        type: NOTIFICATION_TYPES.TASK_COMPLETED,
        title: '任务完成',
        content: `${taskTitle(task)} 已完成`,
        relatedId: task.id,
        relatedType: 'task',
        io
      })
    )
  );
};
