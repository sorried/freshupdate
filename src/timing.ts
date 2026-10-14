import { setTimeout } from "node:timers/promises";

export async function sleep(seconds: number, signal?: AbortSignal): Promise<void> {
  let remaining = Math.max(0, seconds * 1000);
  do {
    const duration = Math.min(remaining, 2_147_483_647);
    await setTimeout(duration, undefined, { signal });
    remaining -= duration;
  } while (remaining > 0);
}

export function nowSeconds(): number {
  return Date.now() / 1000;
}
