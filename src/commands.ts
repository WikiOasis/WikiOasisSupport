import {
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js';
import type { Config } from './config.js';
import type { Ctx } from './service.js';
import { isStaff, refreshThread, runTriage, starterInput } from './service.js';
import * as repo from './db/threads.js';
import { log } from './logger.js';
import { renderBoard } from './discord/board.js';
import { V2_FLAGS, container, text } from './discord/components.js';
import { buildKnownIssueCommand, onKnownIssueCommand } from './commands/knownIssues.js';
import { conversationInput } from './service.js';

const reply = (body: string) => ({
  components: [container(null, text(body))],
  flags: V2_FLAGS | MessageFlags.Ephemeral,
});

export function buildCommands(cfg: Config) {
  const cats = cfg.categories.slice(0, 25).map((c) => ({ name: c.name, value: c.key }));
  const teams = cfg.teams.filter((t) => !t.hidden).slice(0, 25).map((t) => ({ name: t.name, value: t.key }));
  const prios = cfg.priorities.slice(0, 25).map((p) => ({ name: p.name, value: p.key }));

  const triage = new SlashCommandBuilder()
    .setName('triage')
    .setDescription('Support triage controls')
    .addSubcommand((s) =>
      s.setName('board').setDescription('Rebuild the triage board now'),
    )
    .addSubcommand((s) =>
      s.setName('retriage').setDescription('Re-run the classifier on this thread'),
    )
    .addSubcommand((s) =>
      s.setName('resolve').setDescription('Mark this thread resolved'),
    )
    .addSubcommand((s) => s.setName('reopen').setDescription('Reopen this thread'))
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Override the classification on this thread')
        .addStringOption((o) =>
          o.setName('priority').setDescription('Priority').addChoices(...prios),
        )
        .addStringOption((o) =>
          o.setName('category').setDescription('Category (replaces all)').addChoices(...cats),
        )
        .addStringOption((o) =>
          o.setName('team').setDescription('Team (replaces all)').addChoices(...teams),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('rescan')
        .setDescription('Re-read this whole thread now and update its categories'),
    )
    .addSubcommand((s) =>
      s.setName('status').setDescription('Show what the bot knows about this thread'),
    );

  return [triage.toJSON(), buildKnownIssueCommand()];
}

export async function registerCommands(client: Client, cfg: Config, token: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(client.application!.id, cfg.guild_id), {
    body: buildCommands(cfg),
  });
  log.info('slash commands registered', { guildId: cfg.guild_id });
}

export async function onCommand(ctx: Ctx, interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === 'knownissue') {
    await onKnownIssueCommand(ctx, interaction);
    return;
  }
  if (interaction.commandName !== 'triage') return;

  if (!isStaff(ctx.cfg, interaction.member as never)) {
    await interaction.reply(reply('These commands are for the support team.'));
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'board') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await renderBoard(ctx.client, ctx.cfg);
    await interaction.editReply(reply('Board rebuilt.'));
    return;
  }

  const thread = interaction.channel;
  if (!thread?.isThread() || thread.parentId !== ctx.cfg.forum_channel_id) {
    await interaction.reply(reply('Run this inside a thread in the support forum.'));
    return;
  }
  const tracked = await repo.getThread(thread.id);
  if (!tracked) {
    await interaction.reply(reply('This thread is not tracked. `/triage retriage` will adopt it.'));
    if (sub !== 'retriage') return;
  }

  switch (sub) {
    case 'retriage': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!tracked) {
        await repo.createThread({
          threadId: thread.id,
          guildId: thread.guildId,
          forumId: ctx.cfg.forum_channel_id,
          authorId: thread.ownerId ?? '0',
          title: thread.name,
          openedAt: thread.createdAt ?? new Date(),
        });
      }
      const result = await runTriage(ctx, thread, await starterInput(thread), {
        reason: 'retriage',
        actorId: interaction.user.id,
      });
      await interaction.editReply(
        reply(result?.priority ? `Re-triaged as **${result.priority}**.` : 'Re-triage produced no result — the model was unavailable.'),
      );
      return;
    }

    case 'rescan': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const t = tracked!;
      const before = t.categories;
      const input = await conversationInput(ctx, thread, {
        categories: t.categories,
        teams: t.teams,
        priority: t.priority,
      });
      const after = await runTriage(ctx, thread, input, {
        reason: 'rescan',
        actorId: interaction.user.id,
      });
      const names = (keys: string[]) => keys.join(', ') || 'none';
      await interaction.editReply(
        reply(
          after
            ? `Re-read the thread. Categories: ${names(before)} → **${names(after.categories)}**`
            : 'Rescan produced no result — the model was unavailable.',
        ),
      );
      return;
    }

    case 'resolve': {
      await repo.markResolved(thread.id, { by: interaction.user.id, reason: 'staff' });
      await repo.logEvent(thread.id, 'resolved', interaction.user.id, { reason: 'staff' });
      break;
    }

    case 'reopen': {
      await repo.reopen(thread.id);
      await repo.logEvent(thread.id, 'reopened', interaction.user.id, { via: 'command' });
      break;
    }

    case 'set': {
      const priority = interaction.options.getString('priority');
      const category = interaction.options.getString('category');
      const team = interaction.options.getString('team');
      if (!priority && !category && !team) {
        await interaction.reply(reply('Give at least one of priority, category or team.'));
        return;
      }
      await repo.setLabels(thread.id, {
        ...(priority ? { priority } : {}),
        ...(category ? { categories: [category] } : {}),
        ...(team ? { teams: [team] } : {}),
      });
      await repo.logEvent(thread.id, 'override', interaction.user.id, { priority, category, team });
      break;
    }

    case 'status': {
      const t = await repo.getThread(thread.id);
      if (!t) {
        await interaction.reply(reply('Not tracked.'));
        return;
      }
      await interaction.reply(
        reply(
          [
            `**Priority** ${t.priority ?? '—'}`,
            `**Categories** ${t.categories.join(', ') || '—'}`,
            `**Teams** ${t.teams.join(', ') || '—'}`,
            `**Status** ${t.status}`,
            t.knownIssueId != null ? `**Known issue** #${t.knownIssueId}` : '',
            `**Claimed by** ${t.claimedBy ? `<@${t.claimedBy}>` : '—'}`,
            `**First staff reply** ${t.firstStaffAt ? `<t:${Math.floor(t.firstStaffAt.getTime() / 1000)}:R>` : 'none yet'}`,
            `**Confidence** ${t.confidence !== null ? `${(t.confidence * 100).toFixed(0)}%` : '—'}`,
            t.manualOverride ? '_Manually overridden._' : '',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
      return;
    }

    default:
      return;
  }

  const after = await repo.getThread(thread.id);
  if (after) await refreshThread(ctx, thread, after);
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply(reply('Done.'));
  }
}
