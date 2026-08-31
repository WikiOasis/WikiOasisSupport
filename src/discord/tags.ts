import type { ForumChannel, GuildForumTagData, ThreadChannel } from 'discord.js';
import type { Config } from '../config.js';
import { tagNameFor } from '../config.js';
import { log } from '../logger.js';

const MAX_FORUM_TAGS = 20;
const MAX_APPLIED_TAGS = 5;

export interface TagIndex {
  category: Map<string, string>;
  managed: Set<string>;
}

export async function syncTags(forum: ForumChannel, cfg: Config): Promise<TagIndex> {
  const index: TagIndex = { category: new Map(), managed: new Set() };

  const targets = cfg.categories.map((c) => ({
    key: c.key,
    name: tagNameFor(c),
    emoji: c.emoji,
  }));

  const existing = new Map(forum.availableTags.map((t) => [t.name.toLowerCase(), t]));
  const missing = targets.filter((t) => !existing.has(t.name.toLowerCase()));

  if (missing.length && cfg.manage_tags) {
    const room = MAX_FORUM_TAGS - forum.availableTags.length;
    if (missing.length > room) {
      log.error('not enough room on the forum for the configured category tags', {
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
    log.info('creating missing category tags', { tags: missing.map((m) => m.name) });
    await forum.setAvailableTags(next);
  } else if (missing.length) {
    log.warn('forum is missing category tags and manage_tags is off; they will not be applied', {
      missing: missing.map((m) => m.name),
    });
  }

  const byName = new Map(forum.availableTags.map((t) => [t.name.toLowerCase(), t.id]));
  for (const t of targets) {
    const id = byName.get(t.name.toLowerCase());
    if (!id) continue;
    index.managed.add(id);
    index.category.set(t.key, id);
  }
  log.info('category tags indexed', { categories: index.category.size });
  return index;
}

export function desiredTags(
  index: TagIndex,
  current: readonly string[],
  state: { categories: string[] },
): string[] {
  const out: string[] = current.filter((id) => !index.managed.has(id));

  for (const c of state.categories) {
    const id = index.category.get(c);
    if (id && !out.includes(id) && out.length < MAX_APPLIED_TAGS) out.push(id);
  }
  return out;
}

export async function applyTags(
  thread: ThreadChannel,
  index: TagIndex,
  state: { categories: string[] },
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
