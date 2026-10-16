import { existsSync } from "node:fs";
import { resolve } from "node:path";

export class ConfigurationError extends Error {}

export interface Config {
  bottoken: string;
  repository: string;
  checkinterval: number;
  includeprereleases: boolean;
  databasepath: string;
  githubtoken: string;
}

export function readconfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const bottoken = (environment.BOT_TOKEN ?? "").trim();
  if (!/^[1-9]\d{4,}:[A-Za-z0-9_-]{30,}$/.test(bottoken)) {
    throw new ConfigurationError("BOT_TOKEN отсутствует или имеет неверный формат.");
  }
  const repository = (environment.GITHUB_REPOSITORY ?? "Snowy-Fluffy/freshGram").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new ConfigurationError("GITHUB_REPOSITORY должен иметь формат owner/repository.");
  }
  const interval = (environment.CHECK_INTERVAL_SECONDS ?? "300").trim();
  const checkinterval = Number(interval);
  if (!/^\d+$/.test(interval) || !Number.isSafeInteger(checkinterval) || checkinterval < 1) {
    throw new ConfigurationError("CHECK_INTERVAL_SECONDS должен быть положительным целым числом.");
  }
  const prereleases = (environment.INCLUDE_PRERELEASES ?? "true").trim().toLowerCase();
  if (prereleases !== "true" && prereleases !== "false") {
    throw new ConfigurationError("INCLUDE_PRERELEASES должен быть true или false.");
  }
  const databasepath = (environment.DATABASE_PATH ?? "data/bot.db").trim();
  if (!databasepath || databasepath === ":memory:") {
    throw new ConfigurationError("DATABASE_PATH должен указывать на постоянный файл SQLite.");
  }
  return {
    bottoken,
    repository,
    checkinterval,
    includeprereleases: prereleases === "true",
    databasepath: resolve(databasepath),
    githubtoken: (environment.GITHUB_TOKEN ?? "").trim(),
  };
}

export function loadconfig(): Config {
  const path = resolve(".env");
  if (existsSync(path)) process.loadEnvFile(path);
  return readconfig();
}
