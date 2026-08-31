import { ChannelType, type AnyThreadChannel, type Message } from 'discord.js';
import type { Ctx } from '../service.js';
import { isStaff, rescanThread, runTriage, shouldRescan, starterInput } from '../service.js';
import * as repo from '../db/threads.js';
import { log } from '../logger.js';
import { scheduleBoardRefresh } from '../discord/board.js';
import { closedNotice, resolvedByUserNotice } from '../discord/render.js';
import { detectResolution, looksLikeResolution } from '../ai/resolution.js';

export const inSupportForum = (ctx: Ctx, thread: AnyThreadChannel): boolean =>
  thread.parentId === ctx.cfg.forum_channel_id;

export async function onThreadCreate(ctx: Ctx, thread: AnyThreadChannel): Promise<void> {
  if (!inSupportForum(ctx, thread)) return;
  if (thread.type !== ChannelType.PublicThread && thread.type !== ChannelType.PrivateThread) return;

  log.info('new support thread', { threadId: thread.id, title: thread.name });

  await repo.createThread({
    threadId: thread.id,
    guildId: thread.guildId,
    forumId: thread.parentId!,
    authorId: thread.ownerId ?? '0',
    title: thread.name,
    openedAt: thread.createdAt ?? new Date(),
  });

  await new Promise((r) => setTimeout(r, 1500));

  const input = await starterInput(thread);
  await runTriage(ctx, thread, input, { reason: 'created' });
}

export async function onMessage(ctx: Ctx, message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;
  const thread = message.channel;
  if (!inSupportForum(ctx, thread)) return;

  const tracked = await repo.getThread(thread.id);
  if (!tracked) return;

  const staff = isStaff(ctx.cfg, message.member);
  const isReporter = message.author.id === tracked.authorId;

  await repo.recordActivity(thread.id, staff ? 'staff' : 'user', message.createdAt);

  let resolved = false;
  if (
    ctx.cfg.resolution.enabled &&
    isReporter &&
    !staff &&
    tracked.status !== 'resolved' &&
    message.content.trim().length > 0 &&
    looksLikeResolution(ctx.cfg, message.content)
  ) {
    const detection = await detectResolution(ctx.cfg, {
      content: message.content,
      threadTitle: thread.name,
    });
    if (detection?.resolved) {
      await repo.markResolved(thread.id, {
        by: message.author.id,
        reason: 'user_stated',
        quote: detection.quote,
        at: message.createdAt,
      });
      await repo.logEvent(thread.id, 'resolved', message.author.id, {
        reason: 'user_stated',
        quote: detection.quote,
        confidence: detection.confidence,
      });
      await thread
        .send(resolvedByUserNotice(thread.id, detection.quote))
        .catch((err) => log.warn('could not post resolution notice', { threadId: thread.id, err }));
      log.info('thread resolved by reporter', {
        threadId: thread.id,
        confidence: detection.confidence,
      });
      resolved = true;

      if (ctx.cfg.resolution.archive) {
        await thread.setArchived(true).catch((err) =>
          log.warn('could not archive resolved thread', { threadId: thread.id, err }),
        );
      }
    }
  }

  scheduleBoardRefresh(ctx.client, ctx.cfg);

  const latest = await repo.getThread(thread.id);
  if (latest && !resolved && shouldRescan(ctx.cfg, latest)) {
    await rescanThread(ctx, thread, latest).catch((err) =>
      log.error('rescan failed', { threadId: thread.id, err }),
    );
  }
}

export async function handleClosedThread(
  ctx: Ctx,
  thread: AnyThreadChannel,
  reason: 'archived' | 'reconcile',
): Promise<void> {
  const tracked = await repo.getThread(thread.id);
  if (!tracked || tracked.status === 'resolved') return;

  log.info('closed thread was not resolved; resolving it', { threadId: thread.id, reason });

  await repo.markResolved(thread.id, { by: null, reason: 'thread_closed' });
  await repo.logEvent(thread.id, 'resolved', null, { reason: 'thread_closed', detected: reason });

  if (thread.locked) {
    log.info('thread is locked; resolving silently', { threadId: thread.id });
  } else {
    const sent = await thread.send(closedNotice(thread.id)).catch((err) => {
      log.warn('could not post closed-thread notice', { threadId: thread.id, err });
      return null;
    });
    if (sent) {
      await thread
        .setArchived(true)
        .catch((err) => log.warn('could not re-archive thread', { threadId: thread.id, err }));
    }
  }
  scheduleBoardRefresh(ctx.client, ctx.cfg);
}

export async function onThreadUpdate(
  ctx: Ctx,
  oldThread: AnyThreadChannel,
  newThread: AnyThreadChannel,
): Promise<void> {
  if (!inSupportForum(ctx, newThread)) return;

  if (!oldThread.archived && newThread.archived) {
    await handleClosedThread(ctx, newThread, 'archived');
    return;
  }
  if (oldThread.name !== newThread.name) {
    const tracked = await repo.getThread(newThread.id);
    if (tracked) scheduleBoardRefresh(ctx.client, ctx.cfg);
  }
}

export async function onThreadDelete(ctx: Ctx, thread: AnyThreadChannel): Promise<void> {
  if (!inSupportForum(ctx, thread)) return;
  const tracked = await repo.getThread(thread.id);
  if (!tracked) return;

  if (tracked.status !== 'resolved') {
    await repo.markResolved(thread.id, { by: null, reason: 'thread_deleted' });
  }
  await repo.logEvent(thread.id, 'deleted', null, { wasStatus: tracked.status });
  log.info('support thread deleted', { threadId: thread.id, wasStatus: tracked.status });
  scheduleBoardRefresh(ctx.client, ctx.cfg);
}
