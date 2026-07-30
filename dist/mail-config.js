export function validateMailConfig(mail) {
    const fail = (message, hint) => {
        const error = new Error(message);
        error.code = "INVALID_MAIL_CONFIG";
        error.hint = hint;
        throw error;
    };
    const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    const onlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
    const envReference = (value) => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) && !value.startsWith("SPORADES_");
    if (mail === undefined)
        return;
    if (!object(mail) || !onlyKeys(mail, ["smtp"])) {
        fail("Invalid mail configuration.", "Set `mail.smtp` in sporades.json, or omit `mail` to disable delivery.");
    }
    const smtp = mail.smtp;
    if (!object(smtp) || !onlyKeys(smtp, ["vendor", "host", "port", "tls", "auth", "defaultFrom", "connectionTimeoutMs", "socketTimeoutMs"])) {
        fail("Invalid SMTP configuration.", "Configure only vendor, host, port, tls, auth, defaultFrom, connectionTimeoutMs, and socketTimeoutMs.");
    }
    if (typeof smtp.vendor !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(smtp.vendor)) {
        fail("Invalid SMTP vendor.", "Set `mail.smtp.vendor` to a lowercase provider identity such as `generic`.");
    }
    if (typeof smtp.host !== "string" || smtp.host.length < 1 || smtp.host.length > 253 || /[^\x21-\x7e]/.test(smtp.host)) {
        fail("Invalid SMTP host.", "Set `mail.smtp.host` to a non-empty DNS name or IP address.");
    }
    if (!Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65_535) {
        fail("Invalid SMTP port.", "Set `mail.smtp.port` to an integer from 1 through 65535.");
    }
    if (!object(smtp.tls) || !onlyKeys(smtp.tls, ["mode", "rejectUnauthorized"])) {
        fail("Invalid SMTP TLS configuration.", "Set `mail.smtp.tls.mode` and optional `rejectUnauthorized`; do not combine TLS modes or legacy secure flags.");
    }
    if (!["implicit", "required-starttls", "opportunistic", "disabled"].includes(smtp.tls.mode)) {
        fail("Invalid SMTP TLS mode.", "Use `implicit`, `required-starttls`, `opportunistic`, or `disabled`.");
    }
    if (smtp.tls.rejectUnauthorized !== undefined && typeof smtp.tls.rejectUnauthorized !== "boolean") {
        fail("Invalid SMTP TLS certificate policy.", "Set `mail.smtp.tls.rejectUnauthorized` to a boolean.");
    }
    if (!object(smtp.auth) || !onlyKeys(smtp.auth, ["method", "usernameEnv", "passwordEnv"])) {
        fail("Invalid SMTP authentication configuration.", "Set auth method plus usernameEnv and passwordEnv Server env references.");
    }
    if (typeof smtp.auth.method !== "string" || typeof smtp.auth.usernameEnv !== "string" || typeof smtp.auth.passwordEnv !== "string") {
        fail("Invalid SMTP authentication configuration.", "Use `PLAIN` or `LOGIN` with both usernameEnv and passwordEnv.");
    }
    if (!envReference(smtp.auth.usernameEnv) || !envReference(smtp.auth.passwordEnv)) {
        fail("Invalid SMTP Server env reference.", "Use uppercase Server env key names without the reserved `SPORADES_` prefix.");
    }
    if (!["PLAIN", "LOGIN"].includes(smtp.auth.method)) {
        fail("Invalid SMTP authentication configuration.", "Use `PLAIN` or `LOGIN` with both usernameEnv and passwordEnv.");
    }
    if (smtp.defaultFrom !== undefined && (typeof smtp.defaultFrom !== "string" || smtp.defaultFrom.length < 1 || smtp.defaultFrom.length > 320 || /[\r\n\0]/.test(smtp.defaultFrom))) {
        fail("Invalid SMTP default sender.", "Set `mail.smtp.defaultFrom` to one email address without control characters.");
    }
    const validateTimeout = (name, value, maximum, label) => {
        if (value !== undefined && (!Number.isInteger(value) || value < 100 || value > maximum)) {
            fail(`Invalid SMTP ${label} timeout.`, `Set \`mail.smtp.${name}\` to an integer from 100 through ${maximum} milliseconds.`);
        }
    };
    validateTimeout("connectionTimeoutMs", smtp.connectionTimeoutMs, 60_000, "connection");
    validateTimeout("socketTimeoutMs", smtp.socketTimeoutMs, 300_000, "socket");
}
//# sourceMappingURL=mail-config.js.map