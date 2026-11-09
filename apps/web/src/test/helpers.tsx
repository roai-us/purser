import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { vi } from "vitest";
import type { Agent, AgentPage, Connector, Overview } from "../api/types";

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => unknown | Promise<unknown>;
type Reply = { status: number; body: unknown };

/** Stand-in for fetch: routes "METHOD /path" (path without query) to handlers. */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method, url, headers, body };
    calls.push(call);
    const path = new URL(url, "http://localhost").pathname;
    const handler = routes[`${method} ${path}`];
    if (!handler) {
      return new Response(
        JSON.stringify({
          error: {
            code: "not_found",
            message: `No mock for ${method} ${path}`,
          },
        }),
        { status: 404 },
      );
    }
    const result = await handler(call);
    const reply: Reply =
      result &&
      typeof result === "object" &&
      "status" in result &&
      "body" in result
        ? (result as Reply)
        : { status: 200, body: result };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

export function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname + location.search}
    </output>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  { route = "/", path = "*" }: { route?: string; path?: string } = {},
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route
              path={path}
              element={
                <>
                  {ui}
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agt_1",
    name: "newsletter-writer",
    owner: "Dana Ortiz",
    team: "Marketing",
    status: "active",
    state: "running",
    keyHint: "purser_ab...wxyz",
    keyState: "ok",
    limits: { dailyUsd: 2, monthlyUsd: 20 },
    spend: { today: 0.31, month: 4.2 },
    requests: { today: 12 },
    createdAt: "2026-11-01T10:00:00.000Z",
    lastUsedAt: "2026-11-07T10:00:00.000Z",
    ...overrides,
  };
}

export function makePage(
  items: Agent[],
  overrides: Partial<AgentPage> = {},
): AgentPage {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 50,
    facets: {
      owners: ["Dana Ortiz", "Sam Lee"],
      teams: ["Marketing", "Support"],
      providers: ["openrouter"],
    },
    ...overrides,
  };
}

export function makeConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    source: "builtin",
    agentBaseUrl: "http://127.0.0.1:4141/openrouter/api/v1",
    envHint: { baseUrlVar: "OPENAI_BASE_URL", apiKeyVar: "OPENAI_API_KEY" },
    configured: true,
    keyHint: "sk-or...7b30",
    keySource: "vault",
    testModel: "openai/gpt-4o-mini",
    costSource: "provider",
    keyPlaceholder: "sk-or-...",
    ...overrides,
  };
}

export function makeOverview(overrides: Partial<Overview> = {}): Overview {
  return {
    spend: { today: 5.42, month: 63.1 },
    requests: { today: 210 },
    agents: { total: 4, running: 3, paused: 1, atLimit: 0, expired: 0 },
    providers: { configured: 1, total: 3 },
    topToday: [makeAgent()],
    recentEvents: [
      {
        at: "2026-11-07T10:00:00.000Z",
        type: "agent.paused",
        agentId: "agt_1",
      },
    ],
    ...overrides,
  };
}

/** The value, or a test failure if it is missing. */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined)
    throw new Error(`Expected ${what}`);
  return value;
}
