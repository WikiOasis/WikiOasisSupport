import { Client, Events, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
import { loadConfig, loadEnv } from './config.js';
import { log } from './logger.js';
import { closePool, initPool } from './db/pool.js';
import { migrate } from './db/schema.js';
import { initOpenAI } from './ai/client.js';
import { syncTags } from './discord/tags.js';
import { renderBoard, startBoardTimer } from './discord/board.js';
import { reconcile, startReconcileTimer } from './discord/reconcile.js';
import { onButton } from './handlers/interactions.js';
import { onMessage, onThreadCreate, onThreadDelete, onThreadUpdate } from './handlers/threads.js';
import { onCommand, registerCommands } from './commands.js';
import type { Ctx } from './service.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const cfg = loadConfig(env.configPath);

  if (process.argv.includes('--check-config')) {
    log.info('config is valid', {
      categories: cfg.categories.length,
      teams: cfg.teams.length,
      priorities: cfg.priorities.length,
      model: cfg.model,
    });
    return;
  }

  initPool(env);
  await migrate();
  initOpenAI(env);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  let ctx: Ctx | undefined;

  client.once(Events.ClientReady, async (ready) => {
    log.info('connected to Discord', { user: ready.user.tag });

    const forum = await ready.channels.fetch(cfg.forum_channel_id).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) {
      log.error('forum_channel_id is not a forum channel', { channelId: cfg.forum_channel_id });
      process.exitCode = 1;
      client.destroy();
      return;
    }

    const tags = await syncTags(forum, cfg);
    ctx = { client: ready, cfg, tags };

    await registerCommands(ready, cfg, env.discordToken).catch((err) =>
      log.error('could not register slash commands', { err }),
    );

    if (cfg.reconcile.on_start) {
      await reconcile(ctx).catch((err) => log.error('startup reconcile failed', { err }));
    } else {
      await renderBoard(ready, cfg).catch((err) => log.error('board render failed', { err }));
    }

    startBoardTimer(ready, cfg);
    startReconcileTimer(ctx);
    log.info('ready');
  });

  const guard = (name: string, fn: () => Promise<void>) =>
    void fn().catch((err) => log.error(`${name} handler failed`, { err }));

  client.on(Events.ThreadCreate, (thread) => {
    if (!ctx) return;
    guard('threadCreate', () => onThreadCreate(ctx!, thread));
  });

  client.on(Events.MessageCreate, (message) => {
    if (!ctx) return;
    guard('messageCreate', () => onMessage(ctx!, message));
  });

  client.on(Events.ThreadUpdate, (oldT, newT) => {
    if (!ctx) return;
    guard('threadUpdate', () => onThreadUpdate(ctx!, oldT, newT));
  });

  client.on(Events.ThreadDelete, (thread) => {
    if (!ctx) return;
    guard('threadDelete', () => onThreadDelete(ctx!, thread));
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!ctx) return;
    if (interaction.isButton()) guard('button', () => onButton(ctx!, interaction));
    else if (interaction.isChatInputCommand()) guard('command', () => onCommand(ctx!, interaction));
  });

  client.on(Events.Error, (err) => log.error('discord client error', { err }));
  client.on(Events.Warn, (msg) => log.warn('discord client warning', { msg }));

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    await client.destroy();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await client.login(env.discordToken);
}

main().catch((err) => {
  log.error('fatal', { err });
  process.exit(1);
});
