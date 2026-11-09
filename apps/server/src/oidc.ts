import {
  constants,
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

/**
 * "Sign in with your company account" for people, using OpenID Connect.
 *
 * This is the generic authorization code flow with PKCE, so it works with
 * Microsoft Entra ID, Okta, Google Workspace and any other provider that
 * publishes a standard discovery document. It uses only node:crypto and the
 * fetch function it is given: no third-party libraries.
 *
 * A login has two halves. `start()` makes the link that sends the browser to
 * the identity provider and remembers the attempt in memory for ten minutes.
 * `finish()` takes the query parameters the provider sends back, swaps the
 * one-time code for an ID token, checks that token thoroughly and returns
 * who the person is. Restarting Purser forgets attempts in progress, which
 * only means someone halfway through signing in has to start again.
 */

/** How the server is connected to the company's identity provider. */
export interface OidcConfig {
  /** The provider's issuer URL, e.g. https://login.microsoftonline.com/<tenant>/v2.0 */
  issuer: string;
  clientId: string;
  /** Absent (or empty): a public client that relies on PKCE alone. */
  clientSecret?: string | undefined;
  /** Email domains allowed to sign in, lower case, e.g. ["example.com"]. Empty: nobody. */
  allowedDomains: string[];
  /** Defaults to ["openid", "email", "profile"]. "openid" is always added if missing. */
  scopes?: string[] | undefined;
}

/** The person who signed in. */
export interface OidcIdentity {
  /** The provider's `sub` claim. Together with the issuer it uniquely identifies the person. */
  subject: string;
  /** Lower case. */
  email: string;
  name?: string | undefined;
  /** Every claim from the verified ID token, for anything else the caller needs. */
  claims: Record<string, unknown>;
}

/** The parts of a provider's `.well-known/openid-configuration` that Purser uses. */
export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[] | undefined;
  [key: string]: unknown;
}

/**
 * Everything that can go wrong, by code. The route handler can switch on the
 * code; the message is written for the person or admin who will read it.
 *
 * - `invalid_config`: a configured address is not a valid URL.
 * - `insecure_url`: the issuer or an endpoint is not https (localhost excepted).
 * - `discovery_failed`: the provider's settings could not be loaded or were incomplete.
 * - `issuer_mismatch`: the provider calls itself something other than the configured issuer.
 * - `idp_error`: the provider sent the browser back with an error (for example, the person cancelled).
 * - `invalid_state`: the sign-in attempt is missing, unknown, already used or expired.
 * - `invalid_request`: the provider sent no authorization code.
 * - `token_error`: the provider would not exchange the code, or returned no ID token.
 * - `jwks_error`: the provider's signing keys could not be loaded.
 * - `unsupported_alg`: the ID token uses a signing method Purser does not accept.
 * - `unknown_key`: the ID token was signed with a key the provider does not publish.
 * - `invalid_token`: the ID token failed a check (signature, issuer, audience, time, nonce).
 * - `email_unverified`: the provider says the person's email address is not verified.
 * - `no_email`: the ID token carries no email address.
 * - `domain_not_allowed`: the email domain is not in the allowed list.
 */
export type OidcErrorCode =
  | "invalid_config"
  | "insecure_url"
  | "discovery_failed"
  | "issuer_mismatch"
  | "idp_error"
  | "invalid_state"
  | "invalid_request"
  | "token_error"
  | "jwks_error"
  | "unsupported_alg"
  | "unknown_key"
  | "invalid_token"
  | "email_unverified"
  | "no_email"
  | "domain_not_allowed";

/** A sign-in failure with a machine-readable code and a plain-English message. */
export class OidcError extends Error {
  readonly code: OidcErrorCode;

  constructor(code: OidcErrorCode, message: string) {
    super(message);
    this.name = "OidcError";
    this.code = code;
  }
}

/** How long a sign-in link works after `start()`. */
export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;
/** How far apart Purser's clock and the provider's clock may drift. */
export const CLOCK_SKEW_SECONDS = 120;
/** Most sign-in attempts kept in memory at once; the oldest are dropped beyond this. */
export const MAX_PENDING_LOGINS = 10_000;
/** How long to wait for the identity provider before giving up. */
const FETCH_TIMEOUT_MS = 10_000;

const DEFAULT_SCOPES = ["openid", "email", "profile"];
const SUPPORTED_ALGS = new Set(["RS256", "PS256", "ES256"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Entra's multi-tenant discovery document uses this in place of the tenant id. */
const TENANT_PLACEHOLDER = "{tenantid}";

/**
 * Fetches `${issuer}/.well-known/openid-configuration` (a trailing slash on
 * the issuer is ignored) and checks it: the document must name the same
 * issuer, and every endpoint must use https unless it is on localhost.
 *
 * This function does not cache: each call is a fresh request. `OidcClient`
 * caches the result for its own lifetime, so a client fetches it once.
 */
export async function discover(
  issuer: string,
  fetchFn: typeof fetch,
): Promise<DiscoveryDocument> {
  const base = trimSlash(issuer);
  requireSecure(base, "issuer URL");
  const url = `${base}/.well-known/openid-configuration`;
  const { res, body } = await request(
    fetchFn,
    url,
    { headers: { accept: "application/json" } },
    "discovery_failed",
  );
  if (!res.ok) {
    throw new OidcError(
      "discovery_failed",
      `Could not load the identity provider's settings from ${url} (HTTP ${res.status}). Check the issuer URL in the sign-in settings.`,
    );
  }
  if (!isObject(body)) {
    throw new OidcError(
      "discovery_failed",
      `The identity provider's settings at ${url} are not valid JSON. Check the issuer URL in the sign-in settings.`,
    );
  }
  for (const field of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
  ]) {
    if (typeof body[field] !== "string" || body[field] === "") {
      throw new OidcError(
        "discovery_failed",
        `The identity provider's settings at ${url} do not include "${field}". Check the issuer URL in the sign-in settings.`,
      );
    }
  }
  const doc = body as DiscoveryDocument;
  if (!issuerMatches(doc.issuer, base)) {
    throw new OidcError(
      "issuer_mismatch",
      `The identity provider says its issuer is ${doc.issuer}, but Purser is set up with ${base}. Copy the issuer URL exactly as your identity provider shows it.`,
    );
  }
  requireSecure(doc.authorization_endpoint, "sign-in page address");
  requireSecure(doc.token_endpoint, "token endpoint");
  requireSecure(doc.jwks_uri, "signing keys address");
  const methods = doc.token_endpoint_auth_methods_supported;
  if (
    methods !== undefined &&
    !(Array.isArray(methods) && methods.every((m) => typeof m === "string"))
  ) {
    doc.token_endpoint_auth_methods_supported = undefined;
  }
  return doc;
}

/** What `start()` remembers until the browser comes back. */
interface PendingLogin {
  nonce: string;
  verifier: string;
  expires: number;
}

/** The query parameters on the provider's redirect back to Purser. */
export interface OidcCallbackParams {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
  error_description?: string | undefined;
}

/**
 * One configured identity provider. Keep a single instance for the life of
 * the server: it caches the provider's settings and signing keys, and holds
 * the sign-in attempts in progress.
 */
export class OidcClient {
  private readonly config: OidcConfig;
  private readonly redirectUri: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly pending = new Map<string, PendingLogin>();
  private discovery: Promise<DiscoveryDocument> | undefined;
  private jwks: unknown[] | undefined;

  constructor(options: {
    config: OidcConfig;
    redirectUri: string;
    fetch: typeof fetch;
    now: () => Date;
  }) {
    this.config = options.config;
    this.redirectUri = options.redirectUri;
    this.fetchFn = options.fetch;
    this.now = options.now;
  }

  /** How many sign-in attempts are waiting for the browser to come back. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Builds the link that sends the browser to the identity provider
   * (authorization code flow, S256 PKCE, state and nonce) and remembers the
   * attempt for 10 minutes. Store nothing yourself: just redirect to `url`.
   */
  async start(): Promise<{ url: string; state: string }> {
    const doc = await this.metadata();
    const nowMs = this.now().getTime();
    this.prune(nowMs);

    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const url = new URL(doc.authorization_endpoint);
    const params = url.searchParams;
    params.set("response_type", "code");
    params.set("client_id", this.config.clientId);
    params.set("redirect_uri", this.redirectUri);
    params.set("scope", this.scopes().join(" "));
    params.set("state", state);
    params.set("nonce", nonce);
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", "S256");

    this.pending.set(state, {
      nonce,
      verifier,
      expires: nowMs + PENDING_LOGIN_TTL_MS,
    });
    while (this.pending.size > MAX_PENDING_LOGINS) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    return { url: url.toString(), state };
  }

  /**
   * Completes a sign-in from the callback's query parameters. Each `state`
   * works once, whether the attempt succeeds or fails. Throws `OidcError`.
   */
  async finish(params: OidcCallbackParams): Promise<OidcIdentity> {
    if (params.error !== undefined && params.error !== "") {
      if (params.state !== undefined) this.pending.delete(params.state);
      const said = params.error_description?.trim() || params.error;
      throw new OidcError(
        "idp_error",
        `Your identity provider stopped the sign-in. It said: ${said}`,
      );
    }

    const state = params.state;
    if (state === undefined || state === "") {
      throw new OidcError(
        "invalid_state",
        "This sign-in link is incomplete. Start again.",
      );
    }
    const login = this.pending.get(state);
    if (login === undefined) {
      throw new OidcError(
        "invalid_state",
        "This sign-in link is not valid or was already used. Start again.",
      );
    }
    this.pending.delete(state);
    if (login.expires <= this.now().getTime()) {
      throw new OidcError(
        "invalid_state",
        "This sign-in link has expired. Start again.",
      );
    }
    if (params.code === undefined || params.code === "") {
      throw new OidcError(
        "invalid_request",
        "The identity provider did not send a sign-in code. Start again.",
      );
    }

    const doc = await this.metadata();
    const idToken = await this.exchange(doc, params.code, login.verifier);
    const claims = await this.verifyIdToken(doc, idToken, login.nonce);
    return identityFrom(claims, this.config.allowedDomains);
  }

  /** The discovery document, fetched once per client. A failed fetch is retried next time. */
  private metadata(): Promise<DiscoveryDocument> {
    if (this.discovery === undefined) {
      const pending = discover(this.config.issuer, this.fetchFn);
      this.discovery = pending;
      pending.catch(() => {
        if (this.discovery === pending) this.discovery = undefined;
      });
    }
    return this.discovery;
  }

  private scopes(): string[] {
    const scopes = this.config.scopes ?? DEFAULT_SCOPES;
    return scopes.includes("openid") ? scopes : ["openid", ...scopes];
  }

  private prune(nowMs: number): void {
    for (const [state, login] of this.pending) {
      if (login.expires <= nowMs) this.pending.delete(state);
    }
  }

  /**
   * Swaps the authorization code for tokens and returns the ID token. With a
   * client secret, uses HTTP Basic (client_secret_basic) unless the provider
   * says it only supports client_secret_post.
   */
  private async exchange(
    doc: DiscoveryDocument,
    code: string,
    verifier: string,
  ): Promise<string> {
    const { clientId, clientSecret } = this.config;
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      code_verifier: verifier,
      client_id: clientId,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (clientSecret !== undefined && clientSecret !== "") {
      const methods = doc.token_endpoint_auth_methods_supported;
      if (methods === undefined || methods.includes("client_secret_basic")) {
        const pair = `${formEncode(clientId)}:${formEncode(clientSecret)}`;
        headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
      } else {
        form.set("client_secret", clientSecret);
      }
    }

    const { res, body } = await request(
      this.fetchFn,
      doc.token_endpoint,
      { method: "POST", headers, body: form.toString() },
      "token_error",
    );
    if (!res.ok) {
      const said = isObject(body)
        ? (text(body.error_description) ?? text(body.error))
        : undefined;
      throw new OidcError(
        "token_error",
        said === undefined
          ? `The identity provider would not complete the sign-in (HTTP ${res.status}). Start again, and if it keeps happening check the client id and secret in the sign-in settings.`
          : `The identity provider would not complete the sign-in. It said: ${said}`,
      );
    }
    const idToken = isObject(body) ? body.id_token : undefined;
    if (typeof idToken !== "string" || idToken === "") {
      throw new OidcError(
        "token_error",
        'The identity provider did not return an ID token. Check that the app registration allows the "openid" scope.',
      );
    }
    return idToken;
  }

  /** Checks the ID token's signature and claims, and returns its claims. */
  private async verifyIdToken(
    doc: DiscoveryDocument,
    token: string,
    nonce: string,
  ): Promise<Record<string, unknown>> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) {
      throw invalidToken("The sign-in token is not in the expected format.");
    }
    const [headerPart, payloadPart, signaturePart] = parts as [
      string,
      string,
      string,
    ];
    const header = decodeJson(headerPart);
    const claims = decodeJson(payloadPart);
    if (!isObject(header) || !isObject(claims)) {
      throw invalidToken("The sign-in token could not be read.");
    }

    const alg = header.alg;
    if (typeof alg !== "string" || !SUPPORTED_ALGS.has(alg)) {
      throw new OidcError(
        "unsupported_alg",
        `The sign-in token uses the "${String(alg)}" signing method, which Purser does not accept. Set the identity provider to sign ID tokens with RS256, PS256 or ES256.`,
      );
    }
    if (header.crit !== undefined) {
      throw invalidToken(
        "The sign-in token uses extensions Purser does not understand.",
      );
    }

    const kid = typeof header.kid === "string" ? header.kid : undefined;
    const key = await this.signingKey(doc, kid, alg);
    const data = Buffer.from(`${headerPart}.${payloadPart}`);
    const signature = Buffer.from(signaturePart, "base64url");
    if (!checkSignature(alg, key, data, signature)) {
      throw invalidToken(
        "The sign-in token's signature is not valid. Start again.",
      );
    }

    checkClaims(claims, {
      issuer: doc.issuer,
      clientId: this.config.clientId,
      nonce,
      nowSeconds: Math.floor(this.now().getTime() / 1000),
    });
    return claims;
  }

  /**
   * Finds the public key for a token. Keys are cached; if the token names a
   * key we do not have, the provider may have rotated its keys, so fetch the
   * set again once before giving up.
   */
  private async signingKey(
    doc: DiscoveryDocument,
    kid: string | undefined,
    alg: string,
  ): Promise<KeyObject> {
    let fresh = false;
    if (this.jwks === undefined) {
      this.jwks = await fetchJwks(doc.jwks_uri, this.fetchFn);
      fresh = true;
    }
    let jwk = pickKey(this.jwks, kid, alg);
    if (jwk === undefined && !fresh) {
      this.jwks = await fetchJwks(doc.jwks_uri, this.fetchFn);
      jwk = pickKey(this.jwks, kid, alg);
    }
    if (jwk === undefined) {
      throw new OidcError(
        "unknown_key",
        kid === undefined
          ? "The sign-in token does not say which key signed it, and the identity provider publishes more than one. Start again."
          : `The sign-in token was signed with a key (${kid}) that the identity provider does not publish. Start again, and if it keeps happening check the issuer URL.`,
      );
    }
    try {
      return createPublicKey({ key: jwk, format: "jwk" });
    } catch {
      throw new OidcError(
        "unknown_key",
        "One of the identity provider's signing keys could not be read.",
      );
    }
  }
}

/** Loads the provider's JSON Web Key Set. */
async function fetchJwks(
  url: string,
  fetchFn: typeof fetch,
): Promise<unknown[]> {
  const { res, body } = await request(
    fetchFn,
    url,
    { headers: { accept: "application/json" } },
    "jwks_error",
  );
  if (!res.ok || !isObject(body) || !Array.isArray(body.keys)) {
    throw new OidcError(
      "jwks_error",
      `Could not load the identity provider's signing keys from ${url}${res.ok ? "" : ` (HTTP ${res.status})`}. Try again in a minute.`,
    );
  }
  return body.keys;
}

/**
 * Picks the key that matches the token: by `kid` when the token names one,
 * otherwise the only suitable key. The key's type must fit the algorithm
 * (RSA for RS256 and PS256, P-256 for ES256) and it must be a signing key.
 */
function pickKey(
  keys: unknown[],
  kid: string | undefined,
  alg: string,
): JsonWebKey | undefined {
  const usable = keys.filter(
    (k): k is JsonWebKey & { kid?: unknown; alg?: unknown; use?: unknown } =>
      isObject(k) &&
      (alg === "ES256"
        ? k.kty === "EC" && k.crv === "P-256"
        : k.kty === "RSA") &&
      (k.use === undefined || k.use === "sig") &&
      (k.alg === undefined || k.alg === alg),
  );
  if (kid !== undefined) return usable.find((k) => k.kid === kid);
  return usable.length === 1 ? usable[0] : undefined;
}

function checkSignature(
  alg: string,
  key: KeyObject,
  data: Buffer,
  signature: Buffer,
): boolean {
  try {
    switch (alg) {
      case "RS256":
        return verifySignature("sha256", data, key, signature);
      case "PS256":
        return verifySignature(
          "sha256",
          data,
          {
            key,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
          },
          signature,
        );
      case "ES256":
        return (
          signature.length === 64 &&
          verifySignature(
            "sha256",
            data,
            { key, dsaEncoding: "ieee-p1363" },
            signature,
          )
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * The standard ID token checks: issuer, audience, authorized party, expiry,
 * not-before, issued-at and nonce. Times allow two minutes of clock drift.
 */
function checkClaims(
  claims: Record<string, unknown>,
  expected: {
    issuer: string;
    clientId: string;
    nonce: string;
    nowSeconds: number;
  },
): void {
  const { clientId, nowSeconds } = expected;

  let issuer = expected.issuer;
  if (issuer.includes(TENANT_PLACEHOLDER)) {
    const tid = claims.tid;
    if (typeof tid !== "string" || !/^[A-Za-z0-9-]+$/.test(tid)) {
      throw invalidToken(
        "The sign-in token does not say which Microsoft tenant it came from.",
      );
    }
    issuer = issuer.split(TENANT_PLACEHOLDER).join(tid);
  }
  if (claims.iss !== issuer) {
    throw invalidToken(
      `The sign-in token was issued by ${String(claims.iss)}, not by ${issuer}. Check the issuer URL in the sign-in settings.`,
    );
  }

  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(clientId)) {
    throw invalidToken(
      "The sign-in token was issued for a different application. Check the client id in the sign-in settings.",
    );
  }
  if (audiences.length > 1 && claims.azp !== clientId) {
    throw invalidToken(
      "The sign-in token was issued for several applications and does not name this one as the requester.",
    );
  }
  if (claims.azp !== undefined && claims.azp !== clientId) {
    throw invalidToken(
      "The sign-in token was requested by a different application.",
    );
  }

  const exp = claims.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw invalidToken("The sign-in token has no expiry time.");
  }
  if (nowSeconds > exp + CLOCK_SKEW_SECONDS) {
    throw invalidToken(
      "The sign-in token has expired. Start again, and if it keeps happening check that this server's clock is correct.",
    );
  }
  for (const [name, label] of [
    ["nbf", "is not valid yet"],
    ["iat", "was issued in the future"],
  ] as const) {
    const value = claims[name];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw invalidToken(`The sign-in token has an unreadable "${name}" time.`);
    }
    if (value > nowSeconds + CLOCK_SKEW_SECONDS) {
      throw invalidToken(
        `The sign-in token ${label}. Check that this server's clock is correct.`,
      );
    }
  }

  if (claims.nonce !== expected.nonce) {
    throw invalidToken(
      "The sign-in token does not belong to this sign-in attempt. Start again.",
    );
  }
  if (typeof claims.sub !== "string" || claims.sub === "") {
    throw invalidToken("The sign-in token does not identify a person.");
  }
}

/**
 * Turns verified claims into an identity: finds the email address, checks it
 * is verified and in an allowed domain, and works out a display name.
 */
function identityFrom(
  claims: Record<string, unknown>,
  allowedDomains: string[],
): OidcIdentity {
  const email = findEmail(claims);
  if (email === undefined) {
    throw new OidcError(
      "no_email",
      "Your company account did not share an email address with Purser. Ask your administrator to include the email claim for this app.",
    );
  }
  if (claims.email_verified === false || claims.email_verified === "false") {
    throw new OidcError(
      "email_unverified",
      `Your identity provider says ${email} is not verified yet. Verify it with your identity provider, then start again.`,
    );
  }
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const allowed = new Set(
    allowedDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")),
  );
  if (!allowed.has(domain)) {
    throw new OidcError(
      "domain_not_allowed",
      `Accounts from ${domain} are not allowed to sign in here. Ask your administrator to add ${domain} to the allowed email domains.`,
    );
  }

  const given = text(claims.given_name);
  const family = text(claims.family_name);
  const name =
    text(claims.name) ??
    ([given, family].filter((p) => p !== undefined).join(" ") || undefined);

  const identity: OidcIdentity = {
    subject: claims.sub as string,
    email,
    claims,
  };
  if (name !== undefined) identity.name = name;
  return identity;
}

/**
 * The `email` claim, else `preferred_username` or `upn` when they look like
 * an email address (Entra often sends only those). Lower case.
 */
function findEmail(claims: Record<string, unknown>): string | undefined {
  for (const claim of ["email", "preferred_username", "upn"]) {
    const value = text(claims[claim])?.toLowerCase();
    if (value === undefined) continue;
    const at = value.lastIndexOf("@");
    if (at > 0 && at < value.length - 1) return value;
  }
  return undefined;
}

/** Fetches a URL with a timeout and parses any JSON body; network failures become OidcError. */
async function request(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  code: OidcErrorCode,
): Promise<{ res: Response; body: unknown }> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OidcError(
      code,
      `Could not reach the identity provider at ${url} (${err instanceof Error ? err.message : String(err)}). Try again in a minute.`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { res, body };
}

/** Insists on https, except for local development addresses. */
function requireSecure(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OidcError(
      "invalid_config",
      `The ${label} "${url}" is not a valid web address.`,
    );
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname)) return;
  throw new OidcError(
    "insecure_url",
    `The ${label} ${url} must start with https://. Purser only talks to identity providers over a secure connection.`,
  );
}

/**
 * True when the discovery document's issuer is the configured one. Entra's
 * multi-tenant document says `.../{tenantid}/v2.0`, which matches a
 * configured `.../common/v2.0` or `.../organizations/v2.0`.
 */
function issuerMatches(docIssuer: string, configured: string): boolean {
  const doc = trimSlash(docIssuer);
  if (doc === configured) return true;
  if (!doc.includes(TENANT_PLACEHOLDER)) return false;
  const pattern = doc
    .split(TENANT_PLACEHOLDER)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${pattern}$`).test(configured);
}

/** 32 random bytes, base64url: 43 characters. */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** application/x-www-form-urlencoded, as RFC 6749 section 2.3.1 requires for Basic credentials. */
function formEncode(value: string): string {
  return new URLSearchParams([["", value]]).toString().slice(1);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A trimmed, non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function invalidToken(message: string): OidcError {
  return new OidcError("invalid_token", message);
}
