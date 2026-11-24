import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_CONNECTORS } from "./connectors.js";
import type { SubscriptionDirs } from "./subscriptions.js";

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Provider keys from the environment, by connector id. */
  providerKeys: Partial<Record<string, string>>;
  /** Upstream base URLs by connector id: the built-in defaults, with environment overrides. */
  upstreams: Partial<Record<string, string>>;
  subscriptionDirs: SubscriptionDirs;
  /** Where the built web UI is. */
  webDir: string;
  /** The address agents and browsers use to reach this server. */
  baseUrl: string;
}

type Env = Record<string, string | undefined>;

export const DEFAULT_PORT = 4141;

export function dataDirFrom(env: Env): string {
  return env.PURSER_DATA_DIR ?? join(homedir(), ".purser");
}

export function loadConfig(env: Env): ServerConfig {
  const host = env.PURSER_HOST ?? "127.0.0.1";
  if (!isLoopback(host) && env.PURSER_ALLOW_REMOTE !== "1") {
    throw new Error(
      `Refusing to listen on ${host}. Purser binds to localhost by default; set PURSER_ALLOW_REMOTE=1 and put it behind HTTPS to expose it.`,
    );
  }
  // PURSER_<ID>_API_KEY and PURSER_<ID>_UPSTREAM, where <ID> is a connector id
  // in upper case with dashes as underscores (PURSER_AZURE_OPENAI_API_KEY).
  const providerKeys: Partial<Record<string, string>> = {};
  const upstreams: Partial<Record<string, string>> = {};
  for (const m of BUILTIN_CONNECTORS) {
    if (!m.needsUpstream) upstreams[m.id] = m.upstream;
  }
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    const key = /^PURSER_([A-Z0-9_]+)_API_KEY$/.exec(name);
    if (key?.[1]) providerKeys[connectorId(key[1])] = value;
    const up = /^PURSER_([A-Z0-9_]+)_UPSTREAM$/.exec(name);
    if (up?.[1]) upstreams[connectorId(up[1])] = trimSlash(value);
  }
  const port = Number(env.PURSER_PORT ?? DEFAULT_PORT);
  return {
    host,
    port,
    dataDir: dataDirFrom(env),
    providerKeys,
    subscriptionDirs: {
      claudeDir: env.PURSER_CLAUDE_DIR ?? join(homedir(), ".claude"),
      codexDir: env.PURSER_CODEX_DIR ?? join(homedir(), ".codex"),
    },
    upstreams,
    webDir: env.PURSER_WEB_DIR ?? defaultWebDir(),
    baseUrl: env.PURSER_BASE_URL
      ? baseUrlFrom(env.PURSER_BASE_URL)
      : `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
  };
}

/**
 * The address people and agents reach Purser at, when it isn't the one it
 * listens on: inside a container, or behind an HTTPS proxy.
 */
function baseUrlFrom(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PURSER_BASE_URL is not a URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PURSER_BASE_URL must start with http:// or https://.");
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(
      "PURSER_BASE_URL takes a plain address, like https://purser.example.com.",
    );
  }
  return trimSlash(url.toString());
}

/** "AZURE_OPENAI" becomes "azure-openai". */
function connectorId(envPart: string): string {
  return envPart.toLowerCase().replace(/_/g, "-");
}

/** The web build sits beside the server in the repository: apps/web/dist. */
function defaultWebDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

/**
 * The admin token comes from PURSER_ADMIN_TOKEN, or from a file in the data
 * directory that only the current user can read. It is created on first run.
 */
export function adminToken(env: Env, dataDir: string): string {
  if (env.PURSER_ADMIN_TOKEN) return env.PURSER_ADMIN_TOKEN;
  const file = adminTokenFile(dataDir);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = `purser_admin_${randomBytes(32).toString("base64url")}`;
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

export function adminTokenFile(dataDir: string): string {
  return join(dataDir, "admin-token");
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
