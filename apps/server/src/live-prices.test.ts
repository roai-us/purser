import { describe, expect, it } from "vitest";
import { OpenRouterPrices } from "./live-prices.js";

const LIST = {
  data: [
    {
      id: "a/cheap",
      pricing: { prompt: "0.000001", completion: "0.000002" },
    },
    { id: "a/cheap:free", pricing: { prompt: "0", completion: "0" } },
    { id: "router/auto", pricing: { prompt: "-1", completion: "-1" } },
    { id: "a/odd", pricing: { prompt: "", completion: "soon" } },
    { id: "a/none" },
    { pricing: { prompt: "1", completion: "1" } },
    "nope",
  ],
};

function setup(answers: (() => Response | Promise<Response>)[]) {
  let clock = 0;
  const calls: { url: string; auth: string | null }[] = [];
  const prices = new OpenRouterPrices(
    ((url: string, init?: RequestInit) => {
      calls.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
      });
      const answer = answers[calls.length - 1];
      if (!answer) throw new Error("unexpected call");
      return Promise.resolve(answer());
    }) as typeof fetch,
    () => new Date(clock),
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    prices,
    calls,
    settle,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const HOUR = 3_600_000;

describe("OpenRouterPrices", () => {
  it("reads per-token prices as per-million rates and skips the rest", async () => {
    const t = setup([() => Response.json(LIST)]);
    expect(t.prices.find("a/cheap")).toBeNull();
    t.prices.refresh("https://up/api/v1", "sk-test");
    await t.settle();
    expect(t.calls).toEqual([
      { url: "https://up/api/v1/models", auth: "Bearer sk-test" },
    ]);
    const cheap = t.prices.find("a/cheap");
    expect(cheap?.input).toBeCloseTo(1, 8);
    expect(cheap?.output).toBeCloseTo(2, 8);
    expect(t.prices.find("a/cheap:free")).toEqual({ input: 0, output: 0 });
    expect(t.prices.find("a/cheap:nitro")?.input).toBeCloseTo(1, 8);
    for (const missing of ["router/auto", "a/odd", "a/none", "a/other", null]) {
      expect(t.prices.find(missing)).toBeNull();
    }
  });

  it("loads at most once an hour", async () => {
    const t = setup([() => Response.json(LIST), () => Response.json(LIST)]);
    t.prices.refresh("https://up", "k");
    t.prices.refresh("https://up", "k");
    await t.settle();
    t.advance(HOUR - 1);
    t.prices.refresh("https://up", "k");
    expect(t.calls).toHaveLength(1);
    t.advance(1);
    t.prices.refresh("https://up", "k");
    expect(t.calls).toHaveLength(2);
    await t.settle();
  });

  it.each([
    ["an error status", () => new Response("no", { status: 500 })],
    ["the wrong shape", () => Response.json({ data: "nope" })],
    ["no prices", () => Response.json({ data: [{ id: "a/none" }] })],
    ["a failed connection", () => Promise.reject(new Error("offline"))],
  ])("keeps the old prices after %s and retries soon", async (_name, bad) => {
    const t = setup([
      () => Response.json(LIST),
      bad,
      () =>
        Response.json({
          data: [
            {
              id: "a/cheap",
              pricing: { prompt: "0.000003", completion: "0.000004" },
            },
          ],
        }),
    ]);
    t.prices.refresh("https://up", "k");
    await t.settle();
    t.advance(HOUR);
    t.prices.refresh("https://up", "k");
    await t.settle();
    expect(t.prices.find("a/cheap")?.input).toBeCloseTo(1, 8);
    t.advance(299_999);
    t.prices.refresh("https://up", "k");
    expect(t.calls).toHaveLength(2);
    t.advance(1);
    t.prices.refresh("https://up", "k");
    await t.settle();
    expect(t.calls).toHaveLength(3);
    expect(t.prices.find("a/cheap")?.input).toBeCloseTo(3, 8);
  });
});
