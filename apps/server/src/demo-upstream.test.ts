import { describe, expect, it } from "vitest";
import { demoFetch, DEMO_PROVIDER_KEY } from "./demo-upstream.js";
import { harness } from "./test/helpers.js";

const noNetwork: typeof fetch = () => {
  throw new Error("The demo must not reach the network with its own key.");
};

const auth = { authorization: `Bearer ${DEMO_PROVIDER_KEY}` };

describe("the demo's stand-in for providers", () => {
  const fetchDemo = demoFetch(noNetwork);
  const post = (
    url: string,
    body: unknown,
    headers: Record<string, string> = auth,
  ) => fetchDemo(url, { method: "POST", headers, body: JSON.stringify(body) });

  it("keeps any key starting with demo- on this computer, and passes its test", async () => {
    const headers = { authorization: "Bearer demo-my-new-key" };
    const list = await fetchDemo("https://api.openai.com/v1/models", {
      headers,
    });
    expect(list.status).toBe(200);
    const key = await fetchDemo("https://openrouter.ai/api/v1/key", {
      headers,
    });
    expect(key.status).toBe(200);
  });

  it("passes anything without the demo key to the real network", async () => {
    let called = 0;
    const f = demoFetch(() => {
      called++;
      return Promise.resolve(new Response("real"));
    });
    const res = await f("https://api.openai.com/v1/models", {
      headers: { authorization: "Bearer sk-real" },
    });
    expect(await res.text()).toBe("real");
    await f("https://login.example.com/.well-known/openid-configuration");
    expect(called).toBe(2);
  });

  it("answers chat completions, saying plainly that it's the demo", async () => {
    const res = await post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o",
      messages: [{ role: "user", content: "x".repeat(500) }],
    });
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; cost?: number };
    };
    expect(body.choices[0]?.message.content).toContain("No real model");
    expect(body.choices[0]?.message.content).toContain("...");
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.cost).toBeUndefined();
  });

  it("reports a charge where the provider would", async () => {
    const res = await post("https://openrouter.ai/api/v1/chat/completions", {
      messages: [],
    });
    const body = (await res.json()) as { usage: { cost: number } };
    expect(body.usage.cost).toBeGreaterThan(0);
  });

  it("streams chat completions and messages", async () => {
    const chat = await post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const chatText = await chat.text();
    expect(chat.headers.get("content-type")).toContain("text/event-stream");
    expect(chatText).toContain("[DONE]");
    expect(chatText).toContain("prompt_tokens");
    const msg = await post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-5-5",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
      { "x-api-key": DEMO_PROVIDER_KEY },
    );
    const msgText = await msg.text();
    expect(msgText).toContain("event: message_stop");
    expect(msgText).toContain("output_tokens");
  });

  it("answers messages, responses, embeddings and models", async () => {
    const msg = await post(
      "https://api.anthropic.com/v1/messages",
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { "api-key": DEMO_PROVIDER_KEY },
    );
    expect(
      ((await msg.json()) as { content: { text: string }[] }).content[0]?.text,
    ).toContain("No real model");
    const resp = await post("https://api.openai.com/v1/responses", {
      input: "hi",
    });
    expect(
      ((await resp.json()) as { output_text: string }).output_text,
    ).toContain("hi");
    const emb = await post("https://api.openai.com/v1/embeddings", {
      input: "hi",
    });
    expect(emb.status).toBe(200);
    const models = await fetchDemo("https://api.x.ai/v1/models", {
      headers: auth,
    });
    expect(
      ((await models.json()) as { data: { id: string }[] }).data[0]?.id,
    ).toBe("demo-model");
    const other = await post("https://api.openai.com/v1/images", {});
    expect(other.status).toBe(404);
    const noBody = await fetchDemo("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: auth,
      body: "not json",
    });
    expect(noBody.status).toBe(200);
  });

  it("works through the gateway, metered like the real thing", async () => {
    const h = harness({
      providerKeys: { openai: DEMO_PROVIDER_KEY },
      upstreams: { openai: "https://api.openai.com/v1" },
      fetch: fetchDemo,
    });
    const a = h.addAgent("a");
    const res = await h.call("/openai/v1/chat/completions", {
      method: "POST",
      key: a.key,
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(h.store.listUsage(a.id)[0]?.costUsd).toBeGreaterThan(0);
  });
});
