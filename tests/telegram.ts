import type { Api } from "grammy";
import type { UserFromGetMe } from "grammy/types";

export const botinfo: UserFromGetMe = {
  id: 123456789,
  is_bot: true,
  first_name: "testbot",
  username: "testbot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export function mockapi(api: Api, handler: (method: string, payload: unknown) => unknown): void {
  api.config.use(async (previous, method, payload) => {
    const result = handler(method, payload);
    return { ok: true, result } as Awaited<ReturnType<typeof previous<typeof method>>>;
  });
}
