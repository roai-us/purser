#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { createApp, VERSION } from "./app.js";
import { CallLog } from "./logs.js";
import { Org } from "./org.js";
import {
  adminToken,
  adminTokenFile,
  DEFAULT_PORT,
  dataDirFrom,
  isLoopback,
  loadConfig,
} from "./config.js";
import { loadCustomConnectors } from "./connectors.js";
import { demoFetch } from "./demo-upstream.js";
import { runMcpBridge } from "./mcp-stdio.js";
import { generateSeed, writeSeed } from "./seed.js";
import { Sessions } from "./sessions.js";
import { OpenRouterKeys } from "./openrouter-keys.js";
import { Vault } from "./vault.js";
import { InFlight } from "./inflight.js";
import { formatUsd } from "./money.js";
import { DEFAULT_PRICES } from "./prices.js";
import { Store } from "./store.js";
import type { SubscriptionReport } from "./subscriptions.js";
import type { PublicAgent } from "./types.js";
import { Workflows } from "./workflows.js";
import { Alerts } from "./alerts.js";
import { sweepAlerts } from "./workflowapi.js";

interface ApiError {
  error?: { code?: string; message?: string } | string;
}

const HELP = `ROAI Purser ${VERSION}

Usage:
  roai serve [--no-open]             Start Purser and open the web UI in your browser.
                                     "roai" on its own does the same.
  roai agent add <name> --owner <who> [--daily <usd>] [--monthly <usd>]
                 [--models <id,id>] [--purpose <text>] [--ends <iso date>]
  roai agent list                    List agents with today's and this month's spend
  roai kill <agent>                  Pause an agent and cut its open requests
  roai kill --all                    Pause every agent
  roai resume <agent>                Let a paused agent run again
  roai limits <agent> [--daily <usd>] [--monthly <usd>] [--models <id,id>]
  roai rotate-key <agent> [--grace <minutes>]
                                     Issue a new key; the old one stops working
                                     (after the grace period, if given)
  roai subscriptions [--since <day>] What your coding tools used on this machine,
                                     priced at API rates (read-only)
  roai mcp                           Connect an MCP client that only runs local programs:
                                     passes messages between stdin and Purser's /mcp.
                                     Needs PURSER_AGENT_KEY.
  roai demo-seed [--agents 1500] [--days 30] [--force]
                                     Fill the data directory with a fake fleet to try
                                     the UI at scale. Use a separate PURSER_DATA_DIR.

Environment:
  PURSER_<CONNECTOR>_API_KEY   A provider key, for example PURSER_OPENROUTER_API_KEY
                   or PURSER_AZURE_OPENAI_API_KEY. Keys can also be set in the web UI.
  PURSER_PORT (default ${DEFAULT_PORT}), PURSER_DATA_DIR (default ~/.purser)
  PURSER_CLAUDE_DIR, PURSER_CODEX_DIR   Where coding tools keep logs (default ~/.claude, ~/.codex)
  PURSER_URL       Where the CLI finds the server (default http://127.0.0.1:${DEFAULT_PORT})
  PURSER_AGENT_KEY The agent's own Purser key, for roai mcp
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // `npx @roai-us/purser` and `roai --no-open` start the server.
  if (command === undefined || command === "--no-open") return runServer(argv);
  switch (command) {
    case "serve":
      return runServer(rest);
    case "demo-seed":
      return demoSeed(rest);
    case "agent":
      return rest[0] === "add"
        ? addAgent(rest.slice(1))
        : rest[0] === "list"
          ? listAgents()
          : usage();
    case "kill":
      return kill(rest);
    case "resume":
      return simple(rest, "resume");
    case "rotate-key":
      return rotate(rest);
    case "limits":
      return limits(rest);
    case "subscriptions":
      return subscriptions(rest);
    case "mcp":
      return mcpBridge();
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      return usage();
  }
}

function usage(): number {
  process.stderr.write(HELP);
  return 1;
}

function runServer(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { "no-open": { type: "boolean" } },
  });
  const config = loadConfig(process.env);
  const token = adminToken(process.env, config.dataDir);
  const store = new Store(config.dataDir);
  const custom = loadCustomConnectors(config.dataDir);
  for (const problem of custom.problems) {
    process.stderr.write(`Skipped custom connector ${problem}\n`);
  }
  const sessions = new Sessions(() => new Date());
  const logs = new CallLog(config.dataDir, () => new Date());
  const org = new Org(config.dataDir, () => new Date());
  const workflows = new Workflows(config.dataDir);
  const vault = new Vault(config.dataDir);
  const inflight = new InFlight();
  const alerts = new Alerts(
    {
      store,
      vault,
      fetch: globalThis.fetch,
      now: () => new Date(),
      baseUrl: config.baseUrl,
    },
    config.dataDir,
  );
  const openRouterKeys = new OpenRouterKeys(
    { store, vault, fetch: globalThis.fetch, now: () => new Date() },
    config.dataDir,
  );
  // The demo's pick-a-person sign-in has no password, so it only ever runs
  // on this computer, and only when asked for.
  const demoSignIn =
    process.env.PURSER_DEMO_SIGNIN === "1" && isLoopback(config.host);
  // Look for keys about to expire and workflows past their stop line, now and
  // every hour.
  const sweep = () => {
    sweepAlerts({ store, inflight, now: () => new Date(), workflows, alerts });
    // Bring agents' OpenRouter keys in step and check them at OpenRouter.
    void openRouterKeys.sweep();
  };
  setTimeout(sweep, 5_000).unref();
  setInterval(sweep, 3_600_000).unref();
  // Delete call logs past their retention now and every hour.
  logs.purge();
  setInterval(() => logs.purge(), 3_600_000).unref();
  const app = createApp({
    store,
    inflight,
    prices: DEFAULT_PRICES,
    providerKeys: config.providerKeys,
    upstreams: config.upstreams,
    vault,
    customConnectors: custom.manifests,
    sessions,
    logs,
    org,
    workflows,
    alerts,
    openRouterKeys,
    demoSignIn,
    baseUrl: config.baseUrl,
    webDir: config.webDir,
    // In the demo, calls made with the demo's provider key are answered here.
    fetch: demoSignIn ? demoFetch(globalThis.fetch) : globalThis.fetch,
    now: () => new Date(),
    adminToken: token,
    subscriptionDirs: config.subscriptionDirs,
  });
  const server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    () => {
      const base = config.baseUrl;
      const link = `${base}/login?code=${sessions.issueLoginCode()}`;
      process.stdout.write(
        [
          `ROAI Purser ${VERSION} listening on ${base}`,
          `Data:        ${config.dataDir}`,
          `Admin token: ${process.env.PURSER_ADMIN_TOKEN ? "from PURSER_ADMIN_TOKEN" : adminTokenFile(config.dataDir)}`,
          `Agents:      ${store.agentCount()}`,
          demoSignIn
            ? "Demo sign-in: on (pick a person on the sign-in page)"
            : "",
          custom.manifests.length > 0
            ? `Custom connectors: ${custom.manifests.map((m) => m.id).join(", ")}`
            : "",
          "",
          `Open Purser: ${link}`,
          "(This sign-in link works once, for 15 minutes.)",
          "",
        ]
          .filter((line, i, all) => line !== "" || all[i - 1] !== "")
          .join("\n"),
      );
      if (!values["no-open"]) openBrowser(link);
    },
  );
  // Every write is finished before it returns, so stopping now loses nothing.
  // In a container Purser is process 1, which gets no default handlers.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      server.close();
      process.exit(0);
    });
  }
  return 0;
}

/** Opens a URL in the default browser. Never fails: the link is printed anyway. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // No browser to open: the printed link still works.
  }
}

async function mcpBridge(): Promise<number> {
  const key = process.env.PURSER_AGENT_KEY;
  if (!key) {
    process.stderr.write("Set PURSER_AGENT_KEY to the agent's Purser key.\n");
    return 1;
  }
  const base = process.env.PURSER_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  await runMcpBridge({
    url: `${base.replace(/\/+$/, "")}/mcp`,
    key,
    fetch: globalThis.fetch,
    input: process.stdin,
    output: process.stdout,
  });
  return 0;
}

function demoSeed(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      agents: { type: "string" },
      days: { type: "string" },
      force: { type: "boolean" },
    },
  });
  const agents = Number(values.agents ?? 1500);
  const days = Number(values.days ?? 30);
  if (!Number.isInteger(agents) || agents < 1 || agents > 100_000) {
    throw new Error("--agents must be a whole number from 1 to 100000.");
  }
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error("--days must be a whole number from 1 to 366.");
  }
  const dataDir = dataDirFrom(process.env);
  const seed = generateSeed({
    agents,
    days,
    now: new Date(),
    prices: DEFAULT_PRICES,
  });
  writeSeed(dataDir, seed, values.force === true);
  process.stdout.write(
    `Wrote ${seed.agents.length} demo agents, ${seed.usage.length} usage records and ${seed.audit.length} audit events to ${dataDir}.\nStart Purser on it with: PURSER_DATA_DIR=${dataDir} roai serve\n`,
  );
  return 0;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const config = loadConfig({ ...process.env, PURSER_HOST: "127.0.0.1" });
  const base = process.env.PURSER_URL ?? `http://127.0.0.1:${config.port}`;
  const token = adminToken(process.env, config.dataDir);
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  let response: Response;
  try {
    response = await fetch(`${base}/admin${path}`, init);
  } catch {
    throw new Error(
      `Could not reach Purser at ${base}. Is \`roai serve\` running?`,
    );
  }
  const data = (await response.json()) as ApiError;
  if (!response.ok) {
    const message =
      typeof data.error === "string" ? data.error : data.error?.message;
    throw new Error(message ?? `Request failed with ${response.status}.`);
  }
  return data;
}

const money = formatUsd;

function numberFlag(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`--${name} must be a dollar amount.`);
  return n;
}

const limitOptions = {
  daily: { type: "string" },
  monthly: { type: "string" },
  models: { type: "string" },
} as const;

function limitsFrom(values: {
  daily?: string | undefined;
  monthly?: string | undefined;
  models?: string | undefined;
}) {
  const limits: { dailyUsd?: number; monthlyUsd?: number; models?: string[] } =
    {};
  const daily = numberFlag(values.daily, "daily");
  const monthly = numberFlag(values.monthly, "monthly");
  if (daily !== undefined) limits.dailyUsd = daily;
  if (monthly !== undefined) limits.monthlyUsd = monthly;
  if (values.models !== undefined) {
    limits.models = values.models
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
  }
  return limits;
}

async function addAgent(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...limitOptions,
      owner: { type: "string" },
      purpose: { type: "string" },
      ends: { type: "string" },
    },
  });
  const name = positionals[0];
  if (!name || !values.owner) {
    process.stderr.write(
      "Every agent needs a name and an owner: roai agent add <name> --owner <who>\n",
    );
    return 1;
  }
  const body: Record<string, unknown> = {
    name,
    owner: values.owner,
    limits: limitsFrom(values),
  };
  if (values.purpose) body.purpose = values.purpose;
  if (values.ends) body.endsAt = new Date(values.ends).toISOString();
  const result = (await api("POST", "/agents", body)) as {
    agent: PublicAgent;
    key: string;
  };
  process.stdout.write(
    [
      `Registered ${result.agent.name} (${result.agent.id}), owner ${result.agent.owner}.`,
      "",
      `Agent key (shown once, store it now): ${result.key}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function listAgents(): Promise<number> {
  const { items: agents, total } = (await api(
    "GET",
    "/agents?pageSize=200&sort=spend_today",
  )) as { items: PublicAgent[]; total: number };
  if (agents.length === 0) {
    process.stdout.write(
      "No agents yet. Add one with: roai agent add <name> --owner <who>\n",
    );
    return 0;
  }
  for (const a of agents) {
    const caps = [
      a.limits.dailyUsd !== undefined
        ? `${money(a.limits.dailyUsd)}/day`
        : null,
      a.limits.monthlyUsd !== undefined
        ? `${money(a.limits.monthlyUsd)}/month`
        : null,
    ].filter(Boolean);
    process.stdout.write(
      `${a.state.toUpperCase().padEnd(8)}  ${a.name}  owner ${a.owner}  today ${money(a.spend.today)}  month ${money(a.spend.month)}  caps ${caps.length > 0 ? caps.join(", ") : "none"}\n`,
    );
  }
  if (total > agents.length) {
    process.stdout.write(
      `...and ${total - agents.length} more. The web UI shows them all.\n`,
    );
  }
  return 0;
}

async function kill(args: string[]): Promise<number> {
  if (args[0] === "--all") {
    const r = (await api("POST", "/kill-all")) as {
      paused: number;
      abortedRequests: number;
      elapsedMs: number;
    };
    process.stdout.write(
      `Paused ${r.paused} agents, cut ${r.abortedRequests} open requests in ${r.elapsedMs.toFixed(1)} ms.\n`,
    );
    return 0;
  }
  const ref = args[0];
  if (!ref) return usage();
  const r = (await api("POST", `/agents/${encodeURIComponent(ref)}/kill`, {
    by: "cli",
  })) as {
    agent: PublicAgent;
    abortedRequests: number;
    elapsedMs: number;
  };
  process.stdout.write(
    `Paused ${r.agent.name}. Cut ${r.abortedRequests} open requests in ${r.elapsedMs.toFixed(1)} ms. New requests are refused.\n`,
  );
  return 0;
}

async function simple(args: string[], action: "resume"): Promise<number> {
  const ref = args[0];
  if (!ref) return usage();
  const r = (await api("POST", `/agents/${encodeURIComponent(ref)}/${action}`, {
    by: "cli",
  })) as { agent: PublicAgent };
  process.stdout.write(`${r.agent.name} is ${r.agent.status}.\n`);
  return 0;
}

async function rotate(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { grace: { type: "string" } },
  });
  const ref = positionals[0];
  if (!ref) return usage();
  const body: Record<string, unknown> = {};
  if (values.grace !== undefined) {
    const grace = Number(values.grace);
    if (!Number.isInteger(grace) || grace < 0) {
      throw new Error("--grace must be a whole number of minutes.");
    }
    body.graceMinutes = grace;
  }
  const r = (await api(
    "POST",
    `/agents/${encodeURIComponent(ref)}/rotate-key`,
    body,
  )) as { agent: PublicAgent; key: string; previousKeyValidUntil?: string };
  process.stdout.write(
    `New key for ${r.agent.name} (shown once): ${r.key}\n${
      r.previousKeyValidUntil
        ? `The old key keeps working until ${r.previousKeyValidUntil}.`
        : "The old key no longer works."
    }\n`,
  );
  return 0;
}

async function limits(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: limitOptions,
  });
  const ref = positionals[0];
  if (!ref) return usage();
  const r = (await api(
    "PATCH",
    `/agents/${encodeURIComponent(ref)}/limits`,
    limitsFrom(values),
  )) as { agent: PublicAgent };
  process.stdout.write(
    `${r.agent.name} limits: ${JSON.stringify(r.agent.limits)}\n`,
  );
  return 0;
}

async function subscriptions(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { since: { type: "string" } },
  });
  const query = values.since
    ? `?since=${encodeURIComponent(values.since)}`
    : "";
  const r = (await api("GET", `/subscriptions${query}`)) as SubscriptionReport;
  const out: string[] = [`Since ${r.since} (UTC), priced at API rates:`, ""];
  for (const t of r.tools) {
    out.push(
      t.found
        ? `  ${t.tool.padEnd(12)} ${String(t.responses).padStart(7)} responses  ${money(t.apiEquivalentUsd)}`
        : `  ${t.tool.padEnd(12)} not found on this machine`,
    );
  }
  out.push("", `  Total API-equivalent value: ${money(r.apiEquivalentUsd)}`);
  const unpriced = [
    ...new Set(
      r.rows.filter((row) => row.priced === "fallback").map((row) => row.model),
    ),
  ];
  if (unpriced.length > 0) {
    out.push(
      "",
      `  Not in the price table, so priced at the highest rate: ${unpriced.join(", ")}`,
    );
  }
  out.push(
    "",
    "Compare this with what your plans cost each month. Purser only reads these",
    "logs; it cannot cap or stop subscription usage.",
    "",
  );
  process.stdout.write(out.join("\n"));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
