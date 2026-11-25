import { findAgentByKey, noteKeyExpired } from "./control.js";
import { newId } from "./keys.js";
import {
  checkAgent,
  checkModel,
  checkProvider,
  checkService,
} from "./policy.js";
import {
  costUsd,
  findPrice,
  totalInputTokens,
  type PriceTable,
} from "./pricing.js";
import {
  downstreamHeaders,
  upstreamHeaders,
  type Provider,
  type Route,
} from "./providers.js";
import type { InFlight } from "./inflight.js";
import type { Registry } from "./registry.js";
import type { Store } from "./store.js";
import {
  emptyUsage,
  type Agent,
  type TokenUsage,
  type UsageRecord,
} from "./types.js";
import type { OpenRouterKeys } from "./openrouter-keys.js";
import type { OpenRouterPrices } from "./live-prices.js";
import {
  clip,
  preview,
  requestPreview,
  responseTextFromJson,
  StreamText,
  type CallLog,
} from "./logs.js";
import {
  cutOffUsage,
  estimateUsage,
  SseParser,
  StreamUsage,
  usageFromBody,
  type UsageSpec,
} from "./usage.js";

export interface GatewayDeps {
  store: Store;
  /** Where call bodies go when logging is on. Absent: never logged. */
  logs?: CallLog | undefined;
  inflight: InFlight;
  prices: PriceTable;
  /** OpenRouter's own prices, for estimating its calls. */
  openRouterPrices?: OpenRouterPrices | undefined;
  /** Every connector, with the real provider keys and upstreams. Agents never see the keys. */
  registry: Registry;
  /** Agents' own OpenRouter keys, used instead of the shared one when they have one. */
  openRouterKeys?: OpenRouterKeys | undefined;
  fetch: typeof fetch;
  now: () => Date;
}

function deny(
  provider: Provider,
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(provider.errorBody(code, message), {
    status,
    headers: { "x-purser-denied": code },
  });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Proxies one agent request to its provider: checks the key, the agent's
 * status, end date, caps and model allowlist, swaps in the real provider key,
 * streams the response back, and meters the cost.
 */
export async function proxy(
  deps: GatewayDeps,
  provider: Provider,
  request: Request,
  subpath: string,
): Promise<Response> {
  const started = deps.now();
  const key = provider.agentKey(request.headers);
  if (!key) {
    return deny(
      provider,
      401,
      "missing_key",
      "Send your Purser agent key as the API key.",
    );
  }
  const match = findAgentByKey(deps.store, key, started);
  if (!match) {
    return deny(
      provider,
      401,
      "invalid_key",
      "This is not a Purser agent key, or it has been rotated.",
    );
  }
  const { agent, which: keyUsed } = match;
  if (
    keyUsed === "current" &&
    agent.keyExpiresAt !== undefined &&
    Date.parse(agent.keyExpiresAt) <= started.getTime()
  ) {
    noteKeyExpired(deps, agent);
    return deny(
      provider,
      403,
      "key_expired",
      `This agent's key expired on ${agent.keyExpiresAt.slice(0, 10)}. Ask its owner to rotate it.`,
    );
  }

  const route = provider.routes.find(
    (r) => r.method === request.method && r.pattern.test(subpath),
  );
  if (!route) {
    return deny(
      provider,
      404,
      "endpoint_not_supported",
      `Purser does not proxy ${request.method} ${provider.mount}${subpath} yet.`,
    );
  }

  const refused =
    checkAgent(agent, deps.store, started) ??
    checkProvider(agent, provider) ??
    checkService(agent, provider, deps.store, started);
  if (refused) return refuse(deps, provider, agent, refused);

  const sharedKey = deps.registry.keyFor(provider.id);
  const upstreamBase = deps.registry.upstreamFor(provider.id);
  if (sharedKey === undefined || upstreamBase === undefined) {
    return deny(
      provider,
      503,
      "provider_not_configured",
      `Purser has no ${provider.name} key configured.`,
    );
  }
  let providerKey = sharedKey;
  if (provider.id === "openrouter" && deps.openRouterKeys) {
    const own = deps.openRouterKeys.gatewayKey(agent.id);
    if (own && "refuse" in own) {
      return deny(provider, 503, "agent_key_unavailable", own.refuse);
    }
    if (own) providerKey = own.key;
  }

  let body: string | undefined;
  let requestText = "";
  let requestModel: string | null = null;
  let requestBytes = 0;
  if (request.method === "POST") {
    let parsed: unknown;
    try {
      requestText = await request.text();
      parsed = JSON.parse(requestText);
    } catch {
      return deny(
        provider,
        400,
        "invalid_json",
        "The request body must be JSON.",
      );
    }
    if (!isObject(parsed)) {
      return deny(
        provider,
        400,
        "invalid_json",
        "The request body must be a JSON object.",
      );
    }
    requestModel = typeof parsed.model === "string" ? parsed.model : null;
    requestBytes = Buffer.byteLength(JSON.stringify(parsed));
    const modelRefused = checkModel(agent, requestModel, provider.id);
    if (modelRefused) return refuse(deps, provider, agent, modelRefused);
    body = JSON.stringify(provider.prepareBody(route, parsed));
  }

  if (route.metered && provider.id === "openrouter") {
    deps.openRouterPrices?.refresh(upstreamBase, sharedKey);
  }

  const controller = new AbortController();
  deps.inflight.add(agent.id, controller);
  const search = new URL(request.url).search;
  const init: RequestInit = {
    method: request.method,
    headers: upstreamHeaders(request.headers, provider, providerKey),
    signal: controller.signal,
  };
  if (body !== undefined) init.body = body;

  let upstream: Response;
  try {
    upstream = await untilAborted(
      deps.fetch(`${upstreamBase}${subpath}${search}`, init),
      controller.signal,
    );
  } catch {
    deps.inflight.remove(agent.id, controller);
    return controller.signal.aborted
      ? stoppedResponse(provider, agent)
      : deny(
          provider,
          502,
          "upstream_unreachable",
          `Purser could not reach ${provider.name}.`,
        );
  }

  const logs = route.metered && deps.logs?.shouldLog(agent) ? deps.logs : null;
  const meter = (
    usage: TokenUsage | null,
    model: string | null,
    outcome: UsageRecord["outcome"],
    reportedUsd: number | null,
    responseBytes: number,
    /** Output tokens to charge if this call was cut off; null once reported. */
    unreportedOutputTokens: number | null = 0,
  ): UsageRecord | undefined => {
    if (!route.metered) return undefined;
    // A successful call that reported no usage is still charged, from an
    // estimate, so leaving usage out cannot slip past a cap.
    const noUsage = usage === null && outcome === "complete" && upstream.ok;
    // So is a call cut off before its usage arrived, or an agent could read
    // nearly all of an answer, hang up and pay nothing.
    const cutOff =
      outcome !== "complete" &&
      upstream.ok &&
      reportedUsd === null &&
      unreportedOutputTokens !== null;
    return recordUsage(deps, {
      agent,
      provider,
      route,
      usage: noUsage
        ? estimateUsage(requestBytes, responseBytes)
        : cutOff
          ? cutOffUsage(usage, requestBytes, unreportedOutputTokens)
          : (usage ?? emptyUsage()),
      estimated: noUsage || cutOff,
      keyUsed,
      model,
      requestModel,
      outcome,
      started,
      status: upstream.status,
      reportedUsd,
      logged: logs !== null,
    });
  };
  /** Keeps the bodies of a metered call, when logging covers this agent. */
  const keep = (
    record: UsageRecord | undefined,
    response: string,
    responseText: string | undefined,
  ) => {
    if (!logs || !record) return;
    const max = logs.maxChars;
    const [req, reqCut] = clip(requestText, max);
    const [res, resCut] = clip(response, max);
    logs.write({
      id: record.id,
      agentId: agent.id,
      agentName: agent.name,
      at: record.at,
      provider: record.provider,
      endpoint: record.endpoint,
      model: record.model,
      status: record.status,
      outcome: record.outcome,
      costUsd: record.costUsd,
      durationMs: record.durationMs,
      requestPreview: requestPreview(requestText),
      responsePreview: preview(responseText ?? responseTextFromJson(response)),
      truncated: reqCut || resCut || response.length > max,
      request: req,
      response: res,
      responseText:
        responseText ?? (responseTextFromJson(response) || undefined),
    });
  };
  const headers = downstreamHeaders(upstream.headers);
  headers.set("x-purser-agent", agent.id);

  const isStream = (upstream.headers.get("content-type") ?? "").includes(
    "text/event-stream",
  );
  if (!isStream || upstream.body === null) {
    let text: string;
    try {
      text = await untilAborted(upstream.text(), controller.signal);
    } catch {
      deps.inflight.remove(agent.id, controller);
      keep(meter(null, requestModel, "aborted", null, 0), "", undefined);
      return controller.signal.aborted
        ? stoppedResponse(provider, agent)
        : deny(
            provider,
            502,
            "upstream_error",
            `The ${provider.name} response was cut off.`,
          );
    }
    deps.inflight.remove(agent.id, controller);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: pass it through unmetered as tokens, but still recorded.
    }
    const { usage, model, costUsd } = usageFromBody(spec(provider), parsed);
    const record = meter(
      usage,
      model ?? requestModel,
      upstream.ok ? "complete" : "error",
      costUsd,
      Buffer.byteLength(text),
    );
    keep(record, text, undefined);
    if (record) headers.set("x-purser-cost-usd", String(record.costUsd));
    return new Response(text, { status: upstream.status, headers });
  }

  return new Response(
    meteredStream(
      deps,
      provider,
      agent,
      controller,
      upstream.body,
      (stream, outcome, captured) =>
        keep(
          meter(
            stream.seen ? stream.usage : null,
            stream.model ?? requestModel,
            outcome,
            stream.costUsd,
            stream.bytes,
            stream.unreportedOutputTokens,
          ),
          captured?.raw ?? "",
          captured?.text,
        ),
      logs?.maxChars,
    ),
    { status: upstream.status, headers },
  );
}

/**
 * Passes a server-sent event stream through to the agent byte for byte,
 * reading usage as it goes. A kill aborts the controller, which ends the
 * agent's stream at once and cancels the upstream request.
 */
function meteredStream(
  deps: GatewayDeps,
  provider: Provider,
  agent: Agent,
  controller: AbortController,
  source: ReadableStream<Uint8Array>,
  done: (
    stream: StreamUsage,
    outcome: UsageRecord["outcome"],
    captured: { raw: string; text: string } | undefined,
  ) => void,
  /** When set, keep up to this many characters of the stream for the call log. */
  captureChars?: number,
): ReadableStream<Uint8Array> {
  const collector = new StreamUsage(spec(provider));
  const capture =
    captureChars === undefined
      ? undefined
      : {
          decoder: new TextDecoder(),
          raw: "",
          text: new StreamText(captureChars),
        };
  const parser = new SseParser((event) => {
    collector.add(event);
    capture?.text.add(event);
  });
  const reader = source.getReader();
  let finished = false;
  const finish = (outcome: UsageRecord["outcome"]) => {
    if (finished) return;
    finished = true;
    parser.end();
    deps.inflight.remove(agent.id, controller);
    done(
      collector,
      outcome,
      capture ? { raw: capture.raw, text: capture.text.text } : undefined,
    );
  };

  return new ReadableStream<Uint8Array>({
    start(sink) {
      controller.signal.addEventListener(
        "abort",
        () => {
          finish("aborted");
          try {
            sink.error(controller.signal.reason);
          } catch {
            // Already closed or errored.
          }
          reader.cancel().catch(() => undefined);
        },
        { once: true },
      );
    },
    async pull(sink) {
      try {
        const { done, value } = await reader.read();
        if (finished && controller.signal.aborted) return;
        if (done) {
          finish("complete");
          sink.close();
          return;
        }
        collector.bytes += value.byteLength;
        parser.push(value);
        if (capture && captureChars !== undefined) {
          if (capture.raw.length <= captureChars) {
            capture.raw += capture.decoder.decode(value, { stream: true });
          }
        }
        sink.enqueue(value);
      } catch (err) {
        finish(controller.signal.aborted ? "aborted" : "error");
        try {
          sink.error(err);
        } catch {
          // Already errored by the abort handler.
        }
      }
    },
    cancel() {
      // The agent disconnected: stop paying for tokens nobody will read.
      finish("aborted");
      controller.abort();
    },
  });
}

function recordUsage(
  deps: GatewayDeps,
  args: {
    agent: Agent;
    provider: Provider;
    route: Route;
    usage: TokenUsage;
    /** The token counts are Purser's estimate, not the provider's. */
    estimated: boolean;
    keyUsed: "current" | "previous";
    model: string | null;
    requestModel: string | null;
    outcome: UsageRecord["outcome"];
    started: Date;
    status: number;
    /** The charge the provider reported, used instead of the price table. */
    reportedUsd: number | null;
    logged: boolean;
  },
): UsageRecord {
  const model = args.model ?? "unknown";
  const price = findPrice(
    deps.prices,
    args.provider.pricingModel(model),
    totalInputTokens(args.usage),
  );
  // The model asked for sets the price: a stream may name another, such as
  // the one openrouter/auto picked or one without its ":free".
  const openRouterRates =
    args.estimated && args.provider.id === "openrouter"
      ? (deps.openRouterPrices?.find(args.requestModel) ??
        deps.openRouterPrices?.find(model))
      : null;
  const finishedAt = deps.now();
  const record: UsageRecord = {
    id: newId("use"),
    agentId: args.agent.id,
    provider: args.provider.id,
    endpoint: args.route.name,
    model,
    at: finishedAt.toISOString(),
    ...args.usage,
    costUsd:
      args.reportedUsd ?? costUsd(args.usage, openRouterRates ?? price.rates),
    priced:
      args.reportedUsd !== null
        ? "provider"
        : args.estimated
          ? "estimate"
          : price.matched === null
            ? "fallback"
            : "table",
    key: args.keyUsed,
    status: args.status,
    durationMs: finishedAt.getTime() - args.started.getTime(),
    outcome: args.outcome,
    logged: args.logged || undefined,
  };
  deps.store.recordUsage(record);
  return record;
}

/**
 * Settles as soon as the signal aborts, even if the underlying promise does
 * not listen to it. A kill must not wait on a slow provider.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err as Error);
      },
    );
  });
}

function refuse(
  deps: GatewayDeps,
  provider: Provider,
  agent: Agent,
  denial: { status: number; code: string; message: string },
): Response {
  deps.store.audit({
    at: deps.now().toISOString(),
    type: "request.denied",
    agentId: agent.id,
    detail: { code: denial.code, provider: provider.id },
  });
  return deny(provider, denial.status, denial.code, denial.message);
}

function stoppedResponse(provider: Provider, agent: Agent): Response {
  return deny(
    provider,
    403,
    "agent_paused",
    `Agent "${agent.name}" was paused while this request was running.`,
  );
}

function spec(provider: Provider): UsageSpec {
  return {
    kind: provider.kind,
    reportsCost: provider.manifest.costSource === "provider",
  };
}
