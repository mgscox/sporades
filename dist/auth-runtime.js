// The Capsule runtime's auth domain: sessions, the four OAuth providers and their identity-token
// verification, password reset, the email sign-in throttles, and the credential hashing that
// travels with them. Batch 3 of the migration ADR-0041 records — the region moved out of
// `server-runtime-source.ts`, and apart from the two changes named below the bodies are
// byte-identical to the ones that lived there.
//
// **What is exported and what is not.** 116 declarations moved in batch 3: 104 functions and the
// twelve SCREAMING_CASE constants that are this domain's security thresholds. 65 were exported and
// 51 private. Under the emitted list every one of the 51 had to be registered in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS` or become a `ReferenceError` in a deployed Capsule, so
// "private" was not a thing this domain could be.
//
// **Batch 5 added seven more**, at the end of this file — the sessions-and-sign-in region batch 3
// had to leave behind. 123 declarations now, 68 exported and 55 private. See the section header
// down there for why those seven and not the other seven, and what still holds the rest.
//
// The exports are not a designed interface — they are the names something outside this file still
// resolves. Three groups: the constants, which the bundle preamble used to serialize and the
// module-graph bundle's constant probe still derives over; the names the auth functions still in the
// monolith call (see below); and the names the OAuth, password-reset and require-auth suites reach
// for, which resolved through `SERVER_RUNTIME_SOURCE_FUNCTIONS.find(name)` before batch 3 and return
// `undefined` the moment a domain stops being entries in it.
//
// **Six of those seven arrived in batch 8, and one auth function is still in the monolith.**
// `routeSporadesAuth`, `readOAuthCallbackParameters`, `oauthFormContentTypeValid`,
// `beginOAuthSignIn`, `resolveOAuthRequestOrigin` and `resolvePasswordResetConfig` reached the HTTP
// layer (`writeEndpointError`, `readLimitedRequestBody`, `normalizeOrigin`, `singleHttpHeader`,
// `validatedRequestHost`), which is batch 8, and that batch moved every one of them out of the
// monolith. Five are at the end of this file as batch 8's riders, the way batch 5 carried the seven
// above; the sixth, `resolveOAuthRequestOrigin`, is in `http-runtime.ts` instead, because its body
// validates a request origin against the CORS policy and reaches no auth name — see that module's
// header. So this is batch 5's case rather than batch 4's a second time: a blocker that named a
// later batch, and that batch cleared it.
//
// `sendEmailPasswordResetLink` is the one that did not move, and it is not waiting on a batch at
// all. It reaches `enqueueRuntimeJob`, which batch 4 could not move either — it needs
// `createMutationContext`, the composition point `server-runtime-source.ts` retains — so it is
// ticket 05's rather than batch 9's.
//
// **Why `node:crypto` is reached through `process.getBuiltinModule` and not imported.** ADR-0042.
// The emitted-list bundle carries this module as one esbuild IIFE (ADR-0041), and `format: "iife"`
// lowers a *static* external import to `__require("node:crypto")`, which is not defined in the ES
// module the block is spliced into — the Capsule dies at boot. ADR-0041's escape hatch is a
// *dynamic* `import(…)`, which esbuild emits verbatim; the mail domain opens its sockets that way.
// That hatch is closed to this domain, because `hashEmailPassword`, `verifyEmailPassword`,
// `hashPasswordResetVerifier`, `readPasswordResetCode`, `passwordResetCodeParts` and
// `createSessionToken` are *synchronous* and `scryptSync`, `timingSafeEqual`, `createHash` and
// `randomBytes` have no synchronous Web Crypto equivalent — unlike `randomUUID`, which is why mail
// could reach the global and this domain cannot. Making them async would change six signatures and
// every caller, which is a behaviour change this refactor must not make.
//
// `process.getBuiltinModule` resolves a builtin synchronously off a global, so esbuild sees no
// import at all: the carrier's metafile check passes unweakened rather than being relaxed for this
// module. The twenty-three call sites carry the `nodeCryptoModule.` prefix and are the only lines
// here that are not byte-identical to the region they moved out of. Nineteen arrived with batch 3
// and batch 5; the last four are in `beginOAuthSignIn`, one of batch 8's riders, which mints its
// OAuth state, nonce and PKCE pair with `randomBytes` and `createHash`. (This paragraph said
// "seventeen" from batch 3 until batch 8 counted them; it was two short from batch 5 onwards.)
//
// **The accessor is one namespace binding and not a destructuring**, and that is the second
// deliberate line. `const { createHash, randomBytes, scryptSync, timingSafeEqual } = …` reads
// better and would have shipped a `ReferenceError`: `bin/sporades.js` is the whole of `src/` in one
// esbuild scope, so those four top-level names collide with `server-runtime-source.ts`'s
// `import … from "node:crypto"` and esbuild renames one side. That is the defect batch 2 shipped
// with `randomUUID`, recorded in ADR-0041, and the guard in
// `test/server-bundle-free-bindings.test.js` refuses it by name.
import { commandError } from "./runtime-errors.js";
// Batch 5. The one name this domain needs from the user-preferences module, and the reason that
// module was made its own batch and run early: `migrateAnonymousPreferences` is what kept the seven
// functions at the end of this file inside the monolith after batch 3. The dependency runs one way
// — user preferences imports `runtime-errors.js` and nothing else — so this introduces no cycle.
import { migrateAnonymousPreferences } from "./user-preferences-runtime.js";
import { bootstrapInitialTeamForLinkedUser } from "./teams-runtime.js";
// Batch 9. The sync/async bridge every step of the auth storage bootstrap at the end of this file
// chains through: on a synchronous engine that is the order the statements already ran in, and on an
// asynchronous one it is the difference between a sequence and a race.
import { chainMaybePromise } from "./maybe-promise.js";
// Batch 8. The four HTTP primitives the five OAuth riders at the end of this file need: the body
// reader and its size limit, the single-valued header accessor, the origin normalizer and the
// endpoint error writer. `http-runtime.ts` imports `resolveAnonymousSession` from here in turn, for
// the private File route's authentication — a cycle, and a safe one, because every binding across it
// is a hoisted `function` declaration used only inside a body that runs on a request rather than at
// module initialization. See `http-runtime.ts`'s header.
import { normalizeOrigin, readLimitedRequestBody, singleHttpHeader, writeEndpointError, } from "./http-runtime.js";
import { decorateRequireAuth, normalizeRequireUserAuthOptions } from "./auth-admission.js";
import { accessKeyCredentialLogAttribution, createAccessKeyTables, emitAccessKeyOwnerTransitionAudits } from "./access-keys-runtime.js";
// Synchronous access to a Node builtin without an import — see the header. `process` is a global in
// both places this module runs: `dist/auth-runtime.js` loaded as an ES module, and the esbuild IIFE
// the emitted-list bundle splices into a deployed Capsule.
const nodeCryptoModule = process.getBuiltinModule("node:crypto");
// This domain's security thresholds. They stood in `server-runtime-source.ts` and were serialized
// into the generated bundle's constant preamble, because a runtime function reaches that bundle as
// its own source text and the module-level bindings it closes over do not follow.
//
// **They are not in the preamble any more, and they left it in the same commit that moved them
// here.** This module's compiled text is spliced into the bundle immediately after the preamble, so
// serializing them there as well would declare each name twice at the top level of an ES module — a
// load-time `SyntaxError` in a deployed Capsule rather than a drift. They are still reachable by
// name at the bundle's top level, through the destructuring the carried block ends with, which is
// how the auth functions still in the monolith resolve them.
//
// Exported for three reasons at once, and all three are load-bearing. `server-runtime-source.ts`
// imports six of them for `resolvePasswordResetConfig`, `sendEmailPasswordResetLink` and
// `runtimeOwnedJobHandlers`; the carried block only destructures what this module exports, so a
// private one would not reach the bundle at all; and the two-bundle constant probe in
// `test/server-bundle-module-graph.test.js` derives what it compares from the SCREAMING_CASE
// *exports* re-exported through `server-runtime-source.js` — so a private threshold would not fail
// that probe, it would silently stop being compared between the two bundles.
export const PRIVILEGED_AUTH_USER_ID = "__privileged__";
export const EMAIL_SIGN_IN_FAILURE_LIMIT = 5;
export const EMAIL_SIGN_IN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES = 256;
export const EMAIL_SIGN_IN_THROTTLE_FIELD = "__emailSignInThrottle";
export const PASSWORD_CHANGE_THROTTLE_FIELD = "__emailPasswordChangeThrottle";
export const PASSWORD_RESET_THROTTLE_FIELD = "__emailPasswordResetThrottle";
export const PASSWORD_RESET_DEFAULT_PATH = "/reset-password";
export const PASSWORD_RESET_DEFAULT_TTL_MS = 60 * 60 * 1000;
export const PASSWORD_RESET_MIN_TTL_MS = 5 * 60 * 1000;
export const PASSWORD_RESET_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_MAX_OUTSTANDING_PER_EMAIL = 5;
const AUTH_TRANSACTION_RETRY_LIMIT = 5;
// Kept for queued work from before reset requests became durable Jobs of their own.
export const PASSWORD_RESET_MAIL_JOB = "_sporades_password_reset_mail";
export const PASSWORD_RESET_REQUEST_JOB = "_sporades_password_reset_request";
export function privilegedAuthUserId() {
    return "__privileged__";
}
export function isReservedAuthUserId(userId) {
    return userId === privilegedAuthUserId();
}
export function authIdentityRowUnlessReserved(rowOrPromise) {
    if (rowOrPromise && typeof rowOrPromise.then === "function") {
        return rowOrPromise.then((row) => (isReservedAuthUserId(row?.userId) ? null : row));
    }
    return isReservedAuthUserId(rowOrPromise?.userId) ? null : rowOrPromise;
}
export function authIdentityRowsUnlessReserved(rowsOrPromise) {
    if (rowsOrPromise && typeof rowsOrPromise.then === "function") {
        return rowsOrPromise.then((rows) => rows.filter((row) => !isReservedAuthUserId(row?.userId)));
    }
    return rowsOrPromise.filter((row) => !isReservedAuthUserId(row?.userId));
}
export function assertNotReservedAuthUserId(userId) {
    if (!isReservedAuthUserId(userId)) {
        return;
    }
    throw commandError("Reserved auth user ID cannot be used for a real Sporades user.", "Use runtime-generated user IDs for sessions and auth provider links.", "RESERVED_AUTH_USER_ID");
}
export function readEndpointSessionToken(headers, query) {
    return headers["x-sporades-session-token"] ?? null;
}
export function requireUserAuth(context, options = {}) {
    const linked = normalizeRequireUserAuthOptions(options).linked;
    const auth = context?.auth;
    if (auth?.isAuthenticated === true && (!linked || auth.isGuest !== true)) {
        return auth;
    }
    throw createUnauthenticatedError(createAuthDenialLogData(context, linked ? "linked" : "authenticated"));
}
/** @deprecated Use requireUserAuth for the synchronous inline Session check. */
export function requireAuth(context, options = {}) {
    if (typeof context === "function") {
        return decorateRequireAuth({}, context);
    }
    if (typeof options === "function") {
        return decorateRequireAuth(context, options);
    }
    return requireUserAuth(context, options);
}
function createUnauthenticatedError(logData = null) {
    const error = commandError("Unauthenticated.", "Sign in and retry the request.", "UNAUTHENTICATED");
    if (logData) {
        error.sporadesAuthDenialLogData = logData;
    }
    return error;
}
export function createAuthDenialLogData(context, requirement) {
    return {
        requirement,
        handler: {
            kind: context?.kind ?? null,
        },
        actor: {
            userId: context?.auth?.userId ?? null,
            provider: context?.auth?.provider ?? null,
            isAuthenticated: context?.auth?.isAuthenticated ?? null,
            isGuest: context?.auth?.isGuest ?? null,
        },
        ...accessKeyCredentialLogAttribution(context),
    };
}
export function emitAuthDeniedLog(database, details) {
    database.log?.emit?.({
        category: "platform",
        event: "auth.denied",
        level: "warn",
        message: "requireAuth denied an unauthenticated handler request.",
        data: details.data ?? null,
    });
}
export async function simulateLocalIdentitySession(database, options = {}) {
    const provider = String(options.provider ?? "").trim().toLowerCase();
    if (!["email", "google"].includes(provider)) {
        return {
            ok: false,
            data: null,
            error: {
                message: `Unsupported simulated auth provider: ${provider || ""}`.trim(),
                hint: "Use `sporades auth as email` for local identity simulation. Google simulation is reserved for provider-shaped browser tests.",
            },
        };
    }
    const email = normalizeSimulatedEmail(options.email);
    if (!email) {
        return {
            ok: false,
            data: null,
            error: {
                message: "Simulated identity requires an email address.",
                hint: "Pass `--email <address>` to `sporades auth as email`.",
            },
        };
    }
    const displayName = normalizeSimulatedText(options.displayName) ?? email;
    const picture = normalizeSimulatedText(options.picture);
    const now = new Date().toISOString();
    const token = createSessionToken();
    return await withAuthTransaction(database, async (tx) => {
        const subject = `local:${email}`;
        const identity = await tx.findAuthIdentityByProviderSubject(provider, subject);
        const userId = identity?.userId ?? nodeCryptoModule.randomUUID();
        if (identity) {
            await tx.updateAuthUserProfile({ id: userId, displayName, picture, isAuthenticated: 1, isGuest: 0 });
            await tx.updateAuthIdentity({
                id: identity.id,
                subject,
                email,
                displayName,
                picture,
                updatedAt: now,
            });
        }
        else {
            await tx.insertAuthUser({
                id: userId,
                createdAt: now,
                displayName,
                email,
                picture,
                isAuthenticated: 1,
                isGuest: 0,
                provider: "anonymous",
            });
            await tx.insertAuthIdentity({
                id: nodeCryptoModule.randomUUID(),
                userId,
                provider,
                subject,
                email,
                displayName,
                picture,
                createdAt: now,
                updatedAt: now,
            });
            await bootstrapInitialTeamForLinkedUser(tx, userId);
        }
        await tx.insertAuthSession({ token, userId, provider, createdAt: now, expiresAt: sessionExpiresAt(now) });
        const auth = {
            userId,
            displayName,
            email,
            picture,
            isAuthenticated: true,
            isGuest: false,
            provider,
        };
        return {
            ok: true,
            data: {
                localStorage: {
                    key: "sporades.sessionToken",
                    value: token,
                },
                auth,
            },
            error: null,
        };
    });
}
function normalizeSimulatedEmail(value) {
    const email = normalizeSimulatedText(value)?.toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return null;
    }
    return email;
}
export function normalizeSimulatedText(value) {
    if (value === null || value === undefined) {
        return null;
    }
    const text = String(value).trim();
    return text ? text : null;
}
export function parseOAuthFormBody(body) {
    const parameters = new URLSearchParams();
    let error = null;
    let stateTrustworthy = true;
    const invalidCallback = () => commandError("Invalid OAuth callback.", "Retry sign-in from the app.", "OAUTH_INVALID_CALLBACK");
    for (let start = 0; start <= body.length;) {
        let end = body.indexOf(0x26, start);
        if (end === -1)
            end = body.length;
        const separator = body.indexOf(0x3d, start);
        const hasSeparator = separator !== -1 && separator < end;
        const rawName = body.subarray(start, hasSeparator ? separator : end);
        const rawValue = body.subarray(hasSeparator ? separator + 1 : end, end);
        let name = null;
        let value = null;
        try {
            name = decodeOAuthFormComponent(rawName);
        }
        catch {
            stateTrustworthy = false;
            error ??= invalidCallback();
        }
        if (name !== null) {
            try {
                value = decodeOAuthFormComponent(rawValue);
            }
            catch {
                if (name === "state")
                    stateTrustworthy = false;
                error ??= invalidCallback();
            }
        }
        if (name !== null && value !== null) {
            parameters.append(name, value);
        }
        if (end === body.length)
            break;
        start = end + 1;
    }
    return { parameters, error, stateTrustworthy };
}
function decodeOAuthFormComponent(raw) {
    const bytes = [];
    for (let index = 0; index < raw.length; index += 1) {
        const byte = raw[index];
        if (byte === 0x2b) {
            bytes.push(0x20);
            continue;
        }
        if (byte === 0x25) {
            if (index + 2 >= raw.length)
                throw new Error("Malformed percent escape.");
            const pair = raw.subarray(index + 1, index + 3).toString("ascii");
            if (!/^[0-9a-fA-F]{2}$/.test(pair))
                throw new Error("Malformed percent escape.");
            bytes.push(Number.parseInt(pair, 16));
            index += 2;
            continue;
        }
        bytes.push(byte);
    }
    const value = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    validateOAuthCallbackScalar(value);
    return value;
}
function validateOAuthCallbackScalar(value) {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint <= 0x1f
            || (codePoint >= 0x7f && codePoint <= 0x9f)
            || codePoint === 0xfffd
            || (codePoint >= 0xfdd0 && codePoint <= 0xfdef)
            || (codePoint & 0xffff) === 0xfffe
            || (codePoint & 0xffff) === 0xffff) {
            throw new Error("Invalid callback character.");
        }
    }
}
export function validateConsumedOAuthCallbackParameters(parameters) {
    for (const name of ["code", "error", "user"]) {
        if (parameters.getAll(name).length > 1) {
            throw commandError("Invalid OAuth callback.", "Retry sign-in from the app.", "OAUTH_INVALID_CALLBACK");
        }
    }
    if (parameters.has("code") && parameters.has("error")) {
        throw commandError("Invalid OAuth callback.", "Retry sign-in from the app.", "OAUTH_INVALID_CALLBACK");
    }
    if (parameters.has("error") && parameters.has("user")) {
        throw commandError("Invalid OAuth callback.", "Retry sign-in from the app.", "OAUTH_INVALID_CALLBACK");
    }
}
export function normalizeReturnTo(returnTo, origin) {
    if (!returnTo) {
        return origin;
    }
    try {
        const url = new URL(returnTo, origin);
        if (url.origin !== origin) {
            return origin;
        }
        return url.toString();
    }
    catch {
        return origin;
    }
}
export function oauthProviderAdapter(database, provider) {
    if (database.__oauthProviderAdapters?.[provider]) {
        return database.__oauthProviderAdapters[provider];
    }
    const factories = {
        google: createGoogleOAuthProviderAdapter,
        facebook: createFacebookOAuthProviderAdapter,
        apple: createAppleOAuthProviderAdapter,
        microsoft: createMicrosoftOAuthProviderAdapter,
    };
    return factories[provider]?.(database) ?? null;
}
function isSupportedOAuthProvider(database, provider) {
    return ["google", "microsoft", "apple", "facebook"].includes(provider) || Boolean(database.__oauthProviderAdapters?.[provider]);
}
export function isOAuthLoopbackHostname(hostname) {
    if (typeof hostname !== "string")
        return false;
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return normalized === "127.0.0.1" || normalized === "::1";
}
export function oauthProviderTestEndpoint(override, productionUrl) {
    if (typeof override !== "string" || process.env.SPORADES_OAUTH_TEST_ENDPOINTS !== "1") {
        return productionUrl;
    }
    try {
        const url = new URL(override);
        if (!["http:", "https:"].includes(url.protocol) ||
            !isOAuthLoopbackHostname(url.hostname) ||
            url.username ||
            url.password ||
            url.hash) {
            return productionUrl;
        }
        return url.toString();
    }
    catch {
        return productionUrl;
    }
}
export async function fetchBoundedOAuthJson(database, url, request, policy) {
    const configuredTimeout = Number(database?.[policy.timeoutProperty]);
    const defaultTimeoutMs = Number.isFinite(policy.defaultTimeoutMs)
        ? Math.min(Math.max(Math.floor(policy.defaultTimeoutMs), 1), 10_000)
        : 5_000;
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 1 && configuredTimeout <= 10_000
        ? Math.floor(configuredTimeout)
        : defaultTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const signal = controller.signal;
    try {
        const response = await fetch(url, {
            ...request,
            redirect: "error",
            signal,
        });
        if (!response?.ok) {
            try {
                await response?.body?.cancel?.();
            }
            catch { /* response disposal is best effort */ }
            throw commandError(policy.unavailableMessage, policy.unavailableHint, policy.unavailableCode);
        }
        try {
            return await readBoundedJsonBody(response, policy.maxBytes);
        }
        catch (error) {
            if (error?.name === "AbortError" || signal.aborted) {
                throw commandError(policy.unavailableMessage, policy.unavailableHint, policy.unavailableCode);
            }
            throw commandError(policy.invalidMessage, policy.invalidHint, policy.invalidCode);
        }
    }
    catch (error) {
        if (error?.code === policy.unavailableCode || error?.code === policy.invalidCode)
            throw error;
        throw commandError(policy.unavailableMessage, policy.unavailableHint, policy.unavailableCode);
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function completeOpenIdOAuthCodeExchange(database, context, contract) {
    const timeoutMs = Number.isInteger(database?.__oauthExchangeTimeoutMs)
        ? Math.min(Math.max(database.__oauthExchangeTimeoutMs, 10), 30_000)
        : 10_000;
    const signal = AbortSignal.timeout(timeoutMs);
    const exchangeCode = contract.exchangeCode ?? "OAUTH_EXCHANGE_FAILED";
    const timeoutCode = contract.timeoutCode ?? "OAUTH_EXCHANGE_TIMEOUT";
    let tokenResponse;
    try {
        tokenResponse = await fetch(contract.tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(contract.parameters),
            redirect: "error",
            signal,
        });
    }
    catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        throw commandError(timedOut ? (contract.timeoutMessage ?? contract.exchangeMessage) : contract.exchangeMessage, contract.exchangeHint, timedOut ? timeoutCode : exchangeCode);
    }
    if (!tokenResponse.ok) {
        await tokenResponse.body?.cancel?.().catch?.(() => { });
        throw commandError(contract.exchangeMessage, contract.exchangeHint, exchangeCode);
    }
    let token;
    try {
        token = await readBoundedJsonResponse(tokenResponse, 64 * 1024);
    }
    catch (error) {
        const timedOut = signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError";
        throw commandError(timedOut ? (contract.timeoutMessage ?? contract.exchangeMessage) : contract.responseMessage, contract.exchangeHint, timedOut ? timeoutCode : exchangeCode);
    }
    if (typeof token.id_token !== "string" || token.id_token.length > 16 * 1024) {
        throw commandError(contract.tokenMessage, contract.tokenHint, "OAUTH_ID_TOKEN_INVALID");
    }
    return await contract.verify(database, token.id_token, context.nonce);
}
function createGoogleOAuthProviderAdapter(database) {
    const google = database.authConfig.providers.google;
    const configured = Boolean(google.enabled && google.configured);
    return {
        provider: "google",
        responseMode: "query",
        enabled: configured,
        begin(context) {
            const clientId = database.serverEnv[google.clientIdEnv];
            const params = new URLSearchParams({
                client_id: clientId,
                redirect_uri: context.redirectUri,
                response_type: "code",
                scope: "openid email profile",
                state: context.state,
                nonce: context.nonce,
                code_challenge: context.pkceChallenge,
                code_challenge_method: "S256",
            });
            return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
        },
        complete(context) {
            const clientId = database.serverEnv[google.clientIdEnv];
            const clientSecret = database.serverEnv[google.clientSecretEnv];
            return completeOpenIdOAuthCodeExchange(database, context, {
                tokenUrl: oauthProviderTestEndpoint(process.env.SPORADES_GOOGLE_TOKEN_URL, "https://oauth2.googleapis.com/token"),
                parameters: {
                    code: context.code,
                    client_id: clientId,
                    client_secret: clientSecret,
                    redirect_uri: context.redirectUri,
                    grant_type: "authorization_code",
                    code_verifier: context.pkceVerifier,
                },
                exchangeMessage: "Google OAuth code exchange failed.",
                exchangeHint: "Check the Google OAuth client configuration and retry sign-in.",
                responseMessage: "Google OAuth response was invalid.",
                tokenMessage: "Google OAuth response did not include a valid identity token.",
                tokenHint: "Check the Google OAuth client configuration and retry sign-in.",
                verify: verifyGoogleIdentityToken,
            });
        },
    };
}
function createAppleOAuthProviderAdapter(database) {
    const apple = database.authConfig.providers.apple;
    const configured = Boolean(apple.enabled && apple.configured);
    return {
        provider: "apple",
        responseMode: "form_post",
        enabled: configured,
        begin(context) {
            if (!appleOAuthOriginEligible(new URL(context.redirectUri).origin)) {
                throw commandError("Apple sign-in requires an HTTPS domain origin.", "Use an HTTPS development tunnel or a Hosted Capsule with an HTTPS domain.", "OAUTH_APPLE_HTTPS_ORIGIN_REQUIRED");
            }
            const params = new URLSearchParams({
                client_id: apple.clientId,
                redirect_uri: context.redirectUri,
                response_type: "code",
                response_mode: "form_post",
                scope: "name email",
                state: context.state,
                nonce: context.nonce,
            });
            return { url: `https://appleid.apple.com/auth/authorize?${params.toString()}` };
        },
        complete(context) {
            return completeAppleOAuth(database, context);
        },
    };
}
export function appleOAuthOriginEligible(origin) {
    try {
        const url = new URL(String(origin));
        const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (url.protocol !== "https:" || url.username || url.password || !hostname)
            return false;
        if (hostname === "localhost" || hostname.endsWith(".localhost"))
            return false;
        if (hostname.includes(":"))
            return false;
        if (/^\d+(?:\.\d+){3}$/.test(hostname))
            return false;
        const labels = hostname.split(".");
        return hostname.length <= 253 &&
            labels.length >= 2 &&
            labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
    }
    catch {
        return false;
    }
}
async function completeAppleOAuth(database, context) {
    const apple = database.authConfig.providers.apple;
    const tokenUrl = oauthProviderTestEndpoint(process.env.SPORADES_APPLE_TOKEN_URL, "https://appleid.apple.com/auth/token");
    let clientSecret;
    try {
        clientSecret = createAppleClientSecret(database);
    }
    catch {
        throw commandError("Apple client credential could not be generated.", "Check the Apple Team ID, Key ID, Services ID, and private key, then retry sign-in.", "OAUTH_CLIENT_CREDENTIAL_INVALID");
    }
    const identity = await completeOpenIdOAuthCodeExchange(database, context, {
        tokenUrl,
        parameters: {
            code: context.code,
            client_id: apple.clientId,
            client_secret: clientSecret,
            redirect_uri: context.redirectUri,
            grant_type: "authorization_code",
        },
        exchangeMessage: "Apple OAuth code exchange failed.",
        exchangeHint: "Check the Apple OAuth configuration and exact callback URL, then retry sign-in.",
        responseMessage: "Apple OAuth response was invalid.",
        tokenMessage: "Apple OAuth response did not include a valid identity token.",
        tokenHint: "Retry Apple sign-in.",
        verify: verifyAppleIdentityToken,
    });
    const authorizationUser = parseAppleAuthorizationUser(context.parameters?.get("user"));
    return {
        ...identity,
        displayName: authorizationUser?.displayName ?? null,
    };
}
export function createAppleClientSecret(database, nowSeconds = Math.floor(Date.now() / 1000)) {
    const apple = database.authConfig.providers.apple;
    const privateKey = database.serverEnv[apple.privateKeyEnv];
    if (!privateKey ||
        ![apple.clientId, apple.teamId, apple.keyId].every((value) => typeof value === "string" && /^[\x21-\x7e]{1,255}$/.test(value))) {
        throw commandError("Apple client credential is invalid.", "Configure a matching Apple Services ID, Team ID, Key ID, and unencrypted P-256 private key.", "OAUTH_CLIENT_CREDENTIAL_INVALID");
    }
    let signingKey;
    try {
        signingKey = nodeCryptoModule.createPrivateKey(privateKey);
    }
    catch {
        throw commandError("Apple client credential is invalid.", "Configure an unencrypted Apple P-256 private key in PKCS#8 PEM format.", "OAUTH_CLIENT_CREDENTIAL_INVALID");
    }
    if (signingKey.type !== "private" ||
        signingKey.asymmetricKeyType !== "ec" ||
        signingKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
        throw commandError("Apple client credential is invalid.", "Configure the unencrypted P-256 private key issued for Sign in with Apple.", "OAUTH_CLIENT_CREDENTIAL_INVALID");
    }
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: apple.keyId, typ: "JWT" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({
        iss: apple.teamId,
        iat: nowSeconds,
        exp: nowSeconds + 300,
        aud: "https://appleid.apple.com",
        sub: apple.clientId,
    })).toString("base64url");
    const signatureBytes = nodeCryptoModule.sign("sha256", Buffer.from(`${header}.${claims}`), { key: signingKey, dsaEncoding: "ieee-p1363" });
    if (signatureBytes.length !== 64) {
        throw commandError("Apple client credential is invalid.", "Configure the unencrypted P-256 private key issued for Sign in with Apple.", "OAUTH_CLIENT_CREDENTIAL_INVALID");
    }
    return `${header}.${claims}.${signatureBytes.toString("base64url")}`;
}
function createFacebookOAuthProviderAdapter(database) {
    const facebook = database.authConfig.providers.facebook;
    const graphVersion = facebook.graphVersion;
    const configured = Boolean(facebook.enabled &&
        facebook.configured &&
        facebook.runtimeAvailable &&
        graphVersion === "v23.0");
    return {
        provider: "facebook",
        responseMode: "query",
        enabled: configured,
        begin(context) {
            const clientId = database.serverEnv[facebook.clientIdEnv];
            if (typeof clientId !== "string" || clientId.length < 1 || clientId.length > 4096) {
                throw commandError("Facebook App ID is invalid.", "Configure a valid Facebook App ID and retry sign-in.", "FACEBOOK_CONFIGURATION_INVALID");
            }
            const params = new URLSearchParams({
                client_id: clientId,
                redirect_uri: context.redirectUri,
                response_type: "code",
                scope: "public_profile,email",
                state: context.state,
            });
            const authorizationUrl = facebookOAuthEndpoint(process.env.SPORADES_FACEBOOK_AUTH_URL, `https://www.facebook.com/${graphVersion}/dialog/oauth`);
            authorizationUrl.search = params.toString();
            if (authorizationUrl.toString().length > 8192) {
                throw commandError("Facebook authorization URL is too large.", "Check the Facebook App ID and callback configuration.", "FACEBOOK_CONFIGURATION_INVALID");
            }
            return { url: authorizationUrl.toString() };
        },
        callbackError(parameters) {
            return facebookOAuthCallbackError(parameters);
        },
        complete(context) {
            return completeFacebookOAuth(database, context);
        },
    };
}
function facebookOAuthCallbackError(parameters) {
    const reason = parameters.get("error_reason");
    const code = parameters.get("error_code");
    const description = parameters.get("error_description")?.toLowerCase() ?? "";
    if (reason === "user_denied" || code === "200") {
        return commandError("Facebook permissions were declined or are unavailable.", "Allow the requested public profile and email permissions, then retry sign-in.", "FACEBOOK_PERMISSION_DENIED");
    }
    if (code === "191") {
        return commandError("Facebook rejected the OAuth redirect URI.", "Register the exact Sporades callback URL in the Facebook app settings, then retry sign-in.", "FACEBOOK_REDIRECT_MISMATCH");
    }
    if (description.includes("development mode") ||
        description.includes("app is not set up") ||
        description.includes("app not set up") ||
        description.includes("app is not available")) {
        return commandError("Facebook sign-in is unavailable for this account.", "Check the Facebook app mode and tester access, then retry sign-in.", "FACEBOOK_APP_RESTRICTED");
    }
    return null;
}
function facebookOAuthEndpoint(configured, fallback) {
    const value = configured === undefined ? fallback : configured;
    if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
        throw commandError("Facebook OAuth endpoint is invalid.", "Use the built-in HTTPS Meta endpoint.", "FACEBOOK_ENDPOINT_UNSAFE");
    }
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw commandError("Facebook OAuth endpoint is invalid.", "Use the built-in HTTPS Meta endpoint.", "FACEBOOK_ENDPOINT_UNSAFE");
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    const insecureTestEndpoint = process.env.SPORADES_FACEBOOK_TEST_ALLOW_INSECURE_LOOPBACK === "1" &&
        url.protocol === "http:" &&
        loopback;
    if ((url.protocol !== "https:" && !insecureTestEndpoint) ||
        url.username ||
        url.password ||
        url.hash) {
        throw commandError("Facebook OAuth endpoint is unsafe.", "Use the built-in HTTPS Meta endpoint. Plain HTTP is limited to the explicit loopback test seam.", "FACEBOOK_ENDPOINT_UNSAFE");
    }
    return url;
}
function facebookOAuthTimeoutSignal() {
    const testTimeout = process.env.SPORADES_FACEBOOK_TEST_ALLOW_INSECURE_LOOPBACK === "1"
        ? Number(process.env.SPORADES_FACEBOOK_TEST_TIMEOUT_MS)
        : NaN;
    const timeoutMs = Number.isInteger(testTimeout) && testTimeout >= 10 && testTimeout <= 10_000
        ? testTimeout
        : 10_000;
    return AbortSignal.timeout(timeoutMs);
}
async function cancelFacebookOAuthResponse(response) {
    try {
        await response.body?.cancel();
    }
    catch {
        // Preserve the bounded protocol error rather than exposing cleanup details.
    }
}
async function readFacebookOAuthJson(response, signal, failureCode, failureMessage, failureHint, timeoutCode, timeoutMessage) {
    const reader = response.body?.getReader();
    if (!reader) {
        throw commandError(failureMessage, failureHint, failureCode);
    }
    const chunks = [];
    let length = 0;
    const aborted = {};
    let onAbort = null;
    const abort = signal.aborted
        ? Promise.resolve(aborted)
        : new Promise((resolve) => {
            onAbort = () => resolve(aborted);
            signal.addEventListener("abort", onAbort, { once: true });
        });
    try {
        while (true) {
            const next = await Promise.race([reader.read(), abort]);
            if (next === aborted)
                throw aborted;
            if (next.done)
                break;
            if (!(next.value instanceof Uint8Array))
                throw new Error("invalid chunk");
            length += next.value.byteLength;
            if (length > 64 * 1024) {
                throw new Error("response too large");
            }
            chunks.push(next.value);
        }
        return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    }
    catch (error) {
        try {
            await reader.cancel();
        }
        catch {
            // Preserve the bounded protocol error rather than exposing cleanup details.
        }
        if (error === aborted || signal.aborted) {
            throw commandError(timeoutMessage, failureHint, timeoutCode);
        }
        throw commandError(failureMessage, failureHint, failureCode);
    }
    finally {
        if (onAbort)
            signal.removeEventListener("abort", onAbort);
        try {
            reader.releaseLock();
        }
        catch {
            // Reader cleanup must not replace the bounded protocol outcome.
        }
    }
}
async function completeFacebookOAuth(database, context) {
    const facebook = database.authConfig.providers.facebook;
    const graphVersion = facebook.graphVersion;
    if (graphVersion !== "v23.0") {
        throw commandError("Facebook Graph API version is unsupported.", "Configure Facebook Graph API version v23.0 and retry sign-in.", "FACEBOOK_GRAPH_VERSION_UNSUPPORTED");
    }
    const clientId = database.serverEnv[facebook.clientIdEnv];
    const clientSecret = database.serverEnv[facebook.clientSecretEnv];
    if (typeof context.code !== "string" ||
        context.code.length < 1 ||
        context.code.length > 16 * 1024 ||
        typeof context.redirectUri !== "string" ||
        context.redirectUri.length < 1 ||
        context.redirectUri.length > 2048 ||
        typeof clientId !== "string" ||
        clientId.length < 1 ||
        clientId.length > 4096 ||
        typeof clientSecret !== "string" ||
        clientSecret.length < 1 ||
        clientSecret.length > 16 * 1024) {
        throw commandError("Facebook OAuth callback or configuration is invalid.", "Retry sign-in and check the Facebook App ID, App Secret, and callback configuration.", "FACEBOOK_CALLBACK_INVALID");
    }
    const tokenUrl = facebookOAuthEndpoint(process.env.SPORADES_FACEBOOK_TOKEN_URL, `https://graph.facebook.com/${graphVersion}/oauth/access_token`);
    let tokenResponse;
    const tokenSignal = facebookOAuthTimeoutSignal();
    try {
        tokenResponse = await fetch(tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                code: context.code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: context.redirectUri,
            }),
            redirect: "error",
            signal: tokenSignal,
        });
    }
    catch (error) {
        throw commandError(error?.name === "TimeoutError" || error?.name === "AbortError"
            ? "Facebook OAuth code exchange timed out."
            : "Facebook OAuth code exchange failed.", "Check the Facebook app credentials and exact callback URL, then retry sign-in.", error?.name === "TimeoutError" || error?.name === "AbortError"
            ? "FACEBOOK_EXCHANGE_TIMEOUT"
            : "FACEBOOK_EXCHANGE_FAILED");
    }
    if (!tokenResponse.ok) {
        await cancelFacebookOAuthResponse(tokenResponse);
        throw commandError("Facebook OAuth code exchange failed.", "Check the Facebook app credentials and exact callback URL, then retry sign-in.", "FACEBOOK_EXCHANGE_FAILED");
    }
    const token = await readFacebookOAuthJson(tokenResponse, tokenSignal, "FACEBOOK_EXCHANGE_FAILED", "Facebook OAuth response was invalid.", "Check the Facebook app configuration and retry sign-in.", "FACEBOOK_EXCHANGE_TIMEOUT", "Facebook OAuth response timed out.");
    if (typeof token?.access_token !== "string" || token.access_token.length < 1 || token.access_token.length > 16 * 1024) {
        throw commandError("Facebook OAuth response did not include a valid access token.", "Check the Facebook app configuration and retry sign-in.", "FACEBOOK_EXCHANGE_FAILED");
    }
    const graphUrl = facebookOAuthEndpoint(process.env.SPORADES_FACEBOOK_GRAPH_URL, `https://graph.facebook.com/${graphVersion}/me`);
    graphUrl.searchParams.set("fields", "id,name,email,picture");
    let graphResponse;
    const graphSignal = facebookOAuthTimeoutSignal();
    try {
        graphResponse = await fetch(graphUrl, {
            headers: { authorization: `Bearer ${token.access_token}` },
            redirect: "error",
            signal: graphSignal,
        });
    }
    catch (error) {
        throw commandError(error?.name === "TimeoutError" || error?.name === "AbortError"
            ? "Facebook profile request timed out."
            : "Facebook profile could not be loaded.", "Check Facebook Graph API access and retry sign-in.", error?.name === "TimeoutError" || error?.name === "AbortError"
            ? "FACEBOOK_GRAPH_TIMEOUT"
            : "FACEBOOK_GRAPH_FAILED");
    }
    if (!graphResponse.ok) {
        await cancelFacebookOAuthResponse(graphResponse);
        throw commandError("Facebook profile could not be loaded.", "Check Facebook Graph API access and retry sign-in.", "FACEBOOK_GRAPH_FAILED");
    }
    const profile = await readFacebookOAuthJson(graphResponse, graphSignal, "FACEBOOK_GRAPH_FAILED", "Facebook profile response was invalid.", "Check Facebook Graph API access and retry sign-in.", "FACEBOOK_GRAPH_TIMEOUT", "Facebook profile response timed out.");
    if (typeof profile?.id !== "string" || profile.id.length < 1 || profile.id.length > 255 || !/^[\x21-\x7e]+$/.test(profile.id)) {
        throw commandError("Facebook profile is missing a stable identifier.", "Retry Facebook sign-in. Sporades requires the Facebook profile id.", "FACEBOOK_PROFILE_ID_MISSING");
    }
    const email = typeof profile.email === "string" && profile.email.length <= 320
        ? profile.email.trim().toLowerCase() || null
        : null;
    const displayName = typeof profile.name === "string" && profile.name.length <= 512
        ? profile.name.trim() || null
        : null;
    const pictureCandidate = profile.picture?.data?.url;
    let picture = null;
    if (typeof pictureCandidate === "string" && pictureCandidate.length <= 2048) {
        try {
            const pictureUrl = new URL(pictureCandidate);
            if (pictureUrl.protocol === "https:" || pictureUrl.protocol === "http:") {
                picture = pictureUrl.toString();
            }
        }
        catch {
            picture = null;
        }
    }
    return {
        subject: profile.id,
        email,
        emailVerified: null,
        displayName,
        picture,
    };
}
export async function verifyGoogleIdentityToken(database, token, expectedNonce) {
    const parts = token.split(".");
    if (parts.length !== 3) {
        throw commandError("Google identity token was invalid.", "Retry Google sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    let header;
    let claims;
    try {
        header = JSON.parse(decodeJwtPart(parts[0]).toString("utf8"));
        claims = JSON.parse(decodeJwtPart(parts[1]).toString("utf8"));
    }
    catch {
        throw commandError("Google identity token was invalid.", "Retry Google sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
        throw commandError("Google identity token used an unsupported signature.", "Retry Google sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    const jwksUrl = oauthProviderTestEndpoint(process.env.SPORADES_GOOGLE_JWKS_URL, "https://www.googleapis.com/oauth2/v3/certs");
    let jwks;
    try {
        jwks = await fetchBoundedOAuthJson(database, jwksUrl, {}, {
            maxBytes: 64 * 1024,
            timeoutProperty: "__oauthJwksTimeoutMs",
            defaultTimeoutMs: 5_000,
            unavailableCode: "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE",
            unavailableMessage: "Google signing keys could not be loaded.",
            unavailableHint: "Retry Google sign-in.",
            invalidCode: "OAUTH_ID_TOKEN_KEYS_INVALID",
            invalidMessage: "Google signing keys were invalid.",
            invalidHint: "Retry Google sign-in.",
        });
    }
    catch (error) {
        if (error?.code === "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE" || error?.code === "OAUTH_ID_TOKEN_KEYS_INVALID")
            throw error;
        throw commandError("Google signing keys could not be loaded.", "Retry Google sign-in.", "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE");
    }
    const keys = isPlainJsonObject(jwks) && Array.isArray(jwks.keys) && jwks.keys.length <= 32 ? jwks.keys : null;
    if (!keys) {
        throw commandError("Google signing keys were invalid.", "Retry Google sign-in.", "OAUTH_ID_TOKEN_KEYS_INVALID");
    }
    const jwk = keys.find((candidate) => isPlainJsonObject(candidate) &&
        candidate.kid === header.kid &&
        candidate.kty === "RSA" &&
        typeof candidate.n === "string" &&
        typeof candidate.e === "string");
    if (!jwk) {
        throw commandError("Google identity token signing key was not recognized.", "Retry Google sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    let signatureValid = false;
    let signatureCheckFailed = false;
    try {
        signatureValid = nodeCryptoModule.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: jwk, format: "jwk" }, decodeJwtPart(parts[2]));
    }
    catch {
        signatureCheckFailed = true;
    }
    const clientId = database.serverEnv[database.authConfig.providers.google.clientIdEnv];
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const validIssuer = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
    const validSubject = typeof claims.sub === "string" &&
        claims.sub.length <= 255 &&
        /^[\x21-\x7e]+$/.test(claims.sub);
    const invalidCode = signatureCheckFailed ? "OAUTH_ID_TOKEN_SIGNATURE_CHECK_FAILED"
        : !signatureValid ? "OAUTH_ID_TOKEN_SIGNATURE_INVALID"
            : !validIssuer ? "OAUTH_ID_TOKEN_ISSUER_INVALID"
                : !audiences.includes(clientId) ? "OAUTH_ID_TOKEN_AUDIENCE_INVALID"
                    : typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000) ? "OAUTH_ID_TOKEN_EXPIRED"
                        : claims.nonce !== expectedNonce ? "OAUTH_ID_TOKEN_NONCE_INVALID"
                            : !validSubject ? "OAUTH_ID_TOKEN_SUBJECT_INVALID"
                                : null;
    if (invalidCode) {
        throw commandError("Google identity token failed verification.", "Retry Google sign-in.", invalidCode);
    }
    return {
        subject: claims.sub,
        email: normalizeSimulatedText(claims.email)?.toLowerCase() ?? null,
        emailVerified: claims.email_verified === true,
        displayName: normalizeSimulatedText(claims.name) ?? normalizeSimulatedText(claims.email) ?? "Google user",
        picture: normalizeSimulatedText(claims.picture),
    };
}
function createMicrosoftOAuthProviderAdapter(database) {
    const microsoft = database.authConfig.providers.microsoft;
    const configured = Boolean(microsoft.enabled && microsoft.configured);
    return {
        provider: "microsoft",
        responseMode: "query",
        enabled: configured,
        async begin(context) {
            const discovery = await discoverMicrosoftOpenIdConfiguration(database, microsoft.tenant);
            const clientId = database.serverEnv[microsoft.clientIdEnv];
            const params = new URLSearchParams({
                client_id: clientId,
                redirect_uri: context.redirectUri,
                response_type: "code",
                response_mode: "query",
                scope: "openid profile email",
                state: context.state,
                nonce: context.nonce,
                code_challenge: context.pkceChallenge,
                code_challenge_method: "S256",
            });
            return { url: `${discovery.authorization_endpoint}?${params.toString()}` };
        },
        complete(context) {
            return completeMicrosoftOAuth(database, context);
        },
    };
}
export async function discoverMicrosoftOpenIdConfiguration(database, tenant) {
    const selectedTenant = validMicrosoftTenant(tenant) ? tenant : null;
    if (!selectedTenant) {
        throw commandError("Microsoft tenant configuration is invalid.", "Use common, organizations, consumers, a tenant GUID, or a verified tenant domain.", "OAUTH_TENANT_INVALID");
    }
    const productionDiscoveryUrl = `https://login.microsoftonline.com/${encodeURIComponent(selectedTenant)}/v2.0/.well-known/openid-configuration`;
    const discoveryUrl = oauthProviderTestEndpoint(process.env.SPORADES_MICROSOFT_DISCOVERY_URL, productionDiscoveryUrl);
    const discoveryOverride = discoveryUrl !== productionDiscoveryUrl;
    let discoveryOrigin;
    try {
        const parsedDiscoveryUrl = new URL(discoveryUrl);
        const loopbackOverride = discoveryOverride &&
            parsedDiscoveryUrl.protocol === "http:" &&
            isOAuthLoopbackHostname(parsedDiscoveryUrl.hostname) &&
            !parsedDiscoveryUrl.username &&
            !parsedDiscoveryUrl.password &&
            !parsedDiscoveryUrl.hash;
        const microsoftDiscovery = !discoveryOverride &&
            parsedDiscoveryUrl.protocol === "https:" &&
            parsedDiscoveryUrl.hostname === "login.microsoftonline.com";
        if (!loopbackOverride && !microsoftDiscovery)
            throw new Error("untrusted discovery");
        discoveryOrigin = parsedDiscoveryUrl.origin;
    }
    catch {
        throw commandError("Microsoft OpenID discovery URL was invalid.", "Use the Microsoft identity platform discovery endpoint.", "OAUTH_DISCOVERY_INVALID");
    }
    const microsoft = database.authConfig.providers.microsoft;
    const cacheKey = microsoftOidcCacheKey([
        selectedTenant,
        discoveryUrl,
        microsoft.clientIdEnv ?? "",
        microsoft.clientSecretEnv ?? "",
    ]);
    const cacheRoot = microsoftOidcCache(database);
    const cache = cacheRoot.discovery;
    const now = microsoftOidcNow(database);
    pruneMicrosoftOidcCacheMap(cache, now, 32);
    let state = cache.get(cacheKey);
    if (!state || typeof state !== "object" || !Number.isInteger(state.nextGeneration)) {
        pruneMicrosoftOidcCacheMap(cache, now, 32, true);
        state = {
            value: null,
            expiresAt: 0,
            generation: 0,
            nextGeneration: 1,
            inflight: null,
            lastAccess: cacheRoot.nextAccess++,
        };
        if (cache.size >= 32) {
            throw commandError("Microsoft OpenID configuration could not be loaded.", "Retry Microsoft sign-in after other provider requests complete.", "OAUTH_DISCOVERY_UNAVAILABLE");
        }
        cache.set(cacheKey, state);
    }
    state.lastAccess = cacheRoot.nextAccess++;
    if (state.value && state.expiresAt > now)
        return state.value;
    if (state.inflight)
        return await state.inflight;
    const requestGeneration = state.nextGeneration++;
    const inflight = (async () => {
        const discovery = await fetchMicrosoftOidcJson(database, discoveryUrl, {}, {
            maxBytes: 64 * 1024,
            unavailableCode: "OAUTH_DISCOVERY_UNAVAILABLE",
            unavailableMessage: "Microsoft OpenID configuration could not be loaded.",
            unavailableHint: "Check Microsoft tenant selection and network access, then retry sign-in.",
            invalidCode: "OAUTH_DISCOVERY_INVALID",
            invalidMessage: "Microsoft OpenID configuration was invalid.",
            invalidHint: "Check Microsoft tenant selection and retry sign-in.",
        });
        const required = ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"];
        if (!isPlainRecord(discovery) ||
            !required.every((key) => typeof discovery[key] === "string" &&
                discovery[key].length > 0 &&
                discovery[key].length <= 2048)) {
            throw commandError("Microsoft OpenID configuration was invalid.", "Check Microsoft tenant selection and retry sign-in.", "OAUTH_DISCOVERY_INVALID");
        }
        try {
            const endpointUrls = ["authorization_endpoint", "token_endpoint", "jwks_uri"].map((key) => new URL(discovery[key]));
            const issuerUrl = new URL(String(discovery.issuer).replace("{tenantid}", "11111111-2222-3333-4444-555555555555"));
            const endpointsTrusted = discoveryOverride
                ? endpointUrls.every((url) => url.origin === discoveryOrigin)
                : endpointUrls.every((url) => url.protocol === "https:" && url.hostname === "login.microsoftonline.com");
            const issuerTrusted = issuerUrl.protocol === "https:" && issuerUrl.hostname === "login.microsoftonline.com";
            if (!endpointsTrusted || !issuerTrusted)
                throw new Error("untrusted endpoints");
        }
        catch {
            throw commandError("Microsoft OpenID configuration contained invalid endpoints.", "Check Microsoft tenant selection and retry sign-in.", "OAUTH_DISCOVERY_INVALID");
        }
        if (requestGeneration >= state.generation) {
            state.value = discovery;
            state.expiresAt = microsoftOidcNow(database) + 5 * 60 * 1000;
            state.generation = requestGeneration;
        }
        return state.value;
    })();
    state.inflight = inflight;
    try {
        return await inflight;
    }
    finally {
        if (state.inflight === inflight)
            state.inflight = null;
    }
}
export async function fetchMicrosoftOidcJson(database, url, request, policy) {
    return await fetchBoundedOAuthJson(database, url, request, {
        ...policy,
        timeoutProperty: "__microsoftOidcTimeoutMs",
        defaultTimeoutMs: 5_000,
    });
}
async function readBoundedJsonBody(response, maxBytes) {
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        try {
            await response.body?.cancel?.();
        }
        catch { /* response disposal is best effort */ }
        throw new Error("OIDC response exceeded its byte limit");
    }
    const reader = response.body?.getReader?.();
    if (!reader)
        throw new Error("OIDC response body was unavailable");
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            total += chunk.value.byteLength;
            if (total > maxBytes) {
                throw new Error("OIDC response exceeded its byte limit");
            }
            chunks.push(Buffer.from(chunk.value));
        }
    }
    catch (error) {
        try {
            await reader.cancel();
        }
        catch { /* response disposal is best effort */ }
        throw error;
    }
    finally {
        try {
            reader.releaseLock?.();
        }
        catch { /* response disposal is best effort */ }
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}
function microsoftOidcCache(database) {
    if (!database.__microsoftOidcCache ||
        !(database.__microsoftOidcCache.discovery instanceof Map) ||
        !(database.__microsoftOidcCache.jwks instanceof Map)) {
        database.__microsoftOidcCache = {
            discovery: new Map(),
            jwks: new Map(),
            nextAccess: 1,
        };
    }
    if (!Number.isSafeInteger(database.__microsoftOidcCache.nextAccess)) {
        database.__microsoftOidcCache.nextAccess = 1;
    }
    return database.__microsoftOidcCache;
}
function microsoftOidcNow(database) {
    return Number.isFinite(database.__microsoftOidcNowMs)
        ? Number(database.__microsoftOidcNowMs)
        : Date.now();
}
function microsoftOidcCacheKey(parts) {
    return JSON.stringify(parts);
}
function pruneMicrosoftOidcCacheMap(cache, now, maximumSize, reserveSlot = false) {
    for (const [key, state] of cache) {
        if (!state?.inflight && (!state?.value || !Number.isFinite(state.expiresAt) || state.expiresAt <= now)) {
            cache.delete(key);
        }
    }
    const targetSize = Math.max(0, maximumSize - (reserveSlot ? 1 : 0));
    while (cache.size > targetSize) {
        const candidates = [...cache.entries()]
            .filter(([, state]) => !state?.inflight)
            .sort(([leftKey, left], [rightKey, right]) => {
            const accessDifference = Number(left?.lastAccess ?? 0) - Number(right?.lastAccess ?? 0);
            return accessDifference || leftKey.localeCompare(rightKey);
        });
        if (candidates.length === 0)
            break;
        cache.delete(candidates[0][0]);
    }
}
export async function completeMicrosoftOAuth(database, context) {
    const microsoft = database.authConfig.providers.microsoft;
    const discovery = await discoverMicrosoftOpenIdConfiguration(database, microsoft.tenant);
    const clientId = database.serverEnv[microsoft.clientIdEnv];
    const clientSecret = database.serverEnv[microsoft.clientSecretEnv];
    const token = await fetchMicrosoftOidcJson(database, discovery.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code: context.code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: context.redirectUri,
            grant_type: "authorization_code",
            code_verifier: context.pkceVerifier,
            scope: "openid profile email",
        }),
    }, {
        maxBytes: 64 * 1024,
        unavailableCode: "OAUTH_EXCHANGE_FAILED",
        unavailableMessage: "Microsoft OAuth code exchange failed.",
        unavailableHint: "Check the Microsoft client credentials, tenant, consent, and callback URI, then retry sign-in.",
        invalidCode: "OAUTH_EXCHANGE_FAILED",
        invalidMessage: "Microsoft OAuth response was invalid.",
        invalidHint: "Check the Microsoft client configuration and retry sign-in.",
    });
    if (!isPlainRecord(token)) {
        throw commandError("Microsoft OAuth response was invalid.", "Check the Microsoft client configuration and retry sign-in.", "OAUTH_EXCHANGE_FAILED");
    }
    if (typeof token.id_token !== "string" || token.id_token.length > 16 * 1024) {
        throw commandError("Microsoft OAuth response did not include a valid identity token.", "Check the Microsoft client configuration and retry sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    return await verifyMicrosoftIdentityToken(database, token.id_token, context.nonce, discovery);
}
export async function verifyMicrosoftIdentityToken(database, token, expectedNonce, discovery) {
    if (typeof token !== "string" || token.length > 16 * 1024 ||
        typeof expectedNonce !== "string" || expectedNonce.length < 1 || expectedNonce.length > 512 ||
        !isPlainRecord(discovery) ||
        typeof discovery.issuer !== "string" || discovery.issuer.length > 2048 ||
        typeof discovery.jwks_uri !== "string" || discovery.jwks_uri.length > 2048) {
        throw commandError("Microsoft identity token was invalid.", "Retry Microsoft sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        throw commandError("Microsoft identity token was invalid.", "Retry Microsoft sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    let header;
    let claims;
    let signature;
    try {
        header = parseMicrosoftJwtPart(parts[0], 2 * 1024);
        claims = parseMicrosoftJwtPart(parts[1], 12 * 1024);
        signature = decodeJwtPart(parts[2]);
        if (signature.length < 128 || signature.length > 1024)
            throw new Error("signature size");
    }
    catch {
        throw commandError("Microsoft identity token was invalid.", "Retry Microsoft sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    const visible = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
    const validAudience = typeof claims.aud === "string"
        ? visible(claims.aud, 512)
        : Array.isArray(claims.aud) &&
            claims.aud.length > 0 &&
            claims.aud.length <= 10 &&
            claims.aud.every((value) => visible(value, 512));
    const numericDate = (value) => Number.isSafeInteger(value) && value >= 0;
    const optionalNumericDate = (value) => value === undefined || numericDate(value);
    const optionalProfile = (value, max) => value === undefined || value === null || (typeof value === "string" && value.length <= max);
    const structurallyValid = header.alg === "RS256" &&
        visible(header.kid, 255) &&
        visible(claims.iss, 2048) &&
        validAudience &&
        numericDate(claims.exp) &&
        optionalNumericDate(claims.nbf) &&
        optionalNumericDate(claims.iat) &&
        visible(claims.nonce, 512) &&
        typeof claims.tid === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.tid) &&
        visible(claims.sub, 255) &&
        optionalProfile(claims.email, 1024) &&
        optionalProfile(claims.name, 1024) &&
        optionalProfile(claims.preferred_username, 1024);
    if (!structurallyValid) {
        throw commandError("Microsoft identity token was invalid.", "Retry Microsoft sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    const jwk = await selectMicrosoftJwk(database, discovery, header.kid);
    let signatureValid = false;
    let signatureCheckFailed = false;
    try {
        signatureValid = nodeCryptoModule.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: jwk, format: "jwk" }, signature);
    }
    catch {
        signatureCheckFailed = true;
    }
    const microsoft = database.authConfig.providers.microsoft;
    const clientId = database.serverEnv[microsoft.clientIdEnv];
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const expectedIssuer = discovery.issuer.replace("{tenantid}", claims.tid);
    const expectedKeyIssuer = jwk.issuer.replace("{tenantid}", claims.tid);
    const nowSeconds = Math.floor(microsoftOidcNow(database) / 1000);
    const tenantAllowed = microsoftTenantAllowsClaims(microsoft.tenant, claims.tid, claims.iss, discovery.issuer);
    const invalidCode = signatureCheckFailed ? "OAUTH_ID_TOKEN_SIGNATURE_CHECK_FAILED"
        : !signatureValid ? "OAUTH_ID_TOKEN_SIGNATURE_INVALID"
            : claims.iss !== expectedIssuer ? "OAUTH_ID_TOKEN_ISSUER_INVALID"
                : expectedKeyIssuer !== claims.iss ? "OAUTH_ID_TOKEN_KEY_ISSUER_INVALID"
                    : !audiences.includes(clientId) ? "OAUTH_ID_TOKEN_AUDIENCE_INVALID"
                        : claims.exp <= nowSeconds ? "OAUTH_ID_TOKEN_EXPIRED"
                            : claims.nbf !== undefined && claims.nbf > nowSeconds + 60 ? "OAUTH_ID_TOKEN_NOT_YET_VALID"
                                : claims.iat !== undefined && claims.iat > nowSeconds + 5 * 60 ? "OAUTH_ID_TOKEN_ISSUED_AT_INVALID"
                                    : claims.nonce !== expectedNonce ? "OAUTH_ID_TOKEN_NONCE_INVALID"
                                        : !tenantAllowed ? "OAUTH_TENANT_REJECTED"
                                            : null;
    if (invalidCode) {
        const tenantFailure = invalidCode === "OAUTH_TENANT_REJECTED";
        throw commandError(tenantFailure ? "Microsoft account is not allowed by the configured tenant." : "Microsoft identity token failed verification.", tenantFailure ? "Use an account accepted by this Capsule's Microsoft tenant selection." : "Retry Microsoft sign-in.", invalidCode);
    }
    const email = normalizeSimulatedText(claims.email)?.toLowerCase() ?? null;
    return {
        subject: `${claims.tid.toLowerCase()}:${claims.sub}`,
        email,
        emailVerified: null,
        displayName: normalizeSimulatedText(claims.name) ?? normalizeSimulatedText(claims.preferred_username) ?? email ?? "Microsoft user",
        picture: null,
    };
}
export async function verifyAppleIdentityToken(database, token, expectedNonce) {
    if (typeof token !== "string" || token.length > 16 * 1024) {
        throw commandError("Apple identity token was invalid.", "Retry Apple sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
        throw commandError("Apple identity token was invalid.", "Retry Apple sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    let header;
    let claims;
    try {
        header = parseBoundedJwtObject(parts[0]);
        claims = parseBoundedJwtObject(parts[1]);
    }
    catch {
        throw commandError("Apple identity token was invalid.", "Retry Apple sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    if (header.alg !== "RS256" ||
        typeof header.kid !== "string" ||
        !/^[\x21-\x7e]{1,255}$/.test(header.kid) ||
        (header.typ !== undefined && header.typ !== "JWT")) {
        throw commandError("Apple identity token used an unsupported signature.", "Retry Apple sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    const jwksUrl = oauthProviderTestEndpoint(process.env.SPORADES_APPLE_JWKS_URL, "https://appleid.apple.com/auth/keys");
    let jwks;
    try {
        jwks = await fetchBoundedOAuthJson(database, jwksUrl, {}, {
            maxBytes: 64 * 1024,
            timeoutProperty: "__oauthJwksTimeoutMs",
            defaultTimeoutMs: 5_000,
            unavailableCode: "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE",
            unavailableMessage: "Apple signing keys could not be loaded.",
            unavailableHint: "Retry Apple sign-in.",
            invalidCode: "OAUTH_ID_TOKEN_KEYS_INVALID",
            invalidMessage: "Apple signing keys were invalid.",
            invalidHint: "Retry Apple sign-in.",
        });
    }
    catch (error) {
        if (error?.code === "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE" || error?.code === "OAUTH_ID_TOKEN_KEYS_INVALID")
            throw error;
        throw commandError("Apple signing keys could not be loaded.", "Retry Apple sign-in.", "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE");
    }
    const keys = isPlainJsonObject(jwks) && Array.isArray(jwks.keys) && jwks.keys.length <= 32 ? jwks.keys : null;
    if (!keys) {
        throw commandError("Apple signing keys were invalid.", "Retry Apple sign-in.", "OAUTH_ID_TOKEN_KEYS_INVALID");
    }
    const jwk = keys
        .find((candidate) => isPlainJsonObject(candidate) &&
        candidate.kid === header.kid &&
        candidate.kty === "RSA" &&
        candidate.use === "sig" &&
        candidate.alg === "RS256" &&
        typeof candidate.n === "string" &&
        typeof candidate.e === "string");
    if (!jwk) {
        throw commandError("Apple identity token signing key was not recognized.", "Retry Apple sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    let signatureValid = false;
    let signatureCheckFailed = false;
    try {
        signatureValid = nodeCryptoModule.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: jwk, format: "jwk" }, decodeJwtPart(parts[2]));
    }
    catch {
        signatureCheckFailed = true;
    }
    const clientId = database.authConfig.providers.apple.clientId;
    const audiences = typeof claims.aud === "string"
        ? [claims.aud]
        : Array.isArray(claims.aud) && claims.aud.length > 0 && claims.aud.length <= 8 && claims.aud.every((audience) => typeof audience === "string")
            ? claims.aud
            : [];
    const validSubject = typeof claims.sub === "string" &&
        claims.sub.length <= 255 &&
        /^[\x21-\x7e]+$/.test(claims.sub);
    const invalidCode = signatureCheckFailed ? "OAUTH_ID_TOKEN_SIGNATURE_CHECK_FAILED"
        : !signatureValid ? "OAUTH_ID_TOKEN_SIGNATURE_INVALID"
            : typeof claims.iss !== "string" || claims.iss !== "https://appleid.apple.com" ? "OAUTH_ID_TOKEN_ISSUER_INVALID"
                : !audiences.includes(clientId) ? "OAUTH_ID_TOKEN_AUDIENCE_INVALID"
                    : !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000) ? "OAUTH_ID_TOKEN_EXPIRED"
                        : typeof claims.nonce !== "string" || claims.nonce !== expectedNonce ? "OAUTH_ID_TOKEN_NONCE_INVALID"
                            : !validSubject ? "OAUTH_ID_TOKEN_SUBJECT_INVALID"
                                : null;
    if (invalidCode) {
        throw commandError("Apple identity token failed verification.", "Retry Apple sign-in.", invalidCode);
    }
    return {
        subject: claims.sub,
        email: normalizeSimulatedEmail(claims.email),
        emailVerified: claims.email_verified === true || claims.email_verified === "true",
        displayName: null,
        picture: null,
    };
}
function parseBoundedJwtObject(value) {
    if (typeof value !== "string" || value.length > 12 * 1024)
        throw new Error("Invalid JWT part");
    const bytes = decodeJwtPart(value);
    if (bytes.length === 0 || bytes.length > 8 * 1024)
        throw new Error("Invalid JWT part");
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!isPlainJsonObject(parsed))
        throw new Error("Invalid JWT object");
    return parsed;
}
async function readBoundedJsonResponse(response, maxBytes) {
    const contentLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel?.().catch?.(() => { });
        throw new Error("Response too large");
    }
    const chunks = [];
    let size = 0;
    if (response.body?.getReader) {
        const reader = response.body.getReader();
        try {
            while (true) {
                const result = await reader.read();
                if (result.done)
                    break;
                size += result.value.byteLength;
                if (size > maxBytes)
                    throw new Error("Response too large");
                chunks.push(Buffer.from(result.value));
            }
        }
        catch (error) {
            await reader.cancel().catch(() => { });
            throw error;
        }
        finally {
            reader.releaseLock();
        }
    }
    else {
        try {
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > maxBytes)
                throw new Error("Response too large");
            chunks.push(bytes);
        }
        catch (error) {
            await response.body?.cancel?.().catch?.(() => { });
            throw error;
        }
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isPlainJsonObject(parsed))
        throw new Error("Invalid JSON object");
    return parsed;
}
function isPlainJsonObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function parseAppleAuthorizationUser(value) {
    if (value === null || value === undefined || value === "")
        return null;
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 8 * 1024) {
        throw commandError("Apple authorization profile was invalid.", "Retry Apple sign-in.", "OAUTH_APPLE_PROFILE_INVALID");
    }
    let user;
    try {
        user = JSON.parse(value);
    }
    catch {
        throw commandError("Apple authorization profile was invalid.", "Retry Apple sign-in.", "OAUTH_APPLE_PROFILE_INVALID");
    }
    if (!user || typeof user !== "object" || Array.isArray(user) ||
        (user.name !== undefined && (!user.name || typeof user.name !== "object" || Array.isArray(user.name)))) {
        throw commandError("Apple authorization profile was invalid.", "Retry Apple sign-in.", "OAUTH_APPLE_PROFILE_INVALID");
    }
    const firstName = sanitizeAppleNamePart(user.name?.firstName);
    const lastName = sanitizeAppleNamePart(user.name?.lastName);
    const displayName = [firstName, lastName].filter(Boolean).join(" ") || null;
    return { displayName };
}
function sanitizeAppleNamePart(value) {
    if (value === null || value === undefined || value === "")
        return null;
    if (typeof value !== "string") {
        throw commandError("Apple authorization profile was invalid.", "Retry Apple sign-in.", "OAUTH_APPLE_PROFILE_INVALID");
    }
    const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!text)
        return null;
    if (text.length > 128) {
        throw commandError("Apple authorization profile was invalid.", "Retry Apple sign-in.", "OAUTH_APPLE_PROFILE_INVALID");
    }
    return text;
}
export async function loadMicrosoftJwks(database, discovery, forceRefresh = false, observedGeneration = null, missingKid = null) {
    const microsoft = database.authConfig.providers.microsoft;
    const cacheKey = microsoftOidcCacheKey([
        discovery.issuer,
        discovery.jwks_uri,
        microsoft.tenant ?? "",
        microsoft.clientIdEnv ?? "",
    ]);
    const cacheRoot = microsoftOidcCache(database);
    const cache = cacheRoot.jwks;
    const now = microsoftOidcNow(database);
    pruneMicrosoftOidcCacheMap(cache, now, 32);
    let state = cache.get(cacheKey);
    if (!state || typeof state !== "object" || !Number.isInteger(state.nextGeneration)) {
        pruneMicrosoftOidcCacheMap(cache, now, 32, true);
        state = {
            value: null,
            expiresAt: 0,
            generation: 0,
            nextGeneration: 1,
            inflight: null,
            inflightKind: null,
            missingKidCooldowns: new Map(),
            lastAccess: cacheRoot.nextAccess++,
        };
        if (cache.size >= 32) {
            throw commandError("Microsoft signing keys could not be loaded.", "Retry Microsoft sign-in after other provider requests complete.", "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE");
        }
        cache.set(cacheKey, state);
    }
    state.lastAccess = cacheRoot.nextAccess++;
    if (!(state.missingKidCooldowns instanceof Map))
        state.missingKidCooldowns = new Map();
    const rememberMissingKid = (jwks, missingKid, at) => {
        if (typeof missingKid !== "string")
            return;
        for (const [cachedKid, cooldown] of state.missingKidCooldowns) {
            if (!Number.isFinite(cooldown) || cooldown <= at)
                state.missingKidCooldowns.delete(cachedKid);
        }
        const found = Array.isArray(jwks?.keys) &&
            jwks.keys.some((value) => isPlainRecord(value) && value.kid === missingKid);
        state.missingKidCooldowns.delete(missingKid);
        if (!found)
            state.missingKidCooldowns.set(missingKid, at + 10_000);
        while (state.missingKidCooldowns.size > 64) {
            state.missingKidCooldowns.delete(state.missingKidCooldowns.keys().next().value);
        }
    };
    if (forceRefresh) {
        if (Number.isInteger(observedGeneration) && state.generation !== observedGeneration && state.value) {
            rememberMissingKid(state.value, missingKid, now);
            return state.value;
        }
        const cooldownUntil = state.missingKidCooldowns.get(missingKid);
        if (state.value && Number.isFinite(cooldownUntil) && cooldownUntil > now)
            return state.value;
    }
    else if (state.value && state.expiresAt > now) {
        return state.value;
    }
    if (state.inflight) {
        const sharedInflight = state.inflight;
        const sharedKind = state.inflightKind;
        const shared = await sharedInflight;
        if (!forceRefresh)
            return shared;
        if (sharedKind === "rollover") {
            rememberMissingKid(shared, missingKid, microsoftOidcNow(database));
            return shared;
        }
        if (Number.isInteger(observedGeneration) && state.generation !== observedGeneration) {
            rememberMissingKid(state.value, missingKid, microsoftOidcNow(database));
            return state.value;
        }
        const cooldownUntil = state.missingKidCooldowns.get(missingKid);
        if (state.value && Number.isFinite(cooldownUntil) && cooldownUntil > microsoftOidcNow(database))
            return state.value;
    }
    const requestGeneration = state.nextGeneration++;
    const requestKind = forceRefresh ? "rollover" : "load";
    const inflight = (async () => {
        const jwks = await fetchMicrosoftOidcJson(database, discovery.jwks_uri, {}, {
            maxBytes: 256 * 1024,
            unavailableCode: "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE",
            unavailableMessage: "Microsoft signing keys could not be loaded.",
            unavailableHint: "Retry Microsoft sign-in.",
            invalidCode: "OAUTH_ID_TOKEN_KEYS_INVALID",
            invalidMessage: "Microsoft signing keys were invalid.",
            invalidHint: "Retry Microsoft sign-in.",
        });
        if (!isPlainRecord(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length > 100) {
            throw commandError("Microsoft signing keys were invalid.", "Retry Microsoft sign-in.", "OAUTH_ID_TOKEN_KEYS_INVALID");
        }
        if (requestGeneration >= state.generation) {
            state.value = jwks;
            state.expiresAt = microsoftOidcNow(database) + 5 * 60 * 1000;
            state.generation = requestGeneration;
            if (requestKind === "load")
                state.missingKidCooldowns.clear();
            else
                rememberMissingKid(jwks, missingKid, microsoftOidcNow(database));
        }
        return state.value;
    })();
    state.inflight = inflight;
    state.inflightKind = requestKind;
    try {
        return await inflight;
    }
    finally {
        if (state.inflight === inflight) {
            state.inflight = null;
            state.inflightKind = null;
        }
    }
}
async function selectMicrosoftJwk(database, discovery, kid) {
    let jwks = await loadMicrosoftJwks(database, discovery, false);
    let candidate = jwks.keys.find((value) => isPlainRecord(value) && value.kid === kid);
    if (!candidate) {
        const microsoft = database.authConfig.providers.microsoft;
        const cacheKey = microsoftOidcCacheKey([
            discovery.issuer,
            discovery.jwks_uri,
            microsoft.tenant ?? "",
            microsoft.clientIdEnv ?? "",
        ]);
        const observedGeneration = microsoftOidcCache(database).jwks.get(cacheKey)?.generation ?? null;
        jwks = await loadMicrosoftJwks(database, discovery, true, observedGeneration, kid);
        candidate = jwks.keys.find((value) => isPlainRecord(value) && value.kid === kid);
    }
    if (!candidate) {
        throw commandError("Microsoft identity token signing key was not recognized.", "Retry Microsoft sign-in.", "OAUTH_ID_TOKEN_INVALID");
    }
    const valid = candidate.kty === "RSA" &&
        (candidate.alg === undefined || candidate.alg === "RS256") &&
        (candidate.use === undefined || candidate.use === "sig") &&
        typeof candidate.issuer === "string" &&
        candidate.issuer.length > 0 &&
        candidate.issuer.length <= 2048 &&
        typeof candidate.n === "string" &&
        /^[A-Za-z0-9_-]+$/.test(candidate.n) &&
        candidate.n.length >= 256 &&
        candidate.n.length <= 2048 &&
        typeof candidate.e === "string" &&
        /^[A-Za-z0-9_-]+$/.test(candidate.e) &&
        candidate.e.length >= 2 &&
        candidate.e.length <= 16;
    if (!valid) {
        throw commandError("Microsoft signing key was invalid.", "Retry Microsoft sign-in.", "OAUTH_ID_TOKEN_KEYS_INVALID");
    }
    return candidate;
}
function isPlainRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function parseMicrosoftJwtPart(value, maxBytes) {
    if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) + 4) {
        throw new Error("JWT segment exceeded its byte limit");
    }
    const decoded = decodeJwtPart(value);
    if (decoded.length > maxBytes)
        throw new Error("JWT segment exceeded its byte limit");
    const parsed = JSON.parse(decoded.toString("utf8"));
    if (!isPlainRecord(parsed))
        throw new Error("JWT segment was not an object");
    return parsed;
}
function microsoftTenantAllowsClaims(selectedTenant, tenantId, issuer, discoveredIssuer) {
    const consumerTenant = "9188040d-6c67-4c5b-b112-36a304b66dad";
    if (selectedTenant === "common")
        return true;
    if (selectedTenant === "organizations")
        return tenantId.toLowerCase() !== consumerTenant;
    if (selectedTenant === "consumers")
        return tenantId.toLowerCase() === consumerTenant;
    if (/^[0-9a-f-]{36}$/i.test(selectedTenant))
        return tenantId.toLowerCase() === selectedTenant.toLowerCase();
    return discoveredIssuer === issuer;
}
function validMicrosoftTenant(value) {
    if (["common", "organizations", "consumers"].includes(value))
        return true;
    if (typeof value !== "string" || value.length > 253)
        return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        return true;
    return /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(value);
}
function decodeJwtPart(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error("Invalid JWT encoding");
    }
    return Buffer.from(value, "base64url");
}
export function writeRedirect(response, location) {
    response.writeHead(302, { location });
    response.end();
}
// A same-origin absolute path, never a URL: the reset flow has no caller-supplied
// continue target, so it cannot be turned into an open redirect.
export function normalizePasswordResetPath(value) {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
        return null;
    }
    if (value.includes("\\") || value.includes("?") || value.includes("#")) {
        return null;
    }
    if (value.split("/").includes("..")) {
        return null;
    }
    return value;
}
function passwordResetCodeParts(database, requestedCode = null) {
    const [selector, verifier, ...rest] = typeof requestedCode === "string"
        ? requestedCode.split(".")
        : [nodeCryptoModule.randomBytes(16).toString("base64url"), nodeCryptoModule.randomBytes(32).toString("base64url")];
    if (!selector || !verifier || rest.length > 0 || !/^[A-Za-z0-9_-]{16,64}$/.test(selector) || !/^[A-Za-z0-9_-]{32,128}$/.test(verifier)) {
        throw commandError("Invalid password reset request.", "Request a new password reset link.", "INVALID_PASSWORD_RESET_REQUEST");
    }
    return {
        selector,
        verifier,
        code: `${selector}.${verifier}`,
        verifierHash: hashPasswordResetVerifier(verifier),
        now: database.clock.now(),
    };
}
export function hashPasswordResetVerifier(verifier) {
    return nodeCryptoModule.createHash("sha256").update(verifier).digest("base64url");
}
// Issuing does not invalidate outstanding codes, so a flood of reset requests
// cannot kill a link the user is about to click. The outstanding count is capped
// instead. Returns null when the account is already at the cap.
export async function issuePasswordResetCode(database, credential, requestedCode = null, allowRequestedCodeInsert = true) {
    const { selector, code, verifierHash, now } = passwordResetCodeParts(database, requestedCode);
    if (requestedCode) {
        const existing = await database.adapter.findPasswordResetCode(selector);
        if (existing && Date.parse(existing.expiresAt) > now.getTime()) {
            if (existing.email !== credential.email || existing.userId !== credential.userId || existing.verifierHash !== verifierHash) {
                throw commandError("Password reset request conflicted with existing state.", "Request a new password reset link.", "PASSWORD_RESET_REQUEST_CONFLICT");
            }
            const link = new URL(database.passwordResetConfig.path, database.passwordResetConfig.origin);
            link.searchParams.set("code", code);
            return { code, selector, link: link.toString(), expiresAt: existing.expiresAt };
        }
        // The request Job has already had a delivery attempt. A missing row can mean the code was spent
        // (or expired and pruned); it can also be a pre-insert storage failure. Later attempts no-op in
        // either case rather than recreating a selector/verifier a user may already have consumed.
        if (!allowRequestedCodeInsert)
            return null;
    }
    const expiresAt = new Date(now.getTime() + database.passwordResetConfig.ttlMs).toISOString();
    await database.adapter.prunePasswordResetCodes(now.toISOString());
    const outstanding = await database.adapter.countPasswordResetCodesForEmail(credential.email, now.toISOString());
    if (outstanding >= PASSWORD_RESET_MAX_OUTSTANDING_PER_EMAIL) {
        return null;
    }
    await database.adapter.insertPasswordResetCode({
        selector,
        verifierHash,
        email: credential.email,
        userId: credential.userId,
        createdAt: now.toISOString(),
        expiresAt,
    });
    const link = new URL(database.passwordResetConfig.path, database.passwordResetConfig.origin);
    link.searchParams.set("code", code);
    return { code, selector, link: link.toString(), expiresAt };
}
// The public request only enqueues a durable Job. The worker performs lookup and code creation, so
// an unregistered address completes successfully without a Reset row or an SMTP send. Keeping the
// opaque code stable in the Job payload makes retries resend one link rather than minting a new one.
export async function prepareEmailPasswordResetDelivery(database, payload, attempt = 1) {
    const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
    const credential = email ? await database.adapter.findEmailCredentialWithUser(email) : null;
    if (!credential)
        return null;
    const issued = await issuePasswordResetCode(database, credential, payload?.code ?? null, attempt === 1);
    if (!issued)
        return null;
    const body = passwordResetMailBody(issued.link);
    return {
        to: credential.email,
        subject: typeof payload?.subject === "string" ? payload.subject : "Reset your password",
        textBody: typeof payload?.textBody === "string" ? payload.textBody : body.textBody,
        htmlBody: typeof payload?.htmlBody === "string" ? payload.htmlBody : body.htmlBody,
    };
}
export async function createEmailPasswordResetLink(database, _session, email) {
    if (!database.authConfig.providers.email.enabled) {
        return { ok: false, error: emailAuthDisabledError() };
    }
    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!cleanEmail) {
        return { ok: false, error: { message: "Email is required.", hint: "Provide the email address for the account being reset." } };
    }
    const credential = await database.adapter.findEmailCredentialWithUser(cleanEmail);
    if (!credential) {
        return { ok: false, error: { message: "No email account found for that address.", hint: "Check the email address or register a new account." } };
    }
    const issued = await issuePasswordResetCode(database, credential);
    if (!issued) {
        return { ok: false, error: passwordResetLimitError() };
    }
    return { ok: true, link: issued.link, expiresAt: issued.expiresAt };
}
export function serverAuthError(error, fallback) {
    const failure = new Error(error?.message ?? fallback);
    if (error?.code)
        failure.code = error.code;
    if (error?.hint)
        failure.hint = error.hint;
    return failure;
}
function passwordResetLimitError() {
    return {
        code: "PASSWORD_RESET_LIMIT_REACHED",
        message: "Too many password reset links are already outstanding for this account.",
        hint: "Use the most recent reset link, or wait for the outstanding links to expire.",
    };
}
function invalidPasswordResetCodeError() {
    return {
        code: "INVALID_PASSWORD_RESET_CODE",
        message: "This password reset link is invalid or has expired.",
        hint: "Request a new password reset link.",
    };
}
// Unknown selector, wrong verifier, and expiry are deliberately indistinguishable,
// and the verifier comparison is constant-time so lookup timing does not leak
// which of those it was.
async function readPasswordResetCode(database, code) {
    const parts = typeof code === "string" ? code.split(".") : [];
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return null;
    }
    const row = await database.adapter.findPasswordResetCode(parts[0]);
    const expected = Buffer.from(row?.verifierHash ?? hashPasswordResetVerifier("\0absent"), "base64url");
    const actual = Buffer.from(hashPasswordResetVerifier(parts[1]), "base64url");
    const matches = actual.length === expected.length && nodeCryptoModule.timingSafeEqual(actual, expected);
    if (!row || !matches) {
        return null;
    }
    return database.clock.now().getTime() >= Date.parse(row.expiresAt) ? null : row;
}
export async function verifyPasswordResetCode(database, _session, code) {
    if (!database.authConfig.providers.email.enabled) {
        return { ok: false, error: emailAuthDisabledError() };
    }
    const row = await readPasswordResetCode(database, code);
    if (!row) {
        return { ok: false, error: invalidPasswordResetCodeError() };
    }
    return { ok: true, email: row.email };
}
export async function confirmPasswordReset(database, _session, code, newPassword) {
    if (!database.authConfig.providers.email.enabled) {
        return { ok: false, error: emailAuthDisabledError() };
    }
    if (typeof newPassword !== "string" || newPassword.length < 8) {
        return { ok: false, error: { message: "Password is too short.", hint: "Use a password with at least 8 characters." } };
    }
    // This preflight avoids performing an expensive scrypt for obviously bad
    // codes, but cannot authorize the change: another request may spend the
    // code before the Auth transaction starts.
    const preflight = await readPasswordResetCode(database, code);
    if (!preflight) {
        return { ok: false, error: invalidPasswordResetCodeError() };
    }
    const password = hashEmailPassword(newPassword);
    // Only this in-transaction validation and consumption authorize the
    // credential write. A second contender can have passed the preflight before
    // the first transaction commits, so its deletion result decides whether it
    // may continue.
    const outcome = await database.adapter.withTransaction(async (tx) => {
        const row = await readPasswordResetCode({ ...database, adapter: tx }, code);
        if (!row) {
            return { ok: false, error: invalidPasswordResetCodeError() };
        }
        const consumed = await tx.deletePasswordResetCode(row.selector);
        if (consumed?.changes !== 1) {
            return { ok: false, error: invalidPasswordResetCodeError() };
        }
        await tx.updateEmailCredentialPassword(row.email, password.hash, password.salt);
        // The selector-specific delete above authorizes this change. Once it has
        // succeeded, clear any sibling codes the user could otherwise still use.
        await tx.deletePasswordResetCodesForUser(row.userId);
        // Evicting every Session for the account is the point of the reset: an
        // attacker holding a live Session must not outlive the password change.
        await tx.deleteAuthSessionsForUser(row.userId);
        const revokedAccessKeys = await tx.bulkRevokeAccessKeysForOwner({
            ownerUserId: row.userId,
            revokedAt: database.clock.now().toISOString(),
            revocationCause: "password-reset",
        });
        return { ok: true, ownerUserId: row.userId, revokedAccessKeys };
    });
    if (!outcome.ok)
        return outcome;
    await emitAccessKeyOwnerTransitionAudits(database, {
        operation: "auth.confirmPasswordReset",
        ownerUserId: outcome.ownerUserId,
        actor: { kind: "password-reset-code" },
        revocationCause: "password-reset",
        records: outcome.revokedAccessKeys.records,
    });
    return { ok: true };
}
export function passwordResetMailBody(link) {
    return {
        textBody: "We received a request to reset your password.\n\n" +
            `Open this link to choose a new password:\n${link}\n\n` +
            "If you did not request this, you can ignore this message and your password will stay the same.\n",
        htmlBody: "<p>We received a request to reset your password.</p>" +
            `<p><a href="${escapeHtmlAttribute(link)}">Choose a new password</a></p>` +
            "<p>If you did not request this, you can ignore this message and your password will stay the same.</p>",
    };
}
function escapeHtmlAttribute(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export function mailNotConfiguredError() {
    return {
        code: "MAIL_NOT_CONFIGURED",
        message: "Password reset mail cannot be delivered because SMTP is not configured.",
        hint: "Set `mail.smtp` in sporades.json, or use ctx.serverAuth.createEmailPasswordResetLink with your own delivery path.",
    };
}
// Browser-facing password change. `setEmailPassword` is the trusted server-only
// API and deliberately accepts any registered email, so the ownership and
// re-authentication gates live here rather than there: a browser may only
// change the credential its own Session owns after proving knowledge of its
// current password. Non-existent and someone-else's emails share one opaque
// denial, so this cannot be used to discover which addresses have accounts.
export async function setOwnEmailPassword(database, session, email, currentPassword, newPassword) {
    let auth;
    try {
        auth = requireAuth({ ...session, kind: "message" }, { linked: true });
    }
    catch (error) {
        return { ok: false, error: { code: error?.code ?? "UNAUTHENTICATED", message: error.message, hint: error.hint } };
    }
    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    const credential = cleanEmail ? await database.adapter.findEmailCredentialWithUser(cleanEmail) : null;
    if (!credential || credential.userId !== auth.userId) {
        return { ok: false, error: emailNotOwnedError() };
    }
    const throttle = currentEmailSignInThrottleState(database, cleanEmail, session, PASSWORD_CHANGE_THROTTLE_FIELD);
    if (throttle.throttled) {
        return { ok: false, error: invalidCurrentPasswordError() };
    }
    if (typeof currentPassword !== "string" || !verifyEmailPassword(currentPassword, credential.passwordSalt, credential.passwordHash)) {
        recordFailedEmailSignInAttempt(database, cleanEmail, session, PASSWORD_CHANGE_THROTTLE_FIELD);
        return { ok: false, error: invalidCurrentPasswordError() };
    }
    resetEmailSignInAttempts(database, cleanEmail, session, PASSWORD_CHANGE_THROTTLE_FIELD);
    return await setEmailPassword(database, session, cleanEmail, newPassword);
}
function emailNotOwnedError() {
    return {
        code: "AUTH_EMAIL_NOT_OWNED",
        message: "That email address is not this account's email credential.",
        hint: "Change the password for the signed-in account, or use a password reset link.",
    };
}
function invalidCurrentPasswordError() {
    return {
        code: "INVALID_CURRENT_PASSWORD",
        message: "Current password is incorrect.",
        hint: "Enter the current password for this email credential, or use a password reset link.",
    };
}
export async function setEmailPassword(database, _session, email, newPassword) {
    if (!database.authConfig.providers.email.enabled) {
        return { ok: false, error: emailAuthDisabledError() };
    }
    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!cleanEmail) {
        return { ok: false, error: { message: "Email is required.", hint: "Provide the email address for the account whose password is being changed." } };
    }
    if (typeof newPassword !== "string" || newPassword.length < 8) {
        return { ok: false, error: { message: "Password is too short.", hint: "Use a password with at least 8 characters." } };
    }
    const existing = await database.adapter.findEmailCredentialWithUser(cleanEmail);
    if (!existing) {
        return { ok: false, error: { message: "No email account found for that address.", hint: "Check the email address or register a new account." } };
    }
    const password = hashEmailPassword(newPassword);
    await database.adapter.updateEmailCredentialPassword(cleanEmail, password.hash, password.salt);
    return { ok: true };
}
// Sign-in, password-change, and reset requests share this throttle shape but
// never share a bucket: one auth action must not lock out another.
function createEmailSignInThrottleState(database, scope = EMAIL_SIGN_IN_THROTTLE_FIELD) {
    const existing = database[scope];
    if (existing instanceof Map) {
        return existing;
    }
    const next = new Map();
    database[scope] = next;
    return next;
}
function emailSignInThrottleKeys(email, session) {
    return [`email\0${email}`, `caller\0${callerContextKey(session)}`];
}
export function currentEmailSignInThrottleState(database, email, session, scope = EMAIL_SIGN_IN_THROTTLE_FIELD) {
    const attempts = createEmailSignInThrottleState(database, scope);
    const now = Date.now();
    pruneEmailSignInThrottleState(attempts, now);
    const keys = emailSignInThrottleKeys(email, session);
    const entries = keys.map((key) => {
        const current = attempts.get(key);
        return {
            key,
            count: current?.count ?? 0,
            resetAt: current?.resetAt ?? now + EMAIL_SIGN_IN_THROTTLE_WINDOW_MS,
        };
    });
    return {
        throttled: entries.some((entry) => entry.count >= EMAIL_SIGN_IN_FAILURE_LIMIT),
        entries,
        count: Math.max(...entries.map((entry) => entry.count)),
        resetAt: Math.max(...entries.map((entry) => entry.resetAt)),
    };
}
export function recordFailedEmailSignInAttempt(database, email, session, scope = EMAIL_SIGN_IN_THROTTLE_FIELD) {
    const attempts = createEmailSignInThrottleState(database, scope);
    const current = currentEmailSignInThrottleState(database, email, session, scope);
    for (const entry of current.entries) {
        attempts.set(entry.key, {
            count: entry.count + 1,
            resetAt: entry.resetAt,
        });
    }
    boundEmailSignInThrottleState(attempts);
}
export function resetEmailSignInAttempts(database, email, session, scope = EMAIL_SIGN_IN_THROTTLE_FIELD) {
    const attempts = createEmailSignInThrottleState(database, scope);
    for (const key of emailSignInThrottleKeys(email, session)) {
        attempts.delete(key);
    }
}
function pruneEmailSignInThrottleState(attempts, now = Date.now()) {
    for (const [key, entry] of attempts) {
        if (!entry || now >= entry.resetAt) {
            attempts.delete(key);
        }
    }
}
function boundEmailSignInThrottleState(attempts) {
    while (attempts.size > EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES) {
        let evictionKey = null;
        let evictionPriority = Infinity;
        let oldestResetAt = Infinity;
        for (const [key, entry] of attempts) {
            const priority = emailSignInThrottleEvictionPriority(key, entry);
            const resetAt = Number(entry?.resetAt ?? 0);
            if (priority < evictionPriority || (priority === evictionPriority && resetAt < oldestResetAt)) {
                evictionPriority = priority;
                oldestResetAt = resetAt;
                evictionKey = key;
            }
        }
        if (evictionKey === null) {
            return;
        }
        attempts.delete(evictionKey);
    }
}
function emailSignInThrottleEvictionPriority(key, entry) {
    const throttled = Number(entry?.count ?? 0) >= EMAIL_SIGN_IN_FAILURE_LIMIT;
    if (key.startsWith("email\0") && throttled) {
        return 3;
    }
    if (key.startsWith("caller\0") && throttled) {
        return 2;
    }
    if (key.startsWith("email\0")) {
        return 1;
    }
    return 0;
}
function callerContextKey(session) {
    return String(session?.token ?? session?.auth?.userId ?? "anonymous");
}
export function invalidEmailCredentialsError(options = {}) {
    return {
        message: "Email or password is incorrect.",
        hint: "Check the credentials and try email sign-in again.",
        ...(options.code ? { code: options.code } : {}),
    };
}
export function normalizeEmailCredentials(credentials) {
    const email = String(credentials.email ?? "").trim().toLowerCase();
    const password = String(credentials.password ?? "");
    const name = credentials.name == null ? "" : String(credentials.name).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return {
            ok: false,
            error: {
                message: "Email address is invalid.",
                hint: "Pass credentials with a valid email address.",
            },
        };
    }
    if (password.length < 8) {
        return {
            ok: false,
            error: {
                message: "Password is too short.",
                hint: "Use a password with at least 8 characters.",
            },
        };
    }
    return { ok: true, email, password, name };
}
export function hashEmailPassword(password) {
    const salt = nodeCryptoModule.randomBytes(16).toString("base64url");
    const hash = nodeCryptoModule.scryptSync(password, salt, 64).toString("base64url");
    return { hash, salt };
}
export function verifyEmailPassword(password, salt, expectedHash) {
    const actual = nodeCryptoModule.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHash, "base64url");
    return actual.length === expected.length && nodeCryptoModule.timingSafeEqual(actual, expected);
}
export function emailAuthDisabledError() {
    return {
        message: "Email auth is not enabled.",
        hint: "Enable auth.providers.email in sporades.json.",
    };
}
export function sessionExpiresAt(from = new Date().toISOString()) {
    const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
    return new Date(Date.parse(from) + sessionLifetimeMs).toISOString();
}
function isExpiredSession(row) {
    return Date.parse(row.expiresAt) <= Date.now();
}
export function createSessionToken() {
    return nodeCryptoModule.randomBytes(32).toString("base64url");
}
export async function refreshSessionOnAdapter(sqlite, token) {
    const now = new Date().toISOString();
    const expiresAt = sessionExpiresAt(now);
    await sqlite.refreshAuthSession(token, expiresAt);
    return expiresAt;
}
export async function resolveAnonymousSession(database, sessionToken) {
    if (sessionToken) {
        const existing = await database.adapter.readAuthSessionWithUser(sessionToken);
        if (existing) {
            if (isExpiredSession(existing)) {
                await database.adapter.deleteAuthSession(sessionToken);
            }
            else {
                return sessionFromRow(existing);
            }
        }
    }
    const now = new Date().toISOString();
    const userId = nodeCryptoModule.randomUUID();
    const token = createSessionToken();
    await database.adapter.withTransaction(async (tx) => {
        await tx.insertAuthUser({
            id: userId,
            createdAt: now,
            displayName: "Anonymous",
            email: null,
            picture: null,
            isAuthenticated: 0,
            isGuest: 1,
            provider: "anonymous",
        });
        await tx.insertAuthSession({ token, userId, provider: "anonymous", createdAt: now, expiresAt: sessionExpiresAt(now) });
    });
    return {
        token,
        auth: {
            userId,
            displayName: "Anonymous",
            email: null,
            picture: null,
            isAuthenticated: false,
            isGuest: true,
            provider: "anonymous",
        },
    };
}
function sessionFromRow(row) {
    return {
        token: row.token,
        auth: {
            userId: row.userId,
            displayName: row.displayName,
            email: row.email,
            picture: row.picture,
            isAuthenticated: Boolean(row.isAuthenticated),
            isGuest: Boolean(row.isGuest),
            provider: row.provider,
        },
    };
}
export function authStatus(config, serverEnv) {
    const authConfig = config.auth ?? { mode: "anonymous" };
    const normalized = normalizeAuthConfig(authConfig);
    const providerOrder = ["anonymous", "email", "google", "microsoft", "apple", "facebook"];
    const runtimeProviders = new Set(["anonymous", "email", "google", "microsoft", "apple", "facebook"]);
    const providers = {};
    const port = typeof config.dev?.port === "number" ? config.dev.port : typeof config.deploy?.port === "number" ? config.deploy.port : 4000;
    for (const providerName of providerOrder) {
        const provider = normalized.providers[providerName];
        const credentialsConfigured = providerName === "anonymous" || providerName === "email"
            ? true
            : providerName === "apple"
                ? Boolean(provider.clientId && provider.teamId && provider.keyId && provider.privateKeyEnv && serverEnv[provider.privateKeyEnv])
                : Boolean(provider.clientIdEnv && provider.clientSecretEnv && serverEnv[provider.clientIdEnv] && serverEnv[provider.clientSecretEnv]);
        const configured = providerName === "facebook"
            ? credentialsConfigured && provider.graphVersion === "v23.0"
            : credentialsConfigured;
        const state = {
            enabled: provider.enabled,
            configured,
            runtimeAvailable: providerName === "facebook"
                ? Boolean(provider.enabled && configured)
                : runtimeProviders.has(providerName),
        };
        if (["google", "microsoft", "facebook"].includes(providerName)) {
            state.clientIdEnv = provider.clientIdEnv;
            state.clientSecretEnv = provider.clientSecretEnv;
        }
        if (providerName === "microsoft")
            state.tenant = provider.tenant;
        if (providerName === "facebook") {
            state.graphVersion = provider.graphVersion === "__invalid__" ? null : provider.graphVersion;
        }
        if (providerName === "apple") {
            state.clientId = provider.clientId;
            state.teamId = provider.teamId;
            state.keyId = provider.keyId;
            state.privateKeyEnv = provider.privateKeyEnv;
        }
        if (!["anonymous", "email"].includes(providerName)) {
            state.callbackPath = `/__sporades/auth/${providerName}/callback`;
            if (providerName === "apple") {
                state.callbackUrl = null;
                state.callbackGuidance = "Register this callback path on the Capsule's Hosted HTTPS origin, or use an HTTPS development tunnel.";
            }
            else {
                state.callbackUrl = port > 0 ? `http://localhost:${port}${state.callbackPath}` : null;
            }
        }
        providers[providerName] = state;
    }
    return {
        mode: normalized.mode,
        providers,
        google: {
            configured: providers.google.configured,
            clientIdEnv: normalized.providers.google.clientIdEnv,
            clientSecretEnv: normalized.providers.google.clientSecretEnv,
        },
    };
}
function normalizeAuthConfig(authConfig) {
    const providerConfig = authConfig.providers ?? {};
    for (const provider of Object.keys(providerConfig)) {
        if (!["anonymous", "email", "google", "microsoft", "apple", "facebook"].includes(provider)) {
            throw commandError(`Unsupported auth provider: ${provider}`, "Use supported auth providers: anonymous, email, google, microsoft, apple, facebook.");
        }
    }
    const googleConfig = readProviderConfig(providerConfig.google);
    const legacyGoogle = authConfig.google ?? {};
    const microsoftConfig = readProviderConfig(providerConfig.microsoft);
    const googleEnabled = googleConfig.enabled || authConfig.mode === "google";
    const emailConfig = readProviderConfig(providerConfig.email);
    const anonymousConfig = readProviderConfig(providerConfig.anonymous);
    const anonymousEnabled = providerConfig.anonymous === undefined ? true : anonymousConfig.enabled;
    const mode = authConfig.mode ?? (googleEnabled ? "google" : "anonymous");
    return {
        mode,
        providers: {
            anonymous: {
                enabled: anonymousEnabled,
                ...emptyProviderConfig(),
            },
            google: {
                ...emptyProviderConfig(),
                enabled: googleEnabled,
                clientIdEnv: googleConfig.clientIdEnv ?? legacyGoogle.clientIdEnv ?? null,
                clientSecretEnv: googleConfig.clientSecretEnv ?? legacyGoogle.clientSecretEnv ?? null,
            },
            email: {
                enabled: emailConfig.enabled,
                ...emptyProviderConfig(),
            },
            microsoft: {
                ...microsoftConfig,
                tenant: microsoftConfig.tenant ?? "common",
            },
            apple: readProviderConfig(providerConfig.apple),
            facebook: readFacebookProviderConfig(providerConfig.facebook),
        },
    };
}
function readProviderConfig(config) {
    if (config === true) {
        return { enabled: true, ...emptyProviderConfig() };
    }
    if (config === false || config === undefined || config === null) {
        return { enabled: false, ...emptyProviderConfig() };
    }
    return {
        enabled: config.enabled !== false,
        clientIdEnv: config.clientIdEnv ?? null,
        clientSecretEnv: config.clientSecretEnv ?? null,
        clientId: config.clientId ?? null,
        teamId: config.teamId ?? null,
        keyId: config.keyId ?? null,
        privateKeyEnv: config.privateKeyEnv ?? null,
        tenant: config.tenant ?? null,
        graphVersion: config.graphVersion === undefined
            ? null
            : typeof config.graphVersion === "string"
                ? config.graphVersion
                : "__invalid__",
    };
}
function readFacebookProviderConfig(config) {
    const normalized = readProviderConfig(config);
    if (!config || typeof config !== "object" || Array.isArray(config) || !Object.prototype.hasOwnProperty.call(config, "graphVersion")) {
        return { ...normalized, graphVersion: "v23.0" };
    }
    return normalized;
}
function emptyProviderConfig() {
    return { clientIdEnv: null, clientSecretEnv: null, clientId: null, teamId: null, keyId: null, privateKeyEnv: null, tenant: null, graphVersion: null };
}
export function authProvidersForClient(authConfig, origin = null) {
    const providers = {};
    for (const [name, provider] of Object.entries(authConfig.providers)) {
        providers[name] = {
            enabled: provider.enabled,
            configured: provider.configured,
            runtimeAvailable: provider.runtimeAvailable && (name !== "apple" || appleOAuthOriginEligible(origin)),
            ...(name === "facebook"
                ? { graphVersion: provider.graphVersion === "__invalid__" ? null : provider.graphVersion }
                : {}),
        };
    }
    return providers;
}
// ---------------------------------------------------------------------------------------------
// Batch 5: the sessions-and-sign-in region batch 3 had to leave behind.
//
// These seven are the ones `migrateAnonymousPreferences` was holding. `rotateSessionOnAdapter` and
// `moveSessionToUserOnAdapter` call it directly; the other five reach it through those two, so all
// seven moved the moment the user-preferences domain became a module this one may import. Every
// other name they need was already here — the reference graph over the monolith shows no outbound
// edge from any of them to anything outside this file and that module, which is why this batch's
// rider was seven functions rather than the "some, none or all" it was scoped as.
//
// **The count is seven, not the six the ticket says.** The ticket's prose names seven
// (`rotateSessionOnAdapter`, `moveSessionToUserOnAdapter`, `signInWithEmail`, `signUpWithEmail`,
// `linkProviderIdentity`, `rotateSession`, `moveSessionToUser`) while calling them six; batch 3's
// header arithmetic — six blocked on HTTP, one on `enqueueRuntimeJob`, seven here, fourteen in
// total — is the one that adds up.
//
// **Three are exported and four are private.** `signUpWithEmail` and `signInWithEmail` are called by
// `createWebSocketHub` and by the database-adapter and password-reset suites;
// `linkProviderIdentity` by `routeSporadesAuth`, which is still in the monolith behind the HTTP
// layer, and by three OAuth suites — which resolved it through the emitted function list until this
// batch and would have gone `undefined` rather than red. Exporting it is also what keeps
// `test/oauth-provider.test.js`'s "one internal completion and linking seam" assertion true.
//
// `rotateSessionOnAdapter` and `moveSessionToUserOnAdapter` are private because only the five above
// call them.
//
// **`rotateSession` and `moveSessionToUser` were a third and fourth private function here, and
// ticket 05 deleted them.** Batch 3 found that nothing in the repository named either one: they were
// reachable only by being entries in the emitted list, so making them private already dropped them
// from a deployed Capsule's top-level scope, and a repo-wide scan over `src/`, `test/`, `scripts/`
// and `docs/` returned nothing but the paragraph describing them. A migration batch must not change
// what ships, so they were reported and left standing; the deletion ticket removed the declarations
// too, along with `refreshSession`, which was dead in the same way.
// ---------------------------------------------------------------------------------------------
export async function signUpWithEmail(database, session, provider, credentials) {
    if (provider !== "email") {
        return {
            ok: false,
            error: {
                message: `Unsupported auth provider: ${provider ?? ""}`.trim(),
                hint: "Use auth.signUp with the email provider.",
            },
        };
    }
    if (!database.authConfig.providers.email.enabled) {
        return { ok: false, error: emailAuthDisabledError() };
    }
    const normalized = normalizeEmailCredentials(credentials);
    if (!normalized.ok) {
        return normalized;
    }
    if (await database.adapter.emailCredentialExists(normalized.email)) {
        return {
            ok: false,
            error: {
                message: "Email is already registered.",
                hint: "Use auth.signIn(\"email\", ...) with this email address.",
            },
        };
    }
    const password = hashEmailPassword(normalized.password);
    const displayName = normalized.name || normalized.email;
    const auth = {
        userId: session.auth.userId,
        displayName,
        email: normalized.email,
        picture: null,
        isAuthenticated: true,
        isGuest: false,
        provider: "email",
    };
    return await withAuthTransaction(database, async (tx) => {
        await tx.insertEmailCredential({
            email: normalized.email,
            userId: auth.userId,
            passwordHash: password.hash,
            passwordSalt: password.salt,
            createdAt: new Date().toISOString(),
        });
        await tx.linkAuthUser({
            id: auth.userId,
            displayName: auth.displayName,
            email: auth.email,
            picture: auth.picture,
            isAuthenticated: 1,
            isGuest: 0,
            provider: "email",
        });
        await bootstrapInitialTeamForLinkedUser(tx, auth.userId);
        return { ok: true, sessionToken: await rotateSessionOnAdapter(database, tx, session, auth.userId, "email"), auth };
    });
}
export async function signInWithEmail(database, session, credentials) {
    if (!database.authConfig.providers.email.enabled) {
        return { ok: false, error: emailAuthDisabledError() };
    }
    const normalized = normalizeEmailCredentials(credentials);
    if (!normalized.ok) {
        return normalized;
    }
    const throttle = currentEmailSignInThrottleState(database, normalized.email, session);
    if (throttle.throttled) {
        return { ok: false, error: invalidEmailCredentialsError({ code: "INVALID_EMAIL_CREDENTIALS" }) };
    }
    const row = await database.adapter.findEmailCredentialWithUser(normalized.email);
    if (!row || !verifyEmailPassword(normalized.password, row.passwordSalt, row.passwordHash)) {
        recordFailedEmailSignInAttempt(database, normalized.email, session);
        return { ok: false, error: invalidEmailCredentialsError() };
    }
    resetEmailSignInAttempts(database, normalized.email, session);
    const auth = {
        userId: row.userId,
        displayName: row.displayName,
        email: row.email,
        picture: row.picture,
        isAuthenticated: Boolean(row.isAuthenticated),
        isGuest: Boolean(row.isGuest),
        provider: "email",
    };
    return await withAuthTransaction(database, async (tx) => ({
        ok: true,
        sessionToken: await rotateSessionOnAdapter(database, tx, session, auth.userId, "email"),
        auth,
    }));
}
export async function linkProviderIdentity(database, session, provider, profile) {
    const subject = normalizeSimulatedText(profile.subject ?? profile.sub);
    const safeProvider = typeof provider === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)
        ? provider
        : "provider";
    const providerName = `${safeProvider[0].toUpperCase()}${safeProvider.slice(1)}`;
    if (!subject) {
        return {
            ok: false,
            error: {
                message: `${providerName} profile is missing a stable subject.`,
                hint: "Retry sign-in. Sporades requires a verified stable subject claim.",
            },
        };
    }
    return await withAuthTransaction(database, async (tx) => {
        let identity = await tx.findAuthIdentityByProviderSubject(provider, subject);
        const email = normalizeSimulatedText(profile.email)?.toLowerCase() ?? identity?.email ?? null;
        if (!identity && email && provider === "google") {
            const legacyIdentities = await tx.findLegacyAuthIdentitiesByProviderEmail(provider, email);
            if (legacyIdentities.length > 0 && profile.emailVerified !== true) {
                return {
                    ok: false,
                    error: {
                        code: "AUTH_LEGACY_IDENTITY_UNVERIFIED_EMAIL",
                        message: "Google did not verify the email needed to restore this legacy account.",
                        hint: "Use a Google account with a verified email address, or sign in with the account's existing authentication method.",
                    },
                };
            }
            if (legacyIdentities.length > 1) {
                return {
                    ok: false,
                    error: {
                        code: "AUTH_LEGACY_IDENTITY_AMBIGUOUS",
                        message: "Google email matches more than one legacy account.",
                        hint: "Sign in with an existing authentication method before linking this Google identity.",
                    },
                };
            }
            identity = legacyIdentities[0] ?? null;
        }
        // Decide only after legacy recovery. A pre-Teams Google account is already
        // linked even when its old identity must be recovered by verified email.
        const bootstrapInitialTeam = !identity && session.auth.isGuest;
        if (identity && !session.auth.isGuest && identity.userId !== session.auth.userId) {
            return {
                ok: false,
                error: {
                    code: "AUTH_IDENTITY_CONFLICT",
                    message: `${providerName} identity is already linked to another account.`,
                    hint: `Sign out before using this ${providerName} identity, or sign in with the account it is already linked to.`,
                },
            };
        }
        const displayName = normalizeSimulatedText(profile.displayName) ?? identity?.displayName ?? email ?? `${providerName} user`;
        const auth = {
            userId: identity?.userId ?? session.auth.userId,
            displayName,
            email,
            picture: profile.picture ?? null,
            isAuthenticated: true,
            isGuest: false,
            provider,
        };
        const now = new Date().toISOString();
        if (identity) {
            await tx.updateAuthIdentity({
                id: identity.id,
                subject,
                email,
                displayName: auth.displayName,
                picture: auth.picture,
                updatedAt: now,
            });
        }
        else {
            await tx.insertAuthIdentity({
                id: nodeCryptoModule.randomUUID(),
                userId: auth.userId,
                provider,
                subject,
                email,
                displayName: auth.displayName,
                picture: auth.picture,
                createdAt: now,
                updatedAt: now,
            });
        }
        await tx.linkAuthUser({
            id: auth.userId,
            displayName: auth.displayName,
            email: auth.email,
            picture: auth.picture,
            isAuthenticated: 1,
            isGuest: 0,
            provider,
        });
        if (bootstrapInitialTeam) {
            await bootstrapInitialTeamForLinkedUser(tx, auth.userId);
        }
        if (session.auth.isGuest && identity?.userId && identity.userId !== session.auth.userId) {
            await moveSessionToUserOnAdapter(database, tx, session, auth.userId, provider);
        }
        else {
            await tx.setAuthSessionProvider(session.token, provider);
            await refreshSessionOnAdapter(tx, session.token);
        }
        return { ok: true, auth };
    });
}
// Auth links and Session rotation are one transaction. SQLite permits only one
// active transaction per runtime connection, so serialize top-level Auth
// transactions here; persistent identity/bootstrap uniqueness remains the
// cross-runtime guard. A caller already inside a runtime transaction joins it.
async function withAuthTransaction(database, fn) {
    if (database.__transactionActive)
        return await fn(database.adapter);
    const root = database.__rootDatabase ?? database;
    const previous = root.__runtimeTransactionQueue ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => withAuthTransactionRetry(database.adapter, fn));
    root.__runtimeTransactionQueue = work;
    try {
        return await work;
    }
    finally {
        if (root.__runtimeTransactionQueue === work)
            root.__runtimeTransactionQueue = null;
    }
}
async function withAuthTransactionRetry(adapter, fn) {
    for (let attempt = 0;; attempt += 1) {
        try {
            return await adapter.withTransaction(fn);
        }
        catch (error) {
            if (attempt >= AUTH_TRANSACTION_RETRY_LIMIT - 1 || !isTransientAuthTransactionError(error))
                throw error;
            await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 10));
        }
    }
}
function isTransientAuthTransactionError(error) {
    const text = String(error?.message ?? error?.errstr ?? "").toLowerCase();
    const code = String(error?.code ?? "").toUpperCase();
    if (code === "23505" && error?.constraint === "sporades_auth_identities_provider_subject_key") {
        return true;
    }
    return (code === "ERR_SQLITE_ERROR" || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") &&
        (text.includes("locked") || text.includes("busy") || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED");
}
async function rotateSessionOnAdapter(database, sqlite, session, userId, provider = session.auth.provider) {
    const now = new Date().toISOString();
    const token = createSessionToken();
    await migrateAnonymousPreferences(database, session.auth, userId, sqlite);
    await sqlite.rotateAuthSession(session.token, { token, userId, provider, createdAt: now, expiresAt: sessionExpiresAt(now) });
    return token;
}
async function moveSessionToUserOnAdapter(database, sqlite, session, userId, provider = session.auth.provider) {
    const now = new Date().toISOString();
    await migrateAnonymousPreferences(database, session.auth, userId, sqlite);
    await sqlite.rotateAuthSession(session.token, {
        token: session.token,
        userId,
        provider,
        createdAt: now,
        expiresAt: sessionExpiresAt(now),
    });
}
// ---------------------------------------------------------------------------------------------
// Batch 8's riders. These five stood in `server-runtime-source.ts` until the HTTP layer left it,
// held there by four names that are now imports at the top of this file. They are this domain's —
// the OAuth callback route, the OAuth sign-in start, the callback parameter reader and its
// content-type check, and the password-reset link configuration — and they arrive unchanged.
//
// `routeSporadesAuth` is exported for the two servers and three OAuth suites;
// `beginOAuthSignIn` for three OAuth suites, which resolved it through
// `SERVER_RUNTIME_SOURCE_FUNCTIONS.find` until this batch and would have bound `undefined` rather
// than gone red; `resolvePasswordResetConfig` for `openDevDatabase`. The remaining two are private,
// because only the two above call them.
// ---------------------------------------------------------------------------------------------
export async function routeSporadesAuth(database, request, response) {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = requestUrl.pathname.match(/^\/__sporades\/auth\/([a-z0-9-]+)\/callback$/);
    if (!match) {
        return false;
    }
    const provider = match[1];
    if (!isSupportedOAuthProvider(database, provider)) {
        writeEndpointError(response, commandError("Unknown OAuth provider.", "Retry sign-in with a provider configured by this Capsule.", "OAUTH_UNKNOWN_PROVIDER"));
        return true;
    }
    let callbackParameters;
    try {
        callbackParameters = await readOAuthCallbackParameters(request, requestUrl);
    }
    catch (error) {
        writeEndpointError(response, error);
        return true;
    }
    const parameters = callbackParameters.parameters;
    const states = parameters.getAll("state");
    const state = states.length === 1 ? states[0] : null;
    if (!callbackParameters.stateTrustworthy || !state || states.length !== 1) {
        writeEndpointError(response, commandError("Invalid OAuth callback.", "Retry sign-in from the app.", "OAUTH_INVALID_CALLBACK"));
        return true;
    }
    const stateRow = await database.adapter.consumeOAuthState(state);
    if (!stateRow) {
        writeEndpointError(response, commandError("Invalid or already-used OAuth state.", "Retry sign-in from the app.", "OAUTH_INVALID_STATE"));
        return true;
    }
    try {
        if (callbackParameters.error) {
            throw callbackParameters.error;
        }
        validateConsumedOAuthCallbackParameters(parameters);
        if (stateRow.provider !== provider) {
            throw commandError("OAuth provider did not match the sign-in request.", "Retry sign-in from the app.", "OAUTH_PROVIDER_MISMATCH");
        }
        if (!stateRow.expiresAt || Date.parse(stateRow.expiresAt) <= Date.now()) {
            throw commandError("OAuth sign-in request expired.", "Retry sign-in from the app.", "OAUTH_STATE_EXPIRED");
        }
        const adapter = oauthProviderAdapter(database, provider);
        if (!adapter?.enabled) {
            throw commandError("OAuth provider is not configured.", "Configure the provider and retry sign-in.", "OAUTH_PROVIDER_NOT_CONFIGURED");
        }
        if ((adapter.responseMode === "form_post" && request.method !== "POST") ||
            (adapter.responseMode !== "form_post" && request.method !== "GET")) {
            throw commandError("OAuth callback used the wrong response mode.", "Retry sign-in from the app.", "OAUTH_RESPONSE_MODE_MISMATCH");
        }
        const providerError = parameters.get("error");
        if (providerError) {
            const mappedError = adapter.callbackError?.(parameters);
            if (mappedError) {
                throw mappedError;
            }
            const actionRequired = ["consent_required", "interaction_required", "login_required"].includes(providerError);
            const cancelled = ["access_denied", "user_cancelled", "user_cancelled_authorize"].includes(providerError);
            throw commandError(actionRequired
                ? "OAuth provider requires additional user action."
                : cancelled ? "OAuth sign-in was cancelled or declined." : "OAuth provider rejected the sign-in request.", actionRequired
                ? "Retry sign-in and complete the provider's consent or account prompt."
                : cancelled ? "Retry sign-in when you are ready." : "Check the provider credentials, tenant, and callback URI, then retry sign-in.", actionRequired ? "OAUTH_PROVIDER_ACTION_REQUIRED" : cancelled ? "OAUTH_PROVIDER_CANCELLED" : "OAUTH_PROVIDER_REJECTED");
        }
        const code = parameters.get("code");
        if (!code) {
            throw commandError("OAuth callback did not include an authorization code.", "Retry sign-in from the app.", "OAUTH_INVALID_CALLBACK");
        }
        const profile = await adapter.complete({
            provider,
            code,
            redirectUri: stateRow.redirectUri,
            nonce: stateRow.nonce,
            pkceVerifier: stateRow.pkceVerifier,
            parameters,
        });
        const session = await resolveAnonymousSession(database, stateRow.sessionToken);
        let result;
        try {
            result = await linkProviderIdentity(database, session, provider, profile);
        }
        catch {
            throw commandError("OAuth account linking failed.", "Retry sign-in. If the problem persists, check the database connection.", "AUTH_TRANSACTION_FAILED");
        }
        if (!result.ok) {
            throw commandError(result.error?.message, result.error?.hint ?? "Retry sign-in from the app.", result.error?.code);
        }
        writeRedirect(response, stateRow.returnTo);
    }
    catch (error) {
        writeEndpointError(response, error);
    }
    return true;
}
async function readOAuthCallbackParameters(request, requestUrl) {
    if (request.method === "GET") {
        return {
            parameters: requestUrl.searchParams,
            error: null,
            stateTrustworthy: true,
        };
    }
    if (request.method !== "POST" || !oauthFormContentTypeValid(request.headers["content-type"])) {
        throw commandError("Unsupported OAuth callback request.", "Retry sign-in from the app.", "OAUTH_INVALID_CALLBACK");
    }
    const body = await readLimitedRequestBody(request, 16 * 1024);
    return parseOAuthFormBody(body);
}
function oauthFormContentTypeValid(value) {
    const raw = singleHttpHeader(value);
    if (!raw)
        return false;
    const parts = raw.split(";").map((part) => part.trim());
    if (parts.shift()?.toLowerCase() !== "application/x-www-form-urlencoded")
        return false;
    if (parts.length === 0)
        return true;
    if (parts.length !== 1)
        return false;
    const match = parts[0].match(/^charset\s*=\s*(?:"utf-8"|utf-8)$/i);
    return Boolean(match);
}
export async function beginOAuthSignIn(database, session, provider, options) {
    const adapter = oauthProviderAdapter(database, provider);
    if (!adapter?.enabled) {
        return {
            ok: false,
            error: {
                code: "OAUTH_PROVIDER_NOT_CONFIGURED",
                message: `${provider || "OAuth"} provider is not configured.`,
                hint: provider === "google"
                    ? "Run `sporades auth set google --client-id <id> --client-secret <secret>` or `sporades auth set google --client-json <path>`."
                    : "Configure this OAuth provider before retrying sign-in.",
            },
        };
    }
    const origin = options.origin;
    if (!normalizeOrigin(origin) || normalizeOrigin(origin) !== origin) {
        return {
            ok: false,
            error: {
                code: "OAUTH_ORIGIN_INVALID",
                message: "OAuth sign-in requires a trusted request origin.",
                hint: "Use the Capsule origin directly, or configure SPORADES_PUBLIC_ORIGIN for a trusted HTTPS reverse proxy.",
            },
        };
    }
    if (provider === "apple" && !appleOAuthOriginEligible(origin)) {
        return {
            ok: false,
            error: {
                code: "OAUTH_APPLE_HTTPS_ORIGIN_REQUIRED",
                message: "Apple sign-in requires an HTTPS domain origin.",
                hint: "Use an HTTPS development tunnel or a Hosted Capsule with an HTTPS domain, then register its exact Apple callback URL.",
            },
        };
    }
    const redirectUri = `${origin}/__sporades/auth/${provider}/callback`;
    const returnTo = normalizeReturnTo(options.returnTo, origin);
    const state = nodeCryptoModule.randomBytes(32).toString("base64url");
    const nonce = nodeCryptoModule.randomBytes(32).toString("base64url");
    const pkceVerifier = nodeCryptoModule.randomBytes(48).toString("base64url");
    const pkceChallenge = nodeCryptoModule.createHash("sha256").update(pkceVerifier).digest("base64url");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    let started;
    try {
        started = await adapter.begin({
            provider,
            state,
            nonce,
            redirectUri,
            pkceChallenge,
            pkceChallengeMethod: "S256",
        });
    }
    catch {
        return {
            ok: false,
            error: {
                code: "OAUTH_PROVIDER_START_FAILED",
                message: "OAuth sign-in could not be started.",
                hint: "Check the provider configuration and retry sign-in.",
            },
        };
    }
    if (!started?.url) {
        return {
            ok: false,
            error: {
                code: "OAUTH_PROVIDER_START_FAILED",
                message: "OAuth provider did not return an authorization URL.",
                hint: "Check the provider configuration and retry sign-in.",
            },
        };
    }
    await database.adapter.insertOAuthState({
        state,
        provider,
        sessionToken: session.token,
        returnTo,
        redirectUri,
        createdAt: now,
        expiresAt,
        nonce,
        pkceVerifier,
    });
    return { ok: true, url: started.url };
}
// The reset link origin and page path come from Capsule configuration only.
// Deriving either from a request header would let an attacker who can reach the
// Capsule mail a victim a genuine reset link pointing at the attacker's server.
export function resolvePasswordResetConfig(config) {
    const passwordReset = config.auth?.email?.passwordReset ?? {};
    const port = typeof config.dev?.port === "number"
        ? config.dev.port
        : typeof config.deploy?.port === "number" ? config.deploy.port : 4000;
    const ttlMs = typeof passwordReset.ttlMs === "number" && Number.isFinite(passwordReset.ttlMs)
        ? Math.min(Math.max(passwordReset.ttlMs, PASSWORD_RESET_MIN_TTL_MS), PASSWORD_RESET_MAX_TTL_MS)
        : PASSWORD_RESET_DEFAULT_TTL_MS;
    return {
        path: normalizePasswordResetPath(passwordReset.path) ?? PASSWORD_RESET_DEFAULT_PATH,
        origin: normalizeOrigin(config.__sporadesPublicOrigin) ?? `http://localhost:${port}`,
        ttlMs,
    };
}
// ---------------------------------------------------------------------------------------------
// Batch 9's riders. The auth storage bootstrap: the five functions that declare this domain's own
// tables and migrate the ones an older database already has.
//
// They stood in `server-runtime-source.ts` through batch 3, and the reason is the one batch 6
// recorded for `createFileStorageTables` and batch 5 for `createUserPreferencesTables`. A domain's
// table bootstrap is called from exactly one place — the shared Database adapter method set, as
// `ensureAuthStorage()` — and that method set was still in the monolith. A migrated module may not
// import from the monolith, so these five could not follow the rest of auth out.
//
// Batch 9 is the batch that moves the method set, so they come home. `database-runtime.ts` imports
// `createAnonymousAuthTables` the same way it imports `createFileStorageTables` from storage and
// `createUserPreferencesTables` from preferences: the adapter delegates each domain's bootstrap to
// the module that owns those tables, and owns none of them itself. That is the seam this migration
// keeps finding rather than one batch 9 drew — three domains had already been split this way, and
// auth was the one still waiting for its caller to move.
//
// Only `createAnonymousAuthTables` is exported, because it is the only one the adapter calls. The
// other four are private — the OAuth state columns, the provider identity table and its legacy
// backfill, and the two session-column migrations — and each was an entry in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS` until this batch, because under the emitted list a helper of a
// registered function had to be registered too or it was a `ReferenceError` in a deployed Capsule.
//
// They arrive unchanged. `chainMaybePromise` is a new import at the top of this file; every other
// name they resolve was already here, `sessionExpiresAt` among them — which is the second reason
// this is where they belong rather than in the adapter module.
// ---------------------------------------------------------------------------------------------
// The one definition of the auth storage bootstrap, for every engine.
//
// Each step is chained rather than fired: on a synchronous engine that is the order the statements
// already ran in, and on an asynchronous one it is the difference between a sequence and a race.
// The unchained form worked on SQLite alone, which is why Postgres and libSQL each carried a copy
// that awaited the same statements in order.
//
// Kept outside any transaction by its caller. `addMissingColumn` tolerates a column that is
// already there, and on Postgres a swallowed duplicate-column error would abort the enclosing
// transaction and fail everything after it. The Postgres dialect asks the engine not to raise the
// error at all, but storage bootstrap still runs before the migration transaction opens; it has to
// stay there.
export function createAnonymousAuthTables(sqlite, authConfig = null) {
    const sql = sqlite.dialect.sql;
    return chainMaybePromise([
        () => sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_users] (" +
            "[id] TEXT PRIMARY KEY, " +
            "[createdAt] TEXT NOT NULL, " +
            "[displayName] TEXT NOT NULL, " +
            "[email] TEXT, " +
            "[picture] TEXT, " +
            "[isAuthenticated] INTEGER NOT NULL, " +
            "[isGuest] INTEGER NOT NULL, " +
            "[provider] TEXT NOT NULL" +
            ")")),
        () => createAccessKeyTables(sqlite),
        () => sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_sessions] (" +
            "[token] TEXT PRIMARY KEY, " +
            "[userId] TEXT NOT NULL, " +
            "[provider] TEXT NOT NULL, " +
            "[createdAt] TEXT NOT NULL, " +
            "[expiresAt] TEXT NOT NULL" +
            ")")),
        () => ensureSessionLifecycleColumns(sqlite),
        () => ensureSessionProvenanceColumn(sqlite),
        () => createProviderIdentityTables(sqlite),
        ...(authConfig?.providers?.email?.enabled
            ? [
                () => sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_email_credentials] (" +
                    "[email] TEXT PRIMARY KEY, " +
                    "[userId] TEXT NOT NULL, " +
                    "[passwordHash] TEXT NOT NULL, " +
                    "[passwordSalt] TEXT NOT NULL, " +
                    "[createdAt] TEXT NOT NULL" +
                    ")")),
                () => sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_password_reset_codes] (" +
                    "[selector] TEXT PRIMARY KEY, " +
                    "[verifierHash] TEXT NOT NULL, " +
                    "[email] TEXT NOT NULL, " +
                    "[userId] TEXT NOT NULL, " +
                    "[createdAt] TEXT NOT NULL, " +
                    "[expiresAt] TEXT NOT NULL" +
                    ")")),
            ]
            : []),
        () => sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_oauth_states] (" +
            "[state] TEXT PRIMARY KEY, " +
            "[provider] TEXT NOT NULL, " +
            "[sessionToken] TEXT NOT NULL, " +
            "[returnTo] TEXT NOT NULL, " +
            "[redirectUri] TEXT NOT NULL, " +
            "[createdAt] TEXT NOT NULL, " +
            "[expiresAt] TEXT NOT NULL, " +
            "[nonce] TEXT, " +
            "[pkceVerifier] TEXT" +
            ")")),
        () => ensureOAuthStateColumns(sqlite),
    ]);
}
function ensureOAuthStateColumns(sqlite) {
    const sql = sqlite.dialect.sql;
    return chainMaybePromise([
        ...[
            ["provider", "TEXT"],
            ["expiresAt", "TEXT"],
            ["nonce", "TEXT"],
            ["pkceVerifier", "TEXT"],
        ].map(([name, type]) => () => sqlite.dialect.addMissingColumn(sqlite, "sporades_auth_oauth_states", name, type)),
        () => sqlite.exec(sql("UPDATE [sporades_auth_oauth_states] SET [provider] = 'google' WHERE [provider] IS NULL")),
        () => sqlite.exec(sql("UPDATE [sporades_auth_oauth_states] SET [expiresAt] = [createdAt] WHERE [expiresAt] IS NULL")),
    ]);
}
function createProviderIdentityTables(sqlite) {
    const sql = sqlite.dialect.sql;
    return chainMaybePromise([
        () => sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_identities] (" +
            "[id] TEXT PRIMARY KEY, " +
            "[userId] TEXT NOT NULL, " +
            "[provider] TEXT NOT NULL, " +
            "[subject] TEXT NOT NULL, " +
            "[email] TEXT, " +
            "[displayName] TEXT, " +
            "[picture] TEXT, " +
            "[createdAt] TEXT NOT NULL, " +
            "[updatedAt] TEXT NOT NULL, " +
            "UNIQUE([provider], [subject])" +
            ")")),
        () => sqlite.exec(sql("INSERT INTO [sporades_auth_identities] " +
            "([id], [userId], [provider], [subject], [email], [displayName], [picture], [createdAt], [updatedAt]) " +
            "SELECT 'legacy:' || [id], [id], [provider], 'legacy:' || [id], [email], [displayName], [picture], " +
            "[createdAt], [createdAt] " +
            "FROM [sporades_auth_users] [u] WHERE [provider] = 'google' AND [id] != '__privileged__' " +
            "AND NOT EXISTS (SELECT 1 FROM [sporades_auth_identities] [i] " +
            "WHERE [i].[userId] = [u].[id] AND [i].[provider] = [u].[provider])")),
    ]);
}
// The backfill runs unconditionally rather than only when the column was just added. It was
// conditional because the `PRAGMA table_info` probe happened to say whether the ALTER had fired,
// and the probe is SQLite's alone; the predicate does the same work portably, because a session
// that already has an expiry has a non-null one.
function ensureSessionLifecycleColumns(sqlite) {
    return chainMaybePromise([
        () => sqlite.dialect.addMissingColumn(sqlite, "sporades_auth_sessions", "expiresAt", "TEXT"),
        () => sqlite
            .prepare(sqlite.dialect.sql("UPDATE [sporades_auth_sessions] SET [expiresAt] = ? WHERE [expiresAt] IS NULL"))
            .run(sessionExpiresAt(new Date().toISOString())),
    ]);
}
function ensureSessionProvenanceColumn(sqlite) {
    return chainMaybePromise([
        () => sqlite.dialect.addMissingColumn(sqlite, "sporades_auth_sessions", "provider", "TEXT"),
        () => sqlite.exec(sqlite.dialect.sql("UPDATE [sporades_auth_sessions] SET [provider] = " +
            "COALESCE([provider], (SELECT [provider] FROM [sporades_auth_users] " +
            "WHERE [id] = [sporades_auth_sessions].[userId]), 'anonymous') " +
            "WHERE [provider] IS NULL")),
    ]);
}
//# sourceMappingURL=auth-runtime.js.map