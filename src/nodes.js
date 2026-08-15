import { KoinosAiClient } from "./client.js";

// A pool of clients, one per configured node. Tools resolve a client by the
// optional `node` argument; unset means the default (first configured) node.
export function createPool(config) {
  const entries = new Map(
    config.nodes.map((n) => [n.name, { node: n, client: new KoinosAiClient(n) }]),
  );

  return {
    defaultName: config.defaultNode,
    names: [...entries.keys()],
    resolve(name) {
      const key = typeof name === "string" && name.trim() !== "" ? name.trim() : config.defaultNode;
      const hit = entries.get(key);
      if (!hit) {
        throw new Error(`Unknown node "${key}". Configured nodes: ${[...entries.keys()].join(", ")}`);
      }
      return hit.client;
    },
    all() {
      return [...entries.values()];
    },
  };
}
