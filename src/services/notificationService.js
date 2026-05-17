import { prisma } from '../db.js';

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
  type: notification.type,
  title: notification.title,
  content: notification.content,
  relatedId: notification.related_id ? Number(notification.related_id) : null,
  relatedType: notification.related_type,
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
