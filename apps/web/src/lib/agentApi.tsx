import { createContext, useContext, type ReactNode } from "react";
import { api, meApi } from "../api/client";
import type {
  Agent,
  AgentUsage,
  KillResult,
  RaiseResult,
  RotateResult,
  ServiceAsk,
  ServiceResult,
  ViewerInfo,
} from "../api/types";

/**
 * What the agent panel can do, for whoever is signed in. Admins use the
 * admin API and see everything. Everyone else uses /me, which only shows
 * their own agents and those of departments they manage.
 */
export interface AgentApi {
  scope: "admin" | "me";
  agent: (ref: string) => Promise<Agent>;
  agentUsage: (ref: string, days: number) => Promise<AgentUsage>;
  kill: (ref: string) => Promise<KillResult>;
  resume: (ref: string) => Promise<{ agent: Agent }>;
  rotateKey: (ref: string, graceMinutes: number) => Promise<RotateResult>;
  raiseLimit: (
    ref: string,
    raise: { window: "day" | "month"; amountUsd: number; reason?: string },
  ) => Promise<RaiseResult>;
  /** Adds a service or changes its limits, or asks for that. */
  setService: (ref: string, ask: ServiceAsk) => Promise<ServiceResult>;
  removeService: (ref: string, provider: string) => Promise<Agent>;
  /** True when this viewer may raise the agent's limit outright, not just ask. */
  canRaise: (agent: Agent) => boolean;
}

export const adminAgentApi: AgentApi = {
  scope: "admin",
  agent: api.agent,
  agentUsage: api.agentUsage,
  kill: api.kill,
  resume: api.resume,
  rotateKey: api.rotateKey,
  raiseLimit: async (ref, raise) => ({
    status: "raised",
    agent: (await api.raiseLimit(ref, raise)).agent,
  }),
  setService: async (ref, { provider, reason: _reason, ...limit }) => ({
    status: "granted",
    agent: await api.setService(ref, provider, limit),
  }),
  removeService: api.removeService,
  canRaise: () => true,
};

export function meAgentApi(viewer: ViewerInfo | undefined): AgentApi {
  return {
    scope: "me",
    agent: meApi.agent,
    agentUsage: meApi.agentUsage,
    kill: meApi.kill,
    resume: meApi.resume,
    rotateKey: meApi.rotateKey,
    raiseLimit: meApi.raiseLimit,
    setService: meApi.askService,
    removeService: meApi.removeService,
    canRaise: (agent) =>
      viewer?.role === "admin" ||
      (viewer?.role === "manager" &&
        agent.team !== undefined &&
        (viewer.manages ?? []).includes(agent.team)),
  };
}

const Context = createContext<AgentApi>(adminAgentApi);

export function AgentApiProvider({
  value,
  children,
}: {
  value: AgentApi;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useAgentApi = () => useContext(Context);

/** Who is signed in, for pages that change with the role. */
const ViewerContext = createContext<ViewerInfo | undefined>(undefined);

export function ViewerProvider({
  viewer,
  children,
}: {
  viewer: ViewerInfo | undefined;
  children: ReactNode;
}) {
  return (
    <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>
  );
}

export const useViewer = () => useContext(ViewerContext);
