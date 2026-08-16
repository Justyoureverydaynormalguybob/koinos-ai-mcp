// Latest-release lookup for the update check in nodes_status — the only
// outbound request this server ever makes beyond the configured nodes.
// Fail-soft (offline/rate-limited → the check just goes quiet), cached, and
// disabled entirely with KOINOS_AI_NO_VERSION_CHECK=1.

const DEFAULT_RELEASES_URL =
  "https://api.github.com/repos/therexdev/kaiapp/releases/latest";
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map(); // url → { at, value }

export async function latestAppRelease() {
  if (process.env.KOINOS_AI_NO_VERSION_CHECK === "1") return null;
  const url = process.env.KOINOS_AI_RELEASES_URL || DEFAULT_RELEASES_URL;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value = null;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      const version = String(data?.tag_name ?? "").replace(/^v/, "");
      if (version) {
        value = {
          version,
          url: data?.html_url ?? null,
          publishedAt: data?.published_at ?? null,
        };
      }
    }
  } catch {
    // Offline or GitHub unreachable — cache the miss so nodes_status stays fast.
  }
  cache.set(url, { at: Date.now(), value });
  return value;
}

// Numeric per dot segment ("0.25.8" > "0.23.3"); non-numeric segments compare
// equal so a "-beta" tag never produces a false "update available".
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (Number.isNaN(d)) return 0;
    if (d !== 0) return d;
  }
  return 0;
}
