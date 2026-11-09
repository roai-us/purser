import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { harness } from "./test/helpers.js";

/*
 * Company sign-in end to end through Purser's own routes, against a tiny
 * identity provider that lives in this file. The OIDC checks themselves are
 * tested in oidc.test.ts; this covers what Purser does with the result.
 */

const ISSUER = "https://idp.example.com";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: "jwk" }),
  kid: "k1",
  alg: "RS256",
  use: "sig",
};

const b64 = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString("base64url");

function idToken(claims: Record<string, unknown>): string {
  const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = b64(claims);
  const sig = sign(
    "RSA-SHA256",
    Buffer.from(`${head}.${body}`),
    keys.privateKey,
  );
  return `${head}.${body}.${sig.toString("base64url")}`;
}

/** The provider: discovery, keys, and a token endpoint that returns `next` claims. */
function provider(next: () => Record<string, unknown>): typeof fetch {
  let nonce = "";
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    }
    if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
    if (url.pathname === "/authorize") {
      nonce = url.searchParams.get("nonce") ?? "";
      return new Response("ok");
    }
    if (url.pathname === "/token") {
      const now = Math.floor(Date.parse("2026-11-07T12:00:00Z") / 1000);
      return Response.json({
        id_token: idToken({
          iss: ISSUER,
          aud: "purser-client",
          sub: "user-1",
          iat: now,
          exp: now + 600,
          nonce,
          ...next(),
        }),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function setUp(claims: () => Record<string, unknown>) {
  const fetchFn = provider(claims);
  const h = harness({ fetch: fetchFn });
  await h.admin("PUT", "/settings/sign-in", {
    issuer: ISSUER,
    clientId: "purser-client",
    clientSecret: "shh",
    allowedDomains: ["example.com"],
    adminEmails: ["boss@example.com"],
  });
  /** Clicks "Sign in", lets the provider see the nonce, and comes back. */
  const signIn = async () => {
    const start = await h.app.request("/auth/sso/start");
    const location = start.headers.get("location") ?? "";
    await fetchFn(location);
    const state = new URL(location).searchParams.get("state") ?? "";
    const back = await h.app.request(
      `/auth/sso/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    return {
      location: back.headers.get("location"),
      cookie: (back.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    };
  };
  return { h, signIn };
}

describe("company sign-in", () => {
  it("adds a new person as a member on first sign-in and keeps their name current", async () => {
    let name = "Pat Lee";
    const { h, signIn } = await setUp(() => ({
      email: "Pat@Example.com",
      name,
    }));
    const first = await signIn();
    expect(first.location).toBe("/");
    const me = await (
      await h.app.request("/me", { headers: { cookie: first.cookie } })
    ).json();
    expect(me).toMatchObject({
      viewer: { kind: "person", role: "member", email: "pat@example.com" },
    });
    name = "Pat Lee-Smith";
    await signIn();
    const person = h.org.findByEmail("pat@example.com");
    expect(person).toMatchObject({ name: "Pat Lee-Smith", source: "sso" });
    expect(h.org.listPeople()).toHaveLength(1);
    expect(h.store.auditLog().map((e) => e.type)).toEqual(
      expect.arrayContaining(["person.added", "person.signed_in"]),
    );
  });

  it("makes the listed admin emails admins", async () => {
    const { h, signIn } = await setUp(() => ({ email: "boss@example.com" }));
    const { cookie } = await signIn();
    const res = await h.app.request("/admin/agents", { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("turns away other domains and people whose access is off, and says why", async () => {
    let email = "eve@elsewhere.com";
    const { h, signIn } = await setUp(() => ({ email }));
    expect((await signIn()).location).toBe("/?login=domain_not_allowed");
    expect(h.store.auditLog().at(-1)).toMatchObject({
      type: "signin.refused",
      detail: { code: "domain_not_allowed" },
    });

    email = "gone@example.com";
    const p = h.org.addPerson({ email, name: "Gone", source: "admin" });
    h.org.updatePerson(p.id, { status: "disabled" });
    expect((await signIn()).location).toBe("/?login=disabled");
    expect(h.store.auditLog().at(-1)).toMatchObject({
      type: "signin.refused",
      detail: { code: "disabled", email: "gone@example.com" },
    });
  });

  it("refuses a callback it did not start", async () => {
    const { h } = await setUp(() => ({ email: "pat@example.com" }));
    const res = await h.app.request("/auth/sso/callback?code=abc&state=forged");
    expect(res.headers.get("location")).toBe("/?login=invalid_state");
  });

  it("reports a provider it cannot reach", async () => {
    const h = harness({
      fetch: (() => Promise.reject(new Error("offline"))) as typeof fetch,
    });
    await h.admin("PUT", "/settings/sign-in", {
      issuer: ISSUER,
      clientId: "purser-client",
      allowedDomains: ["example.com"],
    });
    const res = await h.app.request("/auth/sso/start");
    expect(res.headers.get("location")).toMatch(/^\/\?login=/);
  });
});
