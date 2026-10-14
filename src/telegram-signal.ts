import type { Api } from "grammy";

export function telegramSignal(signal: AbortSignal): NonNullable<Parameters<Api["getMe"]>[0]> {
  return signal as unknown as NonNullable<Parameters<Api["getMe"]>[0]>;
}
