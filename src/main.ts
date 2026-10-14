import { ConfigurationError, loadConfig } from "./config.js";
import { run } from "./runtime.js";

process.umask(0o077);
const controller = new AbortController();
const stop = (): void => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await run(loadConfig(), controller.signal);
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(
      error instanceof ConfigurationError
        ? error.message
        : "Приложение остановлено. Проверьте токен, сеть, хранилище и конфигурацию.",
    );
    process.exitCode = 1;
  }
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
