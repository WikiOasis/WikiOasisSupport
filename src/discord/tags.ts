import type { ForumChannel, GuildForumTagData, ThreadChannel } from 'discord.js';
import type { Config, StatusKey } from '../config.js';
import { tagNameFor } from '../config.js';
import { log } from '../logger.js';

const MAX_FORUM_TAGS = 20;
const MAX_APPLIED_TAGS = 5;

export interface TagIndex {
  category: Map<string, string>;
  status: Map<StatusKey, string>;
  managed: Set<string>;
}

interface TagTarget {
  key: string;
  name: string;
  emoji: string;
}

export async function syncTags(forum: ForumChannel, cfg: Config): Promise<TagIndex> {
  const index: TagIndex = { category: new Map(), status: new Map(), managed: new Set() };

  const categoryTargets: TagTarget[] = cfg.categories.map((c) => ({
    key: c.key,
    name: tagNameFor(c),
    emoji: c.emoji,
  }));
  const statusTargets: TagTarget[] = (Object.entries(cfg.statuses) as [StatusKey, Config['statuses'][StatusKey]][])
    .filter(([, s]) => s.tag)
    .map(([key, s]) => ({ key, name: s.tag!, emoji: s.emoji }));
  const targets = [...categoryTargets, ...statusTargets];

  const existing = new Map(forum.availableTags.map((t) => [t.name.toLowerCase(), t]));
  const missing = targets.filter((t) => !existing.has(t.name.toLowerCase()));

  if (missing.length && cfg.manage_tags) {
    const room = MAX_FORUM_TAGS - forum.availableTags.length;
    if (missing.length > room) {
      log.error('not enough room on the forum for the configured tags', {
        missing: missing.map((m) => m.name),
        existingTags: forum.availableTags.length,
        room,
      });
      throw new Error(
        `the forum has ${forum.availableTags.length} tags and Discord allows ${MAX_FORUM_TAGS}; ` +
          `${missing.length} more are needed (${missing.map((m) => m.name).join(', ')}). ` +
          'Remove unused tags from the forum, or trim the categories.',
      );
    }

    const next: GuildForumTagData[] = [
      ...forum.availableTags.map((t) => ({
        id: t.id,
        name: t.name,
        moderated: t.moderated,
        emoji: t.emoji,
      })),
      ...missing.map((m) => ({
        name: m.name,
        moderated: false,
        emoji: m.emoji ? { id: null, name: m.emoji } : null,
      })),
    ];
    log.info('creating missing tags', { tags: missing.map((m) => m.name) });
    await forum.setAvailableTags(next);
  } else if (missing.length) {
    log.warn('forum is missing configured tags and manage_tags is off; they will not be applied', {
      missing: missing.map((m) => m.name),
    });
  }

  const byName = new Map(forum.availableTags.map((t) => [t.name.toLowerCase(), t.id]));
  for (const t of categoryTargets) {
    const id = byName.get(t.name.toLowerCase());
    if (!id) continue;
    index.managed.add(id);
    index.category.set(t.key, id);
  }
  for (const t of statusTargets) {
    const id = byName.get(t.name.toLowerCase());
    if (!id) continue;
    index.managed.add(id);
    index.status.set(t.key as StatusKey, id);
  }
  log.info('tags indexed', { categories: index.category.size, statuses: index.status.size });
  return index;
}

export function desiredTags(
  index: TagIndex,
  current: readonly string[],
  state: { categories: string[]; status: StatusKey },
): string[] {
  const out: string[] = current.filter((id) => !index.managed.has(id));

  for (const c of state.categories) {
    const id = index.category.get(c);
    if (id && !out.includes(id) && out.length < MAX_APPLIED_TAGS) out.push(id);
  }

  const statusId = index.status.get(state.status);
  if (statusId && !out.includes(statusId) && out.length < MAX_APPLIED_TAGS) out.push(statusId);

  return out;
}

export async function applyTags(
  thread: ThreadChannel,
  index: TagIndex,
  state: { categories: string[]; status: StatusKey },
): Promise<void> {
  const next = desiredTags(index, thread.appliedTags, state);
  const same =
    next.length === thread.appliedTags.length &&
    next.every((id) => thread.appliedTags.includes(id));
  if (same) return;

  try {
    await thread.setAppliedTags(next);
  } catch (err) {
    log.warn('could not apply tags', { threadId: thread.id, err });
  }
}
