import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * A connector describes one AI provider API that Purser can sit in front of:
 * where it lives, how it authenticates, which endpoints are proxied and how
 * its usage is metered. Built-in connectors and custom ones share this shape,
 * so adding a provider is a manifest, not new gateway code.
 */
export interface ConnectorManifest {
  /** Lower case id, also the first segment of the mount path. */
  id: string;
  name: string;
  /** The wire format: OpenAI-compatible JSON, or the Anthropic Messages API. */
  kind: "openai-compatible" | "anthropic";
  /** Default upstream base URL including its version path, without a trailing slash. */
  upstream: string;
  /** Where agents point their base URL, under the Purser server. Default `/<id>/v1`. */
  mount?: string | undefined;
  /**
   * What agents paste as their base URL, when it differs from the mount. The
   * Anthropic SDK adds `/v1` itself, so its base URL is `/anthropic`.
   */
  agentPath?: string | undefined;
  /** How the real key is sent upstream. */
  auth: "bearer" | "x-api-key" | "api-key";
  /** Endpoints proxied, by name. Anything else is refused. */
  endpoints: EndpointName[];
  /** "list" proxies GET /models only; "list-and-get" also GET /models/<id>. */
  models: "none" | "list" | "list-and-get";
  /** "provider": the response reports the charge in `usage.cost`. "table": priced from the price table. */
  costSource: "provider" | "table";
  /** Add `stream_options.include_usage` to streamed chat completions. */
  injectStreamUsage: boolean;
  /** How a reported model name maps to the price table. */
  pricingModel: "same" | "strip-vendor" | "openrouter";
  /** GET path used to check that a key works. */
  testPath: string;
  /** A small, cheap model to send a first test request to. */
  testModel?: string | undefined;
  docsUrl?: string | undefined;
  /** The page where an admin makes a new key for this provider. */
  keysUrl?: string | undefined;
  keyPlaceholder?: string | undefined;
  /** The environment variables a tool or SDK reads for this connector. */
  envHint: { baseUrlVar: string; apiKeyVar: string };
  /** The upstream differs per customer (for example an Azure resource URL) and must be supplied. */
  needsUpstream: boolean;
  source: "builtin" | "custom";
}

export type EndpointName =
  "chat.completions" | "responses" | "embeddings" | "messages" | "count_tokens";

const OPENAI_ENV = {
  baseUrlVar: "OPENAI_BASE_URL",
  apiKeyVar: "OPENAI_API_KEY",
};

/**
 * Built-in connectors. Base URLs, auth headers and test models come from each
 * provider's own documentation (see `docsUrl`), checked on 2026-11-07.
 */
export const BUILTIN_CONNECTORS: ConnectorManifest[] = [
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai-compatible",
    upstream: "https://api.openai.com/v1",
    auth: "bearer",
    endpoints: ["chat.completions", "responses", "embeddings"],
    models: "list-and-get",
    costSource: "table",
    injectStreamUsage: true,
    pricingModel: "same",
    testPath: "/models",
    testModel: "gpt-4o-mini",
    docsUrl: "https://platform.openai.com/docs/api-reference",
    keysUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-...",
    envHint: OPENAI_ENV,
    needsUpstream: false,
    source: "builtin",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    upstream: "https://api.anthropic.com/v1",
    agentPath: "/anthropic",
    auth: "x-api-key",
    endpoints: ["messages", "count_tokens"],
    models: "list-and-get",
    costSource: "table",
    injectStreamUsage: false,
    pricingModel: "same",
    testPath: "/models",
    testModel: "claude-haiku-5-5",
    docsUrl: "https://docs.anthropic.com/en/api/overview",
    keysUrl: "https://platform.claude.com/settings/keys",
    keyPlaceholder: "sk-ant-...",
    envHint: {
      baseUrlVar: "ANTHROPIC_BASE_URL",
      apiKeyVar: "ANTHROPIC_API_KEY",
    },
    needsUpstream: false,
    source: "builtin",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    upstream: "https://openrouter.ai/api/v1",
    mount: "/openrouter/api/v1",
    auth: "bearer",
    endpoints: ["chat.completions", "responses"],
    // Model ids contain a slash, so per-model paths are not proxied.
    models: "list",
    costSource: "provider",
    injectStreamUsage: false,
    pricingModel: "openrouter",
    // Its model list is public and answers any key, so it proves nothing.
    testPath: "/key",
    testModel: "openai/gpt-4o-mini",
    docsUrl: "https://openrouter.ai/docs/api-reference/authentication",
    keysUrl: "https://openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-...",
    envHint: OPENAI_ENV,
    needsUpstream: false,
    source: "builtin",
  },
  {
    id: "xai",
    name: "xAI",
    kind: "openai-compatible",
    upstream: "https://api.x.ai/v1",
    auth: "bearer",
    endpoints: ["chat.completions", "responses"],
    models: "list",
    costSource: "table",
    injectStreamUsage: false,
    pricingModel: "same",
    testPath: "/models",
    testModel: "grok-build-0.1",
    docsUrl: "https://docs.x.ai/docs/api-reference",
    keysUrl: "https://console.x.ai",
    keyPlaceholder: "xai-...",
    envHint: OPENAI_ENV,
    needsUpstream: false,
    source: "builtin",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    kind: "openai-compatible",
    upstream: "https://generativelanguage.googleapis.com/v1beta/openai",
    auth: "bearer",
    endpoints: ["chat.completions", "embeddings"],
    models: "list-and-get",
    costSource: "table",
    injectStreamUsage: false,
    pricingModel: "same",
    testPath: "/models",
    testModel: "gemini-3.8-flash",
    docsUrl: "https://aistudio.google.com/docs/openai",
    keysUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza...",
    envHint: OPENAI_ENV,
    needsUpstream: false,
    source: "builtin",
  },
  {
    id: "mistral",
    name: "Mistral",
    kind: "openai-compatible",
    upstream: "https://api.mistral.ai/v1",
    auth: "bearer",
    endpoints: ["chat.completions", "embeddings"],
    models: "list-and-get",
    costSource: "table",
    injectStreamUsage: false,
    pricingModel: "same",
    testPath: "/models",
    testModel: "mistral-small-latest",
    docsUrl: "https://docs.mistral.ai/api/",
    keysUrl: "https://console.mistral.ai/api-keys",
    envHint: OPENAI_ENV,
    needsUpstream: false,
    source: "builtin",
  },
  {
    id: "groq",
    name: "Groq",
    kind: "openai-compatible",
    upstream: "https://api.groq.com/openai/v1",
    auth: "bearer",
    endpoints: ["chat.completions", "responses"],
    // Some model ids contain a slash ("openai/gpt-oss-20b").
    models: "list",
    costSource: "table",
    injectStreamUsage: false,
    pricingModel: "strip-vendor",
    testPath: "/models",
    testModel: "openai/gpt-oss-20b",
    docsUrl: "https://console.groq.com/docs/openai",
    keysUrl: "https://console.groq.com/keys",
    keyPlaceholder: "gsk_...",
    envHint: OPENAI_ENV,
    needsUpstream: false,
    source: "builtin",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai-compatible",
    upstream: "https://api.deepseek.com",
    auth: "bearer",
    endpoints: ["chat.completions"],
    models: "list",
    costSource: "table",
    injectStreamUsage: false,
    pricingModel: "same",
    testPath: "/models",
    testModel: "deepseek-flash",
    docsUrl: "https://api-docs.deepseek.com/",
    keysUrl: "https://platform.deepseek.com/api_keys",
    keyPlaceholder: "sk-...",
    envHint: OPENAI_ENV,
    needsUpstream: false,
    source: "builtin",
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    kind: "openai-compatible",
    // Each customer has their own resource URL; this is a pattern, not a default.
    upstream: "https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1",
    auth: "api-key",
    endpoints: ["chat.completions", "responses", "embeddings"],
    models: "list-and-get",
    costSource: "table",
    injectStreamUsage: true,
    pricingModel: "same",
    testPath: "/models",
    docsUrl:
      "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle",
    keysUrl: "https://portal.azure.com",
    envHint: OPENAI_ENV,
    needsUpstream: true,
    source: "builtin",
  },
];

/** Paths a custom connector may not take as its id. */
const RESERVED_IDS = new Set([
  "admin",
  "auth",
  "login",
  "health",
  "assets",
  "static",
  "api",
  "me",
  "mcp",
  "v1",
]);

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(h) ||
    h.endsWith(".localhost")
  );
}

/** An upstream must be https, unless it is on this machine. */
export function upstreamProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The upstream must be a full URL, like https://api.example.com/v1.";
  }
  if (parsed.username || parsed.password) {
    return "The upstream must not contain a user name or password.";
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
    return null;
  return "The upstream must use https, unless it runs on this machine.";
}

const customSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]{1,31}$/,
        "Use 2 to 32 lower case letters, digits and dashes, starting with a letter.",
      ),
    name: z.string().min(1).max(80),
    kind: z.enum(["openai-compatible", "anthropic"]),
    upstream: z.string().max(500),
    auth: z.enum(["bearer", "x-api-key", "api-key"]).optional(),
    endpoints: z
      .array(
        z.enum([
          "chat.completions",
          "responses",
          "embeddings",
          "messages",
          "count_tokens",
        ]),
      )
      .min(1)
      .optional(),
    models: z.enum(["none", "list", "list-and-get"]).optional(),
    costSource: z.enum(["provider", "table"]).optional(),
    injectStreamUsage: z.boolean().optional(),
    stripVendorPrefix: z.boolean().optional(),
    testPath: z
      .string()
      .regex(/^\/[\w./-]*$/)
      .refine((p) => !p.includes(".."), "No .. in the test path.")
      .optional(),
    testModel: z.string().max(200).optional(),
    docsUrl: z.url().optional(),
    keysUrl: z
      .url()
      .refine((u) => u.startsWith("https://"), "Use an https address.")
      .optional(),
    keyPlaceholder: z.string().max(40).optional(),
  })
  .strict();

export type CustomConnectorFile = z.infer<typeof customSchema>;

/** Turns a validated custom connector file into a manifest, with safe defaults. */
export function customManifest(input: CustomConnectorFile): ConnectorManifest {
  const anthropic = input.kind === "anthropic";
  const endpoints =
    input.endpoints ??
    (anthropic
      ? (["messages", "count_tokens"] as EndpointName[])
      : (["chat.completions", "responses"] as EndpointName[]));
  const allowed: EndpointName[] = anthropic
    ? ["messages", "count_tokens"]
    : ["chat.completions", "responses", "embeddings"];
  const bad = endpoints.filter((e) => !allowed.includes(e));
  if (bad.length > 0) {
    throw new Error(
      `Endpoints ${bad.join(", ")} do not belong to the ${input.kind} kind.`,
    );
  }
  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    upstream: input.upstream.replace(/\/+$/, ""),
    mount: `/${input.id}/v1`,
    auth: input.auth ?? (anthropic ? "x-api-key" : "bearer"),
    endpoints,
    models: input.models ?? "list",
    costSource: input.costSource ?? "table",
    injectStreamUsage: input.injectStreamUsage ?? false,
    pricingModel: input.stripVendorPrefix ? "strip-vendor" : "same",
    testPath: input.testPath ?? "/models",
    testModel: input.testModel,
    docsUrl: input.docsUrl,
    keysUrl: input.keysUrl,
    keyPlaceholder: input.keyPlaceholder,
    envHint: anthropic
      ? { baseUrlVar: "ANTHROPIC_BASE_URL", apiKeyVar: "ANTHROPIC_API_KEY" }
      : OPENAI_ENV,
    needsUpstream: false,
    source: "custom",
  };
}

export interface LoadedConnectors {
  manifests: ConnectorManifest[];
  /** One line per file that was skipped, saying why. */
  problems: string[];
}

/**
 * Loads custom connectors from `<dataDir>/connectors/*.json`. A file that
 * fails validation is skipped and reported, never half-loaded.
 */
export function loadCustomConnectors(dataDir: string): LoadedConnectors {
  const dir = join(dataDir, "connectors");
  const result: LoadedConnectors = { manifests: [], problems: [] };
  if (!existsSync(dir)) return result;
  const taken = new Set(BUILTIN_CONNECTORS.map((m) => m.id));
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
      const parsed = customSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          parsed.error.issues
            .map((i) => `${i.path.join(".") || "file"}: ${i.message}`)
            .join("; "),
        );
      }
      const { id } = parsed.data;
      if (RESERVED_IDS.has(id)) throw new Error(`The id "${id}" is reserved.`);
      if (taken.has(id)) {
        throw new Error(`The id "${id}" is already used by another connector.`);
      }
      const problem = upstreamProblem(parsed.data.upstream);
      if (problem) throw new Error(problem);
      result.manifests.push(customManifest(parsed.data));
      taken.add(id);
    } catch (err) {
      result.problems.push(
        `${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}
