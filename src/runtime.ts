import { randomUUID } from "node:crypto";
import { Bot } from "grammy";
import { type Config, ConfigurationError } from "./config.js";
import { Database } from "./database.js";
import { DeliveryWorker } from "./delivery.js";
import { ErrorReporter } from "./errors.js";
import { GitHubClient } from "./github.js";
import { registerhandlers } from "./handlers.js";
import { telegramsignal } from "./telegram-signal.js";
import { nowseconds, sleep } from "./timing.js";
import { ReleaseTracker } from "./tracker.js";

export async function run(
  config: Config,
  shutdown: AbortSignal,
  bot = new Bot(config.bottoken, {
    client: { timeoutSeconds: 30, sensitiveLogs: false },
  }),
  reporter = new ErrorReporter(bot.api, [config.bottoken, config.githubtoken]),
): Promise<void> {
  let database: Database;
  try {
    database = new Database(config.databasepath);
  } catch (error) {
    await reporter.report("runtime", error);
    throw error;
  }
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
    const previousrepository = database.getmetadata("repository");
    if (previousrepository !== undefined && previousrepository !== config.repository) {
      throw new ConfigurationError("Для другого GITHUB_REPOSITORY нужна отдельная база.");
    }
    database.acquirelease(owner, nowseconds());
    leased = true;
    bot.api.config.use((previous, method, payload, requestsignal) => {
      if (method !== "getUpdates") {
        signal.throwIfAborted();
        database.assertlease(owner, nowseconds());
      }
      return previous(
        method,
        payload,
        method === "getUpdates" ? requestsignal : telegramsignal(signal),
      );
    });
    bot.botInfo = await bot.api.getMe(telegramsignal(signal));
    console.info(`Authenticated bot @${bot.botInfo.username} (bot ID ${bot.botInfo.id})`);
    const webhook = await bot.api.getWebhookInfo(telegramsignal(signal));
    if (webhook.url)
      throw new ConfigurationError("Настроен webhook. Отключите его перед polling-запуском.");
    await bot.api.setMyCommands(
      [
        { command: "start", description: "начальное меню" },
        { command: "about", description: "информация о проекте" },
      ],
      {},
      telegramsignal(signal),
    );
    const github = new GitHubClient(config.repository, config.githubtoken);
    registerhandlers(bot, database, reporter, github);
    const tracker = new ReleaseTracker(
      database,
      new GitHubClient(config.repository, config.githubtoken),
      config.checkinterval,
      config.includeprereleases,
      reporter,
    );
    const delivery = new DeliveryWorker(
      database,
      bot.api,
      config.repository,
      nowseconds,
      reporter,
      github,
    );
    const heartbeat = async (): Promise<void> => {
      while (!signal.aborted) {
        database.refreshlease(owner, nowseconds());
        await sleep(30, signal);
      }
    };
    const watch = (task: Promise<void>): Promise<void> =>
      task.catch(async (error: unknown) => {
        if (!signal.aborted) {
          await reporter.report("runtime", error);
          controller.abort();
          throw error;
        }
      });
    tasks.push(watch(heartbeat()), watch(tracker.run(signal)), watch(delivery.run(signal)));
    tasks.push(
      watch(
        bot.start({ allowed_updates: ["message", "callback_query"], timeout: 20 }).then(() => {
          controller.abort();
        }),
      ),
    );
    if (signal.aborted) stop();
    await Promise.all(tasks);
  } catch (error) {
    if (!shutdown.aborted) await reporter.report("runtime", error);
    throw error;
  } finally {
    controller.abort();
    await Promise.allSettled([...tasks, ...(stopping ? [stopping] : [])]);
    signal.removeEventListener("abort", stop);
    if (leased) database.releaselease(owner);
    database.close();
  }
}
