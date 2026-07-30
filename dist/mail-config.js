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
    if (!object(smtp.tls) || !onlyKeys(smtp.tls, ["mode", "rejectUnauthorized", "servername"])) {
        fail("Invalid SMTP TLS configuration.", "Set `mail.smtp.tls.mode` and optional `rejectUnauthorized` and `servername`; do not combine TLS modes or legacy secure flags.");
    }
    if (!["implicit", "required-starttls", "opportunistic", "disabled"].includes(smtp.tls.mode)) {
        fail("Invalid SMTP TLS mode.", "Use `implicit`, `required-starttls`, `opportunistic`, or `disabled`.");
    }
    if (smtp.tls.rejectUnauthorized !== undefined && typeof smtp.tls.rejectUnauthorized !== "boolean") {
        fail("Invalid SMTP TLS certificate policy.", "Set `mail.smtp.tls.rejectUnauthorized` to a boolean.");
    }
    if (smtp.tls.servername !== undefined
        && (typeof smtp.tls.servername !== "string"
            || smtp.tls.servername.length < 1
            || smtp.tls.servername.length > 253
            || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(smtp.tls.servername)
            || smtp.tls.servername.split(".").some((label) => label.length < 1 || label.length > 63 || label.startsWith("-") || label.endsWith("-")))) {
        fail("Invalid SMTP TLS server name.", "Set `mail.smtp.tls.servername` to the DNS name on the SMTP certificate, especially when `host` is an IP address.");
    }
    if (!object(smtp.auth) || !onlyKeys(smtp.auth, ["method", "usernameEnv", "passwordEnv"])) {
        fail("Invalid SMTP authentication configuration.", "Use `PLAIN` or `LOGIN` with Server env references, or exactly `{ \"method\": \"none\" }` for an explicit unauthenticated relay.");
    }
    if (smtp.auth.method === "none") {
        if (!onlyKeys(smtp.auth, ["method"])) {
            fail("Invalid SMTP authentication configuration.", "Set exactly `{ \"method\": \"none\" }` only for an explicitly trusted unauthenticated relay.");
        }
    }
    else {
        if (!["PLAIN", "LOGIN"].includes(smtp.auth.method)
            || typeof smtp.auth.usernameEnv !== "string"
            || typeof smtp.auth.passwordEnv !== "string") {
            fail("Invalid SMTP authentication configuration.", "Use `PLAIN` or `LOGIN` with both usernameEnv and passwordEnv.");
        }
        if (!envReference(smtp.auth.usernameEnv) || !envReference(smtp.auth.passwordEnv)) {
            fail("Invalid SMTP Server env reference.", "Use uppercase Server env key names without the reserved `SPORADES_` prefix.");
        }
    }
    if (["opportunistic", "disabled"].includes(smtp.tls.mode) && smtp.auth.method !== "none") {
        fail("SMTP plaintext delivery requires an explicit unauthenticated relay.", "Use required STARTTLS or implicit TLS with credentials; opportunistic and disabled TLS are allowed only with `{ \"auth\": { \"method\": \"none\" } }`.");
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