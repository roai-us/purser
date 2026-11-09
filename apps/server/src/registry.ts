import { BUILTIN_CONNECTORS, type ConnectorManifest } from "./connectors.js";
import { secretHint } from "./keys.js";
import { buildProvider, type Provider } from "./providers.js";
import type { ConnectorTest, OldKey, Vault } from "./vault.js";

/** A connector as the admin API shows it. Never carries the key itself. */
export interface ConnectorView {
  id: string;
  name: string;
  kind: ConnectorManifest["kind"];
  source: ConnectorManifest["source"];
  agentBaseUrl: string;
  envHint: ConnectorManifest["envHint"];
  configured: boolean;
  keyHint?: string | undefined;
  keySource?: "vault" | "env" | undefined;
  lastTest?: ConnectorTest | undefined;
  testModel?: string | undefined;
  docsUrl?: string | undefined;
  keysUrl?: string | undefined;
  keyPlaceholder?: string | undefined;
  /** When the current key was saved. Unknown for a key from the environment. */
  keySetAt?: string | undefined;
  /** Replaced keys still to be deleted at the provider. */
  oldKeys?: OldKey[] | undefined;
  needsUpstream?: boolean | undefined;
  upstream?: string | undefined;
  costSource: ConnectorManifest["costSource"];
}

export interface RegistryOptions {
  /** Keys from the environment, by connector id. The vault overrides them. */
  envKeys: Partial<Record<string, string>>;
  /** Upstream overrides from the environment, by connector id. */
  envUpstreams: Partial<Record<string, string>>;
  vault: Vault;
  custom: ConnectorManifest[];
  /** The Purser server's own address, for the base URLs agents paste. */
  baseUrl: string;
  fetch: typeof fetch;
  now: () => Date;
}

/** Every connector Purser knows, with where to find each one's key and upstream. */
export class Registry {
  readonly providers: Provider[];
  private readonly byId = new Map<string, Provider>();

  constructor(private readonly options: RegistryOptions) {
    this.providers = [...BUILTIN_CONNECTORS, ...options.custom].map(
      buildProvider,
    );
    for (const p of this.providers) this.byId.set(p.id, p);
  }

  /** The Purser server's own address. */
  get baseUrl(): string {
    return this.options.baseUrl;
  }

  get(id: string): Provider | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** The real provider key: one set through the admin API, else the environment's. */
  keyFor(id: string): string | undefined {
    return this.options.vault.get(id)?.apiKey ?? this.options.envKeys[id];
  }

  keySource(id: string): "vault" | "env" | undefined {
    if (this.options.vault.get(id)?.apiKey) return "vault";
    return this.options.envKeys[id] ? "env" : undefined;
  }

  /** Where requests go. Undefined when a connector needs an upstream nobody has supplied. */
  upstreamFor(id: string): string | undefined {
    const provider = this.byId.get(id);
    if (!provider) return undefined;
    const chosen =
      this.options.vault.get(id)?.upstream ?? this.options.envUpstreams[id];
    if (chosen) return chosen.replace(/\/+$/, "");
    return provider.manifest.needsUpstream
      ? undefined
      : provider.manifest.upstream;
  }

  isConfigured(id: string): boolean {
    return this.keyFor(id) !== undefined && this.upstreamFor(id) !== undefined;
  }

  configuredCount(): number {
    return this.providers.filter((p) => this.isConfigured(p.id)).length;
  }

  view(id: string): ConnectorView | undefined {
    const provider = this.byId.get(id);
    if (!provider) return undefined;
    const m = provider.manifest;
    const key = this.keyFor(id);
    const entry = this.options.vault.get(id);
    return {
      id: m.id,
      name: m.name,
      kind: m.kind,
      source: m.source,
      agentBaseUrl: `${this.options.baseUrl}${m.agentPath ?? provider.mount}`,
      envHint: m.envHint,
      configured: this.isConfigured(id),
      keyHint: key === undefined ? undefined : secretHint(key),
      keySource: this.keySource(id),
      lastTest: entry?.lastTest,
      testModel: m.testModel,
      docsUrl: m.docsUrl,
      keysUrl: m.keysUrl,
      keyPlaceholder: m.keyPlaceholder,
      keySetAt: entry?.apiKey ? entry.updatedAt : undefined,
      oldKeys: entry?.oldKeys?.length ? entry.oldKeys : undefined,
      needsUpstream: m.needsUpstream || undefined,
      upstream: m.needsUpstream ? this.upstreamFor(id) : undefined,
      costSource: m.costSource,
    };
  }

  views(): ConnectorView[] {
    return this.providers.map((p) => this.view(p.id) as ConnectorView);
  }

  /**
   * Checks the current key by asking the provider about it. A test never runs
   * a model, so it costs nothing. The result is kept with the key.
   */
  async test(id: string): Promise<ConnectorTest> {
    const provider = this.byId.get(id);
    const key = this.keyFor(id);
    const upstream = this.upstreamFor(id);
    const at = this.options.now().toISOString();
    let result: ConnectorTest;
    if (!provider || key === undefined) {
      result = { ok: false, at, error: "No key is set for this connector." };
    } else if (upstream === undefined) {
      result = { ok: false, at, error: "Set this connector's address first." };
    } else {
      result = await this.check(provider, key, upstream);
    }
    // Kept beside the key (or, for an environment key, on its own).
    if (key !== undefined) this.options.vault.set(id, { lastTest: result });
    return result;
  }

  /** Checks a key that isn't in use yet, without keeping anything. */
  async tryKey(
    id: string,
    key: string,
    upstream = this.upstreamFor(id),
  ): Promise<ConnectorTest> {
    const provider = this.byId.get(id);
    const at = this.options.now().toISOString();
    if (!provider) return { ok: false, at, error: "No such connector." };
    if (upstream === undefined) {
      return { ok: false, at, error: "Set this connector's address first." };
    }
    return this.check(provider, key, upstream);
  }

  private async check(
    provider: Provider,
    key: string,
    upstream: string,
  ): Promise<ConnectorTest> {
    const at = this.options.now().toISOString();
    const headers = new Headers({ accept: "application/json" });
    provider.setAuth(headers, key);
    if (provider.kind === "anthropic") {
      headers.set("anthropic-version", "2023-06-01");
    }
    const started = performance.now();
    try {
      const response = await this.options.fetch(
        `${upstream}${provider.manifest.testPath}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      const latencyMs = Math.round(performance.now() - started);
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return { ok: true, at, latencyMs };
      return {
        ok: false,
        at,
        latencyMs,
        ...(response.status === 400 || response.status === 401
          ? { rejected: true }
          : {}),
        // xAI and Gemini answer 400 to a key they don't recognize.
        error: [400, 401, 403].includes(response.status)
          ? `${provider.name} rejected this key.`
          : `${provider.name} answered with status ${response.status}.`,
      };
    } catch {
      return {
        ok: false,
        at,
        error: `Could not reach ${new URL(upstream).host}.`,
      };
    }
  }
}
