import { randomUUID } from "node:crypto";
import { Bot } from "grammy";
import { type Config, ConfigurationError } from "./config.js";
import { Database } from "./database.js";
import { DeliveryWorker } from "./delivery.js";
import { GitHubClient } from "./github.js";
import { registerHandlers } from "./handlers.js";
import { telegramSignal } from "./telegram-signal.js";
import { nowSeconds, sleep } from "./timing.js";
import { ReleaseTracker } from "./tracker.js";

export async function run(
  config: Config,
  shutdown: AbortSignal,
  bot = new Bot(config.botToken, {
    client: { timeoutSeconds: 30, sensitiveLogs: false },
  }),
): Promise<void> {
  const database = new Database(config.databasePath);
  const owner = randomUUID();
  const controller = new AbortController();
  const signal = AbortSignal.any([shutdown, controller.signal]);
  let leased = false;
  let stopping: Promise<void> | undefined;
  const tasks: Promise<void>[] = [];
  const stop = (): void => {
    if (bot.isRunning() && !stopping) stopping = bot.stop();
  };
  signal.addEventListener("abort", stop);
  try {
    signal.throwIfAborted();
    const previousRepository = database.getMetadata("repository");
    if (previousRepository !== undefined && previousRepository !== config.repository) {
      throw new ConfigurationError("Для другого GITHUB_REPOSITORY нужна отдельная база.");
    }
    database.acquireLease(owner, nowSeconds());
    leased = true;
    bot.api.config.use((previous, method, payload, requestSignal) => {
      if (method !== "getUpdates") {
        signal.throwIfAborted();
        database.assertLease(owner, nowSeconds());
      }
      return previous(
        method,
        payload,
        method === "getUpdates" ? requestSignal : telegramSignal(signal),
      );
    });
    await bot.init(telegramSignal(signal));
    console.info(`Authenticated bot @${bot.botInfo.username} (bot ID ${bot.botInfo.id})`);
    const webhook = await bot.api.getWebhookInfo(telegramSignal(signal));
    if (webhook.url)
      throw new ConfigurationError("Настроен webhook. Отключите его перед polling-запуском.");
    await bot.api.setMyCommands(
      [
        { command: "start", description: "начальное меню" },
        { command: "about", description: "информация о проекте" },
      ],
      {},
      telegramSignal(signal),
    );
    registerHandlers(bot, database);
    const tracker = new ReleaseTracker(
      database,
      new GitHubClient(config.repository, config.githubToken),
      config.checkInterval,
      config.includePrereleases,
    );
    const delivery = new DeliveryWorker(database, bot.api, config.repository);
    const heartbeat = async (): Promise<void> => {
      while (!signal.aborted) {
        database.refreshLease(owner, nowSeconds());
        await sleep(30, signal);
      }
    };
    const watch = (task: Promise<void>): Promise<void> =>
      task.catch((error: unknown) => {
        if (!signal.aborted) {
          controller.abort();
          throw error;
        }
      });
    tasks.push(watch(heartbeat()), watch(tracker.run(signal)), watch(delivery.run(signal)));
    tasks.push(
      bot.start({ allowed_updates: ["message", "callback_query"], timeout: 20 }).finally(() => {
        controller.abort();
      }),
    );
    if (signal.aborted) stop();
    await Promise.all(tasks);
  } finally {
    controller.abort();
    await Promise.allSettled([...tasks, ...(stopping ? [stopping] : [])]);
    signal.removeEventListener("abort", stop);
    if (leased) database.releaseLease(owner);
    database.close();
  }
}
