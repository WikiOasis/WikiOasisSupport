import { ButtonStyle, type MessageCreateOptions, type MessageEditOptions } from 'discord.js';
import type { Config, RedirectConfig, StatusKey } from '../config.js';
import type { TrackedThread } from '../db/threads.js';
import { V2_FLAGS, button, container, linkButton, row, separator, text, truncate } from './components.js';

export const priorityOf = (cfg: Config, key: string | null) =>
  cfg.priorities.find((p) => p.key === key) ?? null;
export const categoryOf = (cfg: Config, key: string) =>
  cfg.categories.find((c) => c.key === key) ?? null;
export const teamOf = (cfg: Config, key: string) => cfg.teams.find((t) => t.key === key) ?? null;

const statusLabel = (cfg: Config, s: StatusKey): string => {
  const st = cfg.statuses[s];
  return st.emoji ? `${st.emoji} ${st.label}` : st.label;
};

const nameList = (names: string[]): string => (names.length ? names.join(', ') : '—');

export const ID = {
  claim: (t: string) => `triage:claim:${t}`,
  resolve: (t: string) => `triage:resolve:${t}`,
  reopen: (t: string) => `triage:reopen:${t}`,
  retriage: (t: string) => `triage:retriage:${t}`,
  waitUser: (t: string) => `triage:waituser:${t}`,
  notResolved: (t: string) => `triage:notresolved:${t}`,
};

export function triageCard(
  cfg: Config,
  t: TrackedThread,
  knownIssueTitle?: string | null,
): MessageCreateOptions & MessageEditOptions {
  const prio = priorityOf(cfg, t.priority);
  const cats = t.categories.map((k) => categoryOf(cfg, k)?.name ?? k);
  const teams = t.teams.map((k) => teamOf(cfg, k));

  const header = [
    `## ${prio?.emoji ? prio.emoji + ' ' : ''}${prio?.name ?? 'Untriaged'}`,
    t.summary ?? '_no summary_',
  ].join('\n');

  const known =
    t.knownIssueId != null
      ? `**Known issue** #${t.knownIssueId}${knownIssueTitle ? ` — ${knownIssueTitle}` : ''}`
      : null;

  const facts = [
    `**Categories** ${nameList(cats)}`,
    `**Teams** ${teams.length ? teams.map((x) => (x?.role_id ? `<@&${x.role_id}>` : x?.name ?? '—')).join(' ') : '—'}`,
    `**Status** ${statusLabel(cfg, t.status)}`,
    t.claimedBy ? `**Claimed by** <@${t.claimedBy}>` : null,
    known,
  ]
    .filter(Boolean)
    .join('\n');

  const why = t.reasoning
    ? `-# ${truncate(t.reasoning, 300)}${
        t.confidence !== null ? ` · confidence ${(t.confidence * 100).toFixed(0)}%` : ''
      }`
    : null;

  const c = container(prio?.colour ?? '#5865f2', text(header), separator(), text(facts));
  if (why) c.addTextDisplayComponents(text(why));

  c.addSeparatorComponents(separator());
  c.addActionRowComponents(
    row(
      button(ID.claim(t.threadId), t.claimedBy ? 'Release' : 'Claim', ButtonStyle.Primary),
      button(ID.waitUser(t.threadId), 'Waiting on user'),
      button(ID.resolve(t.threadId), 'Resolve', ButtonStyle.Success),
      button(ID.retriage(t.threadId), 'Re-triage'),
    ),
  );

  return { components: [c], flags: V2_FLAGS };
}

export function redirectNotice(
  redirect: RedirectConfig,
  authorId: string,
): MessageCreateOptions {
  const c = container(
    redirect.colour,
    text(`## ${redirect.title}`),
    separator(),
    text(`<@${authorId}> ${redirect.message}`),
  );
  c.addActionRowComponents(row(linkButton(redirect.button_label, redirect.url)));
  return { components: [c], flags: V2_FLAGS };
}

export function resolvedByUserNotice(threadId: string, quote: string): MessageCreateOptions {
  const c = container(
    '#3ba55d',
    text('## ✅ Marked resolved'),
    separator(),
    text(
      `You said:\n> ${truncate(quote.replace(/\n/g, ' '), 300)}\n\n` +
        'so this thread is now marked resolved. If that was wrong, or the problem comes ' +
        'back, just reply here, that reopens it.',
    ),
  );
  c.addActionRowComponents(
    row(button(ID.notResolved(threadId), 'Not resolved', ButtonStyle.Danger)),
  );
  return { components: [c], flags: V2_FLAGS };
}

export function closedNotice(threadId: string): MessageCreateOptions {
  const c = container(
    '#3ba55d',
    text('## ✅ Marked resolved'),
    separator(),
    text(
      'This thread was closed, so it has been marked resolved. Reply here if you still need help — that reopens it.',
    ),
  );
  c.addActionRowComponents(
    row(button(ID.notResolved(threadId), 'Not resolved', ButtonStyle.Danger)),
  );
  return { components: [c], flags: V2_FLAGS };
}

export function knownIssueNotice(
  cfg: Config,
  issue: { id: number; title: string; description: string; advice: string | null; url: string | null },
  authorId: string,
): MessageCreateOptions {
  const ki = cfg.known_issues;
  const body = [`<@${authorId}> ${ki.message}`, '', `**${issue.title}**`, issue.description.trim()];
  if (issue.advice) body.push('', issue.advice.trim());

  const c = container(ki.colour, text(`## ${ki.title}`), separator(), text(body.join('\n')));
  if (issue.url) {
    c.addActionRowComponents(row(linkButton('Track this issue', issue.url)));
  }
  return { components: [c], flags: V2_FLAGS };
}

export function knownIssueResolvedNotice(
  cfg: Config,
  issue: { title: string },
): MessageCreateOptions {
  return {
    components: [
      container(
        '#3ba55d',
        text('## ✅ Update'),
        separator(),
        text(`**${issue.title}**\n\n${cfg.known_issues.resolved_message}`),
      ),
    ],
    flags: V2_FLAGS,
  };
}

export function recategorisedNotice(
  cfg: Config,
  from: string[],
  to: string[],
): MessageCreateOptions {
  const names = (keys: string[]) =>
    keys.map((k) => categoryOf(cfg, k)?.name ?? k).join(', ') || 'none';
  return {
    components: [
      container(
        '#5865f2',
        text(`-# Re-categorised: ${names(from)} → **${names(to)}**`),
      ),
    ],
    flags: V2_FLAGS,
  };
}

export function notice(body: string, accent = '#5865f2'): MessageCreateOptions {
  return { components: [container(accent, text(body))], flags: V2_FLAGS };
}
