import type { CallEntry } from "./logs.js";
import { preview } from "./logs.js";
import type { Agent, UsageRecord } from "./types.js";

/** A made-up exchange for each kind of demo agent, so the call log reads like real work. */
const SAMPLES: Record<
  string,
  { system: string; asks: string[]; answers: string[] }
> = {
  "invoice-reader": {
    system:
      "Extract supplier, invoice number, date, currency and line totals as JSON.",
    asks: [
      "Invoice INV-20931 from Northwind Paper, 14 Oct, 3 lines, total 4,210.00 EUR.",
      "Attached: Contoso Freight invoice 8812, net 30, USD 1,980.40.",
    ],
    answers: [
      '{"supplier":"Northwind Paper","number":"INV-20931","currency":"EUR","total":4210.00}',
      '{"supplier":"Contoso Freight","number":"8812","currency":"USD","total":1980.40,"terms":"net 30"}',
    ],
  },
  "expense-checker": {
    system:
      "Check each claim against the travel and expense policy. Say pass or flag, with the rule.",
    asks: [
      "Dinner, 4 people, $412, client meeting, no attendee list.",
      "Taxi from airport, $64, receipt attached.",
    ],
    answers: [
      "Flag: meals over $75 a head need an attendee list (policy 4.2).",
      "Pass: ground transport with receipt, under the $100 limit.",
    ],
  },
  "ticket-triage": {
    system:
      "Tag each ticket with product area, urgency (P1 to P4) and language.",
    asks: [
      "I can't log in since the update and payroll runs tomorrow!!",
      "How do I export last year's reports to CSV?",
    ],
    answers: [
      "area: auth, urgency: P1, language: en. Payroll deadline mentioned.",
      "area: reporting, urgency: P4, language: en. How-to question.",
    ],
  },
  "reply-drafter": {
    system: "Draft a friendly first reply. Never promise refunds or dates.",
    asks: [
      "Customer says the order arrived damaged and wants a replacement.",
      "Customer asks whether the Pro plan includes SSO.",
    ],
    answers: [
      "Hi Sam, I'm sorry your order arrived damaged. Could you send a photo of the box and the item? Once we have it, we'll sort out the next step with you.",
      "Hi Priya, yes: single sign-on is part of the Pro plan. Here is the setup guide for your identity provider.",
    ],
  },
  "lead-research": {
    system: "Summarise the company in five bullets before a sales call.",
    asks: ["Research Fabrikam Logistics, inbound from the pricing page."],
    answers: [
      "- Mid-size freight forwarder, about 900 staff\n- Three warehouses in the Midwest\n- Hiring a data team\n- Uses a legacy routing system\n- Visited pricing twice this week",
    ],
  },
  "proposal-writer": {
    system: "Turn call notes into a two-page proposal outline.",
    asks: ["Notes: wants 200 seats, phased rollout, SSO, starts Q1."],
    answers: [
      "1. Goals\n2. Phase one: 50 seats in January\n3. Phase two: 150 seats\n4. Security and SSO\n5. Pricing and terms",
    ],
  },
  "campaign-copy": {
    system: "Write three subject lines under 50 characters.",
    asks: ["Winter sale, 20% off annual plans, ends Friday."],
    answers: [
      "1. 20% off annual plans, ends Friday\n2. Your winter upgrade is 20% off\n3. Last week to save 20%",
    ],
  },
  "code-review": {
    system: "Review the diff for bugs and missing tests. Be specific.",
    asks: ["diff --git a/src/billing.ts ... + if (amount = 0) return;"],
    answers: [
      "Line 42 assigns instead of comparing: `amount = 0` should be `amount === 0`. As written, every amount becomes zero. Add a test for a zero-amount invoice.",
    ],
  },
  "test-writer": {
    system: "Write Vitest unit tests for the function.",
    asks: ["export function slugify(s: string) { ... }"],
    answers: [
      'describe("slugify", () => {\n  it("lowercases and joins words", () => {\n    expect(slugify("Hello World")).toBe("hello-world");\n  });\n});',
    ],
  },
  "contract-redliner": {
    system: "Compare the clause with the playbook and propose redlines.",
    asks: ["Clause 9: Supplier liability is unlimited for all claims."],
    answers: [
      "Playbook caps liability at 12 months of fees, except for data breaches. Proposed: 'Supplier liability is capped at fees paid in the prior 12 months, except for breaches of clause 14 (data protection).'",
    ],
  },
  "policy-qa": {
    system: "Answer from the HR policy only. Cite the section.",
    asks: ["How many days of parental leave do we get?"],
    answers: [
      "Sixteen weeks at full pay for the primary carer and six weeks for the secondary carer (HR policy 7.1).",
    ],
  },
  "shift-planner": {
    system:
      "Plan next week's rota to meet the forecast with the fewest overtime hours.",
    asks: [
      "Forecast: Mon 120 orders, Tue 95, Wed 140. 12 staff, 8-hour shifts.",
    ],
    answers: [
      "Mon: 6 day, 3 late. Tue: 5 day, 2 late. Wed: 7 day, 4 late. No overtime needed.",
    ],
  },
  "rfp-summarizer": {
    system: "Summarise each supplier response: price, timeline, risks.",
    asks: ["Response from Tailspin Systems, 38 pages, attached."],
    answers: [
      "Price: $410k over 3 years. Timeline: 20 weeks. Risks: subcontracts hosting; no named project manager.",
    ],
  },
  "sql-helper": {
    system: "Write SQL for the warehouse schema. Explain it in one line.",
    asks: ["Monthly active customers by region for 2026."],
    answers: [
      "SELECT region, date_trunc('month', seen_at) AS month, count(DISTINCT customer_id) FROM activity WHERE seen_at >= '2026-01-01' GROUP BY 1, 2;\nCounts distinct customers seen each month, per region.",
    ],
  },
};

/**
 * Call log entries for a demo fleet: the chat calls of the last day, up to
 * `limit`, newest first. Marks each of those usage records as logged.
 */
export function demoCalls(
  agents: Agent[],
  usage: UsageRecord[],
  now: Date,
  limit: number,
): CallEntry[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const out: CallEntry[] = [];
  for (let i = usage.length - 1; i >= 0 && out.length < limit; i--) {
    const record = usage[i];
    if (!record || record.at < since) break;
    if (record.endpoint === "embeddings") continue;
    const agent = byId.get(record.agentId);
    const slug = agent?.name.replace(/-\d+$/, "") ?? "";
    const sample = SAMPLES[slug];
    if (!agent || !sample) continue;
    const pick = i % sample.asks.length;
    const ask = sample.asks[pick] ?? "";
    const answer = sample.answers[pick % sample.answers.length] ?? "";
    const request =
      record.endpoint === "messages"
        ? {
            model: record.model,
            max_tokens: 1024,
            system: sample.system,
            messages: [{ role: "user", content: ask }],
          }
        : {
            model: record.model,
            messages: [
              { role: "system", content: sample.system },
              { role: "user", content: ask },
            ],
          };
    const response =
      record.endpoint === "messages"
        ? {
            id: `msg_${record.id}`,
            type: "message",
            role: "assistant",
            model: record.model,
            content: [{ type: "text", text: answer }],
            usage: {
              input_tokens: record.inputTokens,
              output_tokens: record.outputTokens,
            },
          }
        : {
            id: `chatcmpl-${record.id}`,
            object: "chat.completion",
            model: record.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: answer },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: record.inputTokens,
              completion_tokens: record.outputTokens,
            },
          };
    record.logged = true;
    out.push({
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
      requestPreview: preview(ask),
      responsePreview: preview(answer),
      truncated: false,
      request: JSON.stringify(request),
      response: JSON.stringify(response),
      responseText: answer,
    });
  }
  return out;
}
