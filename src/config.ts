import { existsSync } from "node:fs";
import { resolve } from "node:path";

export class ConfigurationError extends Error {}

export interface Config {
  botToken: string;
  repository: string;
  checkInterval: number;
  includePrereleases: boolean;
  databasePath: string;
  githubToken: string;
}

export function readConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const botToken = (environment.BOT_TOKEN ?? "").trim();
  if (!/^[1-9]\d{4,}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
    throw new ConfigurationError("BOT_TOKEN отсутствует или имеет неверный формат.");
  }
  const repository = (environment.GITHUB_REPOSITORY ?? "Snowy-Fluffy/freshGram").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new ConfigurationError("GITHUB_REPOSITORY должен иметь формат owner/repository.");
  }
  const interval = (environment.CHECK_INTERVAL_SECONDS ?? "300").trim();
  const checkInterval = Number(interval);
  if (!/^\d+$/.test(interval) || !Number.isSafeInteger(checkInterval) || checkInterval < 1) {
    throw new ConfigurationError("CHECK_INTERVAL_SECONDS должен быть положительным целым числом.");
  }
  const prereleases = (environment.INCLUDE_PRERELEASES ?? "true").trim().toLowerCase();
  if (prereleases !== "true" && prereleases !== "false") {
    throw new ConfigurationError("INCLUDE_PRERELEASES должен быть true или false.");
  }
  const databasePath = (environment.DATABASE_PATH ?? "data/bot.db").trim();
  if (!databasePath || databasePath === ":memory:") {
    throw new ConfigurationError("DATABASE_PATH должен указывать на постоянный файл SQLite.");
  }
  return {
    botToken,
    repository,
    checkInterval,
    includePrereleases: prereleases === "true",
    databasePath: resolve(databasePath),
    githubToken: (environment.GITHUB_TOKEN ?? "").trim(),
  };
}

export function loadConfig(): Config {
  const path = resolve(".env");
  if (existsSync(path)) process.loadEnvFile(path);
  return readConfig();
}
