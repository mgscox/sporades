import type { WithImplicitCoercion } from "buffer";
import type { BinaryLike } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
type LooseRecord = Record<string, any>;
export declare const PRIVILEGED_AUTH_USER_ID = "__privileged__";
export declare const EMAIL_SIGN_IN_FAILURE_LIMIT = 5;
export declare const EMAIL_SIGN_IN_THROTTLE_WINDOW_MS: number;
export declare const EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES = 256;
export declare const EMAIL_SIGN_IN_THROTTLE_FIELD = "__emailSignInThrottle";
export declare const PASSWORD_CHANGE_THROTTLE_FIELD = "__emailPasswordChangeThrottle";
export declare const PASSWORD_RESET_THROTTLE_FIELD = "__emailPasswordResetThrottle";
export declare const PASSWORD_RESET_DEFAULT_PATH = "/reset-password";
export declare const PASSWORD_RESET_DEFAULT_TTL_MS: number;
export declare const PASSWORD_RESET_MIN_TTL_MS: number;
export declare const PASSWORD_RESET_MAX_TTL_MS: number;
export declare const PASSWORD_RESET_MAX_OUTSTANDING_PER_EMAIL = 5;
export declare const PASSWORD_RESET_MAIL_JOB = "_sporades_password_reset_mail";
export declare const PASSWORD_RESET_REQUEST_JOB = "_sporades_password_reset_request";
export declare function privilegedAuthUserId(): string;
export declare function isReservedAuthUserId(userId: any): boolean;
export declare function authIdentityRowUnlessReserved(rowOrPromise: any): any;
export declare function authIdentityRowsUnlessReserved(rowsOrPromise: any): any;
export declare function assertNotReservedAuthUserId(userId: any): void;
export declare function readEndpointSessionToken(headers: {
    [x: string]: any;
}, query: {
    [x: string]: any;
    sessionToken?: any;
}): any;
export declare function requireUserAuth(context: LooseRecord, options?: LooseRecord): any;
/** @deprecated Use requireUserAuth for the synchronous inline Session check. */
export declare function requireAuth(context: LooseRecord, options?: LooseRecord): any;
export declare function emitAuthDeniedLog(database: LooseRecord, details: LooseRecord): void;
export declare function simulateLocalIdentitySession(database: LooseRecord, options?: LooseRecord): Promise<any>;
export declare function normalizeSimulatedText(value: null | undefined): string | null;
export declare function parseOAuthFormBody(body: Buffer): {
    parameters: URLSearchParams;
    error: any;
    stateTrustworthy: boolean;
};
export declare function validateConsumedOAuthCallbackParameters(parameters: URLSearchParams): void;
export declare function normalizeReturnTo(returnTo: string | URL, origin: string | URL | undefined): string | URL | undefined;
export declare function oauthProviderAdapter(database: LooseRecord, provider: string): any;
export declare function isOAuthLoopbackHostname(hostname: any): boolean;
export declare function oauthProviderTestEndpoint(override: any, productionUrl: string): string;
export declare function fetchBoundedOAuthJson(database: LooseRecord, url: string, request: LooseRecord, policy: LooseRecord): Promise<any>;
export declare function completeOpenIdOAuthCodeExchange(database: LooseRecord, context: LooseRecord, contract: LooseRecord): Promise<any>;
export declare function appleOAuthOriginEligible(origin: any): boolean;
export declare function createAppleClientSecret(database: LooseRecord, nowSeconds?: number): string;
export declare function verifyGoogleIdentityToken(database: LooseRecord, token: string, expectedNonce: string): Promise<{
    subject: any;
    email: string | null;
    emailVerified: boolean;
    displayName: string;
    picture: string | null;
}>;
export declare function discoverMicrosoftOpenIdConfiguration(database: LooseRecord, tenant: string): Promise<any>;
export declare function fetchMicrosoftOidcJson(database: LooseRecord, url: string, request: LooseRecord, policy: LooseRecord): Promise<any>;
export declare function completeMicrosoftOAuth(database: LooseRecord, context: LooseRecord): Promise<{
    subject: string;
    email: string | null;
    emailVerified: null;
    displayName: string;
    picture: null;
}>;
export declare function verifyMicrosoftIdentityToken(database: LooseRecord, token: string, expectedNonce: string, discovery: LooseRecord): Promise<{
    subject: string;
    email: string | null;
    emailVerified: null;
    displayName: string;
    picture: null;
}>;
export declare function verifyAppleIdentityToken(database: LooseRecord, token: string, expectedNonce: string): Promise<{
    subject: any;
    email: string | null;
    emailVerified: boolean;
    displayName: null;
    picture: null;
}>;
export declare function loadMicrosoftJwks(database: LooseRecord, discovery: LooseRecord, forceRefresh?: boolean, observedGeneration?: number | null, missingKid?: string | null): Promise<any>;
export declare function writeRedirect(response: {
    writeHead: (arg0: number, arg1: {
        location: any;
    }) => void;
    end: () => void;
}, location: any): void;
export declare function normalizePasswordResetPath(value: any): string | null;
export declare function hashPasswordResetVerifier(verifier: string): string;
export declare function issuePasswordResetCode(database: LooseRecord, credential: LooseRecord, requestedCode?: string | null, allowRequestedCodeInsert?: boolean): Promise<{
    code: string;
    selector: string;
    link: string;
    expiresAt: any;
} | null>;
export declare function prepareEmailPasswordResetDelivery(database: LooseRecord, payload: LooseRecord, attempt?: number): Promise<{
    to: any;
    subject: string;
    textBody: string;
    htmlBody: string;
} | null>;
export declare function createEmailPasswordResetLink(database: LooseRecord, _session: LooseRecord, email: string): Promise<{
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
    link?: undefined;
    expiresAt?: undefined;
} | {
    ok: boolean;
    link: string;
    expiresAt: any;
    error?: undefined;
}>;
export declare function serverAuthError(error: LooseRecord | undefined, fallback: string): Error & {
    code?: string;
    hint?: string;
};
export declare function verifyPasswordResetCode(database: LooseRecord, _session: LooseRecord, code: any): Promise<{
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
    email?: undefined;
} | {
    ok: boolean;
    email: any;
    error?: undefined;
}>;
export declare function confirmPasswordReset(database: LooseRecord, _session: LooseRecord, code: any, newPassword: string): Promise<any>;
export declare function passwordResetMailBody(link: string): {
    textBody: string;
    htmlBody: string;
};
export declare function mailNotConfiguredError(): {
    code: string;
    message: string;
    hint: string;
};
export declare function setOwnEmailPassword(database: LooseRecord, session: LooseRecord, email: string, currentPassword: string, newPassword: string): Promise<{
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
} | {
    ok: boolean;
    error?: undefined;
} | {
    ok: boolean;
    error: {
        code: any;
        message: any;
        hint: any;
    };
}>;
export declare function setEmailPassword(database: LooseRecord, _session: LooseRecord, email: string, newPassword: string): Promise<{
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
} | {
    ok: boolean;
    error?: undefined;
}>;
export declare function currentEmailSignInThrottleState(database: LooseRecord, email: string, session: LooseRecord, scope?: string): {
    throttled: boolean;
    entries: {
        key: string;
        count: any;
        resetAt: any;
    }[];
    count: number;
    resetAt: number;
};
export declare function recordFailedEmailSignInAttempt(database: LooseRecord, email: string, session: LooseRecord, scope?: string): void;
export declare function resetEmailSignInAttempts(database: LooseRecord, email: string, session: LooseRecord, scope?: string): void;
export declare function invalidEmailCredentialsError(options?: LooseRecord): {
    code?: any;
    message: string;
    hint: string;
};
export declare function normalizeEmailCredentials(credentials: {
    email: any;
    password: any;
    name: null;
}): {
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
    email?: undefined;
    password?: undefined;
    name?: undefined;
} | {
    ok: boolean;
    email: string;
    password: string;
    name: string;
    error?: undefined;
};
export declare function hashEmailPassword(password: BinaryLike): {
    hash: string;
    salt: string;
};
export declare function verifyEmailPassword(password: BinaryLike, salt: BinaryLike, expectedHash: WithImplicitCoercion<string>): boolean;
export declare function emailAuthDisabledError(): {
    message: string;
    hint: string;
};
export declare function sessionExpiresAt(from?: string): string;
export declare function createSessionToken(): string;
export declare function refreshSessionOnAdapter(sqlite: LooseRecord, token: any): Promise<string>;
export declare function resolveAnonymousSession(database: LooseRecord, sessionToken: string | null): Promise<{
    token: any;
    auth: {
        userId: any;
        displayName: any;
        email: any;
        picture: any;
        isAuthenticated: boolean;
        isGuest: boolean;
        provider: any;
    };
}>;
export declare function authStatus(config: LooseRecord, serverEnv: LooseRecord): {
    mode: any;
    providers: LooseRecord;
    google: {
        configured: any;
        clientIdEnv: any;
        clientSecretEnv: any;
    };
};
export declare function authProvidersForClient(authConfig: LooseRecord, origin?: any): LooseRecord;
export declare function signUpWithEmail(database: LooseRecord, session: LooseRecord, provider: string, credentials: any): Promise<any>;
export declare function signInWithEmail(database: LooseRecord, session: any, credentials: any): Promise<any>;
export declare function linkProviderIdentity(database: LooseRecord, session: LooseRecord, provider: string, profile: LooseRecord): Promise<any>;
export declare function routeSporadesAuth(database: LooseRecord, request: IncomingMessage, response: ServerResponse<IncomingMessage> & {
    req: IncomingMessage;
}): Promise<boolean>;
export declare function beginOAuthSignIn(database: LooseRecord, session: LooseRecord, provider: string, options: LooseRecord): Promise<{
    ok: boolean;
    error: {
        code: string;
        message: string;
        hint: string;
    };
    url?: undefined;
} | {
    ok: boolean;
    url: any;
    error?: undefined;
}>;
export declare function resolvePasswordResetConfig(config: LooseRecord): {
    path: string;
    origin: string;
    ttlMs: number;
};
export declare function createAnonymousAuthTables(sqlite: LooseRecord, authConfig?: LooseRecord | null): any;
export {};
//# sourceMappingURL=auth-runtime.d.ts.map