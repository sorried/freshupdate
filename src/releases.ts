export interface Release {
  id: number;
  name: string;
  tag_name: string;
  body: string;
  published_at: string;
  html_url: string;
  prerelease: boolean;
}

export function releasechanges(body: string): string[] {
  const changes = new Set<string>();
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(?:#{1,6}\s|```|~~~)/.test(line)) continue;
    const change = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]*\)/g, "$1")
      .replace(/\*\*|__|~~|`/g, "")
      .replace(/^\s*(?:[-+*•]\s+|\d+[.)]\s+)/, "")
      .trim();
    if (
      !change ||
      /^(?:full changelog|changelog|what(?:'s| is) (?:changed|new))\s*:?(?:\s*https?:\/\/\S+)?\s*$/i.test(
        change,
      ) ||
      /^https?:\/\/\S+$/i.test(change) ||
      /^\[[^\]]+\]:\s*https?:\/\//i.test(change)
    )
      continue;
    changes.add(change);
  }
  return [...changes];
}

export function isrecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parserelease(value: unknown, repository: string): Release {
  if (!isrecord(value)) throw new Error("Invalid release metadata");
  const { id, name, tag_name, body, published_at, html_url, prerelease } = value;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof tag_name !== "string" ||
    !tag_name ||
    typeof prerelease !== "boolean" ||
    typeof published_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(published_at) ||
    !Number.isFinite(Date.parse(published_at)) ||
    typeof html_url !== "string" ||
    (name !== undefined && name !== null && typeof name !== "string") ||
    (body !== undefined && body !== null && typeof body !== "string")
  ) {
    throw new Error("Invalid release metadata");
  }
  const url = new URL(html_url);
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(`/${repository}/releases/tag/`) ||
    url.hash ||
    url.search
  ) {
    throw new Error("Unexpected release URL");
  }
  return {
    id,
    name: name || tag_name,
    tag_name,
    body: body || "",
    html_url,
    prerelease,
    published_at: new Date(published_at).toISOString(),
  };
}
