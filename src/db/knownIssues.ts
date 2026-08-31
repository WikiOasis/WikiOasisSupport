import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from './pool.js';

export interface KnownIssue {
  id: number;
  title: string;
  description: string;
  advice: string | null;
  url: string | null;
  active: boolean;
  createdBy: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

const hydrate = (r: RowDataPacket): KnownIssue => ({
  id: Number(r.id),
  title: r.title,
  description: r.description,
  advice: r.advice ?? null,
  url: r.url ?? null,
  active: Boolean(r.active),
  createdBy: r.created_by === null ? null : String(r.created_by),
  createdAt: r.created_at,
  resolvedAt: r.resolved_at ?? null,
  resolvedBy: r.resolved_by === null ? null : String(r.resolved_by),
});

export async function listKnownIssues(activeOnly = true): Promise<KnownIssue[]> {
  const [rows] = await db().query<RowDataPacket[]>(
    `SELECT * FROM known_issues ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id DESC`,
  );
  return rows.map(hydrate);
}

export async function getKnownIssue(id: number): Promise<KnownIssue | null> {
  const [rows] = await db().query<RowDataPacket[]>('SELECT * FROM known_issues WHERE id = ?', [id]);
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function addKnownIssue(input: {
  title: string;
  description: string;
  advice?: string | null;
  url?: string | null;
  createdBy: string;
}): Promise<number> {
  const [res] = await db().query<ResultSetHeader>(
    `INSERT INTO known_issues (title, description, advice, url, active, created_by, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [
      input.title.slice(0, 120),
      input.description,
      input.advice ?? null,
      input.url ?? null,
      input.createdBy,
      new Date(),
    ],
  );
  return res.insertId;
}

export async function editKnownIssue(
  id: number,
  patch: { title?: string; description?: string; advice?: string | null; url?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.title !== undefined) (sets.push('title = ?'), args.push(patch.title.slice(0, 120)));
  if (patch.description !== undefined) (sets.push('description = ?'), args.push(patch.description));
  if (patch.advice !== undefined) (sets.push('advice = ?'), args.push(patch.advice));
  if (patch.url !== undefined) (sets.push('url = ?'), args.push(patch.url));
  if (!sets.length) return;
  args.push(id);
  await db().query(`UPDATE known_issues SET ${sets.join(', ')} WHERE id = ?`, args);
}

export async function resolveKnownIssue(id: number, by: string): Promise<void> {
  await db().query(
    'UPDATE known_issues SET active = 0, resolved_at = ?, resolved_by = ? WHERE id = ?',
    [new Date(), by, id],
  );
}

export async function reopenKnownIssue(id: number): Promise<void> {
  await db().query(
    'UPDATE known_issues SET active = 1, resolved_at = NULL, resolved_by = NULL WHERE id = ?',
    [id],
  );
}

export async function deleteKnownIssue(id: number): Promise<void> {
  await db().query('DELETE FROM known_issues WHERE id = ?', [id]);
}

export async function threadsForIssue(id: number, openOnly = true): Promise<string[]> {
  const [rows] = await db().query<RowDataPacket[]>(
    `SELECT thread_id FROM threads
      WHERE known_issue_id = ? ${openOnly ? "AND status <> 'resolved'" : ''}`,
    [id],
  );
  return rows.map((r) => String(r.thread_id));
}

export async function threadCounts(): Promise<Map<number, number>> {
  const [rows] = await db().query<RowDataPacket[]>(
    `SELECT known_issue_id AS id, COUNT(*) AS n FROM threads
      WHERE known_issue_id IS NOT NULL GROUP BY known_issue_id`,
  );
  return new Map(rows.map((r) => [Number(r.id), Number(r.n)]));
}
