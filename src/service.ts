import { ChannelType, type AnyThreadChannel, type Client, type GuildMember, type Message } from 'discord.js';
import type { Config, StatusKey } from './config.js';
import { log } from './logger.js';
import { triageThread, type TriageInput } from './ai/triage.js';
import * as repo from './db/threads.js';
import type { TrackedThread } from './db/threads.js';
import { applyTags, type TagIndex } from './discord/tags.js';
import { renderBoard, scheduleBoardRefresh } from './discord/board.js';
import { knownIssueNotice, recategorisedNotice, redirectNotice, triageCard } from './discord/render.js';
import { getKnownIssue, listKnownIssues } from './db/knownIssues.js';

export interface Ctx {
  client: Client;
  cfg: Config;
  tags: TagIndex;
}

export function isStaff(cfg: Config, member: GuildMember | null): boolean {
  if (!member) return false;
  const roles = member.roles.cache;
  if (cfg.support_roles.some((r) => roles.has(r))) return true;
  return cfg.teams.some((t) => t.role_id && roles.has(t.role_id));
}

export async function syncThreadTags(ctx: Ctx, thread: AnyThreadChannel, t: TrackedThread): Promise<void> {
  await applyTags(thread, ctx.tags, { categories: t.categories, status: t.status });
}

async function upsertTriageCard(ctx: Ctx, thread: AnyThreadChannel, t: TrackedThread): Promise<void> {
  const issue = t.knownIssueId ? await getKnownIssue(t.knownIssueId) : null;
  const payload = triageCard(ctx.cfg, t, issue?.title ?? null);

  if (t.triageMessageId) {
    const existing = await thread.messages.fetch(t.triageMessageId).catch(() => null);
    if (existing) {
      await existing.edit(payload).catch((err) =>
        log.warn('could not edit triage card', { threadId: t.threadId, err }),
      );
      return;
    }
  }
  const sent = await thread.send(payload).catch((err) => {
    log.warn('could not post triage card', { threadId: t.threadId, err });
    return null;
  });
  if (sent) {
    await repo.setTriageMessageId(t.threadId, sent.id);
    await sent.pin().catch(() => undefined);
  }
}

async function postRedirects(ctx: Ctx, thread: AnyThreadChannel, t: TrackedThread): Promise<StatusKey | null> {
  let statusOverride: StatusKey | null = null;

  for (const key of t.categories) {
    const cat = ctx.cfg.categories.find((c) => c.key === key);
    const redirect = cat?.redirect;
    if (!redirect?.enabled) continue;

    if (redirect.once) {
      const [rows] = await (await import('./db/pool.js')).db().query<import('mysql2').RowDataPacket[]>(
        'SELECT 1 FROM thread_events WHERE thread_id = ? AND kind = ? LIMIT 1',
        [t.threadId, `redirect:${key}`],
      );
      if (rows.length) continue;
    }

    const sent = await thread
      .send(redirectNotice(redirect, t.authorId))
      .catch((err) => {
        log.warn('could not post redirect notice', { threadId: t.threadId, category: key, err });
        return null;
      });
    if (!sent) continue;

    await repo.logEvent(t.threadId, `redirect:${key}`, null, { url: redirect.url });
    log.info('posted redirect notice', { threadId: t.threadId, category: key, url: redirect.url });
    if (redirect.set_waiting_on_user) statusOverride = 'waiting_on_user';
  }
  return statusOverride;
}

export async function runTriage(
  ctx: Ctx,
  thread: AnyThreadChannel,
  input: TriageInput,
  opts: { reason: 'created' | 'retriage' | 'rescan'; actorId?: string | null } = { reason: 'created' },
): Promise<TrackedThread | null> {
  const matchIssues =
    ctx.cfg.known_issues.enabled && opts.reason !== 'rescan'
      ? await listKnownIssues(true)
      : [];

  const before = await repo.getThread(thread.id);
  const result = await triageThread(ctx.cfg, input, matchIssues);
  if (!result) {
    log.warn('triage produced no result; leaving thread untriaged', { threadId: thread.id });
    await repo.logEvent(thread.id, 'triage_failed', opts.actorId ?? null);
    scheduleBoardRefresh(ctx.client, ctx.cfg);
    return repo.getThread(thread.id);
  }

  const may = (what: 'categories' | 'teams' | 'priority') =>
    opts.reason !== 'rescan' || ctx.cfg.rescan.updates.includes(what);

  await repo.applyTriage(thread.id, {
    categories: may('categories') ? result.categories : before?.categories ?? result.categories,
    teams: may('teams') ? result.teams : before?.teams ?? result.teams,
    priority: may('priority') ? result.priority : before?.priority ?? result.priority,
    status:
      opts.reason === 'rescan'
        ? before?.status ?? 'waiting_on_team'
        : result.needsUserResponse
          ? 'waiting_on_user'
          : 'waiting_on_team',
    summary: result.summary,
    reasoning: result.reasoning,
    confidence: result.confidence,
    model: ctx.cfg.model,
  });
  await repo.logEvent(
    thread.id,
    opts.reason === 'created' ? 'triaged' : opts.reason === 'rescan' ? 'rescanned' : 'retriaged',
    opts.actorId ?? null,
    result,
  );

  if (matchIssues.length && result.knownIssueId !== null) {
    await repo.setKnownIssue(thread.id, result.knownIssueId);
  }

  const reloaded = await repo.getThread(thread.id);
  if (!reloaded) return null;
  let t: TrackedThread = reloaded;

  if (result.knownIssueId !== null && before?.knownIssueId !== result.knownIssueId) {
    const issue = matchIssues.find((i) => i.id === result.knownIssueId);
    if (issue) {
      const sent = await thread
        .send(knownIssueNotice(ctx.cfg, issue, t.authorId))
        .catch((err) => {
          log.warn('could not post known-issue notice', { threadId: thread.id, err });
          return null;
        });
      if (sent) {
        await repo.logEvent(thread.id, 'known_issue_matched', null, {
          issueId: issue.id,
          title: issue.title,
        });
        log.info('thread matched a known issue', { threadId: thread.id, issueId: issue.id });
        if (ctx.cfg.known_issues.set_waiting_on_user) {
          await repo.setStatus(thread.id, 'waiting_on_user');
          t = (await repo.getThread(thread.id)) ?? t;
        }
      }
    }
  }

  if (opts.reason === 'rescan' && ctx.cfg.rescan.announce_changes && before) {
    const changed =
      before.categories.length !== t.categories.length ||
      !before.categories.every((c) => t.categories.includes(c));
    if (changed) {
      await thread
        .send(recategorisedNotice(ctx.cfg, before.categories, t.categories))
        .catch((err) => log.warn('could not post recategorised notice', { threadId: thread.id, err }));
    }
  }

  const override = await postRedirects(ctx, thread, t);
  if (override && override !== t.status) {
    await repo.setStatus(thread.id, override);
    t = (await repo.getThread(thread.id)) ?? t;
  }

  await syncThreadTags(ctx, thread, t);
  await upsertTriageCard(ctx, thread, t);
  scheduleBoardRefresh(ctx.client, ctx.cfg);

  log.info('thread triaged', {
    threadId: thread.id,
    categories: t.categories,
    teams: t.teams,
    priority: t.priority,
    confidence: t.confidence,
  });
  return t;
}

export async function refreshThread(ctx: Ctx, thread: AnyThreadChannel, t: TrackedThread): Promise<void> {
  await syncThreadTags(ctx, thread, t);
  await upsertTriageCard(ctx, thread, t);
  scheduleBoardRefresh(ctx.client, ctx.cfg);
}

export async function closeResolvedThread(ctx: Ctx, thread: AnyThreadChannel): Promise<void> {
  if (thread.archived) return;
  await thread.setArchived(true).catch((err) =>
    log.warn('could not archive resolved thread', { threadId: thread.id, err }),
  );
}

export async function rebuildBoard(ctx: Ctx): Promise<{ closed: number; retagged: number }> {
  let closed = 0;
  let retagged = 0;

  const forum = await ctx.client.channels.fetch(ctx.cfg.forum_channel_id).catch(() => null);
  if (forum?.type === ChannelType.GuildForum) {
    const active = await forum.threads.fetchActive().catch(() => null);
    for (const thread of active?.threads.values() ?? []) {
      const tracked = await repo.getThread(thread.id);
      if (!tracked) continue;
      if (tracked.status === 'resolved') {
        await closeResolvedThread(ctx, thread);
        closed++;
      } else {
        await syncThreadTags(ctx, thread, tracked);
        retagged++;
      }
    }
  }

  await renderBoard(ctx.client, ctx.cfg);
  return { closed, retagged };
}

export async function starterInput(thread: AnyThreadChannel): Promise<TriageInput> {
  const starter = await thread.fetchStarterMessage().catch(() => null as Message | null);
  return {
    title: thread.name,
    body: starter?.content ?? '',
    authorTag: starter?.author?.tag ?? 'unknown',
    attachments: starter ? [...starter.attachments.values()].map((a) => a.name) : [],
  };
}

export async function conversationInput(
  ctx: Ctx,
  thread: AnyThreadChannel,
  current: { categories: string[]; teams: string[]; priority: string | null },
): Promise<TriageInput> {
  const base = await starterInput(thread);

  const fetched = await thread.messages
    .fetch({ limit: Math.min(100, ctx.cfg.rescan.context_messages) })
    .catch(() => null);

  const conversation = fetched
    ? [...fetched.values()]
        .filter((m) => !m.author.bot && m.content.trim().length > 0)
        .reverse()
        .map((m) => ({
          author: m.author.tag,
          staff: isStaff(ctx.cfg, m.member),
          content: m.content.slice(0, 1500),
        }))
    : [];

  return { ...base, conversation, current };
}

export function shouldRescan(cfg: Config, t: TrackedThread, now = new Date()): boolean {
  if (!cfg.rescan.enabled) return false;
  if (t.status === 'resolved') return false;
  if (t.manualOverride && !cfg.rescan.override_manual) return false;
  if (!t.lastTriagedAt) return false;
  if (t.msgsSinceTriage < cfg.rescan.min_new_messages) return false;

  const minutes = (now.getTime() - t.lastTriagedAt.getTime()) / 60000;
  return minutes >= cfg.rescan.cooldown_minutes;
}

export async function rescanThread(
  ctx: Ctx,
  thread: AnyThreadChannel,
  t: TrackedThread,
): Promise<void> {
  log.info('rescanning thread', {
    threadId: t.threadId,
    msgsSinceTriage: t.msgsSinceTriage,
    categories: t.categories,
  });
  const input = await conversationInput(ctx, thread, {
    categories: t.categories,
    teams: t.teams,
    priority: t.priority,
  });
  const after = await runTriage(ctx, thread, input, { reason: 'rescan' });

  if (after) {
    const moved =
      after.categories.length !== t.categories.length ||
      !t.categories.every((c) => after.categories.includes(c));
    if (moved) {
      log.info('rescan changed categories', {
        threadId: t.threadId,
        from: t.categories,
        to: after.categories,
      });
    }
  }
}
