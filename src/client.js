// Minimal HTTP client for the Koinos AI local control plane (/core/*).
// The API key is held in a private field and never appears in error messages
// or serialized output.

export class KoinosAiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "KoinosAiError";
    this.status = status;
    this.body = body;
  }
}

export class NodeUnreachableError extends Error {
  constructor(baseUrl, cause) {
    super(
      `Could not reach the Koinos AI node at ${baseUrl}. ` +
        `Is the Koinos AI app running? (${cause?.code ?? cause?.name ?? "connection failed"})`,
    );
    this.name = "NodeUnreachableError";
  }
}

export class KoinosAiClient {
  #apiKey;

  constructor({ baseUrl, apiKey, timeoutMs = 10_000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.#apiKey = apiKey;
  }

  async get(path, opts) {
    return this.#request("GET", path, undefined, opts);
  }

  async post(path, body, opts) {
    return this.#request("POST", path, body, opts);
  }

  async patch(path, body, opts) {
    return this.#request("PATCH", path, body, opts);
  }

  async delete(path, opts) {
    return this.#request("DELETE", path, undefined, opts);
  }

  async #request(method, path, body, { timeoutMs = this.timeoutMs } = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = { accept: "application/json" };
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err.name === "TimeoutError") {
        throw new KoinosAiError(
          `Request to ${url} timed out after ${timeoutMs}ms.`,
        );
      }
      throw new NodeUnreachableError(this.baseUrl, err.cause ?? err);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new KoinosAiError(
        `Koinos AI node returned ${res.status} for ${method} ${path}: ${truncate(text)}`,
        { status: res.status, body: text },
      );
    }

    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

function truncate(text, max = 300) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
