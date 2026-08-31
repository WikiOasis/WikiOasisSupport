import {
  ChannelType,
  type Client,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import type { Config } from '../config.js';
import type { TrackedThread } from '../db/threads.js';
import {
  deleteBoardMessagesFrom,
  getBoardMessages,
  listOpen,
  saveBoardMessage,
} from '../db/threads.js';
import { log } from '../logger.js';
import {
  MAX_TEXT_CHARS,
  V2_FLAGS,
  age,
  container,
  escapeLinkText,
  relative,
  separator,
  text,
  truncate,
} from './components.js';
import { priorityOf, teamOf } from './render.js';

const UNASSIGNED = '__unassigned__';

const TEXT_BUDGET = 3400;

const threadUrl = (guildId: string, threadId: string): string =>
  `https://discord.com/channels/${guildId}/${threadId}`;

function renderRow(cfg: Config, t: TrackedThread): string {
  const prio = priorityOf(cfg, t.priority);
  const status = cfg.statuses[t.status];

  const replied = t.firstStaffAt
    ? t.claimedBy
      ? `replied · <@${t.claimedBy}>`
      : 'replied'
    : '**no reply yet**';

  const title = truncate(escapeLinkText(t.title), 70);
  const bits = [
    `${status.emoji || ''}${status.emoji ? ' ' : ''}${status.label.toLowerCase()}`,
    replied,
    age(t.lastActivityAt),
  ];

  if (t.knownIssueId != null) bits.push(`🔧 known #${t.knownIssueId}`);

  return `- ${prio?.emoji ? prio.emoji + ' ' : ''}[${title}](${threadUrl(t.guildId, t.threadId)}) — ${bits.join(' · ')}`;
}

function groupByTeam(cfg: Config, threads: TrackedThread[]): Map<string, TrackedThread[]> {
  const order = new Map(cfg.priorities.map((p) => [p.key, p.order]));
  const rank = (t: TrackedThread) => order.get(t.priority ?? '') ?? 999;

  const groups = new Map<string, TrackedThread[]>();
  for (const t of threads) {
    const keys = t.teams.length ? t.teams : [UNASSIGNED];
    for (const k of keys) {
      const list = groups.get(k) ?? [];
      list.push(t);
      groups.set(k, list);
    }
  }
  for (const list of groups.values()) {
    list.sort((a, b) => rank(a) - rank(b) || a.lastActivityAt.getTime() - b.lastActivityAt.getTime());
  }
  return groups;
}

interface Section {
  title: string;
  rows: string[];
}

function buildSections(cfg: Config, threads: TrackedThread[]): Section[] {
  const groups = groupByTeam(cfg, threads);
  const sections: Section[] = [];

  for (const team of cfg.teams) {
    if (team.hidden) continue;
    const list = groups.get(team.key);
    if (!list?.length) continue;
    sections.push({
      title: `### ${team.name} — ${list.length}`,
      rows: list.map((t) => renderRow(cfg, t)),
    });
  }

  const orphans = groups.get(UNASSIGNED);
  if (orphans?.length) {
    sections.push({
      title: `### ⚠️ Unassigned — ${orphans.length}`,
      rows: orphans.map((t) => renderRow(cfg, t)),
    });
  }
  return sections;
}

export function renderBoardPages(cfg: Config, threads: TrackedThread[]) {
  return paginate(cfg, buildSections(cfg, threads), threads.length);
}

function paginate(cfg: Config, sections: Section[], total: number): ReturnType<typeof pageOf>[] {
  const pages: { blocks: string[] }[] = [{ blocks: [] }];
  let used = 200;

  const push = (block: string) => {
    if (used + block.length > TEXT_BUDGET && pages[pages.length - 1]!.blocks.length > 0) {
      pages.push({ blocks: [] });
      used = 0;
    }
    pages[pages.length - 1]!.blocks.push(block);
    used += block.length;
  };

  for (const section of sections) {
    const whole = [section.title, ...section.rows].join('\n');
    if (whole.length <= TEXT_BUDGET) {
      push(whole);
      continue;
    }
    let chunk: string[] = [section.title];
    let len = section.title.length;
    for (const r of section.rows) {
      if (len + r.length > TEXT_BUDGET - 100) {
        push(chunk.join('\n'));
        chunk = [`${section.title} (cont.)`];
        len = section.title.length + 8;
      }
      chunk.push(r);
      len += r.length + 1;
    }
    if (chunk.length > 1) push(chunk.join('\n'));
  }

  return pages.map((p, i) => pageOf(cfg, p.blocks, i, pages.length, total));
}

function pageOf(cfg: Config, blocks: string[], index: number, count: number, total: number) {
  const c = container(null);
  if (index === 0) {
    c.addTextDisplayComponents(
      text(
        `# Support triage\n${total} open thread${total === 1 ? '' : 's'} · updated ${relative(new Date())}`,
      ),
    );
    c.addSeparatorComponents(separator(true));
  }
  if (blocks.length === 0) {
    c.addTextDisplayComponents(text('_Nothing open. Enjoy it._'));
  }
  blocks.forEach((b, i) => {
    if (i > 0) c.addSeparatorComponents(separator());
    c.addTextDisplayComponents(text(b));
  });
  if (count > 1) {
    c.addSeparatorComponents(separator());
    c.addTextDisplayComponents(text(`-# Board ${index + 1} of ${count}`));
  }
  return { components: [c], flags: V2_FLAGS };
}

async function resolveBoardChannel(client: Client, cfg: Config): Promise<TextBasedChannel | null> {
  const ch = await client.channels.fetch(cfg.board_channel_id).catch(() => null);
  if (!ch) {
    log.error('board channel not found', { channelId: cfg.board_channel_id });
    return null;
  }
  if (
    ch.type !== ChannelType.GuildText &&
    ch.type !== ChannelType.PublicThread &&
    ch.type !== ChannelType.PrivateThread
  ) {
    log.error('board channel is not a text channel', { channelId: cfg.board_channel_id, type: ch.type });
    return null;
  }
  return ch;
}

export async function renderBoard(client: Client, cfg: Config): Promise<void> {
  const channel = await resolveBoardChannel(client, cfg);
  if (!channel || !('send' in channel)) return;

  const threads = await listOpen(cfg.forum_channel_id, cfg.board.max_threads);
  const pages = renderBoardPages(cfg, threads);
  const existing = await getBoardMessages(cfg.board_channel_id);

  for (let i = 0; i < pages.length; i++) {
    const payload = pages[i]!;
    const known = existing.find((m) => m.position === i);
    let message: Message | null = null;

    if (known) {
      message = await channel.messages.fetch(known.messageId).catch(() => null);
      if (message) {
        await message.edit(payload).catch(async (err) => {
          log.warn('board edit failed; reposting', { position: i, err });
          message = null;
        });
      }
    }
    if (!message) {
      const sent = await channel.send(payload).catch((err) => {
        log.error('could not post board message', { position: i, err });
        return null;
      });
      if (sent) await saveBoardMessage(cfg.board_channel_id, i, sent.id);
    }
  }

  const stale = existing.filter((m) => m.position >= pages.length);
  for (const m of stale) {
    const msg = await channel.messages.fetch(m.messageId).catch(() => null);
    await msg?.delete().catch(() => undefined);
  }
  if (stale.length) await deleteBoardMessagesFrom(cfg.board_channel_id, pages.length);

  log.debug('board rendered', { threads: threads.length, pages: pages.length });
}

let timer: NodeJS.Timeout | undefined;
let pending = false;

export function scheduleBoardRefresh(client: Client, cfg: Config): void {
  pending = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    if (!pending) return;
    pending = false;
    void renderBoard(client, cfg).catch((err) => log.error('board refresh failed', { err }));
  }, cfg.board.debounce_ms);
  timer.unref?.();
}

export function startBoardTimer(client: Client, cfg: Config): NodeJS.Timeout {
  const t = setInterval(
    () => void renderBoard(client, cfg).catch((err) => log.error('board refresh failed', { err })),
    cfg.board.refresh_minutes * 60_000,
  );
  t.unref?.();
  return t;
}
