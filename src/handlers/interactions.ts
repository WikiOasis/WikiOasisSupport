import { MessageFlags, type ButtonInteraction } from 'discord.js';
import type { Ctx } from '../service.js';
import { closeResolvedThread, isStaff, refreshThread, runTriage, starterInput } from '../service.js';
import * as repo from '../db/threads.js';
import { log } from '../logger.js';
import { scheduleBoardRefresh } from '../discord/board.js';
import { V2_FLAGS, container, text } from '../discord/components.js';

const ephemeral = (body: string) => ({
  components: [container(null, text(body))],
  flags: V2_FLAGS | MessageFlags.Ephemeral,
});

export async function onButton(ctx: Ctx, interaction: ButtonInteraction): Promise<void> {
  const [ns, action, threadId] = interaction.customId.split(':');
  if (ns !== 'triage' || !action || !threadId) return;

  const tracked = await repo.getThread(threadId);
  if (!tracked) {
    await interaction.reply(ephemeral('That thread is not tracked any more.'));
    return;
  }

  const thread = await ctx.client.channels.fetch(threadId).catch(() => null);
  if (!thread?.isThread()) {
    await interaction.reply(ephemeral('That thread no longer exists.'));
    return;
  }

  const staff = isStaff(ctx.cfg, interaction.member as never);
  const isReporter = interaction.user.id === tracked.authorId;

  const reporterAction = action === 'notresolved';
  if (!staff && !(reporterAction && isReporter)) {
    await interaction.reply(ephemeral('That control is for the support team.'));
    return;
  }

  await interaction.deferUpdate();

  switch (action) {
    case 'claim': {
      const next = tracked.claimedBy === interaction.user.id ? null : interaction.user.id;
      await repo.setClaim(threadId, next);
      await repo.logEvent(threadId, next ? 'claimed' : 'released', interaction.user.id);
      break;
    }
    case 'waituser': {
      await repo.setStatus(threadId, 'waiting_on_user');
      await repo.logEvent(threadId, 'status', interaction.user.id, 'waiting_on_user');
      break;
    }
    case 'resolve': {
      await repo.markResolved(threadId, { by: interaction.user.id, reason: 'staff' });
      await repo.logEvent(threadId, 'resolved', interaction.user.id, { reason: 'staff' });
      break;
    }
    case 'reopen':
    case 'notresolved': {
      await repo.reopen(threadId);
      await repo.logEvent(threadId, 'reopened', interaction.user.id, { via: action });
      log.info('thread reopened', { threadId, by: interaction.user.id });
      break;
    }
    case 'retriage': {
      await runTriage(ctx, thread, await starterInput(thread), {
        reason: 'retriage',
        actorId: interaction.user.id,
      });
      return;
    }
    default:
      return;
  }

  const after = await repo.getThread(threadId);
  if (after) await refreshThread(ctx, thread, after);
  else scheduleBoardRefresh(ctx.client, ctx.cfg);

  if (action === 'resolve') await closeResolvedThread(ctx, thread);
}
