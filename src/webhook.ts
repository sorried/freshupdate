import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Bot } from "grammy";
import { loadconfig } from "./config.js";
import { Database } from "./database.js";
import { DeliveryWorker } from "./delivery.js";
import { ErrorReporter } from "./errors.js";
import { GitHubClient } from "./github.js";
import { registerhandlers } from "./handlers.js";
import { isrecord } from "./releases.js";
import { nowseconds, sleep } from "./timing.js";
import { ReleaseTracker } from "./tracker.js";

process.umask(0o077);
const config = loadconfig();
const secret = process.env.API_SECRET ?? "";
if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid API_SECRET");
const port = Number(process.env.API_PORT ?? "18754");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid API_PORT");
const expected = Buffer.from(`Bearer ${secret}`);
const controller = new AbortController();
const database = new Database(config.databasepath);
const bot = new Bot(config.bottoken);
const reporter = new ErrorReporter(bot.api, [config.bottoken, config.githubtoken, secret]);
const github = new GitHubClient(config.repository, config.githubtoken);
const owner = "webhook";
const completed = new Map<number, Promise<void>>();
registerhandlers(bot, database, reporter, github);
const server = createServer(
  { requestTimeout: 15_000, headersTimeout: 10_000 },
  async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/updates") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
      response.writeHead(415).end();
      return;
    }
    try {
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 131_072) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      let update: unknown;
      try {
        update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (!isrecord(update) || !Number.isSafeInteger(update.update_id)) {
        response.writeHead(400).end();
        return;
      }
      database.assertlease(owner, nowseconds());
      const id = update.update_id as number;
      let task = completed.get(id);
      if (!task) {
        task = bot.handleUpdate({ ...update, update_id: id });
        completed.set(id, task);
        if (completed.size > 1000) {
          const oldest = completed.keys().next().value;
          if (oldest !== undefined) completed.delete(oldest);
        }
        task.catch(() => completed.delete(id));
      }
      await task;
      response.writeHead(204).end();
    } catch (error) {
      response.writeHead(503).end();
      await reporter.report("webhook", error);
    }
  },
);
server.maxConnections = 100;
const stop = (): void => {
  controller.abort();
  server.close();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const tasks: Promise<void>[] = [];
let leased = false;
try {
  await bot.init();
  database.acquirelease(owner, nowseconds());
  leased = true;
  await bot.api.setMyCommands([
    { command: "start", description: "начальное меню" },
    { command: "about", description: "информация о проекте" },
  ]);
  const heartbeat = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      database.refreshlease(owner, nowseconds());
      await sleep(30, controller.signal);
    }
  };
  const tracker = new ReleaseTracker(
    database,
    github,
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
  tasks.push(heartbeat(), tracker.run(controller.signal), delivery.run(controller.signal));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing API address");
  console.info(`Webhook API listening on 127.0.0.1:${address.port}`);
  await Promise.all(tasks);
} catch (error) {
  if (!controller.signal.aborted) {
    await reporter.report("runtime", error);
    process.exitCode = 1;
  }
} finally {
  stop();
  await Promise.allSettled(tasks);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (leased) database.releaselease(owner);
  database.close();
}
