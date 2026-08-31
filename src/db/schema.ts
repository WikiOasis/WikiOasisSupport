import { db } from './pool.js';
import { log } from '../logger.js';

const TABLES = [
  `CREATE TABLE IF NOT EXISTS known_issues (
     id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     title       VARCHAR(120)    NOT NULL,
     description TEXT            NOT NULL,
     advice      TEXT            NULL,
     url         VARCHAR(500)    NULL,
     active      TINYINT(1)      NOT NULL DEFAULT 1,
     created_by  BIGINT UNSIGNED NULL,
     created_at  DATETIME        NOT NULL,
     resolved_at DATETIME        NULL,
     resolved_by BIGINT UNSIGNED NULL,
     INDEX idx_active (active)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS threads (
     thread_id        BIGINT UNSIGNED  NOT NULL PRIMARY KEY,
     guild_id         BIGINT UNSIGNED  NOT NULL,
     forum_id         BIGINT UNSIGNED  NOT NULL,
     author_id        BIGINT UNSIGNED  NOT NULL,
     title            VARCHAR(200)     NOT NULL,
     priority         VARCHAR(64)      NULL,
     status           ENUM('waiting_on_team','waiting_on_user','resolved') NOT NULL
                        DEFAULT 'waiting_on_team',
     summary          TEXT             NULL,
     reasoning        TEXT             NULL,
     confidence       FLOAT            NULL,
     model            VARCHAR(64)      NULL,
     manual_override  TINYINT(1)       NOT NULL DEFAULT 0,
     claimed_by       BIGINT UNSIGNED  NULL,
     triage_message_id BIGINT UNSIGNED NULL,
     opened_at        DATETIME         NOT NULL,
     last_activity_at DATETIME         NOT NULL,
     last_user_at     DATETIME         NULL,
     first_staff_at   DATETIME         NULL,
     last_staff_at    DATETIME         NULL,
     resolved_at      DATETIME         NULL,
     resolved_by      BIGINT UNSIGNED  NULL,
     resolved_reason  VARCHAR(32)      NULL,
     resolved_quote   TEXT             NULL,
     known_issue_id   BIGINT UNSIGNED  NULL,
     last_triaged_at  DATETIME         NULL,
     msgs_since_triage INT UNSIGNED    NOT NULL DEFAULT 0,
     INDEX idx_status (status),
     INDEX idx_known_issue (known_issue_id),
     INDEX idx_forum_status (forum_id, status),
     INDEX idx_last_activity (last_activity_at),
     CONSTRAINT fk_thread_known_issue FOREIGN KEY (known_issue_id)
       REFERENCES known_issues(id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS thread_categories (
     thread_id     BIGINT UNSIGNED NOT NULL,
     category_key  VARCHAR(64)     NOT NULL,
     PRIMARY KEY (thread_id, category_key),
     CONSTRAINT fk_tc_thread FOREIGN KEY (thread_id) REFERENCES threads(thread_id)
       ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS thread_teams (
     thread_id  BIGINT UNSIGNED NOT NULL,
     team_key   VARCHAR(64)     NOT NULL,
     PRIMARY KEY (thread_id, team_key),
     INDEX idx_team (team_key),
     CONSTRAINT fk_tt_thread FOREIGN KEY (thread_id) REFERENCES threads(thread_id)
       ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS board_messages (
     channel_id BIGINT UNSIGNED NOT NULL,
     position   INT             NOT NULL,
     message_id BIGINT UNSIGNED NOT NULL,
     PRIMARY KEY (channel_id, position)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS thread_events (
     id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     thread_id  BIGINT UNSIGNED NOT NULL,
     at         DATETIME        NOT NULL,
     kind       VARCHAR(32)     NOT NULL,
     actor_id   BIGINT UNSIGNED NULL,
     detail     TEXT            NULL,
     INDEX idx_thread (thread_id, at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const MIGRATIONS: { table: string; column: string; ddl: string }[] = [];

export async function migrate(): Promise<void> {
  const pool = db();
  for (const ddl of TABLES) await pool.query(ddl);

  for (const m of MIGRATIONS) {
    const [rows] = await pool.query<import('mysql2').RowDataPacket[]>(
      `SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [m.table, m.column],
    );
    if (rows.length === 0) {
      log.info('applying migration', { table: m.table, column: m.column });
      await pool.query(m.ddl);
    }
  }
  log.info('schema ready');
}
