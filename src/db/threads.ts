import type { RowDataPacket } from 'mysql2';
import { db } from './pool.js';
import type { StatusKey } from '../config.js';

export interface TrackedThread {
  threadId: string;
  guildId: string;
  forumId: string;
  authorId: string;
  title: string;
  categories: string[];
  teams: string[];
  priority: string | null;
  status: StatusKey;
  summary: string | null;
  reasoning: string | null;
  confidence: number | null;
  model: string | null;
  manualOverride: boolean;
  claimedBy: string | null;
  triageMessageId: string | null;
  openedAt: Date;
  lastActivityAt: Date;
  lastUserAt: Date | null;
  firstStaffAt: Date | null;
  lastStaffAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolvedReason: string | null;
  resolvedQuote: string | null;
  knownIssueId: number | null;
  lastTriagedAt: Date | null;
  msgsSinceTriage: number;
}

export interface NewThread {
  threadId: string;
  guildId: string;
  forumId: string;
  authorId: string;
  title: string;
  openedAt: Date;
}

export interface TriageWrite {
  categories: string[];
  teams: string[];
  priority: string;
  status: StatusKey;
  summary: string;
  reasoning: string;
  confidence: number;
  model: string;
}

function hydrate(r: RowDataPacket, categories: string[], teams: string[]): TrackedThread {
  return {
    threadId: String(r.thread_id),
    guildId: String(r.guild_id),
    forumId: String(r.forum_id),
    authorId: String(r.author_id),
    title: r.title,
    categories,
    teams,
    priority: r.priority ?? null,
    status: r.status as StatusKey,
    summary: r.summary ?? null,
    reasoning: r.reasoning ?? null,
    confidence: r.confidence ?? null,
    model: r.model ?? null,
    manualOverride: Boolean(r.manual_override),
    claimedBy: r.claimed_by === null ? null : String(r.claimed_by),
    triageMessageId: r.triage_message_id === null ? null : String(r.triage_message_id),
    openedAt: r.opened_at,
    lastActivityAt: r.last_activity_at,
    lastUserAt: r.last_user_at ?? null,
    firstStaffAt: r.first_staff_at ?? null,
    lastStaffAt: r.last_staff_at ?? null,
    resolvedAt: r.resolved_at ?? null,
    resolvedBy: r.resolved_by === null ? null : String(r.resolved_by),
    resolvedReason: r.resolved_reason ?? null,
    resolvedQuote: r.resolved_quote ?? null,
    knownIssueId: r.known_issue_id === null ? null : Number(r.known_issue_id),
    lastTriagedAt: r.last_triaged_at ?? null,
    msgsSinceTriage: Number(r.msgs_since_triage ?? 0),
  };
}

async function withLabels(rows: RowDataPacket[]): Promise<TrackedThread[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => String(r.thread_id));
  const pool = db();
  const [cats] = await pool.query<RowDataPacket[]>(
    'SELECT thread_id, category_key FROM thread_categories WHERE thread_id IN (?)',
    [ids],
  );
  const [teams] = await pool.query<RowDataPacket[]>(
    'SELECT thread_id, team_key FROM thread_teams WHERE thread_id IN (?)',
    [ids],
  );
  const byCat = new Map<string, string[]>();
  for (const c of cats) {
    const k = String(c.thread_id);
    (byCat.get(k) ?? byCat.set(k, []).get(k)!).push(c.category_key);
  }
  const byTeam = new Map<string, string[]>();
  for (const t of teams) {
    const k = String(t.thread_id);
    (byTeam.get(k) ?? byTeam.set(k, []).get(k)!).push(t.team_key);
  }
  return rows.map((r) =>
    hydrate(r, byCat.get(String(r.thread_id)) ?? [], byTeam.get(String(r.thread_id)) ?? []),
  );
}

export async function getThread(threadId: string): Promise<TrackedThread | null> {
  const [rows] = await db().query<RowDataPacket[]>(
    'SELECT * FROM threads WHERE thread_id = ?',
    [threadId],
  );
  const hydrated = await withLabels(rows);
  return hydrated[0] ?? null;
}

export async function createThread(t: NewThread): Promise<void> {
  await db().query(
    `INSERT INTO threads
       (thread_id, guild_id, forum_id, author_id, title, status, opened_at,
        last_activity_at, last_user_at)
     VALUES (?, ?, ?, ?, ?, 'waiting_on_team', ?, ?, ?)
     ON DUPLICATE KEY UPDATE title = VALUES(title)`,
    [t.threadId, t.guildId, t.forumId, t.authorId, t.title.slice(0, 200), t.openedAt, t.openedAt, t.openedAt],
  );
}

export async function applyTriage(threadId: string, w: TriageWrite): Promise<void> {
  const pool = db();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE threads
          SET priority = ?, status = ?, summary = ?, reasoning = ?,
              confidence = ?, model = ?, last_triaged_at = ?, msgs_since_triage = 0
        WHERE thread_id = ?`,
      [w.priority, w.status, w.summary, w.reasoning, w.confidence, w.model, new Date(), threadId],
    );
    await conn.query('DELETE FROM thread_categories WHERE thread_id = ?', [threadId]);
    await conn.query('DELETE FROM thread_teams WHERE thread_id = ?', [threadId]);
    if (w.categories.length) {
      await conn.query('INSERT INTO thread_categories (thread_id, category_key) VALUES ?', [
        w.categories.map((c) => [threadId, c]),
      ]);
    }
    if (w.teams.length) {
      await conn.query('INSERT INTO thread_teams (thread_id, team_key) VALUES ?', [
        w.teams.map((t) => [threadId, t]),
      ]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function setKnownIssue(threadId: string, issueId: number | null): Promise<void> {
  await db().query('UPDATE threads SET known_issue_id = ? WHERE thread_id = ?', [
    issueId,
    threadId,
  ]);
}

export async function setTriageMessageId(threadId: string, messageId: string): Promise<void> {
  await db().query('UPDATE threads SET triage_message_id = ? WHERE thread_id = ?', [
    messageId,
    threadId,
  ]);
}

export async function recordActivity(
  threadId: string,
  by: 'user' | 'staff',
  at: Date,
): Promise<void> {
  if (by === 'staff') {
    await db().query(
      `UPDATE threads
          SET last_activity_at = ?, last_staff_at = ?,
              msgs_since_triage = msgs_since_triage + 1,
              first_staff_at = COALESCE(first_staff_at, ?),
              status = CASE WHEN status = 'resolved' THEN 'resolved'
                            ELSE 'waiting_on_user' END
        WHERE thread_id = ?`,
      [at, at, at, threadId],
    );
  } else {
    await db().query(
      `UPDATE threads
          SET last_activity_at = ?, last_user_at = ?, status = 'waiting_on_team',
              msgs_since_triage = msgs_since_triage + 1,
              resolved_at = NULL, resolved_by = NULL, resolved_reason = NULL,
              resolved_quote = NULL
        WHERE thread_id = ?`,
      [at, at, threadId],
    );
  }
}

export async function setStatus(threadId: string, status: StatusKey): Promise<void> {
  await db().query('UPDATE threads SET status = ? WHERE thread_id = ?', [status, threadId]);
}

export async function markResolved(
  threadId: string,
  opts: { by: string | null; reason: string; quote?: string | null; at?: Date },
): Promise<void> {
  await db().query(
    `UPDATE threads
        SET status = 'resolved', resolved_at = ?, resolved_by = ?,
            resolved_reason = ?, resolved_quote = ?
      WHERE thread_id = ?`,
    [opts.at ?? new Date(), opts.by, opts.reason, opts.quote ?? null, threadId],
  );
}

export async function reopen(threadId: string, status: StatusKey = 'waiting_on_team'): Promise<void> {
  await db().query(
    `UPDATE threads
        SET status = ?, resolved_at = NULL, resolved_by = NULL,
            resolved_reason = NULL, resolved_quote = NULL
      WHERE thread_id = ?`,
    [status, threadId],
  );
}

export async function setClaim(threadId: string, userId: string | null): Promise<void> {
  await db().query('UPDATE threads SET claimed_by = ? WHERE thread_id = ?', [userId, threadId]);
}

export async function setLabels(
  threadId: string,
  labels: { categories?: string[]; teams?: string[]; priority?: string },
): Promise<void> {
  const pool = db();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (labels.priority !== undefined) {
      await conn.query('UPDATE threads SET priority = ? WHERE thread_id = ?', [
        labels.priority,
        threadId,
      ]);
    }
    if (labels.categories) {
      await conn.query('DELETE FROM thread_categories WHERE thread_id = ?', [threadId]);
      if (labels.categories.length) {
        await conn.query('INSERT INTO thread_categories (thread_id, category_key) VALUES ?', [
          labels.categories.map((c) => [threadId, c]),
        ]);
      }
    }
    if (labels.teams) {
      await conn.query('DELETE FROM thread_teams WHERE thread_id = ?', [threadId]);
      if (labels.teams.length) {
        await conn.query('INSERT INTO thread_teams (thread_id, team_key) VALUES ?', [
          labels.teams.map((t) => [threadId, t]),
        ]);
      }
    }
    await conn.query('UPDATE threads SET manual_override = 1 WHERE thread_id = ?', [threadId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function listOpen(forumId: string, limit: number): Promise<TrackedThread[]> {
  const [rows] = await db().query<RowDataPacket[]>(
    `SELECT * FROM threads
      WHERE forum_id = ? AND status <> 'resolved'
      ORDER BY last_activity_at ASC
      LIMIT ?`,
    [forumId, limit],
  );
  return withLabels(rows);
}

export async function listUnresolved(forumId: string): Promise<TrackedThread[]> {
  const [rows] = await db().query<RowDataPacket[]>(
    `SELECT * FROM threads WHERE forum_id = ? AND status <> 'resolved'`,
    [forumId],
  );
  return withLabels(rows);
}

export async function deleteThread(threadId: string): Promise<void> {
  await db().query('DELETE FROM threads WHERE thread_id = ?', [threadId]);
}

export async function logEvent(
  threadId: string,
  kind: string,
  actorId: string | null,
  detail?: unknown,
): Promise<void> {
  await db().query(
    'INSERT INTO thread_events (thread_id, at, kind, actor_id, detail) VALUES (?, ?, ?, ?, ?)',
    [
      threadId,
      new Date(),
      kind,
      actorId,
      detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
    ],
  );
}

export interface BoardMessage {
  position: number;
  messageId: string;
}

export async function getBoardMessages(channelId: string): Promise<BoardMessage[]> {
  const [rows] = await db().query<RowDataPacket[]>(
    'SELECT position, message_id FROM board_messages WHERE channel_id = ? ORDER BY position ASC',
    [channelId],
  );
  return rows.map((r) => ({ position: r.position, messageId: String(r.message_id) }));
}

export async function saveBoardMessage(
  channelId: string,
  position: number,
  messageId: string,
): Promise<void> {
  await db().query(
    `INSERT INTO board_messages (channel_id, position, message_id) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE message_id = VALUES(message_id)`,
    [channelId, position, messageId],
  );
}

export async function deleteBoardMessagesFrom(channelId: string, position: number): Promise<void> {
  await db().query('DELETE FROM board_messages WHERE channel_id = ? AND position >= ?', [
    channelId,
    position,
  ]);
}
