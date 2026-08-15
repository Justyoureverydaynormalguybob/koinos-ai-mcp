// Configuration comes from the environment; MCP clients pass env vars in their
// server config block, so this is the least-friction surface.
//
// Single node (default):
//   KOINOS_AI_BASE_URL     default http://127.0.0.1:41100
//                          (honours upstream's KAI_CORE_PORT if set, like the app does)
//   KOINOS_AI_API_KEY      optional — sent as a Bearer token when present
//   KOINOS_AI_TIMEOUT_MS   per-request timeout, default 10000
//
// Multi-node:
//   KOINOS_AI_NODES        "desktop=http://127.0.0.1:41100,laptop=http://192.168.1.20:41100"
//                          First entry is the default node for tools called
//                          without a `node` argument.
//   KOINOS_AI_API_KEY_<NAME>  per-node key (name upper-cased, dashes → underscores);
//                          falls back to KOINOS_AI_API_KEY.

const DEFAULT_PORT = 41100;
const DEFAULT_TIMEOUT_MS = 10_000;
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.KAI_CORE_PORT ?? "", 10) || DEFAULT_PORT;
  const timeoutMs = Number.parseInt(env.KOINOS_AI_TIMEOUT_MS ?? "", 10) || DEFAULT_TIMEOUT_MS;

  const nodes = [];
  const spec = (env.KOINOS_AI_NODES ?? "").trim();
  if (spec) {
    for (const entry of spec.split(",")) {
      const eq = entry.indexOf("=");
      if (eq < 1) throw new Error(`KOINOS_AI_NODES: expected name=url, got "${entry.trim()}"`);
      const name = entry.slice(0, eq).trim();
      const url = entry.slice(eq + 1).trim();
      if (!NAME_RE.test(name)) throw new Error(`KOINOS_AI_NODES: bad node name "${name}"`);
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`KOINOS_AI_NODES: bad url for "${name}": "${url}"`);
      }
      const keyVar = `KOINOS_AI_API_KEY_${name.toUpperCase().replaceAll("-", "_")}`;
      nodes.push({
        name,
        baseUrl: url.replace(/\/+$/, ""),
        apiKey: env[keyVar] || env.KOINOS_AI_API_KEY || undefined,
        timeoutMs,
      });
    }
    if (new Set(nodes.map((n) => n.name)).size !== nodes.length) {
      throw new Error("KOINOS_AI_NODES: duplicate node names");
    }
  } else {
    nodes.push({
      name: "local",
      baseUrl: (env.KOINOS_AI_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ""),
      apiKey: env.KOINOS_AI_API_KEY || undefined,
      timeoutMs,
    });
  }

  return { nodes, defaultNode: nodes[0].name };
}
