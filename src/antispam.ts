import type { Command, CommandDecision, Database } from "./database.js";
import { nowseconds } from "./timing.js";

export function checkcommand(
  database: Database,
  userid: number,
  command: Command,
): CommandDecision {
  return database.checkcommand(userid, command, nowseconds());
}
