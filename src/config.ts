import { readFileSync } from 'node:fs';
import { z } from 'zod';

const Snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake');

const Team = z.object({
  key: z.string().min(1).regex(/^[a-z0-9_-]+$/, 'lowercase slug'),
  name: z.string().min(1),
  role_id: Snowflake.nullable().default(null),
  prompt: z.string().default(''),
  hidden: z.boolean().default(false),
});

const Redirect = z.object({
  enabled: z.boolean().default(true),
  url: z.string().url(),
  title: z.string().default('This looks like a bug report'),
  message: z.string().min(1),
  button_label: z.string().min(1).max(80).default('Open the issue tracker'),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f5a623'),
  once: z.boolean().default(true),
  set_waiting_on_user: z.boolean().default(false),
});

const Category = z.object({
  key: z.string().min(1).regex(/^[a-z0-9_-]+$/, 'lowercase slug'),
  name: z.string().min(1),
  tag: z.string().min(1).max(20).nullable().default(null),
  emoji: z.string().default(''),
  prompt: z.string().default(''),
  teams: z.array(z.string()).default([]),
  redirect: Redirect.nullable().default(null),
});

const Priority = z.object({
  key: z.string().min(1).regex(/^[a-z0-9_-]+$/, 'lowercase slug'),
  name: z.string().min(1),
  prompt: z.string().default(''),
  emoji: z.string().default(''),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#5865f2'),
  order: z.number().int().default(100),
});

const StatusStyle = z.object({
  label: z.string().min(1),
  emoji: z.string().default(''),
});

export const ConfigSchema = z.object({
  guild_id: Snowflake,
  forum_channel_id: Snowflake,
  board_channel_id: Snowflake,

  support_roles: z.array(Snowflake).default([]),

  teams: z.array(Team).min(1),
  categories: z.array(Category).min(1),
  priorities: z.array(Priority).min(1),

  statuses: z.object({
    waiting_on_team: StatusStyle.default({ label: 'Waiting on team', emoji: '🟦' }),
    waiting_on_user: StatusStyle.default({ label: 'Waiting on user', emoji: '⏳' }),
    resolved: StatusStyle.default({ label: 'Resolved', emoji: '✅' }),
  }).prefault({}),

  prompt: z.object({
    preamble: z.string().default(''),
    extra: z.string().default(''),
  }).prefault({}),

  model: z.string().default('gpt-5.5'),
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('low'),

  max_categories: z.number().int().min(1).max(4).default(2),

  manage_tags: z.boolean().default(true),

  resolution: z.object({
    enabled: z.boolean().default(true),
    min_confidence: z.number().min(0).max(1).default(0.8),
    prefilter: z.boolean().default(true),
    prefilter_patterns: z.array(z.string()).default([
      'thank', 'thanks', 'thx', 'cheers', 'ta ',
      'resolved', 'solved', 'fixed', 'works', 'working', 'sorted',
      'no longer', 'all good', 'all set', 'good now', 'great now',
      'that did it', 'that worked', 'did the trick', 'nevermind', 'never mind',
      'close this', 'closing', 'can close', 'you can close', 'issue is gone',
      'sorry for', 'my mistake', 'my bad', 'figured it out', 'found it',
    ]),
    archive: z.boolean().default(false),
  }).prefault({}),

  known_issues: z.object({
    enabled: z.boolean().default(true),
    min_confidence: z.number().min(0).max(1).default(0.75),
    title: z.string().default('This is a known issue'),
    message: z.string().default(
      "Thanks for reporting this — we already know about it and it's being worked on. " +
        'There is nothing you need to do; this thread will be updated when it is fixed.',
    ),
    colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#5865f2'),
    notify_on_resolve: z.boolean().default(true),
    resolved_message: z.string().default(
      'The known issue behind this thread has been resolved. Please check whether ' +
        'things are working for you now, and reply here if anything is still wrong.',
    ),
    set_waiting_on_user: z.boolean().default(true),
  }).prefault({}),

  rescan: z.object({
    enabled: z.boolean().default(true),
    min_new_messages: z.number().int().min(1).default(3),
    cooldown_minutes: z.number().int().min(0).default(20),
    context_messages: z.number().int().min(1).max(100).default(25),
    updates: z
      .array(z.enum(['categories', 'teams', 'priority']))
      .min(1)
      .default(['categories', 'teams']),
    override_manual: z.boolean().default(false),
    announce_changes: z.boolean().default(false),
  }).prefault({}),

  reconcile: z.object({
    on_start: z.boolean().default(true),
    interval_minutes: z.number().int().min(5).default(60),
    backfill: z.boolean().default(false),
    backfill_limit: z.number().int().min(1).max(200).default(25),
  }).prefault({}),

  board: z.object({
    debounce_ms: z.number().int().min(250).default(4000),
    refresh_minutes: z.number().int().min(1).default(15),
    show_resolved_minutes: z.number().int().min(0).default(0),
    max_threads: z.number().int().min(1).default(200),
  }).prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type TeamConfig = z.infer<typeof Team>;
export type CategoryConfig = z.infer<typeof Category>;
export type RedirectConfig = z.infer<typeof Redirect>;
export type PriorityConfig = z.infer<typeof Priority>;
export type StatusKey = 'waiting_on_team' | 'waiting_on_user' | 'resolved';

export interface Env {
  discordToken: string;
  openaiApiKey: string;
  openaiBaseUrl: string | undefined;
  configPath: string;
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — see .env.example`);
  return v;
}

export function loadEnv(): Env {
  return {
    discordToken: required('DISCORD_TOKEN'),
    openaiApiKey: required('OPENAI_API_KEY'),
    openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
    configPath: process.env.TRIAGE_CONFIG_PATH ?? '/etc/wikioasis-support/triage.json',
    db: {
      host: required('DB_HOST'),
      port: Number(process.env.DB_PORT ?? 3306),
      user: required('DB_USER'),
      password: required('DB_PASSWORD'),
      database: required('DB_NAME'),
    },
  };
}

export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`could not read triage config at ${path}: ${(err as Error).message}`);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`triage config at ${path} is invalid:\n${issues}`);
  }
  const cfg = parsed.data;

  const problems: string[] = [];

  const dupe = (label: string, keys: string[]) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) problems.push(`duplicate ${label} key "${k}"`);
      seen.add(k);
    }
  };
  dupe('team', cfg.teams.map((t) => t.key));
  dupe('category', cfg.categories.map((c) => c.key));
  dupe('priority', cfg.priorities.map((p) => p.key));

  const orders = cfg.priorities.map((p) => p.order);
  if (new Set(orders).size !== orders.length) {
    problems.push('two or more priorities share the same `order`');
  }

  const teamKeys = new Set(cfg.teams.map((t) => t.key));
  for (const c of cfg.categories) {
    for (const t of c.teams) {
      if (!teamKeys.has(t)) problems.push(`category "${c.key}" routes to unknown team "${t}"`);
    }
  }

  if (cfg.manage_tags && cfg.categories.length > 20) {
    problems.push(
      `${cfg.categories.length} categories need a forum tag each, but a Discord ` +
        'forum allows at most 20',
    );
  }

  if (problems.length) {
    throw new Error(`triage config at ${path} is invalid:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  return cfg;
}

export const tagNameFor = (x: { tag: string | null; name: string }): string => x.tag ?? x.name;
