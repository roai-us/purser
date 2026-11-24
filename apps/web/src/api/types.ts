/** Types for the Purser admin API. They mirror the server's contract. */

export type AgentStatus = "active" | "paused";
/** Only "running" can make calls; every other state is the reason it can't. */
export type AgentState =
  "running" | "paused" | "at_limit" | "expired" | "key_expired";
/** Green can make calls; yellow hit a spending limit; red was stopped, ended or has a lapsed key. */
export type Light = "green" | "yellow" | "red";
/** A state to filter by, or every state but "running". */
export type StateFilter = AgentState | "not_running";
/** Which fields the search text is matched against. */
export type SearchField = "all" | "name" | "owner" | "team" | "provider";
export type KeyState = "ok" | "expiring" | "expired";

/** Rotate the key every so many days, with an overlap for the old key. */
export interface RotationPolicy {
  everyDays: number;
  graceDays: number;
}

export interface AgentLimits {
  dailyUsd?: number;
  monthlyUsd?: number;
  models?: string[];
}

export interface Agent {
  id: string;
  name: string;
  owner: string;
  team?: string;
  purpose?: string;
  /** Allowed connector ids. Absent means any configured connector. */
  providers?: string[];
  status: AgentStatus;
  state: AgentState;
  keyHint: string;
  keyRotatedAt?: string;
  previousKeyValidUntil?: string;
  /** When the current key stops working. Absent means never. */
  keyExpiresAt?: string;
  rotation?: RotationPolicy;
  /** "expiring" means within 14 days of keyExpiresAt. */
  keyState: KeyState;
  limits: AgentLimits;
  spend: { today: number; month: number };
  requests: { today: number };
  lastUsedAt?: string;
  createdAt: string;
  endsAt?: string;
  pausedAt?: string;
  pausedBy?: string;
  /** One-time raises in force right now, on top of `limits`. */
  raised?: { dailyUsd?: number; monthlyUsd?: number };
  /** Keep this agent's call bodies when logging is set to chosen agents. */
  logCalls?: boolean;
  /** The owner's company email. */
  ownerEmail?: string;
  /** Its owner has a new key to collect: it was just approved, or its key was replaced. */
  awaitingKey?: boolean;
  /** Limits per service, by connector id. */
  serviceLimits?: Record<string, ServiceLimit>;
  /** Spend per service, for the services it may use or has used. */
  serviceSpend?: Record<string, { today: number; month: number }>;
}

/** What an agent may do on one service, on top of its overall limits. */
export interface ServiceLimit {
  dailyUsd?: number;
  monthlyUsd?: number;
  models?: string[];
}

export interface ServiceAsk extends ServiceLimit {
  provider: string;
  reason?: string;
}

export type ServiceResult =
  | { status: "granted"; agent: Agent; request?: AgentRequest }
  | { status: "pending"; request: AgentRequest };

export type SortKey =
  | "name"
  | "spend_today"
  | "spend_month"
  | "created"
  | "last_used"
  | "key_expires";

export interface AgentQuery {
  q?: string;
  in?: SearchField;
  state?: StateFilter;
  light?: Light;
  keyState?: KeyState;
  /** "1": only agents whose owner has a new key to collect. */
  awaitingKey?: "1";
  provider?: string;
  owner?: string;
  team?: string;
  sort?: SortKey;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface AgentPage {
  items: Agent[];
  total: number;
  page: number;
  pageSize: number;
  facets: { owners: string[]; teams: string[]; providers: string[] };
}

export interface NewAgent {
  name: string;
  owner: string;
  ownerEmail?: string;
  team?: string;
  purpose?: string;
  providers?: string[];
  limits?: AgentLimits;
  endsAt?: string;
  keyExpiresAt?: string;
  rotation?: RotationPolicy;
}

export interface AgentPatch {
  owner?: string;
  ownerEmail?: string | null;
  team?: string;
  purpose?: string;
  providers?: string[];
  limits?: AgentLimits;
  endsAt?: string | null;
  keyExpiresAt?: string | null;
  rotation?: RotationPolicy | null;
  logCalls?: boolean;
}

export interface CreatedAgent {
  agent: Agent;
  key: string;
}

export interface KillResult {
  agent: Agent;
  abortedRequests: number;
  elapsedMs: number;
}

export interface RotateResult {
  agent: Agent;
  key: string;
  previousKeyValidUntil?: string;
}

export type BulkAction = "kill" | "resume" | "rotate-key";

export interface BulkResult {
  results: {
    id: string;
    name: string;
    ok: boolean;
    error?: string;
    key?: string;
  }[];
  abortedRequests?: number;
  elapsedMs: number;
}

export interface KillAllResult {
  paused: number;
  abortedRequests: number;
  elapsedMs: number;
}

export interface UsageRecord {
  id: string;
  agentId: string;
  provider: string;
  endpoint: string;
  model: string;
  at: string;
  costUsd: number;
  priced: "provider" | "table" | "fallback";
  status: number;
  durationMs: number;
  outcome: "complete" | "aborted" | "error";
  inputTokens: number;
  outputTokens: number;
  /** Its request and response are in the call log under the same id. */
  logged?: boolean;
}

export type LogMode = "off" | "all" | "selected";

export interface LogSettings {
  mode: LogMode;
  retentionDays: number;
  maxKb: number;
}

export interface CallSummary {
  id: string;
  agentId: string;
  agentName: string;
  at: string;
  provider: string;
  endpoint: string;
  model: string;
  status: number;
  outcome: "complete" | "aborted" | "error";
  costUsd: number;
  durationMs: number;
  requestPreview: string;
  responsePreview: string;
  truncated: boolean;
}

export interface CallEntry extends CallSummary {
  request: string;
  response: string;
  responseText?: string;
}

export interface CallPage {
  items: CallSummary[];
  next?: string;
  settings: LogSettings;
}

export interface DailyUsage {
  date: string;
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentUsage {
  daily: DailyUsage[];
  recent: UsageRecord[];
}

export interface AuditEvent {
  at: string;
  type: string;
  agentId?: string;
  detail?: Record<string, unknown>;
}

export interface Overview {
  spend: { today: number; month: number };
  requests: { today: number };
  agents: {
    total: number;
    running: number;
    paused: number;
    atLimit: number;
    expired: number;
    keyExpired?: number;
  };
  providers: { configured: number; total: number };
  keys?: { expiring: number; expired: number };
  topToday: Agent[];
  recentEvents: AuditEvent[];
}

/** One agent that can't make calls right now. */
export interface StoppedAgent {
  id: string;
  name: string;
  owner: string;
  team?: string;
  state: Exclude<AgentState, "running">;
  since?: string;
  by?: string;
}

/** The fleet at a glance, for the status bar. */
export interface StatusBoard {
  total: number;
  running: number;
  notRunning: number;
  /** Of those, the ones at a spending limit: yellow. */
  atLimit: number;
  /** Most recently stopped first, capped; notRunning has the full count. */
  stopped: StoppedAgent[];
}

export interface ConnectorTest {
  ok: boolean;
  at?: string;
  latencyMs?: number;
  error?: string;
}

export interface Connector {
  id: string;
  name: string;
  kind: "openai-compatible" | "anthropic";
  source: "builtin" | "custom";
  agentBaseUrl: string;
  envHint: { baseUrlVar: string; apiKeyVar: string };
  configured: boolean;
  keyHint?: string;
  keySource?: "vault" | "env";
  lastTest?: ConnectorTest;
  testModel?: string;
  docsUrl?: string;
  /** The page where an admin makes a new key. */
  keysUrl?: string;
  keyPlaceholder?: string;
  /** When the current key was saved. Unknown for a key from the environment. */
  keySetAt?: string;
  /** Replaced keys someone still has to delete at the provider. */
  oldKeys?: { hint: string; replacedAt: string }[];
  needsUpstream?: boolean;
  upstream?: string;
  costSource: "provider" | "table";
}

export interface AuditPage {
  items: AuditEvent[];
  next?: string;
}

// People, departments and self-service

export type Role = "admin" | "manager" | "member";

/** Who is signed in. The owner signed in with the admin token or link. */
export interface ViewerInfo {
  kind: "owner" | "person";
  role: Role;
  name: string;
  email?: string;
  department?: string;
  manages?: string[];
}

export interface SessionInfo {
  authenticated: boolean;
  viewer?: ViewerInfo;
}

export interface SignInOptions {
  sso: { label: string } | null;
  demo:
    | {
        id: string;
        name: string;
        email: string;
        role: Role;
        department?: string;
        manages?: string[];
      }[]
    | null;
}

export interface SelfServicePolicy {
  autoApproveDailyUsd: number;
  maxDailyUsd: number;
  allowedProviders?: string[];
}

export interface Me {
  viewer: ViewerInfo;
  selfService: boolean;
  policy: SelfServicePolicy;
  providers: Connector[];
  /** Where agents connect over MCP, and whether they may. */
  mcp?: { enabled: boolean; url: string };
  /** How many of this person's agents have a new key to collect. */
  keysWaiting?: number;
  pending: { mine: number; toDecide: number };
}

export interface Person {
  id: string;
  email: string;
  name: string;
  role: Role;
  department?: string;
  manages?: string[];
  status: "active" | "disabled";
  source: "sso" | "admin" | "demo";
  createdAt: string;
  lastSignInAt?: string;
  disabledAt?: string;
  disabledBy?: string;
}

export interface PersonRow extends Person {
  agents: number;
  running: number;
  spendMonth: number;
}

export interface PeoplePage {
  items: PersonRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DepartmentRow {
  name: string;
  budgetMonthlyUsd?: number;
  selfService?: SelfServicePolicy;
  policy: SelfServicePolicy;
  people: number;
  managers: { name: string; email: string }[];
  pending: number;
  agents: number;
  green: number;
  yellow: number;
  red: number;
  spendMonth: number;
  spendToday: number;
}

export interface DepartmentsPage {
  defaults: SelfServicePolicy;
  selfService: boolean;
  items: DepartmentRow[];
}

export interface OffboardResult {
  person: Person;
  stopped: number;
  reassigned: number;
  sessionsEnded: number;
}

export type RequestStatus = "pending" | "approved" | "denied" | "cancelled";

export interface AgentRequest {
  id: string;
  kind: "agent" | "raise" | "service";
  status: RequestStatus;
  by: string;
  byName: string;
  department?: string;
  reason?: string;
  createdAt: string;
  agent?: {
    name: string;
    purpose: string;
    providers?: string[];
    dailyUsd: number;
    monthlyUsd?: number;
  };
  raise?: {
    agentId: string;
    agentName: string;
    window: "day" | "month";
    amountUsd: number;
  };
  service?: {
    agentId: string;
    agentName: string;
    provider: string;
    providerName: string;
    dailyUsd: number;
    monthlyUsd?: number;
    models?: string[];
  };
  /** The agent asked for this itself. A person always decides those. */
  askedByAgent?: { id: string; name: string };
  /** Its owner may decide: it is within what they could give it themselves. */
  ownerMayDecide?: boolean;
  decidedAt?: string;
  decidedBy?: string;
  /** The decider's name, for people; absent for older requests. */
  decidedByName?: string;
  note?: string;
  agentId?: string;
}

export interface AgentAsk {
  name: string;
  purpose: string;
  providers?: string[];
  dailyUsd: number;
  monthlyUsd?: number;
  reason?: string;
}

export type AskResult =
  | { status: "ready"; agent: Agent; key: string; request: AgentRequest }
  | { status: "pending"; request: AgentRequest };

export type RaiseResult =
  | { status: "raised"; agent: Agent }
  | { status: "pending"; request: AgentRequest };

export interface SignInConfig {
  issuer: string;
  clientId: string;
  allowedDomains: string[];
  adminEmails: string[];
  label?: string;
  hasSecret: boolean;
  redirectUri: string;
}

export interface RotateAllResult {
  rotated: number;
  waitingForOwners: number;
  keys: {
    id: string;
    name: string;
    owner: string;
    team?: string;
    key: string;
  }[];
  abortedRequests: number;
  oldKeysUntil?: string;
  elapsedMs: number;
}

export interface SecurityView {
  confirm: string;
  peopleCanSignIn: boolean;
  /** The demo's stand-in keys pass the test, so a replacement can be tried. */
  demoKeys?: boolean;
  agents: {
    total: number;
    ownerCollects: number;
    adminGets: number;
    waiting: number;
  };
  departments: string[];
  providers: { id: string; name: string }[];
  history: {
    at: string;
    by?: string;
    reason?: string;
    department?: string;
    rotated?: number;
    waitingForOwners?: number;
    deliveredToAdmin?: number;
    graceMinutes?: number;
  }[];
}

export interface OrgSettingsView {
  selfService: boolean;
  defaults: SelfServicePolicy;
  mcp?: { enabled: boolean; url: string };
  signIn: SignInConfig | null;
  redirectUri: string;
}

// Workflows and ROI

/** How far a number can be trusted. A number takes the weakest label of its parts. */
export type Confidence = "measured" | "attributed" | "modelled";

export interface Labelled {
  value: number | null;
  label: Confidence;
}

export type ThresholdMetric =
  "cost_per_accepted_unit" | "acceptance_rate" | "net_monthly_return";

export interface Threshold {
  metric: ThresholdMetric;
  when: "above" | "below";
  value: number;
}

export interface Baseline {
  minutesPerUnit: number;
  hourlyCostUsd: number;
  unitsPerMonth?: number | undefined;
  measuredOn: string;
  method: string;
  source: "measured" | "estimated";
}

export type Attribution = "holdout" | "before_after" | "modelled";

export interface WorkflowCosts {
  implementationUsd: number;
  monthlyMaintenanceUsd: number;
  monthlyEvaluationUsd: number;
  discountRate: number;
}

export interface Workflow {
  id: string;
  name: string;
  unit: string;
  owner: string;
  ownerEmail?: string | undefined;
  team?: string | undefined;
  agents: string[];
  baseline: Baseline;
  attribution: Attribution;
  defaultReviewMinutes: number;
  costs: WorkflowCosts;
  stopIf: Threshold;
  scaleIf?: Threshold | undefined;
  minUnits: number;
  status: "active" | "archived";
  createdAt: string;
  createdBy: string;
  lockedAt?: string | undefined;
  changedAfterLock?: { at: string; by: string; fields: string[] }[] | undefined;
}

export type Verdict = "too_early" | "stop" | "scale" | "continue";

export interface RoiReport {
  workflowId: string;
  period: { from: string; to: string; days: number };
  results: {
    accepted: number;
    reworked: number;
    discarded: number;
    total: number;
    acceptanceRate: number | null;
    byAgents: number;
    voided: number;
  };
  cost: {
    inference: Labelled;
    review: Labelled & { minutes: number; minutesDefaulted: number };
    upkeep: Labelled;
    total: Labelled;
    estimatedCalls: number;
    calls: number;
  };
  perUnit: { baseline: Labelled; costPerAcceptedUnit: Labelled };
  value: Labelled;
  netReturn: Labelled;
  netMonthlyReturn: Labelled;
  projection: {
    paybackMonths: Labelled;
    year1RoiPercent: Labelled;
    threeYearNpv: Labelled;
    mostSensitive: {
      input: string;
      words: string;
      netAnnualIfChanged: number;
      delta: number;
    } | null;
    calculatorVersion: string;
  };
  verdict: Verdict;
  thresholds: {
    stop: Threshold & { met: boolean };
    scale: (Threshold & { met: boolean }) | null;
  };
  caveats: string[];
}

export interface WorkflowSummary extends Workflow {
  summary: {
    period: RoiReport["period"];
    verdict: Verdict;
    results: number;
    acceptanceRate: number | null;
    costPerAcceptedUnit: Labelled;
    baselineCostPerUnit: Labelled;
    netMonthlyReturn: Labelled;
  };
}

export interface WorkflowAgent {
  id: string;
  name: string | null;
  state: AgentState | null;
}

export interface WorkflowDetail {
  workflow: Workflow;
  agents: WorkflowAgent[];
  report: RoiReport;
}

export type OutcomeResult = "accepted" | "reworked" | "discarded";

export interface Outcome {
  id: string;
  workflowId: string;
  at: string;
  recordedAt: string;
  result: OutcomeResult;
  count: number;
  reviewMinutes?: number | undefined;
  ref?: string | undefined;
  note?: string | undefined;
  source: "agent" | "person";
  by: string;
  agentId?: string | undefined;
  voidedAt?: string | undefined;
  voidedBy?: string | undefined;
}

export interface NewWorkflow {
  name: string;
  unit: string;
  owner: string;
  ownerEmail?: string;
  team?: string;
  agents: string[];
  baseline: Baseline;
  attribution: Attribution;
  defaultReviewMinutes: number;
  costs: WorkflowCosts;
  stopIf: Threshold;
  scaleIf?: Threshold;
  minUnits: number;
}

export type WorkflowPatch = Partial<
  Omit<NewWorkflow, "ownerEmail" | "team" | "scaleIf">
> & {
  ownerEmail?: string | null;
  team?: string | null;
  scaleIf?: Threshold | null;
  status?: "active" | "archived";
};

export interface NewOutcome {
  result: OutcomeResult;
  count: number;
  reviewMinutes?: number;
  note?: string;
  at?: string;
}

// Alerts

export type AlertType =
  | "agent.near_limit"
  | "agent.at_limit"
  | "agent.spend_spike"
  | "agent.stopped"
  | "key.expiring"
  | "key.expired"
  | "workflow.stop"
  | "request.waiting";

export type ChannelKind = "webhook" | "slack" | "discord";

export interface AlertSettings {
  nearLimitPercent: number;
  spikeMultiple: number;
  spikeMinUsd: number;
  keyExpiringDays: number;
}

export interface AlertChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** Empty means every type. */
  events: AlertType[];
  enabled: boolean;
  createdAt: string;
  urlHint: string;
  signed: boolean;
  lastDelivery?:
    { at: string; ok: boolean; error?: string | undefined } | undefined;
}

export interface AlertDelivery {
  channelId: string;
  channelName: string;
  ok: boolean;
  attempts: number;
  status?: number | undefined;
  error?: string | undefined;
}

export interface AlertRecord {
  id: string;
  type: AlertType;
  severity: "info" | "warning" | "critical";
  at: string;
  title: string;
  text: string;
  url: string;
  count: number;
  deliveries: AlertDelivery[];
}

export interface AlertsView {
  settings: AlertSettings;
  channels: AlertChannel[];
  types: { type: AlertType; words: string }[];
  recent: AlertRecord[];
}

export interface NewChannel {
  name: string;
  kind: ChannelKind;
  url: string;
  events: AlertType[];
}
