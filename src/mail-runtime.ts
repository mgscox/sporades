// The Capsule runtime's mail domain: SMTP delivery, MIME assembly, message normalization and the
// three provider profiles. Batch 2 of the migration ADR-0041 records — the region moved out of
// `server-runtime-source.ts` whole, and the bodies below are byte-identical to the ones that lived
// there, so what changed is where they live rather than what they do.
//
// **What is exported and what is not.** Twenty-five functions moved; four are exported and
// twenty-one are private. That is the property carrying a module whole buys: under the emitted list
// every one of the twenty-one had to be registered in `SERVER_RUNTIME_SOURCE_FUNCTIONS` or become a
// `ReferenceError` in a deployed Capsule, so "private" was not a thing this domain could be.
//
// The four, and who asks for each:
//
//   createMailRuntime    `openDevDatabase`, in the still-monolithic runtime
//   createMailTransport  `test/mail.test.js`, on the owned-transport boundary
//   connectSmtpSocket    `test/mail.test.js`, on TLS server-name forwarding
//   buildSmtpMessage     `test/mail.test.js`, throughout, as the MIME oracle
//
// A twenty-sixth function, `mailJsonSize`, was moved with the domain and exported for a reason that
// was not a consumer: it had no caller anywhere in the repository and reached the bundle only by
// being an entry in the emitted list, so leaving it private would have let esbuild tree-shake it out
// of the carried block and change the shipped artifact. Batch 2 exported it to keep that artifact
// byte-comparable across a no-behaviour-change refactor, and reported it as dead rather than
// deleting it there. It has since been deleted, and the artifact no longer carries it.
//
// Apart from those five `export` keywords and the four `crypto.randomUUID()` call sites explained
// next, the bodies below are byte-identical to lines 938-2086 of `server-runtime-source.ts` at
// 41230b5.
//
// **Why `node:crypto` is not imported here, and why there is no local alias for it either.** The
// emitted-list bundle carries this module as one esbuild IIFE (ADR-0041), and `format: "iife"`
// lowers a *static* external import to `__require("node:crypto")` — which is not defined in the ES
// module the block is spliced into, so the Capsule dies at boot rather than at build. So this module
// reaches the Web Crypto global, exactly as `server-runtime-source.ts` already does for the same
// generator.
//
// The obvious tidier spelling — `const randomUUID = () => crypto.randomUUID()` at the top, leaving
// the four call sites untouched — was written first and shipped a `ReferenceError` into a deployed
// Capsule. `bin/sporades.js` is the whole of `src/` bundled by esbuild, so a top-level `randomUUID`
// here collides with `server-runtime-source.ts`'s `import { randomUUID } from "node:crypto"` and
// esbuild renames one of them to `randomUUID2`. Every still-registered runtime function then travels
// into the emitted bundle as source text saying `randomUUID2`, while the bundle's hand-written
// preamble imports `randomUUID` — a free binding no build catches, because it only exists in
// `bin/`, and the container tests found it. Hence: no new top-level binding in a migrated module may
// share a name with anything `server-runtime-source.ts` imports.
//
// The three dynamic `await import(…)` calls below — `node:tls` twice, `node:net` once — need none of
// this treatment. esbuild emits a dynamic import of an external verbatim rather than lowering it to
// `require`, and a deployed Capsule resolves Node's builtins exactly as the bundle's own top-level
// imports do. That is the case ADR-0041 left untested, and the carrier's self-containment check was
// narrowed to say so.

type LooseRecord = Record<string, any>;
type RuntimeEnv = Record<string, string | undefined>;

function mailError(code: string, message: string, hint: string) {
  const error: any = new Error(message);
  error.code = code;
  error.hint = hint;
  return error;
}

export function createMailRuntime(mailConfig: any, serverEnv: RuntimeEnv, options: LooseRecord = {}) {
  const smtp = mailConfig?.smtp;
  if (!smtp) {
    return {
      enabled: false,
      async send() {
        throw mailError(
          "MAIL_DISABLED",
          "Mail delivery is disabled.",
          "Configure `mail.smtp` in sporades.json and restart the Capsule runtime.",
        );
      },
      close() {},
    };
  }

  let auth;
  if (smtp.auth.method === "none") {
    auth = { method: "none" };
  } else {
    const username = serverEnv[smtp.auth.usernameEnv];
    const password = serverEnv[smtp.auth.passwordEnv];
    if (typeof username !== "string" || typeof password !== "string") {
      throw mailError(
        "MAIL_CREDENTIAL_MISSING",
        "SMTP credentials are unavailable.",
        "Set the configured SMTP username and password keys in Server env, then restart the Capsule runtime.",
      );
    }
    auth = { method: smtp.auth.method, username, password };
  }
  const resolvedSmtp = {
    vendor: smtp.vendor,
    host: smtp.host,
    port: smtp.port,
    tls: {
      mode: smtp.tls.mode,
      rejectUnauthorized: smtp.tls.rejectUnauthorized !== false,
      servername: smtp.tls.servername,
    },
    auth,
    defaultFrom: smtp.defaultFrom,
    connectionTimeoutMs: smtp.connectionTimeoutMs ?? 10_000,
    socketTimeoutMs: smtp.socketTimeoutMs ?? 30_000,
  };
  const factory = options.mailTransportFactory ?? createMailTransport;
  const ownedTransportBoundary = factory === createMailTransport;
  const trustedTestTransportBoundary = options.mailTransportFactoryTrusted === true;
  const transport = factory(resolvedSmtp);
  if (!transport || typeof transport.send !== "function") {
    throw mailError("MAIL_CONNECTION_FAILED", "SMTP transport could not be created.", "Check the SMTP configuration and restart the Capsule runtime.");
  }
  let closeStarted = false;
  let closeResult: any;
  return {
    enabled: true,
    async send(input: any, deliveryLog: any = options.mailLog) {
      const message = normalizeMailMessage(input, resolvedSmtp.defaultFrom, resolvedSmtp.vendor);
      const messageIdentity = `mail_${crypto.randomUUID()}`;
      const startedAt = Date.now();
      try {
        const result = await transport.send(message);
        const normalizedResult = {
          messageId: String(result?.messageId ?? ""),
          accepted: Array.isArray(result?.accepted) ? result.accepted.map(String) : [],
          rejected: Array.isArray(result?.rejected) ? result.rejected.map(String) : [],
        };
        const resultCategory = normalizedResult.rejected.length > 0 ? "partial" : "accepted";
        try {
          await deliveryLog?.({
            category: "mail",
            event: "mail.delivery",
            level: "info",
            message: "SMTP delivery completed.",
            data: createMailDeliveryLogData(
              resolvedSmtp.vendor,
              message,
              messageIdentity,
              Date.now() - startedAt,
              resultCategory,
              normalizedResult,
            ),
            request: null,
            release: null,
            correlation: { mail: messageIdentity },
          });
        } catch {
          // Diagnostics must never turn a completed external side effect into
          // an apparent delivery failure that callers may retry.
        }
        return normalizedResult;
      } catch (error) {
        // Only Sporades-owned transport failures, or explicitly trusted
        // internal test doubles, may be inspected for classification. An
        // arbitrary injected value remains completely opaque.
        const normalizedError = ownedTransportBoundary
          ? error
          : trustedTestTransportBoundary
            ? normalizeMailTransportError(error)
            : mailError("MAIL_CONNECTION_FAILED", "SMTP delivery failed.", "Check the SMTP host, port, network access, and provider status.");
        try {
          await deliveryLog?.({
            category: "mail",
            event: "mail.delivery",
            level: "error",
            message: "SMTP delivery failed.",
            data: createMailDeliveryLogData(
              resolvedSmtp.vendor,
              message,
              messageIdentity,
              Date.now() - startedAt,
              normalizedError.code,
            ),
            request: null,
            release: null,
            correlation: { mail: messageIdentity },
          });
        } catch {
          // Preserve the stable mail failure even if diagnostics are unavailable.
        }
        throw normalizedError;
      }
    },
    close() {
      if (closeStarted) return closeResult;
      closeStarted = true;
      closeResult = transport.close?.();
      return closeResult;
    },
  };
}

function createMailDeliveryLogData(
  vendor: string,
  message: any,
  messageIdentity: string,
  latencyMs: number,
  result: string,
  delivery: any = undefined,
) {
  const to = Array.isArray(message?.to) ? message.to.length : 0;
  const cc = Array.isArray(message?.cc) ? message.cc.length : 0;
  const bcc = Array.isArray(message?.bcc) ? message.bcc.length : 0;
  return {
    vendor,
    messageIdentity,
    recipients: {
      to,
      cc,
      bcc,
      total: to + cc + bcc,
      accepted: Array.isArray(delivery?.accepted) ? delivery.accepted.length : 0,
      rejected: Array.isArray(delivery?.rejected) ? delivery.rejected.length : 0,
    },
    latencyMs: Math.max(0, Math.floor(Number(latencyMs) || 0)),
    result,
  };
}

function normalizeMailMessage(input: any, defaultFrom: any, vendor = "generic") {
  const invalid = (hint: string) => {
    throw mailError("INVALID_MAIL_MESSAGE", "Invalid mail message.", hint);
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Pass one mail message object.");
  const allowed = new Set(["to", "cc", "bcc", "from", "replyTo", "subject", "textBody", "htmlBody", "provider"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid(`Remove unsupported mail fields: ${unknown.sort().join(", ")}.`);
  const from = normalizeMailAddresses(input.from ?? defaultFrom, "from", false);
  if (from.length !== 1) invalid("Pass exactly one sender in `from`, or configure `mail.smtp.defaultFrom`.");
  const to = normalizeMailAddresses(input.to, "to", true);
  const cc = normalizeMailAddresses(input.cc, "cc", false);
  const bcc = normalizeMailAddresses(input.bcc, "bcc", false);
  if (to.length + cc.length + bcc.length === 0) invalid("Pass at least one recipient in `to`, `cc`, or `bcc`.");
  if (to.length + cc.length + bcc.length > 100) invalid("Use at most 100 recipients in one mail message.");
  const replyTo = normalizeMailAddresses(input.replyTo, "replyTo", false);
  if (replyTo.length > 1) invalid("Pass at most one `replyTo` address.");
  if (typeof input.subject !== "string" || input.subject.length < 1 || input.subject.length > 998 || /[\x00-\x1f\x7f]/.test(input.subject)) {
    invalid("Pass a non-empty subject of at most 998 characters without prohibited control characters.");
  }
  if (input.textBody === undefined && input.htmlBody === undefined) invalid("Pass at least one of `textBody` or `htmlBody`.");
  for (const field of ["textBody", "htmlBody"]) {
    const value = input[field];
    if (value !== undefined && (typeof value !== "string" || value.length > 1024 * 1024 || /\0/.test(value))) {
      invalid(`Pass \`${field}\` as a string of at most 1 MiB without null characters.`);
    }
  }
  let provider = input.provider;
  let providerHeaders: { name: string; value: string }[] | undefined;
  if (provider !== undefined) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) invalid("Pass `provider` as a JSON object.");
    if (vendor === "postmark") {
      providerHeaders = normalizePostmarkProvider(provider);
      provider = undefined;
    } else if (vendor === "mailgun") {
      providerHeaders = normalizeMailgunProvider(provider);
      provider = undefined;
    } else {
      providerHeaders = normalizeGenericProvider(provider);
      provider = undefined;
    }
  }
  return {
    from: from[0],
    to,
    cc,
    bcc,
    ...(replyTo[0] ? { replyTo: replyTo[0] } : {}),
    subject: input.subject,
    ...(input.textBody !== undefined ? { textBody: input.textBody } : {}),
    ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
    ...(providerHeaders?.length ? { providerHeaders } : {}),
    ...(provider !== undefined ? { provider } : {}),
  };
}

function normalizeGenericProvider(provider: any) {
  const providerEntries = captureMailProviderDataObject(provider, "provider", "generic SMTP");
  const unsupported = providerEntries.map(([field]) => field).filter((field) => field !== "headers").sort();
  if (unsupported.length > 0) {
    throw mailError(
      "UNSUPPORTED_MAIL_PROVIDER_FIELD",
      `Unsupported generic SMTP provider field: ${unsupported[0]}.`,
      "Use only `headers` in the generic SMTP provider object; addressing, MIME, authentication, and transport settings are not message-level provider fields.",
    );
  }
  if (providerEntries.length === 0) return [];
  const providerData = new Map(providerEntries);
  const headerEntries = captureMailProviderDataObject(providerData.get("headers"), "provider.headers", "generic SMTP")
    .map(([name, value]) => ({ name, normalizedName: name.toLowerCase(), value }))
    .sort((left, right) => {
      if (left.normalizedName < right.normalizedName) return -1;
      if (left.normalizedName > right.normalizedName) return 1;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
  if (headerEntries.length > 50) {
    throw mailError("INVALID_MAIL_MESSAGE", "Invalid generic SMTP provider data.", "Pass at most 50 `provider.headers` names.");
  }
  const seen = new Set<string>();
  const protectedNames = new Set([
    "x-from",
    "x-to",
    "x-cc",
    "x-bcc",
    "x-sender",
    "x-reply-to",
    "x-return-path",
    "x-subject",
    "x-content-type",
    "x-content-transfer-encoding",
    "x-mime-version",
    "x-message-id",
    "x-date",
    // SendGrid's legacy X-SMTPAPI header can replace envelope recipients.
    "x-smtpapi",
  ]);
  const protectedPrefixes = [
    "x-envelope-",
    "x-original-",
    "x-delivered-",
    "x-auth",
    "x-smtp-",
    "x-starttls",
    "x-tls",
  ];
  const headers: { name: string; value: string; verbatim: boolean }[] = [];
  for (const entry of headerEntries) {
    if (!/^[Xx]-[A-Za-z0-9](?:[A-Za-z0-9-]{0,125})$/.test(entry.name)) {
      throw mailError(
        "INVALID_MAIL_MESSAGE",
        "Invalid generic SMTP provider data.",
        `Pass \`provider.headers.${entry.name}\` as a custom X-* header name containing only ASCII letters, numbers, and hyphens.`,
      );
    }
    if (protectedNames.has(entry.normalizedName) || protectedPrefixes.some((prefix) => entry.normalizedName.startsWith(prefix))) {
      throw mailError(
        "INVALID_MAIL_MESSAGE",
        "Invalid generic SMTP provider data.",
        `Provider header \`${entry.name}\` is protected because it may alter addressing, MIME, authentication, or transport behavior.`,
      );
    }
    if (seen.has(entry.normalizedName)) {
      throw mailError("INVALID_MAIL_MESSAGE", "Invalid generic SMTP provider data.", `Provider header names collide case-insensitively at \`${entry.name}\`.`);
    }
    seen.add(entry.normalizedName);
    for (const value of captureGenericHeaderValues(entry.value, `provider.headers.${entry.name}`)) {
      if (
        !/^[\x20-\x7e]+$/.test(value)
        || value.trim() !== value
        || entry.name.length + 2 + value.length > 998
      ) {
        throw mailError(
          "INVALID_MAIL_MESSAGE",
          "Invalid generic SMTP provider data.",
          `Pass \`provider.headers.${entry.name}\` values as non-empty printable ASCII strings without leading or trailing whitespace that fit one SMTP header line of at most 998 characters.`,
        );
      }
      headers.push({ name: entry.name, value, verbatim: true });
    }
  }
  return headers;
}

function captureGenericHeaderValues(value: any, label: string) {
  if (typeof value === "string") return [value];
  const invalid = (detail: string): never => {
    throw mailError(
      "INVALID_MAIL_MESSAGE",
      "Invalid generic SMTP provider data.",
      `Pass \`${label}\` as a string or complete ordinary array of strings; ${detail}.`,
    );
  };
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid("custom prototypes and non-array values are not supported");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") invalid("symbol fields are not supported");
    const stringKey = key as string;
    if (stringKey === "length") continue;
    if (!/^(?:0|[1-9]\d*)$/.test(stringKey) || Number(stringKey) >= value.length) invalid(`field \`${stringKey}\` is not an array index`);
    const descriptor = descriptors[stringKey];
    if (!descriptor.enumerable) invalid(`field \`${stringKey}\` must be enumerable`);
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) invalid(`field \`${stringKey}\` must not be an accessor`);
  }
  if (value.length < 1 || value.length > 50) invalid("arrays must contain one to 50 values");
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) invalid(`index ${index} must be an own data property`);
    if (typeof descriptor.value !== "string") invalid(`index ${index} must be a string`);
    result.push(descriptor.value);
  }
  return result;
}

function unsupportedMailProviderField(field: string) {
  return mailError(
    "UNSUPPORTED_MAIL_PROVIDER_FIELD",
    `Unsupported Postmark provider field: ${field}.`,
    "Use only `tag`, `metadata`, and `messageStream` in the Postmark provider object.",
  );
}

function captureMailProviderDataObject(value: any, label: string, vendor = "Postmark") {
  const invalid = (detail: string): never => {
    throw mailError(
      "INVALID_MAIL_MESSAGE",
      `Invalid ${vendor} provider data.`,
      `Pass \`${label}\` as a plain data object; ${detail}.`,
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("arrays and non-object values are not supported");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid("custom prototypes and inherited fields are not supported");
  }
  const entries: [string, any][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid("symbol fields are not supported");
    const stringKey = key as string;
    const descriptor = Object.getOwnPropertyDescriptor(value, stringKey);
    if (!descriptor) invalid(`field \`${stringKey}\` must have an own property descriptor`);
    const ownDescriptor = descriptor as PropertyDescriptor;
    if (!ownDescriptor.enumerable) invalid(`field \`${stringKey}\` must be enumerable`);
    if (!Object.prototype.hasOwnProperty.call(ownDescriptor, "value")) {
      invalid(`field \`${stringKey}\` must not be an accessor`);
    }
    entries.push([stringKey, ownDescriptor.value]);
  }
  return entries;
}

function captureMailProviderDataArray(value: any, label: string) {
  const invalid = (detail: string): never => {
    throw mailError(
      "INVALID_MAIL_MESSAGE",
      "Invalid Mailgun provider data.",
      `Pass \`${label}\` as an ordinary data array; ${detail}.`,
    );
  };
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid("custom prototypes and non-array values are not supported");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") invalid("symbol fields are not supported");
    const stringKey = key as string;
    if (stringKey === "length") continue;
    if (!/^(?:0|[1-9]\d*)$/.test(stringKey) || Number(stringKey) >= value.length) {
      invalid(`field \`${stringKey}\` is not an array index`);
    }
    const descriptor = descriptors[stringKey];
    if (!descriptor.enumerable) invalid(`field \`${stringKey}\` must be enumerable`);
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) invalid(`field \`${stringKey}\` must not be an accessor`);
  }
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      invalid(`index ${index} must be an own data property`);
    }
    entries.push(descriptor.value);
  }
  return entries;
}

function normalizePostmarkProvider(provider: any) {
  const allowed = new Set(["tag", "metadata", "messageStream"]);
  const providerEntries = captureMailProviderDataObject(provider, "provider");
  const unsupported = providerEntries.map(([field]) => field).filter((field) => !allowed.has(field)).sort();
  if (unsupported.length > 0) throw unsupportedMailProviderField(unsupported[0]);
  const providerData = new Map(providerEntries);
  const invalid = (hint: string): never => {
    throw mailError("INVALID_MAIL_MESSAGE", "Invalid Postmark provider data.", hint);
  };
  const headers: { name: string; value: string }[] = [];
  const tag = providerData.get("tag");
  if (providerData.has("tag")) {
    if (typeof tag !== "string" || tag.length < 1 || tag.length > 1000 || /[\x00-\x1f\x7f]/.test(tag)) {
      invalid("Pass `provider.tag` as one non-empty value of at most 1000 characters without control characters.");
    }
    headers.push({ name: "X-PM-Tag", value: encodeMimeHeaderValue(tag) });
  }
  const metadataValue = providerData.get("metadata");
  if (providerData.has("metadata")) {
    const metadata = captureMailProviderDataObject(metadataValue, "provider.metadata")
      .map(([key, value]) => ({ originalKey: key, key: key.toLowerCase(), value }))
      .sort((left, right) => {
        if (left.key < right.key) return -1;
        if (left.key > right.key) return 1;
        if (left.originalKey < right.originalKey) return -1;
        if (left.originalKey > right.originalKey) return 1;
        return 0;
      });
    if (metadata.length > 10) invalid("Pass at most 10 Postmark metadata fields.");
    const seen = new Set<string>();
    for (const entry of metadata) {
      if (!/^[a-z0-9][a-z0-9_-]{0,19}$/.test(entry.key)) {
        invalid(`Postmark metadata key \`${entry.originalKey}\` must be 1 to 20 ASCII letters, numbers, hyphens, or underscores.`);
      }
      if (seen.has(entry.key)) {
        invalid(`Postmark metadata keys collide case-insensitively at \`${entry.key}\`.`);
      }
      seen.add(entry.key);
      const metadataValue = entry.value;
      if (typeof metadataValue !== "string" || metadataValue.length > 80 || /[\x00-\x1f\x7f]/.test(metadataValue)) {
        invalid(`Postmark metadata value \`${entry.originalKey}\` must be a string of at most 80 characters without control characters.`);
      }
      headers.push({
        name: `X-PM-Metadata-${entry.key}`,
        value: encodeMimeHeaderValue(metadataValue as string),
      });
    }
  }
  const messageStream = providerData.get("messageStream");
  if (providerData.has("messageStream")) {
    if (
      typeof messageStream !== "string"
      || !/^[a-z][a-z0-9_-]{0,29}$/.test(messageStream)
      || messageStream.startsWith("pm-")
    ) {
      invalid("Pass `provider.messageStream` as a Postmark stream ID: 1 to 30 lowercase letters, numbers, hyphens, or underscores, beginning with a letter and not `pm-`.");
    }
    headers.push({ name: "X-PM-Message-Stream", value: messageStream });
  }
  return headers;
}

function normalizeMailgunProvider(provider: any) {
  const allowed = new Set([
    "tags",
    "variables",
    "recipientVariables",
    "templateName",
    "templateVersion",
    "templateVariables",
    "tracking",
    "testMode",
    "deliveryTime",
    "deliverWithin",
    "deliveryTimeOptimizePeriod",
    "timeZoneLocalize",
  ]);
  const providerEntries = captureMailProviderDataObject(provider, "provider", "Mailgun");
  const unsupported = (field: string): never => {
    throw mailError(
      "UNSUPPORTED_MAIL_PROVIDER_FIELD",
      `Unsupported Mailgun provider field: ${field}.`,
      `Use only ${[...allowed].map((allowedField) => `\`${allowedField}\``).join(", ")} in the Mailgun provider object.`,
    );
  };
  const unsupportedFields = providerEntries.map(([field]) => field).filter((field) => !allowed.has(field)).sort();
  if (unsupportedFields.length > 0) unsupported(unsupportedFields[0]);
  const providerData = new Map(providerEntries);
  const invalid = (hint: string): never => {
    throw mailError("INVALID_MAIL_MESSAGE", "Invalid Mailgun provider data.", hint);
  };
  const headers: { name: string; value: string; json?: boolean }[] = [];
  const controlFreeString = (field: string, value: any, maximum = 128) => {
    if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
      invalid(`Pass \`provider.${field}\` as a non-empty string of at most ${maximum} characters without control characters.`);
    }
    return value as string;
  };
  const booleanHeader = (field: string, name: string) => {
    if (!providerData.has(field)) return;
    const value = providerData.get(field);
    if (typeof value !== "boolean") invalid(`Pass \`provider.${field}\` as a boolean.`);
    headers.push({ name, value: value ? "yes" : "no" });
  };

  if (providerData.has("tags")) {
    const tags = providerData.get("tags");
    if (!Array.isArray(tags) || tags.length < 1 || tags.length > 3) {
      invalid("Pass `provider.tags` as an array containing one to three Mailgun tags.");
    }
    for (const tag of captureMailProviderDataArray(tags, "provider.tags")) {
      if (typeof tag !== "string" || tag.length < 1 || tag.length > 128 || /[^\x20-\x7e]/.test(tag)) {
        invalid("Pass each Mailgun tag as 1 to 128 printable ASCII characters.");
      }
      if (tag.trim() !== tag || /\s{2,}/.test(tag)) {
        invalid("Pass Mailgun tags without leading, trailing, or repeated whitespace.");
      }
      headers.push({ name: "X-Mailgun-Tag", value: tag });
    }
  }

  for (const [field, name, maximum] of [
    ["variables", "X-Mailgun-Variables", 4096],
    ["recipientVariables", "X-Mailgun-Recipient-Variables", 32 * 1024],
  ] as const) {
    if (!providerData.has(field)) continue;
    const value = providerData.get(field);
    if (field === "variables") {
      try {
        captureMailProviderDataObject(value, "provider.variables", "Mailgun");
      } catch {
        invalid("Pass `provider.variables` as a plain JSON dictionary.");
      }
    }
    const json = serializeMailgunJson(value, `provider.${field}`, maximum);
    if (field === "recipientVariables") {
      const entries = captureMailProviderDataObject(value, "provider.recipientVariables", "Mailgun");
      if (entries.length < 1 || entries.length > 1000) {
        invalid("Pass `provider.recipientVariables` for one to 1000 recipients.");
      }
      for (const [recipient, variables] of entries) {
        try {
          const address = normalizeMailAddress(recipient, "provider.recipientVariables");
          if (address.email !== recipient || address.name !== undefined) throw new Error("not plain");
          captureMailProviderDataObject(variables, `provider.recipientVariables.${recipient}`, "Mailgun");
        } catch {
          invalid("Use plain ASCII recipient email addresses mapped to variable objects in `provider.recipientVariables`.");
        }
      }
    }
    foldMailgunJsonHeader(name, json);
    headers.push({ name, value: json, json: true });
  }

  for (const [field, name] of [
    ["templateName", "X-Mailgun-Template-Name"],
    ["templateVersion", "X-Mailgun-Template-Version"],
  ] as const) {
    if (providerData.has(field)) {
      const value = controlFreeString(field, providerData.get(field));
      if (!/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) || / {2,}/.test(value)) {
        invalid(`Pass \`provider.${field}\` as printable ASCII with only single internal spaces.`);
      }
      headers.push({ name, value });
    }
  }
  if (providerData.has("templateVariables")) {
    try {
      captureMailProviderDataObject(providerData.get("templateVariables"), "provider.templateVariables", "Mailgun");
    } catch {
      invalid("Pass `provider.templateVariables` as a plain JSON dictionary.");
    }
    const templateVariables = serializeMailgunJson(providerData.get("templateVariables"), "provider.templateVariables", 32 * 1024);
    foldMailgunJsonHeader("X-Mailgun-Template-Variables", templateVariables);
    headers.push({
      name: "X-Mailgun-Template-Variables",
      value: templateVariables,
      json: true,
    });
  }

  if (providerData.has("tracking")) {
    const tracking = providerData.get("tracking");
    if (typeof tracking === "boolean") {
      headers.push({ name: "X-Mailgun-Track", value: tracking ? "yes" : "no" });
    } else {
      const entries = captureMailProviderDataObject(tracking, "provider.tracking", "Mailgun");
      const trackingAllowed = new Set(["enabled", "clicks", "opens", "pixelLocationTop"]);
      const unknown = entries.map(([field]) => field).filter((field) => !trackingAllowed.has(field)).sort();
      if (unknown.length > 0) unsupported(`tracking.${unknown[0]}`);
      const data = new Map(entries);
      for (const [field, name] of [
        ["enabled", "X-Mailgun-Track"],
        ["clicks", "X-Mailgun-Track-Clicks"],
        ["opens", "X-Mailgun-Track-Opens"],
        ["pixelLocationTop", "X-Mailgun-Track-Pixel-Location-Top"],
      ] as const) {
        if (!data.has(field)) continue;
        const value = data.get(field);
        if (field === "clicks") {
          if (typeof value !== "boolean" && value !== "htmlonly") {
            invalid("Pass `provider.tracking.clicks` as a boolean or `htmlonly`.");
          }
          headers.push({ name, value: value === "htmlonly" ? value : value ? "yes" : "no" });
        } else {
          if (typeof value !== "boolean") invalid(`Pass \`provider.tracking.${field}\` as a boolean.`);
          headers.push({ name, value: value ? "yes" : "no" });
        }
      }
    }
  }

  booleanHeader("testMode", "X-Mailgun-Drop-Message");

  if (providerData.has("deliveryTime")) {
    const deliveryTime = controlFreeString("deliveryTime", providerData.get("deliveryTime"));
    if (
      !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d [+-](?:[01]\d|2[0-3])[0-5]\d$/.test(deliveryTime)
      || !Number.isFinite(Date.parse(deliveryTime))
    ) {
      invalid("Pass `provider.deliveryTime` in RFC 2822 format, for example `Fri, 14 Oct 2011 12:00:00 +0000`.");
    }
    headers.push({ name: "X-Mailgun-Deliver-By", value: deliveryTime });
  }
  if (providerData.has("deliverWithin")) {
    const deliverWithin = controlFreeString("deliverWithin", providerData.get("deliverWithin"), 6);
    const match = deliverWithin.match(/^(?:(\d{1,2})h)?(?:(\d{1,2})m)?$/);
    const minutes = match ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) : 0;
    if (!match || minutes < 5 || minutes > 24 * 60) {
      invalid("Pass `provider.deliverWithin` in Mailgun's `1h30m` format, from 5m through 24h.");
    }
    headers.push({ name: "X-Mailgun-Deliver-Within", value: deliverWithin });
  }
  if (providerData.has("deliveryTimeOptimizePeriod")) {
    const period = controlFreeString("deliveryTimeOptimizePeriod", providerData.get("deliveryTimeOptimizePeriod"), 5);
    const hours = period.match(/^(\d{2})h$/)?.[1];
    if (hours === undefined || Number(hours) < 24 || Number(hours) > 72) {
      invalid("Pass `provider.deliveryTimeOptimizePeriod` from `24h` through `72h`.");
    }
    headers.push({ name: "X-Mailgun-Delivery-Time-Optimize-Period", value: period });
  }
  if (providerData.has("timeZoneLocalize")) {
    const localize = controlFreeString("timeZoneLocalize", providerData.get("timeZoneLocalize"), 7);
    const valid24Hour = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localize);
    const valid12Hour = /^(?:0[1-9]|1[0-2]):[0-5]\d(?:am|pm)$/.test(localize);
    if (!valid24Hour && !valid12Hour) invalid("Pass `provider.timeZoneLocalize` as `HH:mm` or `hh:mmaa`.");
    headers.push({ name: "X-Mailgun-Time-Zone-Localize", value: localize });
  }
  return headers;
}

function serializeMailgunJson(value: any, label: string, maximumBytes: number) {
  const seen = new Set<any>();
  const normalize = (candidate: any, path: string): any => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (Array.isArray(candidate)) {
      if (seen.has(candidate)) throw new Error(`${path} is cyclic`);
      seen.add(candidate);
      const result = captureMailProviderDataArray(candidate, path)
        .map((entry, index) => normalize(entry, `${path}[${index}]`));
      seen.delete(candidate);
      return result;
    }
    if (candidate && typeof candidate === "object") {
      if (seen.has(candidate)) throw new Error(`${path} is cyclic`);
      seen.add(candidate);
      const entries = captureMailProviderDataObject(candidate, path, "Mailgun").sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      const result = Object.create(null);
      for (const [key, entry] of entries) result[key] = normalize(entry, `${path}.${key}`);
      seen.delete(candidate);
      return result;
    }
    throw new Error(`${path} is not JSON-compatible`);
  };
  let json;
  try {
    json = JSON.stringify(normalize(value, label));
  } catch {
    throw mailError("INVALID_MAIL_MESSAGE", "Invalid Mailgun provider data.", `Pass \`${label}\` as JSON-compatible plain data without accessors, symbols, hidden fields, custom prototypes, cycles, or non-finite numbers.`);
  }
  const asciiJson = json?.replace(/[^\x20-\x7e]/g, (character: string) => {
    const code = character.charCodeAt(0);
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
  if (asciiJson === undefined || Buffer.byteLength(asciiJson) > maximumBytes) {
    throw mailError("INVALID_MAIL_MESSAGE", "Invalid Mailgun provider data.", `Keep \`${label}\` within ${maximumBytes} UTF-8 bytes.`);
  }
  return asciiJson;
}

function normalizeMailAddresses(value: any, field: string, required: boolean) {
  if (value === undefined || value === null) {
    if (required) return [];
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 && required) return [];
  return values.map((entry) => normalizeMailAddress(entry, field));
}

function normalizeMailAddress(value: any, field: string) {
  let email;
  let name;
  if (typeof value === "string") {
    if (/[\x00-\x1f\x7f]/.test(value) || value.length > 320) {
      throw mailError("INVALID_MAIL_MESSAGE", "Invalid mail message.", `Pass valid ${field} addresses without control characters.`);
    }
    const match = value.match(/^\s*(?:(.*?)\s*)?<([^<>]+)>\s*$/);
    email = match ? match[2] : value.trim();
    name = match?.[1]?.trim().replace(/^"(.*)"$/, "$1") || undefined;
  } else if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => key === "email" || key === "name")) {
    email = value.email;
    name = value.name;
  }
  if (typeof email !== "string" || email.length < 3 || email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+$/.test(email) || /[^\x21-\x7e]/.test(email)) {
    throw mailError("INVALID_MAIL_MESSAGE", "Invalid mail message.", `Pass valid ASCII ${field} email addresses; internationalized envelopes are not supported.`);
  }
  if (name !== undefined && (typeof name !== "string" || name.length > 200 || /[\x00-\x1f\x7f]/.test(name))) {
    throw mailError("INVALID_MAIL_MESSAGE", "Invalid mail message.", `Pass valid ${field} display names without control characters.`);
  }
  return { email, ...(name ? { name } : {}) };
}

function normalizeMailTransportError(error: any) {
  const code = String(error?.code ?? "");
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return mailError("MAIL_TIMEOUT", "SMTP delivery timed out.", "Check the SMTP host and timeout settings before retrying.");
  }
  if (code === "MAIL_TIMEOUT") return mailError("MAIL_TIMEOUT", "SMTP delivery timed out.", "Check the SMTP host and timeout settings before retrying.");
  if (code === "EAUTH" || code === "MAIL_AUTH_FAILED") {
    return mailError("MAIL_AUTH_FAILED", "SMTP authentication failed.", "Check the SMTP Server env credentials and authentication method.");
  }
  if (
    code === "ETLS"
    || code.startsWith("CERT_")
    || code.startsWith("ERR_TLS_")
    || code.startsWith("ERR_SSL_")
    || ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(code)
    || code === "MAIL_TLS_FAILED"
  ) return mailError("MAIL_TLS_FAILED", "SMTP TLS negotiation failed.", "Check the SMTP TLS mode, port, and certificate policy.");
  if (code === "EREJECTED" || code === "MAIL_REJECTED") {
    return mailError("MAIL_REJECTED", "The SMTP server rejected the message.", "Check the sender, recipients, and provider delivery policy.");
  }
  return mailError("MAIL_CONNECTION_FAILED", "SMTP delivery failed.", "Check the SMTP host, port, network access, and provider status.");
}

export function createMailTransport(smtp: any) {
  const sockets = new Set<any>();
  let closed = false;
  return {
    async send(message: any) {
      let socket: any;
      let reader: any;
      try {
        if (closed) {
          const error: any = new Error("closed");
          error.code = "ECONNECTION";
          throw error;
        }
        socket = await connectSmtpSocket(smtp);
        if (closed) {
          const error: any = new Error("closed");
          error.code = "ECONNECTION";
          socket.destroy(error);
          throw error;
        }
        sockets.add(socket);
        reader = createSmtpResponseReader(socket, smtp.socketTimeoutMs);
        let encrypted = smtp.tls.mode === "implicit";
        await reader.expect([220]);
        const ehlo = await smtpCommand(socket, reader, `EHLO sporades.local`, [250]);
        if (smtp.tls.mode === "required-starttls" || smtp.tls.mode === "opportunistic") {
          if (/\bSTARTTLS\b/i.test(ehlo.text)) {
            await smtpCommand(socket, reader, "STARTTLS", [220]);
            const tls = await import("node:tls");
            const upgraded = tls.connect({
              socket,
              servername: smtp.tls.servername ?? smtp.host,
              rejectUnauthorized: smtp.tls.rejectUnauthorized,
            });
            sockets.delete(socket);
            sockets.add(upgraded);
            reader.replaceSocket(upgraded);
            await new Promise((resolve, reject) => {
              upgraded.once("secureConnect", resolve);
              upgraded.once("error", reject);
            }).catch((cause) => {
              const error: any = new Error("TLS negotiation failed");
              error.code = "ETLS";
              error.cause = cause;
              throw error;
            });
            await smtpCommand(upgraded, reader, "EHLO sporades.local", [250]);
            encrypted = true;
          } else if (smtp.tls.mode === "required-starttls") {
            const error: any = new Error("STARTTLS unavailable");
            error.code = "ETLS";
            throw error;
          }
        }
        const activeSocket = reader.socket();
        if (smtp.auth.method !== "none" && !encrypted) {
          const error: any = new Error("refusing SMTP authentication over plaintext");
          error.code = "ETLS";
          throw error;
        }
        if (smtp.auth.method === "PLAIN") {
          const credential = Buffer.from(`\0${smtp.auth.username}\0${smtp.auth.password}`).toString("base64");
          await smtpCommand(activeSocket, reader, `AUTH PLAIN ${credential}`, [235], "EAUTH");
        } else if (smtp.auth.method === "LOGIN") {
          await smtpCommand(activeSocket, reader, "AUTH LOGIN", [334], "EAUTH");
          await smtpCommand(activeSocket, reader, Buffer.from(smtp.auth.username).toString("base64"), [334], "EAUTH");
          await smtpCommand(activeSocket, reader, Buffer.from(smtp.auth.password).toString("base64"), [235], "EAUTH");
        }
        await smtpCommand(activeSocket, reader, `MAIL FROM:<${message.from.email}>`, [250]);
        const accepted = [];
        const rejected = [];
        for (const recipient of [...message.to, ...message.cc, ...message.bcc]) {
          if (await smtpRecipientCommand(activeSocket, reader, recipient.email)) accepted.push(recipient.email);
          else rejected.push(recipient.email);
        }
        if (accepted.length === 0) {
          const error: any = new Error("all recipients rejected");
          error.code = "EREJECTED";
          throw error;
        }
        await smtpCommand(activeSocket, reader, "DATA", [354]);
        const messageId = `<${crypto.randomUUID()}@sporades.local>`;
        const raw = buildSmtpMessage({ ...message, messageId }).replace(/(^|\r\n)\./g, "$1..");
        activeSocket.write(`${raw}\r\n.\r\n`);
        const delivered = await reader.expect([250], "EREJECTED");
        activeSocket.write("QUIT\r\n");
        return {
          messageId: delivered.messageId ?? messageId,
          accepted,
          rejected,
        };
      } catch (error) {
        // This is the trusted Sporades-owned SMTP boundary. Classify Node
        // socket/TLS and runtime command errors here, then expose only a fresh
        // stable mail Error to the outer runtime.
        throw normalizeMailTransportError(error);
      } finally {
        reader?.close();
        for (const candidate of [...sockets]) {
          if (candidate === socket || candidate === reader?.socket()) {
            sockets.delete(candidate);
            candidate.destroy();
          }
        }
      }
    },
    close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

export async function connectSmtpSocket(smtp: any) {
  let socket: any;
  if (smtp.tls.mode === "implicit") {
    const tls = await import("node:tls");
    socket = tls.connect({
      host: smtp.host,
      port: smtp.port,
      servername: smtp.tls.servername ?? smtp.host,
      rejectUnauthorized: smtp.tls.rejectUnauthorized,
    });
  } else {
    const net = await import("node:net");
    socket = net.connect({ host: smtp.host, port: smtp.port });
  }
  socket.setTimeout(smtp.socketTimeoutMs, () => {
    const error: any = new Error("socket timeout");
    error.code = "ESOCKETTIMEDOUT";
    socket.destroy(error);
  });
  const event = smtp.tls.mode === "implicit" ? "secureConnect" : "connect";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error: any = new Error("connection timeout");
      error.code = "ETIMEDOUT";
      socket.destroy(error);
    }, smtp.connectionTimeoutMs);
    socket.once(event, () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    socket.once("error", (error: any) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

function createSmtpResponseReader(initialSocket: any, timeoutMs: number) {
  let activeSocket = initialSocket;
  let buffer = "";
  let pending: any = null;
  const onData = (chunk: any) => {
    buffer += chunk.toString("utf8");
    pending?.();
  };
  activeSocket.on("data", onData);
  const replaceSocket = (next: any) => {
    activeSocket.off("data", onData);
    activeSocket = next;
    activeSocket.on("data", onData);
  };
  return {
    socket: () => activeSocket,
    replaceSocket,
    async expect(expected: number[], failureCode = "ECONNECTION") {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const lines = buffer.split("\r\n");
        let consumed = 0;
        let complete = null;
        for (const line of lines.slice(0, -1)) {
          consumed += line.length + 2;
          if (/^\d{3} /.test(line)) {
            const code = Number(line.slice(0, 3));
            const responseLines = buffer.slice(0, consumed).trimEnd();
            complete = { code, text: responseLines, messageId: responseLines.match(/<[^<>\r\n]+>/)?.[0] };
            break;
          }
        }
        if (complete) {
          buffer = buffer.slice(consumed);
          if (!expected.includes(complete.code)) {
            const error: any = new Error("unexpected SMTP response");
            error.code = failureCode;
            error.smtpCode = complete.code;
            throw error;
          }
          return complete;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const error: any = new Error("SMTP response timeout");
          error.code = "ESOCKETTIMEDOUT";
          throw error;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            const error: any = new Error("SMTP response timeout");
            error.code = "ESOCKETTIMEDOUT";
            reject(error);
          }, remaining);
          const onError = (error: any) => { cleanup(); reject(error); };
          const onClose = () => {
            cleanup();
            const error: any = new Error("SMTP connection closed");
            error.code = "ECONNECTION";
            reject(error);
          };
          const cleanup = () => {
            clearTimeout(timer);
            activeSocket.off("error", onError);
            activeSocket.off("close", onClose);
            pending = null;
          };
          pending = () => { cleanup(); resolve(); };
          activeSocket.once("error", onError);
          activeSocket.once("close", onClose);
        });
      }
    },
    close() {
      activeSocket.off("data", onData);
      pending = null;
    },
  };
}

async function smtpCommand(socket: any, reader: any, command: string, expected: number[], failureCode = "ECONNECTION") {
  socket.write(`${command}\r\n`);
  return reader.expect(expected, failureCode);
}

async function smtpRecipientCommand(socket: any, reader: any, email: string) {
  socket.write(`RCPT TO:<${email}>\r\n`);
  try {
    await reader.expect([250, 251], "EREJECTED");
    return true;
  } catch (error: any) {
    if (error?.code === "EREJECTED" && error?.smtpCode >= 400 && error?.smtpCode <= 599) return false;
    throw error;
  }
}

export function buildSmtpMessage(message: any) {
  const formatAddress = (address: any) => address.name
    ? `${encodeMimeHeaderValue(address.name, true)} <${address.email}>`
    : address.email;
  const headers = [
    foldMimeHeader("From", formatAddress(message.from)),
    foldMimeHeader("To", message.to.map(formatAddress).join(", ")),
    ...(message.cc.length ? [foldMimeHeader("Cc", message.cc.map(formatAddress).join(", "))] : []),
    ...(message.replyTo ? [foldMimeHeader("Reply-To", formatAddress(message.replyTo))] : []),
    foldMimeHeader("Subject", encodeMimeHeaderValue(message.subject)),
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${message.messageId ?? `<${crypto.randomUUID()}@sporades.local>`}`,
    "MIME-Version: 1.0",
    ...(message.providerHeaders ?? []).map((header: any) => header.json
      ? foldMailgunJsonHeader(header.name, header.value)
      : header.verbatim
        ? `${header.name}: ${header.value}`
        : foldMimeHeader(header.name, header.value)),
  ];
  if (message.textBody !== undefined && message.htmlBody !== undefined) {
    const boundary = `sporades-${crypto.randomUUID()}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return `${headers.join("\r\n")}\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodeMimeBase64(message.textBody)}\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodeMimeBase64(message.htmlBody)}\r\n--${boundary}--`;
  }
  const html = message.htmlBody !== undefined;
  headers.push(`Content-Type: ${html ? "text/html" : "text/plain"}; charset=utf-8`, "Content-Transfer-Encoding: base64");
  return `${headers.join("\r\n")}\r\n\r\n${encodeMimeBase64(html ? message.htmlBody : message.textBody)}`;
}

function encodeMimeHeaderValue(value: string, quoteAscii = false) {
  const text = String(value);
  if (/^[\x20-\x7e]*$/.test(text) && Buffer.byteLength(text) <= 70) {
    return quoteAscii ? `"${text.replace(/(["\\])/g, "\\$1")}"` : text;
  }
  const chunks = [];
  let current = "";
  for (const character of text) {
    // 39 UTF-8 bytes encode to at most 64 encoded-word characters. That leaves
    // room for the longest emitted field prefix (`Reply-To: `) while keeping
    // every encoded-word header line within RFC 2047's 76-character limit.
    if (current && Buffer.byteLength(current + character) > 39) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`).join(" ");
}

function foldMimeHeader(name: string, value: string) {
  const prefix = `${name}: `;
  const tokens = String(value).split(/(?<=,)\s+|\s+/);
  const lines = [];
  let line = prefix;
  for (const token of tokens) {
    if (!token) continue;
    const separator = line === prefix || line === " " ? "" : " ";
    const candidate = `${line}${separator}${token}`;
    const lineLimit = candidate.includes("=?UTF-8?B?") ? 76 : 78;
    if (candidate.length <= lineLimit) {
      line = candidate;
    } else {
      lines.push(line === prefix ? line.trimEnd() : line);
      line = ` ${token}`;
    }
  }
  if (line !== prefix) lines.push(line);
  if (lines.some((candidate) => candidate.length > 998)) {
    throw mailError("INVALID_MAIL_MESSAGE", "Invalid mail message.", `${name} cannot be encoded within SMTP header line limits.`);
  }
  return lines.join("\r\n");
}

function foldMailgunJsonHeader(name: string, value: string) {
  const text = String(value);
  const tokens = [];
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if ("{}[],:".includes(character)) {
      tokens.push(character);
      index += 1;
      continue;
    }
    const start = index;
    if (character === "\"") {
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const next = text[index];
        index += 1;
        if (escaped) escaped = false;
        else if (next === "\\") escaped = true;
        else if (next === "\"") break;
      }
    } else {
      while (index < text.length && !"{}[],:\"".includes(text[index])) index += 1;
    }
    tokens.push(text.slice(start, index));
  }
  const prefix = `${name}: `;
  const lines = [];
  let line = prefix;
  for (const token of tokens) {
    if (token.length > 997) {
      throw mailError("INVALID_MAIL_MESSAGE", "Invalid Mailgun provider data.", `${name} JSON keys and values must each encode within 997 characters so Sporades can fold them before SMTP delivery.`);
    }
    if (`${line}${token}`.length <= 78) {
      line += token;
      continue;
    }
    if (line !== prefix && line !== " ") {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line += token;
    }
    if (line.length > 998) {
      throw mailError("INVALID_MAIL_MESSAGE", "Invalid Mailgun provider data.", `${name} contains a JSON token that cannot be folded within SMTP's 998-character line limit.`);
    }
  }
  if (line !== prefix) lines.push(line);
  return lines.join("\r\n");
}

function encodeMimeBase64(value: string) {
  return Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
}
