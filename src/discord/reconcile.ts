import type { AnyThreadChannel, Client } from 'discord.js';
import { ChannelType } from 'discord.js';
import type { Ctx } from '../service.js';
import { runTriage, starterInput } from '../service.js';
import * as repo from '../db/threads.js';
import { log } from '../logger.js';
import { handleClosedThread } from '../handlers/threads.js';
import { renderBoard } from './board.js';

const UNKNOWN_CHANNEL = 10003;

const isUnknownChannel = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === UNKNOWN_CHANNEL;

export async function reconcile(ctx: Ctx): Promise<void> {
  const open = await repo.listUnresolved(ctx.cfg.forum_channel_id);
  log.info('reconciling', { open: open.length });

  let closed = 0;
  let deleted = 0;

  for (const t of open) {
    let thread: AnyThreadChannel | null = null;
    try {
      const ch = await ctx.client.channels.fetch(t.threadId);
      thread = ch?.isThread() ? ch : null;
    } catch (err) {
      if (isUnknownChannel(err)) {
        await repo.markResolved(t.threadId, { by: null, reason: 'thread_deleted' });
        await repo.logEvent(t.threadId, 'deleted', null, { detected: 'reconcile' });
        log.info('thread no longer exists; marked resolved', { threadId: t.threadId });
        deleted++;
        continue;
      }
      log.warn('could not fetch thread during reconcile; leaving it alone', {
        threadId: t.threadId,
        err,
      });
      continue;
    }

    if (!thread) continue;
    if (thread.archived) {
      await handleClosedThread(ctx, thread, 'reconcile');
      closed++;
    }
  }

  if (ctx.cfg.reconcile.backfill) await backfill(ctx);

  log.info('reconcile complete', { closed, deleted });
  await renderBoard(ctx.client, ctx.cfg).catch((err) => log.error('board render failed', { err }));
}

async function backfill(ctx: Ctx): Promise<void> {
  const forum = await ctx.client.channels.fetch(ctx.cfg.forum_channel_id).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) return;

  const active = await forum.threads.fetchActive().catch(() => null);
  if (!active) return;

  let done = 0;
  for (const thread of active.threads.values()) {
    if (done >= ctx.cfg.reconcile.backfill_limit) {
      log.info('backfill limit reached; remaining threads will be picked up next sweep');
      break;
    }
    if (thread.archived) continue;
    if (await repo.getThread(thread.id)) continue;

    log.info('backfilling untriaged thread', { threadId: thread.id, title: thread.name });
    await repo.createThread({
      threadId: thread.id,
      guildId: thread.guildId,
      forumId: ctx.cfg.forum_channel_id,
      authorId: thread.ownerId ?? '0',
      title: thread.name,
      openedAt: thread.createdAt ?? new Date(),
    });
    await runTriage(ctx, thread, await starterInput(thread), { reason: 'created' });
    done++;
  }
}

export function startReconcileTimer(ctx: Ctx): NodeJS.Timeout {
  const t = setInterval(
    () => void reconcile(ctx).catch((err) => log.error('reconcile failed', { err })),
    ctx.cfg.reconcile.interval_minutes * 60_000,
  );
  t.unref?.();
  return t;
}

export type { Client };
