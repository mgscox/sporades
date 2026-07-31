export function validateMailConfig(mail) {
    const fail = (message, hint) => {
        const error = new Error(message);
        error.code = "INVALID_MAIL_CONFIG";
        error.hint = hint;
        throw error;
    };
    const capture = (value, allowed, message, hint) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            fail(message, hint);
        const objectValue = value;
        const prototype = Object.getPrototypeOf(objectValue);
        if (prototype !== Object.prototype && prototype !== null)
            fail(message, hint);
        const entries = [];
        for (const key of Reflect.ownKeys(objectValue)) {
            if (typeof key !== "string")
                fail(message, hint);
            const stringKey = key;
            const descriptor = Object.getOwnPropertyDescriptor(objectValue, stringKey);
            if (!descriptor
                || !descriptor.enumerable
                || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
                fail(message, hint);
            }
            entries.push([stringKey, descriptor.value]);
        }
        if (entries.map(([key]) => key).filter((key) => !allowed.includes(key)).sort().length > 0) {
            fail(message, hint);
        }
        return new Map(entries);
    };
    const envReference = (value) => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) && !value.startsWith("SPORADES_");
    const optional = (target, name, value) => {
        if (value !== undefined)
            target[name] = value;
    };
    if (mail === undefined)
        return undefined;
    const mailData = capture(mail, ["smtp"], "Invalid mail configuration.", "Set `mail.smtp` in sporades.json, or omit `mail` to disable delivery.");
    const smtpData = capture(mailData.get("smtp"), ["vendor", "host", "port", "tls", "auth", "defaultFrom", "connectionTimeoutMs", "socketTimeoutMs"], "Invalid SMTP configuration.", "Configure only vendor, host, port, tls, auth, defaultFrom, connectionTimeoutMs, and socketTimeoutMs.");
    const vendor = smtpData.get("vendor");
    const host = smtpData.get("host");
    const port = smtpData.get("port");
    if (typeof vendor !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(vendor)) {
        fail("Invalid SMTP vendor.", "Set `mail.smtp.vendor` to a lowercase provider identity such as `generic`.");
    }
    if (typeof host !== "string" || host.length < 1 || host.length > 253 || /[^\x21-\x7e]/.test(host)) {
        fail("Invalid SMTP host.", "Set `mail.smtp.host` to a non-empty DNS name or IP address.");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        fail("Invalid SMTP port.", "Set `mail.smtp.port` to an integer from 1 through 65535.");
    }
    const tlsData = capture(smtpData.get("tls"), ["mode", "rejectUnauthorized", "servername"], "Invalid SMTP TLS configuration.", "Set `mail.smtp.tls.mode` and optional `rejectUnauthorized` and `servername`; do not combine TLS modes or legacy secure flags.");
    const tlsMode = tlsData.get("mode");
    const rejectUnauthorized = tlsData.get("rejectUnauthorized");
    const servername = tlsData.get("servername");
    if (!["implicit", "required-starttls", "opportunistic", "disabled"].includes(tlsMode)) {
        fail("Invalid SMTP TLS mode.", "Use `implicit`, `required-starttls`, `opportunistic`, or `disabled`.");
    }
    if (rejectUnauthorized !== undefined && typeof rejectUnauthorized !== "boolean") {
        fail("Invalid SMTP TLS certificate policy.", "Set `mail.smtp.tls.rejectUnauthorized` to a boolean.");
    }
    if (servername !== undefined
        && (typeof servername !== "string"
            || servername.length < 1
            || servername.length > 253
            || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(servername)
            || servername.split(".").some((label) => label.length < 1 || label.length > 63 || label.startsWith("-") || label.endsWith("-")))) {
        fail("Invalid SMTP TLS server name.", "Set `mail.smtp.tls.servername` to the DNS name on the SMTP certificate, especially when `host` is an IP address.");
    }
    const authData = capture(smtpData.get("auth"), ["method", "usernameEnv", "passwordEnv"], "Invalid SMTP authentication configuration.", "Use `PLAIN` or `LOGIN` with Server env references, or exactly `{ \"method\": \"none\" }` for an explicit unauthenticated relay.");
    const authMethod = authData.get("method");
    const usernameEnv = authData.get("usernameEnv");
    const passwordEnv = authData.get("passwordEnv");
    let auth;
    if (authMethod === "none") {
        if (authData.size !== 1) {
            fail("Invalid SMTP authentication configuration.", "Set exactly `{ \"method\": \"none\" }` only for an explicitly trusted unauthenticated relay.");
        }
        auth = { method: "none" };
    }
    else {
        if (!["PLAIN", "LOGIN"].includes(authMethod)
            || typeof usernameEnv !== "string"
            || typeof passwordEnv !== "string") {
            fail("Invalid SMTP authentication configuration.", "Use `PLAIN` or `LOGIN` with both usernameEnv and passwordEnv.");
        }
        if (!envReference(usernameEnv) || !envReference(passwordEnv)) {
            fail("Invalid SMTP Server env reference.", "Use uppercase Server env key names without the reserved `SPORADES_` prefix.");
        }
        auth = { method: authMethod, usernameEnv, passwordEnv };
    }
    if (["opportunistic", "disabled"].includes(tlsMode) && authMethod !== "none") {
        fail("SMTP plaintext delivery requires an explicit unauthenticated relay.", "Use required STARTTLS or implicit TLS with credentials; opportunistic and disabled TLS are allowed only with `{ \"auth\": { \"method\": \"none\" } }`.");
    }
    const defaultFrom = smtpData.get("defaultFrom");
    if (defaultFrom !== undefined && (typeof defaultFrom !== "string" || defaultFrom.length < 1 || defaultFrom.length > 320 || /[\r\n\0]/.test(defaultFrom))) {
        fail("Invalid SMTP default sender.", "Set `mail.smtp.defaultFrom` to one email address without control characters.");
    }
    const validateTimeout = (name, value, maximum, label) => {
        if (value !== undefined && (!Number.isInteger(value) || value < 100 || value > maximum)) {
            fail(`Invalid SMTP ${label} timeout.`, `Set \`mail.smtp.${name}\` to an integer from 100 through ${maximum} milliseconds.`);
        }
    };
    const connectionTimeoutMs = smtpData.get("connectionTimeoutMs");
    const socketTimeoutMs = smtpData.get("socketTimeoutMs");
    validateTimeout("connectionTimeoutMs", connectionTimeoutMs, 60_000, "connection");
    validateTimeout("socketTimeoutMs", socketTimeoutMs, 300_000, "socket");
    const tls = { mode: tlsMode };
    optional(tls, "rejectUnauthorized", rejectUnauthorized);
    optional(tls, "servername", servername);
    const smtp = { vendor, host, port, tls, auth };
    optional(smtp, "defaultFrom", defaultFrom);
    optional(smtp, "connectionTimeoutMs", connectionTimeoutMs);
    optional(smtp, "socketTimeoutMs", socketTimeoutMs);
    return { smtp };
}
//# sourceMappingURL=mail-config.js.map