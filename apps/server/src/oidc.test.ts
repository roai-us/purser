import {
  constants,
  createHash,
  createHmac,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OidcClient,
  OidcError,
  discover,
  type OidcConfig,
  type OidcErrorCode,
} from "./oidc.js";

/*
 * A mock identity provider lives in this file: real RSA and EC key pairs,
 * JWTs signed by hand, and a fake fetch that serves discovery, JWKS and the
 * token endpoint by URL. Nothing touches the network.
 */

// ---------------------------------------------------------------------------
// Keys and JWT signing
// ---------------------------------------------------------------------------

interface TestKey {
  kid: string;
  alg: "RS256" | "PS256" | "ES256";
  privateKey: KeyObject;
  publicKey: KeyObject;
}

function rsaKey(kid: string, alg: "RS256" | "PS256" = "RS256"): TestKey {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, alg, ...pair };
}

function ecKey(kid: string): TestKey {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { kid, alg: "ES256", ...pair };
}

// Generated once: RSA key generation is slow enough to matter per test.
const RSA = rsaKey("rsa-1");
const RSA_ROTATED = rsaKey("rsa-2");
const PSS = rsaKey("pss-1", "PS256");
const EC = ecKey("ec-1");

const b64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

/** Signs a JWT. `header.alg` decides how; "none" and HS256 are for attack tests. */
function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: KeyObject,
  hmacSecret = "",
): string {
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  let signature: Buffer;
  switch (header.alg) {
    case "RS256":
      signature = sign("sha256", Buffer.from(data), key);
      break;
    case "PS256":
      signature = sign("sha256", Buffer.from(data), {
        key,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      });
      break;
    case "ES256":
      signature = sign("sha256", Buffer.from(data), {
        key,
        dsaEncoding: "ieee-p1363",
      });
      break;
    case "HS256":
      signature = createHmac("sha256", hmacSecret).update(data).digest();
      break;
    default:
      signature = Buffer.alloc(0);
  }
  return `${data}.${b64url(signature)}`;
}

// ---------------------------------------------------------------------------
// Mock identity provider
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

const ORIGIN = "http://127.0.0.1:9000";
const ISSUER = `${ORIGIN}/tenant-a`;
const CLIENT_ID = "purser-app";
const CLIENT_SECRET = "s3cr:et/+ &";
const REDIRECT_URI = "http://127.0.0.1:8080/auth/callback";
const START = Date.parse("2026-11-08T12:00:00Z");
const MINUTE = 60_000;
/** En and em dashes, which messages must not contain. */
const LONG_DASHES = new RegExp("[\\u2013\\u2014]");

class MockIdp {
  readonly requests: RecordedRequest[] = [];
  /** The base URL the endpoints live under (the configured issuer, trimmed). */
  readonly base: string;
  /** Keys published in the JWKS. */
  keys: TestKey[] = [RSA, PSS, EC];
  /** Merged over the default discovery document. */
  discoveryOverrides: Record<string, unknown> = {};
  discoveryStatus = 200;
  tokenStatus = 200;
  tokenBody: Record<string, unknown> | string = {};

  constructor(base: string) {
    this.base = base;
  }

  get discovery(): Record<string, unknown> {
    return {
      issuer: this.base,
      authorization_endpoint: `${this.base}/authorize?prompt=select_account`,
      token_endpoint: `${this.base}/token`,
      jwks_uri: `${this.base}/keys`,
      ...this.discoveryOverrides,
    };
  }

  /** Requests made to a path under the base, e.g. "/token". */
  calls(path: string): RecordedRequest[] {
    return this.requests.filter(
      (r) => new URL(r.url).pathname === new URL(this.base + path).pathname,
    );
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    this.requests.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    const path = new URL(url).pathname;
    const json = (status: number, body: unknown) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === `${this.base}/.well-known/openid-configuration`) {
      return json(this.discoveryStatus, this.discovery);
    }
    if (path === new URL(`${this.base}/keys`).pathname) {
      const keys = this.keys.map((k) => ({
        ...k.publicKey.export({ format: "jwk" }),
        kid: k.kid,
        use: "sig",
      }));
      return json(200, { keys });
    }
    if (path === new URL(`${this.base}/token`).pathname) {
      return json(this.tokenStatus, this.tokenBody);
    }
    return json(404, { error: "not_found" });
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  idp: MockIdp;
  client: OidcClient;
  config: OidcConfig;
  /** Moves the injected clock forward. */
  advance(ms: number): void;
  nowSeconds(): number;
}

function setup(
  options: {
    config?: Partial<OidcConfig>;
    discovery?: Record<string, unknown>;
  } = {},
): Harness {
  let now = START;
  const config: OidcConfig = {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    allowedDomains: ["example.com"],
    ...options.config,
  };
  const idp = new MockIdp(config.issuer.replace(/\/+$/, ""));
  idp.discoveryOverrides = options.discovery ?? {};
  const client = new OidcClient({
    config,
    redirectUri: REDIRECT_URI,
    fetch: idp.fetch,
    now: () => new Date(now),
  });
  return {
    idp,
    client,
    config,
    advance: (ms) => {
      now += ms;
    },
    nowSeconds: () => Math.floor(now / 1000),
  };
}

/** The claims a well-behaved provider would put in the ID token. */
function goodClaims(h: Harness, nonce: string): Record<string, unknown> {
  return {
    iss: h.idp.discovery.issuer,
    aud: CLIENT_ID,
    sub: "user-123",
    email: "ann@example.com",
    email_verified: true,
    name: "Ann Example",
    nonce,
    iat: h.nowSeconds(),
    exp: h.nowSeconds() + 3600,
  };
}

interface SignInOptions {
  /** Merged over goodClaims; a value of undefined removes the claim. */
  claims?: Record<string, unknown>;
  key?: TestKey;
  /** Merged over the JWT header. */
  header?: Record<string, unknown>;
  /** Replaces the whole ID token. */
  idToken?: string;
}

/** Runs start(), has the provider issue a token for that attempt, then finish(). */
async function signIn(h: Harness, options: SignInOptions = {}) {
  const { url, state } = await h.client.start();
  const nonce = new URL(url).searchParams.get("nonce") ?? "";
  const key = options.key ?? RSA;
  const idToken =
    options.idToken ??
    signJwt(
      { alg: key.alg, kid: key.kid, typ: "JWT", ...options.header },
      { ...goodClaims(h, nonce), ...options.claims },
      key.privateKey,
    );
  h.idp.tokenBody = {
    access_token: "at",
    token_type: "Bearer",
    id_token: idToken,
  };
  return h.client.finish({ code: "auth-code-1", state });
}

/** Asserts that a promise rejects with an OidcError of this code. */
async function expectError(
  promise: Promise<unknown>,
  code: OidcErrorCode,
  message?: string | RegExp,
): Promise<OidcError> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OidcError);
  const oidc = err as OidcError;
  expect(oidc.code).toBe(code);
  if (message !== undefined) expect(oidc.message).toMatch(message);
  expect(oidc.message).not.toMatch(LONG_DASHES);
  return oidc;
}

const tokenRequest = (h: Harness) => {
  const calls = h.idp.calls("/token");
  expect(calls).toHaveLength(1);
  const call = calls[0] as RecordedRequest;
  return { ...call, form: new URLSearchParams(call.body) };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discovery", () => {
  it("fetches the document once per client, ignoring a trailing slash on the issuer", async () => {
    const h = setup({ config: { issuer: `${ISSUER}/` } });
    await h.client.start();
    await h.client.start();
    expect(h.idp.requests.map((r) => r.url)).toEqual([
      `${ISSUER}/.well-known/openid-configuration`,
    ]);
  });

  it("discover() returns the document", async () => {
    const h = setup();
    const doc = await discover(ISSUER, h.idp.fetch);
    expect(doc).toMatchObject({
      issuer: ISSUER,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/keys`,
    });
  });

  it("rejects a document that names a different issuer", async () => {
    const h = setup({ discovery: { issuer: `${ORIGIN}/someone-else` } });
    await expectError(h.client.start(), "issuer_mismatch", /someone-else/);
  });

  it("requires https for a non-local issuer, without fetching anything", async () => {
    const h = setup({ config: { issuer: "http://login.example.com/x" } });
    await expectError(h.client.start(), "insecure_url", /https/);
    expect(h.idp.requests).toHaveLength(0);
  });

  it("requires https for endpoints", async () => {
    const h = setup({
      discovery: { token_endpoint: "http://idp.example.com/token" },
    });
    await expectError(h.client.start(), "insecure_url", /token endpoint/);
  });

  it("reports a failed fetch and tries again next time", async () => {
    const h = setup();
    h.idp.discoveryStatus = 500;
    await expectError(h.client.start(), "discovery_failed", /HTTP 500/);
    h.idp.discoveryStatus = 200;
    await expect(h.client.start()).resolves.toHaveProperty("state");
  });

  it("rejects a document missing an endpoint", async () => {
    const h = setup({ discovery: { jwks_uri: undefined } });
    await expectError(h.client.start(), "discovery_failed", /jwks_uri/);
  });
});

describe("start()", () => {
  it("builds an authorization code + PKCE link and keeps existing query parameters", async () => {
    const h = setup();
    const { url, state } = await h.client.start();
    const link = new URL(url);
    const p = link.searchParams;
    expect(`${link.origin}${link.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(p.get("prompt")).toBe("select_account");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(p.get("scope")).toBe("openid email profile");
    expect(p.get("state")).toBe(state);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(p.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it("makes fresh state, nonce and challenge every time", async () => {
    const h = setup();
    const a = new URL((await h.client.start()).url).searchParams;
    const b = new URL((await h.client.start()).url).searchParams;
    for (const name of ["state", "nonce", "code_challenge"]) {
      expect(a.get(name)).not.toBe(b.get(name));
    }
  });

  it("uses configured scopes, adding openid if missing", async () => {
    const h = setup({ config: { scopes: ["email", "offline_access"] } });
    const { url } = await h.client.start();
    expect(new URL(url).searchParams.get("scope")).toBe(
      "openid email offline_access",
    );
  });

  it("prunes expired attempts", async () => {
    const h = setup();
    await h.client.start();
    await h.client.start();
    expect(h.client.pendingCount).toBe(2);
    h.advance(11 * MINUTE);
    await h.client.start();
    expect(h.client.pendingCount).toBe(1);
  });
});

describe("sign-in, happy paths", () => {
  it("signs in with RS256 and sends a correct token request (PKCE, Basic auth)", async () => {
    const h = setup();
    const { url, state } = await h.client.start();
    const params = new URL(url).searchParams;
    h.idp.tokenBody = {
      id_token: signJwt(
        { alg: "RS256", kid: RSA.kid },
        goodClaims(h, params.get("nonce") ?? ""),
        RSA.privateKey,
      ),
    };
    const identity = await h.client.finish({ code: "auth-code-1", state });

    expect(identity).toEqual({
      subject: "user-123",
      email: "ann@example.com",
      name: "Ann Example",
      claims: expect.objectContaining({ sub: "user-123", aud: CLIENT_ID }),
    });

    const req = tokenRequest(h);
    expect(req.url).toBe(`${ISSUER}/token`);
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(req.form.get("grant_type")).toBe("authorization_code");
    expect(req.form.get("code")).toBe("auth-code-1");
    expect(req.form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(req.form.get("client_id")).toBe(CLIENT_ID);
    expect(req.form.has("client_secret")).toBe(false);

    const verifier = req.form.get("code_verifier") ?? "";
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      params.get("code_challenge"),
    );

    // RFC 6749 2.3.1: form-encode id and secret, then base64 "id:secret".
    const basic = req.headers.get("authorization") ?? "";
    expect(basic.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(basic.slice(6), "base64").toString()).toBe(
      "purser-app:s3cr%3Aet%2F%2B+%26",
    );
  });

  it("uses Basic auth when the provider lists client_secret_basic", async () => {
    const h = setup({
      discovery: {
        token_endpoint_auth_methods_supported: [
          "client_secret_post",
          "client_secret_basic",
        ],
      },
    });
    await signIn(h);
    const req = tokenRequest(h);
    expect(req.headers.get("authorization")).toMatch(/^Basic /);
    expect(req.form.has("client_secret")).toBe(false);
  });

  it("falls back to client_secret_post when Basic is not supported", async () => {
    const h = setup({
      discovery: {
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      },
    });
    await signIn(h);
    const req = tokenRequest(h);
    expect(req.headers.has("authorization")).toBe(false);
    expect(req.form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(req.form.get("client_id")).toBe(CLIENT_ID);
  });

  it("signs in as a public client with PKCE alone", async () => {
    const h = setup({ config: { clientSecret: undefined } });
    await signIn(h);
    const req = tokenRequest(h);
    expect(req.headers.has("authorization")).toBe(false);
    expect(req.form.has("client_secret")).toBe(false);
    expect(req.form.get("client_id")).toBe(CLIENT_ID);
    expect(req.form.get("code_verifier")).toBeTruthy();
  });

  it("accepts ES256 tokens", async () => {
    const h = setup();
    await expect(signIn(h, { key: EC })).resolves.toMatchObject({
      email: "ann@example.com",
    });
  });

  it("accepts PS256 tokens", async () => {
    const h = setup();
    await expect(signIn(h, { key: PSS })).resolves.toMatchObject({
      email: "ann@example.com",
    });
  });

  it("builds the name from given and family names, or leaves it out", async () => {
    const h = setup();
    const joined = await signIn(h, {
      claims: { name: undefined, given_name: "Ann", family_name: "Lee" },
    });
    expect(joined.name).toBe("Ann Lee");
    const none = await signIn(h, { claims: { name: undefined } });
    expect(none).not.toHaveProperty("name");
  });

  it("accepts an allowed domain regardless of case", async () => {
    const h = setup({ config: { allowedDomains: ["Example.COM"] } });
    const identity = await signIn(h, { claims: { email: "Ann@EXAMPLE.com" } });
    expect(identity.email).toBe("ann@example.com");
  });
});

describe("signing keys", () => {
  it("caches the key set, and refetches once when the provider rotates keys", async () => {
    const h = setup();
    h.idp.keys = [RSA];
    await signIn(h);
    await signIn(h);
    expect(h.idp.calls("/keys")).toHaveLength(1);

    h.idp.keys = [RSA_ROTATED];
    await expect(signIn(h, { key: RSA_ROTATED })).resolves.toHaveProperty(
      "subject",
    );
    expect(h.idp.calls("/keys")).toHaveLength(2);
  });

  it("gives up after one refetch when the key is still unknown", async () => {
    const h = setup();
    h.idp.keys = [RSA];
    await signIn(h);
    await expectError(signIn(h, { key: RSA_ROTATED }), "unknown_key", /rsa-2/);
    expect(h.idp.calls("/keys")).toHaveLength(2);
  });

  it("uses the only key when the token names none", async () => {
    const h = setup();
    h.idp.keys = [RSA];
    await expect(
      signIn(h, { header: { kid: undefined } }),
    ).resolves.toHaveProperty("subject");
  });
});

describe("finish() errors before the token exchange", () => {
  it("reports an error from the provider, with its description", async () => {
    const h = setup();
    const { state } = await h.client.start();
    await expectError(
      h.client.finish({
        state,
        error: "access_denied",
        error_description: "The user cancelled the sign-in.",
      }),
      "idp_error",
      /The user cancelled the sign-in\./,
    );
    // The attempt is spent.
    await expectError(h.client.finish({ state, code: "x" }), "invalid_state");
  });

  it("rejects a missing or unknown state", async () => {
    const h = setup();
    await expectError(h.client.finish({ code: "x" }), "invalid_state");
    await expectError(
      h.client.finish({ code: "x", state: "made-up" }),
      "invalid_state",
      /not valid/,
    );
  });

  it("lets each state work only once", async () => {
    const h = setup();
    const { url, state } = await h.client.start();
    const nonce = new URL(url).searchParams.get("nonce") ?? "";
    h.idp.tokenBody = {
      id_token: signJwt(
        { alg: "RS256", kid: RSA.kid },
        goodClaims(h, nonce),
        RSA.privateKey,
      ),
    };
    await h.client.finish({ code: "c", state });
    await expectError(
      h.client.finish({ code: "c", state }),
      "invalid_state",
      /already used/,
    );
  });

  it("expires a sign-in link after 10 minutes", async () => {
    const h = setup();
    const { state } = await h.client.start();
    h.advance(11 * MINUTE);
    await expectError(
      h.client.finish({ code: "c", state }),
      "invalid_state",
      "This sign-in link has expired. Start again.",
    );
    expect(h.idp.calls("/token")).toHaveLength(0);
  });

  it("still accepts a link used within 10 minutes", async () => {
    const h = setup();
    const { url, state } = await h.client.start();
    const nonce = new URL(url).searchParams.get("nonce") ?? "";
    h.advance(9 * MINUTE);
    h.idp.tokenBody = {
      id_token: signJwt(
        { alg: "RS256", kid: RSA.kid },
        goodClaims(h, nonce),
        RSA.privateKey,
      ),
    };
    await expect(h.client.finish({ code: "c", state })).resolves.toHaveProperty(
      "email",
    );
  });

  it("rejects a callback without a code", async () => {
    const h = setup();
    const { state } = await h.client.start();
    await expectError(h.client.finish({ state }), "invalid_request");
  });
});

describe("token exchange errors", () => {
  it("includes the provider's error_description", async () => {
    const h = setup();
    const { state } = await h.client.start();
    h.idp.tokenStatus = 400;
    h.idp.tokenBody = {
      error: "invalid_client",
      error_description: "AADSTS7000215: Invalid client secret provided.",
    };
    await expectError(
      h.client.finish({ code: "c", state }),
      "token_error",
      /Invalid client secret provided/,
    );
  });

  it("names the HTTP status when the provider gives no reason", async () => {
    const h = setup();
    const { state } = await h.client.start();
    h.idp.tokenStatus = 502;
    h.idp.tokenBody = "Bad gateway";
    await expectError(
      h.client.finish({ code: "c", state }),
      "token_error",
      /HTTP 502/,
    );
  });

  it("rejects a response without an ID token", async () => {
    const h = setup();
    const { state } = await h.client.start();
    h.idp.tokenBody = { access_token: "at", token_type: "Bearer" };
    await expectError(
      h.client.finish({ code: "c", state }),
      "token_error",
      /ID token/,
    );
  });
});

describe("ID token verification", () => {
  it("rejects alg none", async () => {
    const h = setup();
    await expectError(
      signIn(h, { header: { alg: "none" } }),
      "unsupported_alg",
      /"none"/,
    );
  });

  it("rejects HS256, even when signed with the client secret", async () => {
    const h = setup();
    const { url, state } = await h.client.start();
    const nonce = new URL(url).searchParams.get("nonce") ?? "";
    h.idp.tokenBody = {
      id_token: signJwt(
        { alg: "HS256", kid: RSA.kid },
        goodClaims(h, nonce),
        RSA.privateKey,
        CLIENT_SECRET,
      ),
    };
    await expectError(h.client.finish({ code: "c", state }), "unsupported_alg");
  });

  it("rejects a token that is not a JWT", async () => {
    const h = setup();
    await expectError(signIn(h, { idToken: "not.a-jwt" }), "invalid_token");
  });

  it("rejects a bad signature", async () => {
    const h = setup();
    // Signed with an unpublished key while claiming the published key's kid.
    await expectError(
      signIn(h, { key: { ...RSA_ROTATED, kid: RSA.kid } }),
      "invalid_token",
      /signature/,
    );
  });

  it("rejects a tampered payload", async () => {
    const h = setup();
    const { url, state } = await h.client.start();
    const nonce = new URL(url).searchParams.get("nonce") ?? "";
    const [header, , signature] = signJwt(
      { alg: "RS256", kid: RSA.kid },
      goodClaims(h, nonce),
      RSA.privateKey,
    ).split(".");
    const forged = b64url(
      JSON.stringify({ ...goodClaims(h, nonce), email: "boss@example.com" }),
    );
    h.idp.tokenBody = { id_token: `${header}.${forged}.${signature}` };
    await expectError(h.client.finish({ code: "c", state }), "invalid_token");
  });

  it("rejects the wrong issuer", async () => {
    const h = setup();
    await expectError(
      signIn(h, { claims: { iss: `${ORIGIN}/tenant-b` } }),
      "invalid_token",
      /tenant-b/,
    );
  });

  it("rejects a token for another application", async () => {
    const h = setup();
    await expectError(
      signIn(h, { claims: { aud: "other-app" } }),
      "invalid_token",
      /different application/,
    );
  });

  it("accepts an audience array when azp names this client", async () => {
    const h = setup();
    await expect(
      signIn(h, { claims: { aud: ["other-api", CLIENT_ID], azp: CLIENT_ID } }),
    ).resolves.toHaveProperty("subject");
    await expect(
      signIn(h, { claims: { aud: [CLIENT_ID] } }),
    ).resolves.toHaveProperty("subject");
  });

  it("rejects an audience array without a matching azp", async () => {
    const h = setup();
    await expectError(
      signIn(h, { claims: { aud: ["other-api", CLIENT_ID] } }),
      "invalid_token",
    );
    await expectError(
      signIn(h, {
        claims: { aud: ["other-api", CLIENT_ID], azp: "other-api" },
      }),
      "invalid_token",
    );
  });

  it("tolerates two minutes of clock skew", async () => {
    const h = setup();
    const now = h.nowSeconds();
    await expect(
      signIn(h, { claims: { exp: now - 100, iat: now + 100, nbf: now + 100 } }),
    ).resolves.toHaveProperty("subject");
  });

  it("rejects an expired token beyond the skew", async () => {
    const h = setup();
    await expectError(
      signIn(h, { claims: { exp: h.nowSeconds() - 130 } }),
      "invalid_token",
      /expired/,
    );
  });

  it("rejects nbf and iat beyond the skew", async () => {
    const h = setup();
    const later = h.nowSeconds() + 300;
    await expectError(
      signIn(h, { claims: { nbf: later } }),
      "invalid_token",
      /not valid yet/,
    );
    await expectError(
      signIn(h, { claims: { iat: later } }),
      "invalid_token",
      /issued in the future/,
    );
  });

  it("rejects a token with no expiry", async () => {
    const h = setup();
    await expectError(
      signIn(h, { claims: { exp: undefined } }),
      "invalid_token",
      /expiry/,
    );
  });

  it("rejects a nonce from another attempt", async () => {
    const h = setup();
    await expectError(
      signIn(h, { claims: { nonce: "someone-elses-nonce" } }),
      "invalid_token",
      /this sign-in attempt/,
    );
  });
});

describe("Microsoft Entra ID", () => {
  const TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
  const entra = () =>
    setup({
      config: { issuer: `${ORIGIN}/common/v2.0` },
      discovery: { issuer: `${ORIGIN}/{tenantid}/v2.0` },
    });

  it("accepts the multi-tenant issuer template and preferred_username", async () => {
    const h = entra();
    const identity = await signIn(h, {
      claims: {
        iss: `${ORIGIN}/${TENANT}/v2.0`,
        tid: TENANT,
        email: undefined,
        email_verified: undefined,
        preferred_username: "Ann.Lee@Example.com",
      },
    });
    expect(identity.email).toBe("ann.lee@example.com");
    expect(identity.claims.tid).toBe(TENANT);
  });

  it("rejects a token whose tid does not match its issuer", async () => {
    const h = entra();
    await expectError(
      signIn(h, {
        claims: { iss: `${ORIGIN}/${TENANT}/v2.0`, tid: "another-tenant" },
      }),
      "invalid_token",
    );
  });

  it("rejects a template token with no tid", async () => {
    const h = entra();
    await expectError(
      signIn(h, { claims: { iss: `${ORIGIN}/${TENANT}/v2.0` } }),
      "invalid_token",
      /tenant/,
    );
  });

  it("falls back to upn", async () => {
    const h = setup();
    const identity = await signIn(h, {
      claims: { email: undefined, upn: "ANN@example.com" },
    });
    expect(identity.email).toBe("ann@example.com");
  });
});

describe("email and domain checks", () => {
  it("rejects an email the provider marks unverified", async () => {
    const h = setup();
    await expectError(
      signIn(h, { claims: { email_verified: false } }),
      "email_unverified",
      /ann@example\.com/,
    );
  });

  it("rejects a token with no usable email", async () => {
    const h = setup();
    await expectError(
      signIn(h, {
        claims: { email: undefined, preferred_username: "ann" },
      }),
      "no_email",
    );
  });

  it("rejects a domain that is not allowed, naming it", async () => {
    const h = setup();
    await expectError(
      signIn(h, { claims: { email: "eve@evil.example.org" } }),
      "domain_not_allowed",
      "Accounts from evil.example.org are not allowed to sign in here. Ask your administrator to add evil.example.org to the allowed email domains.",
    );
  });

  it("does not treat a subdomain as allowed", async () => {
    const h = setup();
    await expectError(
      signIn(h, { claims: { email: "ann@sub.example.com" } }),
      "domain_not_allowed",
    );
  });

  it("lets nobody in when no domains are allowed", async () => {
    const h = setup({ config: { allowedDomains: [] } });
    await expectError(signIn(h), "domain_not_allowed", /example\.com/);
  });
});
