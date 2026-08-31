import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Ctx } from '../service.js';
import { isStaff } from '../service.js';
import * as ki from '../db/knownIssues.js';
import { logEvent } from '../db/threads.js';
import { log } from '../logger.js';
import { knownIssueResolvedNotice } from '../discord/render.js';
import { scheduleBoardRefresh } from '../discord/board.js';
import { V2_FLAGS, container, separator, text, truncate } from '../discord/components.js';

const reply = (body: string) => ({
  components: [container(null, text(body))],
  flags: V2_FLAGS | MessageFlags.Ephemeral,
});

export function buildKnownIssueCommand() {
  return new SlashCommandBuilder()
    .setName('knownissue')
    .setDescription('Manage the list of known issues the bot matches new threads against')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add a known issue')
        .addStringOption((o) =>
          o
            .setName('title')
            .setDescription('Short name, shown to reporters')
            .setRequired(true)
            .setMaxLength(120),
        )
        .addStringOption((o) =>
          o
            .setName('description')
            .setDescription('The symptoms people will report, this is what threads are matched against')
            .setRequired(true)
            .setMaxLength(2000),
        )
        .addStringOption((o) =>
          o
            .setName('advice')
            .setDescription('Optional: a workaround, or what to expect')
            .setMaxLength(1000),
        )
        .addStringOption((o) =>
          o.setName('url').setDescription('Optional: link to the task, incident or status page'),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List known issues'))
    .addSubcommand((s) =>
      s
        .setName('show')
        .setDescription('Show one known issue in full')
        .addIntegerOption((o) => o.setName('id').setDescription('Issue id').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Change a known issue')
        .addIntegerOption((o) => o.setName('id').setDescription('Issue id').setRequired(true))
        .addStringOption((o) => o.setName('title').setDescription('New title').setMaxLength(120))
        .addStringOption((o) =>
          o.setName('description').setDescription('New description').setMaxLength(2000),
        )
        .addStringOption((o) => o.setName('advice').setDescription('New advice').setMaxLength(1000))
        .addStringOption((o) => o.setName('url').setDescription('New link')),
    )
    .addSubcommand((s) =>
      s
        .setName('resolve')
        .setDescription('Retire an issue and update the threads waiting on it')
        .addIntegerOption((o) => o.setName('id').setDescription('Issue id').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('reopen')
        .setDescription('Make a retired issue active again')
        .addIntegerOption((o) => o.setName('id').setDescription('Issue id').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Delete an issue outright (threads that matched it keep their history)')
        .addIntegerOption((o) => o.setName('id').setDescription('Issue id').setRequired(true)),
    )
    .toJSON();
}

export async function onKnownIssueCommand(
  ctx: Ctx,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!isStaff(ctx.cfg, interaction.member as never)) {
    await interaction.reply(reply('Known issues are managed by the support team.'));
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const id = await ki.addKnownIssue({
      title: interaction.options.getString('title', true),
      description: interaction.options.getString('description', true),
      advice: interaction.options.getString('advice'),
      url: interaction.options.getString('url'),
      createdBy: interaction.user.id,
    });
    log.info('known issue added', { id, by: interaction.user.id });
    await interaction.reply(
      reply(
        `Added known issue **#${id}**. New threads matching it will be told it is known ` +
          'and asked to wait.\n-# Threads already open are not matched retroactively.',
      ),
    );
    return;
  }

  if (sub === 'list') {
    const issues = await ki.listKnownIssues(false);
    if (!issues.length) {
      await interaction.reply(reply('No known issues. `/knownissue add` creates one.'));
      return;
    }
    const counts = await ki.threadCounts();
    const active = issues.filter((i) => i.active);
    const retired = issues.filter((i) => !i.active);

    const line = (i: ki.KnownIssue) =>
      `- \`#${i.id}\` **${truncate(i.title, 60)}** — ${counts.get(i.id) ?? 0} thread${
        (counts.get(i.id) ?? 0) === 1 ? '' : 's'
      }`;

    const c = container(null, text(`## Known issues`));
    if (active.length) {
      c.addSeparatorComponents(separator());
      c.addTextDisplayComponents(text(`### Active — ${active.length}\n${active.map(line).join('\n')}`));
    }
    if (retired.length) {
      c.addSeparatorComponents(separator());
      c.addTextDisplayComponents(
        text(`### Retired — ${retired.length}\n${retired.slice(0, 15).map(line).join('\n')}`),
      );
    }
    await interaction.reply({ components: [c], flags: V2_FLAGS | MessageFlags.Ephemeral });
    return;
  }

  const id = interaction.options.getInteger('id', true);
  const issue = await ki.getKnownIssue(id);
  if (!issue) {
    await interaction.reply(reply(`No known issue with id \`#${id}\`.`));
    return;
  }

  switch (sub) {
    case 'show': {
      const threads = await ki.threadsForIssue(id, false);
      await interaction.reply(
        reply(
          [
            `## #${issue.id} — ${issue.title}`,
            issue.active ? '**Active**' : `**Retired**`,
            '',
            issue.description,
            issue.advice ? `\n**Advice**\n${issue.advice}` : '',
            issue.url ? `\n${issue.url}` : '',
            `\n-# ${threads.length} thread${threads.length === 1 ? '' : 's'} matched · added by <@${issue.createdBy}>`,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
      return;
    }

    case 'edit': {
      const patch: Parameters<typeof ki.editKnownIssue>[1] = {};
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const advice = interaction.options.getString('advice');
      const url = interaction.options.getString('url');
      if (title !== null) patch.title = title;
      if (description !== null) patch.description = description;
      if (advice !== null) patch.advice = advice;
      if (url !== null) patch.url = url;
      if (Object.keys(patch).length === 0) {
        await interaction.reply(reply('Give at least one field to change.'));
        return;
      }
      await ki.editKnownIssue(id, patch);
      await interaction.reply(reply(`Updated known issue **#${id}**.`));
      return;
    }

    case 'resolve': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await ki.resolveKnownIssue(id, interaction.user.id);

      let notified = 0;
      if (ctx.cfg.known_issues.notify_on_resolve) {
        const threadIds = await ki.threadsForIssue(id, true);
        for (const threadId of threadIds) {
          const thread = await ctx.client.channels.fetch(threadId).catch(() => null);
          if (!thread?.isThread()) continue;
          if (thread.archived || thread.locked) continue;
          const sent = await thread
            .send(knownIssueResolvedNotice(ctx.cfg, issue))
            .catch((err) => {
              log.warn('could not notify thread of known-issue resolution', { threadId, err });
              return null;
            });
          if (sent) {
            notified++;
            await logEvent(threadId, 'known_issue_resolved', interaction.user.id, { issueId: id });
          }
        }
      }
      log.info('known issue resolved', { id, notified, by: interaction.user.id });
      scheduleBoardRefresh(ctx.client, ctx.cfg);
      await interaction.editReply(
        reply(
          `Retired known issue **#${id}**.` +
            (ctx.cfg.known_issues.notify_on_resolve
              ? ` Notified ${notified} open thread${notified === 1 ? '' : 's'}.`
              : ''),
        ),
      );
      return;
    }

    case 'reopen': {
      await ki.reopenKnownIssue(id);
      await interaction.reply(reply(`Known issue **#${id}** is active again.`));
      return;
    }

    case 'remove': {
      await ki.deleteKnownIssue(id);
      log.info('known issue deleted', { id, by: interaction.user.id });
      await interaction.reply(
        reply(`Deleted known issue **#${id}**. Threads that matched it keep their history.`),
      );
      return;
    }

    default:
      return;
  }
}
