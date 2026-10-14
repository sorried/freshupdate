import type { Command, CommandDecision, Database } from "./database.js";
import { nowSeconds } from "./timing.js";

export function checkCommand(
  database: Database,
  userId: number,
  command: Command,
): CommandDecision {
  return database.checkCommand(userId, command, nowSeconds());
}
