import mysql from 'mysql2/promise';
import type { Env } from '../config.js';
import { log } from '../logger.js';

let pool: mysql.Pool | undefined;

export function initPool(env: Env): mysql.Pool {
  pool = mysql.createPool({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    waitForConnections: true,
    connectionLimit: 5,
    supportBigNumbers: true,
    bigNumberStrings: true,
    timezone: 'Z',
    dateStrings: false,
    charset: 'utf8mb4_unicode_ci',
    enableKeepAlive: true,
    keepAliveInitialDelay: 30_000,
  });
  return pool;
}

export function db(): mysql.Pool {
  if (!pool) throw new Error('database pool used before initPool()');
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end().catch((err) => log.warn('pool did not close cleanly', { err }));
    pool = undefined;
  }
}
