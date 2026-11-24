import type {
  Agent,
  AgentPage,
  AgentPatch,
  AgentQuery,
  AgentUsage,
  AuditPage,
  BulkAction,
  BulkResult,
  Connector,
  ConnectorTest,
  CreatedAgent,
  KillAllResult,
  KillResult,
  NewAgent,
  Overview,
  RotateResult,
  StatusBoard,
  CallEntry,
  CallPage,
  LogSettings,
  AgentAsk,
  AgentRequest,
  AskResult,
  DepartmentsPage,
  Me,
  OffboardResult,
  OrgSettingsView,
  PeoplePage,
  Person,
  RaiseResult,
  RotateAllResult,
  SecurityView,
  SelfServicePolicy,
  ServiceAsk,
  ServiceLimit,
  ServiceResult,
  SessionInfo,
  SignInOptions,
  NewOutcome,
  NewWorkflow,
  Outcome,
  Workflow,
  WorkflowAgent,
  WorkflowDetail,
  WorkflowPatch,
  WorkflowSummary,
} from "./types";

/** Fired on window when the server says the session is gone. */
export const UNAUTHORIZED_EVENT = "purser:unauthorized";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const OFFLINE_MESSAGE =
  "Purser isn't responding. Check that it is still running on this computer.";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  // The server refuses cookie-authenticated changes without this header. A
  // page on another site cannot add it, which blocks cross-site requests.
  if (method !== "GET") headers["x-purser-csrf"] = "1";

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, "offline", OFFLINE_MESSAGE);
  }

  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } })
      ?.error;
    if (
      response.status === 401 &&
      (path.startsWith("/admin") || path.startsWith("/me"))
    ) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(
      response.status,
      error?.code ?? `http_${response.status}`,
      error?.message ?? `Something went wrong (error ${response.status}).`,
    );
  }
  return data as T;
}

/** Builds a query string, leaving out empty values. */
export function queryString(
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

const enc = encodeURIComponent;

export const api = {
  session: () => request<SessionInfo>("GET", "/auth/session"),
  signInOptions: () => request<SignInOptions>("GET", "/auth/options"),
  demoSignIn: (personId: string) =>
    request<{ authenticated: boolean }>("POST", "/auth/demo", { personId }),
  login: (token: string) =>
    request<{ authenticated: boolean }>("POST", "/auth/session", { token }),
  logout: () => request<unknown>("DELETE", "/auth/session"),

  overview: () => request<Overview>("GET", "/admin/overview"),
  status: (limit = 120) =>
    request<StatusBoard>("GET", `/admin/status${queryString({ limit })}`),

  agents: (query: AgentQuery = {}) =>
    request<AgentPage>("GET", `/admin/agents${queryString({ ...query })}`),
  agent: (ref: string) => request<Agent>("GET", `/admin/agents/${enc(ref)}`),
  createAgent: (agent: NewAgent) =>
    request<CreatedAgent>("POST", "/admin/agents", agent),
  updateAgent: (ref: string, patch: AgentPatch) =>
    request<Agent>("PATCH", `/admin/agents/${enc(ref)}`, patch),
  kill: (ref: string) =>
    request<KillResult>("POST", `/admin/agents/${enc(ref)}/kill`),
  resume: (ref: string) =>
    request<{ agent: Agent }>("POST", `/admin/agents/${enc(ref)}/resume`),
  rotateKey: (ref: string, graceMinutes: number) =>
    request<RotateResult>("POST", `/admin/agents/${enc(ref)}/rotate-key`, {
      graceMinutes,
    }),
  bulk: (action: BulkAction, ids: string[], graceMinutes?: number) =>
    request<BulkResult>("POST", "/admin/agents/bulk", {
      action,
      ids,
      ...(graceMinutes !== undefined ? { graceMinutes } : {}),
    }),
  raiseLimit: (
    ref: string,
    raise: { window: "day" | "month"; amountUsd: number; reason?: string },
  ) =>
    request<{ agent: Agent }>(
      "POST",
      `/admin/agents/${enc(ref)}/raise-limit`,
      raise,
    ),
  setService: (ref: string, provider: string, limit: ServiceLimit) =>
    request<Agent>(
      "PUT",
      `/admin/agents/${enc(ref)}/services/${enc(provider)}`,
      limit,
    ),
  removeService: (ref: string, provider: string) =>
    request<Agent>(
      "DELETE",
      `/admin/agents/${enc(ref)}/services/${enc(provider)}`,
    ),
  security: (department?: string) =>
    request<SecurityView>(
      "GET",
      `/admin/security${queryString({ department })}`,
    ),
  rotateAll: (body: {
    confirm: string;
    reason: string;
    department?: string;
    graceMinutes: number;
  }) => request<RotateAllResult>("POST", "/admin/security/rotate-all", body),
  killAll: () => request<KillAllResult>("POST", "/admin/kill-all"),
  agentUsage: (ref: string, days = 30) =>
    request<AgentUsage>(
      "GET",
      `/admin/agents/${enc(ref)}/usage${queryString({ days })}`,
    ),

  providers: () => request<Connector[]>("GET", "/admin/providers"),
  saveProviderKey: (id: string, apiKey: string, upstream?: string) =>
    request<Connector>("PUT", `/admin/providers/${enc(id)}/key`, {
      apiKey,
      ...(upstream ? { upstream } : {}),
    }),
  testProvider: (id: string) =>
    request<ConnectorTest>("POST", `/admin/providers/${enc(id)}/test`),
  confirmOldKeysDeleted: (id: string) =>
    request<Connector>("POST", `/admin/providers/${enc(id)}/old-keys/deleted`),
  removeProviderKey: (id: string) =>
    request<Connector>("DELETE", `/admin/providers/${enc(id)}/key`),

  settings: () => request<{ logging: LogSettings }>("GET", "/admin/settings"),
  saveLogging: (patch: Partial<LogSettings>) =>
    request<{ logging: LogSettings }>("PUT", "/admin/settings/logging", patch),
  logs: (params: { agent?: string; before?: string; limit?: number } = {}) =>
    request<CallPage>("GET", `/admin/logs${queryString(params)}`),
  log: (id: string) => request<CallEntry>("GET", `/admin/logs/${enc(id)}`),

  // Workflows and ROI (admins)
  workflows: (status: "active" | "archived" | "all" = "active") =>
    request<{ workflows: WorkflowSummary[] }>(
      "GET",
      `/admin/workflows${queryString({ status })}`,
    ),
  workflow: (ref: string) =>
    request<WorkflowDetail>("GET", `/admin/workflows/${enc(ref)}`),
  workflowReport: (ref: string, period: { from?: string; to?: string } = {}) =>
    request<WorkflowDetail>(
      "GET",
      `/admin/workflows/${enc(ref)}/report${queryString(period)}`,
    ),
  createWorkflow: (input: NewWorkflow) =>
    request<{ workflow: Workflow; agents: WorkflowAgent[] }>(
      "POST",
      "/admin/workflows",
      input,
    ),
  updateWorkflow: (ref: string, patch: WorkflowPatch) =>
    request<{ workflow: Workflow; agents: WorkflowAgent[] }>(
      "PATCH",
      `/admin/workflows/${enc(ref)}`,
      patch,
    ),
  outcomes: (ref: string, limit = 50) =>
    request<{ outcomes: Outcome[]; total: number }>(
      "GET",
      `/admin/workflows/${enc(ref)}/outcomes${queryString({ limit })}`,
    ),
  recordOutcome: (ref: string, input: NewOutcome) =>
    request<{ outcome: Outcome; duplicate: boolean; locked?: boolean }>(
      "POST",
      `/admin/workflows/${enc(ref)}/outcomes`,
      input,
    ),
  voidOutcome: (ref: string, id: string) =>
    request<{ outcome: Outcome }>(
      "POST",
      `/admin/workflows/${enc(ref)}/outcomes/${enc(id)}/void`,
    ),

  // People, departments and organisation settings (admins)
  people: (
    params: {
      q?: string;
      role?: string;
      department?: string;
      status?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) => request<PeoplePage>("GET", `/admin/people${queryString(params)}`),
  addPerson: (person: {
    email: string;
    name: string;
    role?: string;
    department?: string;
    manages?: string[];
  }) => request<Person>("POST", "/admin/people", person),
  updatePerson: (
    ref: string,
    patch: {
      name?: string;
      role?: string;
      department?: string | null;
      manages?: string[];
    },
  ) => request<Person>("PATCH", `/admin/people/${enc(ref)}`, patch),
  disablePerson: (ref: string, reassignTo?: string) =>
    request<OffboardResult>(
      "POST",
      `/admin/people/${enc(ref)}/disable`,
      reassignTo ? { reassignTo } : {},
    ),
  enablePerson: (ref: string) =>
    request<Person>("POST", `/admin/people/${enc(ref)}/enable`),
  departments: () => request<DepartmentsPage>("GET", "/admin/departments"),
  saveDepartment: (
    name: string,
    patch: {
      budgetMonthlyUsd?: number | null;
      selfService?: SelfServicePolicy | null;
    },
  ) => request<unknown>("PUT", `/admin/departments/${enc(name)}`, patch),
  orgSettings: () => request<OrgSettingsView>("GET", "/admin/settings/org"),
  saveSelfService: (patch: {
    selfService?: boolean;
    defaults?: SelfServicePolicy;
  }) => request<OrgSettingsView>("PUT", "/admin/settings/self-service", patch),
  saveSignIn: (config: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    allowedDomains: string[];
    adminEmails?: string[];
    label?: string;
  }) => request<OrgSettingsView>("PUT", "/admin/settings/sign-in", config),
  saveMcp: (enabled: boolean) =>
    request<OrgSettingsView>("PUT", "/admin/settings/mcp", { enabled }),
  removeSignIn: () =>
    request<OrgSettingsView>("DELETE", "/admin/settings/sign-in"),

  audit: (params: { limit?: number; before?: string; agent?: string } = {}) =>
    request<AuditPage>("GET", `/admin/audit${queryString(params)}`),
};

/** The API for whoever is signed in: their agents, requests and approvals. */
export const meApi = {
  me: () => request<Me>("GET", "/me"),
  agents: (query: AgentQuery & { scope?: "mine" | "team" } = {}) =>
    request<AgentPage>("GET", `/me/agents${queryString({ ...query })}`),
  status: (scope: "mine" | "team") =>
    request<StatusBoard>("GET", `/me/status${queryString({ scope })}`),
  agent: (ref: string) => request<Agent>("GET", `/me/agents/${enc(ref)}`),
  agentUsage: (ref: string, days = 30) =>
    request<AgentUsage>(
      "GET",
      `/me/agents/${enc(ref)}/usage${queryString({ days })}`,
    ),
  ask: (ask: AgentAsk) => request<AskResult>("POST", "/me/agents", ask),
  kill: (ref: string) =>
    request<KillResult>("POST", `/me/agents/${enc(ref)}/kill`),
  resume: (ref: string) =>
    request<{ agent: Agent }>("POST", `/me/agents/${enc(ref)}/resume`),
  rotateKey: (ref: string, graceMinutes: number) =>
    request<RotateResult>("POST", `/me/agents/${enc(ref)}/rotate-key`, {
      graceMinutes,
    }),
  raiseLimit: (
    ref: string,
    raise: { window: "day" | "month"; amountUsd: number; reason?: string },
  ) =>
    request<RaiseResult>("POST", `/me/agents/${enc(ref)}/raise-limit`, raise),
  askService: (ref: string, ask: ServiceAsk) =>
    request<ServiceResult>("POST", `/me/agents/${enc(ref)}/services`, ask),
  removeService: (ref: string, provider: string) =>
    request<Agent>(
      "DELETE",
      `/me/agents/${enc(ref)}/services/${enc(provider)}`,
    ),
  requests: () => request<{ items: AgentRequest[] }>("GET", "/me/requests"),
  cancelRequest: (id: string) =>
    request<AgentRequest>("POST", `/me/requests/${enc(id)}/cancel`),
  approvals: (status?: string) =>
    request<{ items: AgentRequest[] }>(
      "GET",
      `/me/approvals${queryString(status ? { status } : {})}`,
    ),
  approve: (id: string, note?: string) =>
    request<AgentRequest>(
      "POST",
      `/me/approvals/${enc(id)}/approve`,
      note ? { note } : {},
    ),
  deny: (id: string, note?: string) =>
    request<AgentRequest>(
      "POST",
      `/me/approvals/${enc(id)}/deny`,
      note ? { note } : {},
    ),
};

export interface TestRequestResult {
  ok: boolean;
  model?: string;
  costUsd?: number;
  error?: string;
}

/**
 * Sends one tiny request through the gateway with an agent's own key, the
 * same way a connected tool would. Same origin, so the agent key never
 * leaves this computer.
 */
export async function sendTestRequest(
  connector: Pick<Connector, "kind" | "agentBaseUrl" | "testModel">,
  agentKey: string,
): Promise<TestRequestResult> {
  const base = new URL(
    connector.agentBaseUrl,
    window.location.origin,
  ).pathname.replace(/\/$/, "");
  const model = connector.testModel ?? "";
  const anthropic = connector.kind === "anthropic";
  const url = anthropic ? `${base}/v1/messages` : `${base}/chat/completions`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (anthropic) {
    headers["x-api-key"] = agentKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${agentKey}`;
  }
  const body = {
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with the word ready." }],
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      credentials: "omit",
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: OFFLINE_MESSAGE };
  }
  const data = (await response.json().catch(() => ({}))) as {
    model?: string;
    usage?: { cost?: number };
    error?: { message?: string } | string;
  };
  if (!response.ok) {
    const message =
      typeof data.error === "string" ? data.error : data.error?.message;
    return {
      ok: false,
      error: message ?? `The request failed (error ${response.status}).`,
    };
  }
  return {
    ok: true,
    ...(data.model ? { model: data.model } : model ? { model } : {}),
    ...(typeof data.usage?.cost === "number"
      ? { costUsd: data.usage.cost }
      : {}),
  };
}
