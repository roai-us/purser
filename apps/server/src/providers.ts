import {
  BUILTIN_CONNECTORS,
  type ConnectorManifest,
  type EndpointName,
} from "./connectors.js";

/**
 * `GET /models` or `GET /models/<id>`. The id may hold only model-name
 * characters and may not be "." or "..", so an encoded path such as
 * `%2e%2e%2ffiles` cannot walk to another endpoint upstream.
 */
const MODELS_ROUTE = /^\/models(\/(?!\.\.?$)[\w.:-]+)?$/;
const MODELS_LIST_ROUTE = /^\/models$/;

export interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  /** Metered routes are priced and count toward caps. */
  metered: boolean;
  name: string;
}

export interface Provider {
  id: string;
  name: string;
  kind: ConnectorManifest["kind"];
  manifest: ConnectorManifest;
  /** Where agents point their base URL, under the Purser server. */
  mount: string;
  /**
   * Only these endpoints are proxied. Anything else is refused, so there is
   * no unmetered side door around the caps.
   */
  routes: Route[];
  agentKey(headers: Headers): string | null;
  setAuth(headers: Headers, providerKey: string): void;
  errorBody(code: string, message: string): unknown;
  /** Adjusts a request body before it goes upstream. */
  prepareBody(
    route: Route,
    body: Record<string, unknown>,
  ): Record<string, unknown>;
  /** The name to look up in the price table for a model this provider reports. */
  pricingModel(model: string): string;
}

const bearer = (headers: Headers): string | null => {
  const value = headers.get("authorization");
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() ?? null;
};

const ROUTES: Record<EndpointName, Route> = {
  "chat.completions": {
    method: "POST",
    pattern: /^\/chat\/completions$/,
    metered: true,
    name: "chat.completions",
  },
  responses: {
    method: "POST",
    pattern: /^\/responses$/,
    metered: true,
    name: "responses",
  },
  embeddings: {
    method: "POST",
    pattern: /^\/embeddings$/,
    metered: true,
    name: "embeddings",
  },
  messages: {
    method: "POST",
    pattern: /^\/messages$/,
    metered: true,
    name: "messages",
  },
  count_tokens: {
    method: "POST",
    pattern: /^\/messages\/count_tokens$/,
    metered: false,
    name: "count_tokens",
  },
};

/** Drops a "vendor/" prefix: "openai/gpt-oss-20b" becomes "gpt-oss-20b". */
export function stripVendor(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

/** Builds the runtime provider for a connector manifest. */
export function buildProvider(manifest: ConnectorManifest): Provider {
  const anthropic = manifest.kind === "anthropic";
  const routes: Route[] = manifest.endpoints.map((e) => ROUTES[e]);
  if (manifest.models !== "none") {
    routes.push({
      method: "GET",
      pattern: manifest.models === "list" ? MODELS_LIST_ROUTE : MODELS_ROUTE,
      metered: false,
      name: "models",
    });
  }
  return {
    id: manifest.id,
    name: manifest.name,
    kind: manifest.kind,
    manifest,
    mount: manifest.mount ?? `/${manifest.id}/v1`,
    routes,
    agentKey: anthropic
      ? (headers) => headers.get("x-api-key")?.trim() || bearer(headers)
      : bearer,
    setAuth(headers, providerKey) {
      if (manifest.auth === "bearer") {
        headers.set("authorization", `Bearer ${providerKey}`);
      } else {
        headers.set(manifest.auth, providerKey);
      }
    },
    errorBody: anthropic
      ? (code, message) => ({ type: "error", error: { type: code, message } })
      : (code, message) => ({ error: { message, type: code, code } }),
    prepareBody(route, body) {
      // Streaming chat completions only report token usage when asked to.
      // Purser asks, so streamed calls are metered. The client receives one
      // extra final chunk with an empty `choices` array, which the official
      // SDKs handle.
      if (
        manifest.injectStreamUsage &&
        route.name === "chat.completions" &&
        body.stream === true
      ) {
        const existing =
          typeof body.stream_options === "object" &&
          body.stream_options !== null
            ? body.stream_options
            : {};
        return {
          ...body,
          stream_options: { ...existing, include_usage: true },
        };
      }
      return body;
    },
    pricingModel:
      manifest.pricingModel === "openrouter"
        ? openrouterPricingModel
        : manifest.pricingModel === "strip-vendor"
          ? stripVendor
          : (model) => model,
  };
}

/**
 * Maps an OpenRouter model id such as "anthropic/claude-sonnet-4.5:nitro" to
 * the price table's name for it ("claude-sonnet-4-5"): drops the vendor and
 * any ":variant", and for Anthropic models writes version dots as dashes.
 */
export function openrouterPricingModel(model: string): string {
  const slash = model.indexOf("/");
  const vendor = slash === -1 ? "" : model.slice(0, slash);
  let name = slash === -1 ? model : model.slice(slash + 1);
  const colon = name.indexOf(":");
  if (colon !== -1) name = name.slice(0, colon);
  if (vendor === "anthropic") name = name.replace(/(\d)\.(\d)/g, "$1-$2");
  return name;
}

const builtin = (id: string): Provider => {
  const manifest = BUILTIN_CONNECTORS.find((m) => m.id === id);
  if (!manifest) throw new Error(`No built-in connector ${id}.`);
  return buildProvider(manifest);
};

export const OPENAI: Provider = builtin("openai");
export const ANTHROPIC: Provider = builtin("anthropic");
export const OPENROUTER: Provider = builtin("openrouter");

/** Request headers never forwarded upstream. */
const DROP_REQUEST = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "content-length",
  "accept-encoding",
  "cookie",
  // The agent's own credentials and account selectors. Purser supplies its own.
  "authorization",
  "x-api-key",
  "openai-organization",
  "openai-project",
]);

/** Response headers never passed back to the agent. */
const DROP_RESPONSE = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
]);

export function upstreamHeaders(
  incoming: Headers,
  provider: Provider,
  providerKey: string,
): Headers {
  const headers = new Headers();
  incoming.forEach((value, name) => {
    if (!DROP_REQUEST.has(name.toLowerCase())) headers.set(name, value);
  });
  // Ask for an uncompressed body so Purser can read the usage it carries.
  headers.set("accept-encoding", "identity");
  provider.setAuth(headers, providerKey);
  return headers;
}

export function downstreamHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  upstream.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name.toLowerCase())) headers.set(name, value);
  });
  return headers;
}
