import { prisma } from '../db.js';
import { emitNotification } from './notificationService.js';
import crypto from 'crypto';

const formatReminderTime = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const processReminders = async (io) => {
  const batchId = crypto.randomUUID();
  try {
    const now = new Date();

    const reminders = await prisma.taskreminder.findMany({
      where: {
        status: 'pending',
        reminder_time: { lte: now }
      },
      include: {
        task: true,
        user: { include: { user_settings: true } }
      }
    });

    if (reminders.length > 0) {
      console.log(`[Batch:${batchId}] Found ${reminders.length} pending reminders.`);
    }

    for (const reminder of reminders) {
      const traceId = crypto.randomUUID();
      try {
        console.log(`[Trace:${traceId}] Processing reminder ${reminder.id} for task ${reminder.task_id}`);

        if (reminder.user.status !== 'active') {
          console.log(`[Trace:${traceId}] Skipping: user ${reminder.user_id} is not active.`);
          await prisma.taskreminder.updateMany({
            where: { id: reminder.id, status: 'pending' },
            data: { status: 'skipped' }
          });
          continue;
        }

        const notificationData = {
          user_id: reminder.user_id,
          type: 'reminder',
          title: '任务提醒',
          content: `任务 "${reminder.task.title}" 的提醒时间已到（提醒时间：${formatReminderTime(reminder.reminder_time)}）`,
          related_id: reminder.task_id,
          related_type: 'task',
          is_read: false,
          created_at: now
        };

        // 事务内原子抢占 + 写收件箱：保证同一条 reminder 不会被并发重复处理；
        // 抢占失败（updateMany.count === 0）说明已被其他进程消费，跳过本轮副作用。
        const notification = await prisma.$transaction(async (tx) => {
          const updateResult = await tx.taskreminder.updateMany({
            where: { id: reminder.id, status: 'pending' },
            data: { status: 'sent', sent_at: now }
          });
          if (updateResult.count === 0) return null;

          return tx.notification.create({ data: notificationData });
        });

        if (!notification) {
          console.log(`[Trace:${traceId}] Reminder ${reminder.id} already claimed by another worker.`);
          continue;
        }

        emitNotification(io, notification, { traceId });

        if (reminder.reminder_type === 'email') {
          const emailEnabled =
            reminder.user.user_settings?.preferences?.notifications?.email !== false;
          if (emailEnabled) {
            // TODO: Implement Email Sending
            console.log(`[Trace:${traceId}] [Mock] Sending email to ${reminder.user.email}`);
          } else {
            console.log(`[Trace:${traceId}] Email disabled by user preference; inbox only.`);
          }
        }

        console.log(`[Trace:${traceId}] Successfully processed reminder ${reminder.id}`);
      } catch (err) {
        console.error(`[Trace:${traceId}] Failed to process reminder ${reminder.id}:`, err);
        await prisma.taskreminder.updateMany({
          where: { id: reminder.id, status: 'pending' },
          data: { status: 'failed' }
        });
      }
    }
  } catch (error) {
    console.error(`[Batch:${batchId}] Error processing reminders:`, error);
  }
};
