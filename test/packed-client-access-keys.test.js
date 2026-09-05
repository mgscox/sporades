import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the packed package exposes the complete server and client Access-key contract", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-packed-access-keys-"));
  try {
    const packed = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], {
      cwd: repoRoot,
      env: { ...process.env, npm_config_cache: path.join(dir, "npm-cache") },
    });
    const [{ filename }] = JSON.parse(packed.stdout);
    const modules = path.join(dir, "consumer", "node_modules");
    await mkdir(modules, { recursive: true });
    await run("tar", ["-xzf", path.join(dir, filename), "-C", modules]);
    await rename(path.join(modules, "package"), path.join(modules, "sporades"));
    await writeFile(path.join(dir, "consumer", "package.json"), JSON.stringify({ type: "module" }));
    const packedClientTypes = await readFile(path.join(modules, "sporades", "src", "types", "client.d.ts"), "utf8");
    const packedServerTypes = await readFile(path.join(modules, "sporades", "src", "types", "server.d.ts"), "utf8");
    const packedGeneratedServerTypes = await readFile(path.join(modules, "sporades", "dist", "server.d.ts"), "utf8");
    const generatedServerTypes = await readFile(path.join(repoRoot, "dist", "server.d.ts"), "utf8");
    assert.match(packedClientTypes, /AccessKeyErrorCode[\s\S]*"TRANSPORT_CLOSED"/);
    assert.match(packedClientTypes, /AccessKeyRevocationCause[\s\S]*"service-user-administrator"[\s\S]*"service-user-disabled"/);
    assert.match(packedServerTypes, /@deprecated Use requireUserAuth/);
    assert.match(packedServerTypes, /CredentialProvenance/);
    assert.match(packedServerTypes, /PrivilegedAccessKeysApi/);
    const admissionTypeMetadata = [
      ["EndpointMultipartAdmissionRequest", "Shared immutable request head supplied to endpoint multipart admission."],
      ["EndpointMultipartAdmissionContext", "An authenticated, read-only policy context evaluated before a multipart endpoint reads its request body."],
      ["EndpointMultipartAdmissionDecision", "The endpoint policy can only continue or reject this request; it cannot provide file claim authority."],
      ["EndpointMultipartIngressLimits", "Runtime-owned bounds and stable identifiers for one endpoint multipart ingress request."],
      ["EndpointActorMultipartIngressOptions", "Actor-owned ingress may apply a request-specific admission policy."],
      ["EndpointCapsulePrincipalMultipartIngressOptions", "Capsule-principal ingress has its separate Capsule-level admission policy and cannot add actor admission."],
      ["EndpointMultipartIngressOptions", "One of the supported endpoint multipart ingress authority modes."],
      ["EndpointFileAttachmentOptionsDeclaration", "Endpoint declaration that permits an opaque File attachment response."],
      ["EndpointBuilder", "Schema-bound endpoint declaration helper for callbacks that read the Capsule database before request-body handling."],
    ];
    const supportedAdmissionTypes = [
      "EndpointMultipartAdmissionRequest",
      "EndpointMultipartAdmissionContext",
      "EndpointMultipartAdmissionDecision",
      "EndpointMultipartIngressLimits",
      "EndpointActorMultipartIngressOptions",
      "EndpointCapsulePrincipalMultipartIngressOptions",
      "EndpointMultipartIngressOptions",
      "EndpointFileAttachmentOptionsDeclaration",
      "EndpointBuilder",
    ];
    for (const declaration of [packedServerTypes, packedGeneratedServerTypes, generatedServerTypes]) {
      for (const [name, description] of admissionTypeMetadata) {
        const escapedDescription = description.replaceAll(".", "\\.");
        assert.match(declaration, new RegExp(`/\\*\\* ${escapedDescription} \\*/\\s*export type ${name}`));
      }
      for (const name of supportedAdmissionTypes) {
        assert.doesNotMatch(declaration, new RegExp(`/\\*\\*[^*]*@deprecated[^*]*\\*/\\s*export type ${name}`));
      }
      assert.match(declaration, /\/\*\* Bind a declared Capsule schema once when endpoint admission needs schema-aware read-only database typing\. \*\/\s*export (?:declare )?function endpointFor/);
      assert.doesNotMatch(declaration, /\/\*\*[^*]*@deprecated[^*]*\*\/\s*export (?:declare )?function endpointFor/);
    }
    const probe = path.join(dir, "consumer", "probe.mjs");
    await writeFile(probe, [
      'import { accessKeys } from "sporades/client";',
      'import { endpointFor, requireAuth, requireUserAuth } from "sporades/server";',
      'const names = Object.keys(accessKeys).sort();',
      'if (JSON.stringify(names) !== JSON.stringify(["delete", "issue", "list", "revoke", "rotate"])) process.exit(1);',
      'if (typeof requireAuth !== "function" || typeof requireUserAuth !== "function" || typeof endpointFor({}) !== "function") process.exit(2);',
    ].join("\n"));
    const result = await run(process.execPath, [probe]);
    assert.equal(result.stderr, "");
    const typeProbe = path.join(dir, "consumer", "probe.ts");
    await writeFile(typeProbe, `
import { capsule, endpoint, endpointFor, requireAuth, requireUserAuth, String, table, type AccessKeyRevocationCause, type AccessKeyStatus,
  type CredentialProvenance, type EndpointMultipartIngressOptions } from "sporades/server";
import { accessKeys, type AccessKeySummary, type AccessKeyErrorCode,
  type AccessKeyRevocationCause as ClientAccessKeyRevocationCause } from "sporades/client";
endpoint({ method: "GET", path: "/probe" }, requireAuth({ credentials: ["access-key"] as const, scopes: ["requests:read"] },
  (ctx) => { const kind: "access-key" = ctx.credential.kind; return { kind, path: ctx.request.path }; }));
declare const inlineContext: { auth: Parameters<typeof requireUserAuth>[0]["auth"] };
requireUserAuth(inlineContext);
requireAuth(inlineContext);
const status: AccessKeyStatus = "active";
const cause: AccessKeyRevocationCause = "operator";
const administratorCause: ClientAccessKeyRevocationCause = "service-user-administrator";
const disabledCause: AccessKeySummary["revocationCause"] = "service-user-disabled";
// @ts-expect-error unknown revocation causes must remain rejected by the public client contract
const unknownCause: AccessKeySummary["revocationCause"] = "invented-service-user-cause";
const provenance: CredentialProvenance = { kind: "access-key", id: "key-id", name: "automation" };
const multipartLimits = { maxFiles: 1, maxFileBytes: 1, maxTotalFileBytes: 1, maxFieldCount: 0, maxFieldBytes: 0,
  maxTotalFieldBytes: 0, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id" } as const;
const actorMultipart: EndpointMultipartIngressOptions = { ...multipartLimits, admit: () => ({ allow: true }) };
const principalMultipart: EndpointMultipartIngressOptions = { ...multipartLimits, claimAuthorities: ["capsule-principal"] };
// @ts-expect-error Capsule-principal ingress cannot add actor multipart admission
const invalidPrincipalMultipart: EndpointMultipartIngressOptions = { ...multipartLimits, claimAuthorities: ["capsule-principal"], admit: () => ({ allow: true }) };
const typedAdmissionSchema = { resources: table({ state: String() }) };
const defineTypedAdmissionEndpoint = endpointFor(typedAdmissionSchema);
// @ts-expect-error Schema-bound endpoint declarations keep Capsule-principal ingress separate from actor admission
defineTypedAdmissionEndpoint({ method: "POST", path: "/invalid-principal-admission", body: { multipart: { ...multipartLimits, claimAuthorities: ["capsule-principal"] as const, admit: () => ({ allow: true }) } } }, async () => ({ status: 200 }));
const typedAdmission = capsule({ name: "typed-admission", schema: typedAdmissionSchema, endpoints: {
  upload: defineTypedAdmissionEndpoint({ method: "POST", path: "/typed-admission", body: { multipart: { ...multipartLimits, admit: async ({ db }) => {
    const resource = await db.resources.where("id", "resource").get();
    const state: string | null | undefined = resource?.state;
    // @ts-expect-error an undeclared table is not available in normal capsule endpoint admission
    await db.missingResources.get();
    // @ts-expect-error row fields retain the declared schema in normal capsule endpoint admission
    resource?.missingField;
    return { allow: state === "available" };
  } } } }, async () => ({ status: 200 })),
} });
const typedAdmissionName: "typed-admission" = typedAdmission.name;
const typedAdmissionUpload = typedAdmission.endpoints.upload;
const futureSafeCode: string = "FUTURE_CODE" satisfies string;
const knownCode: AccessKeyErrorCode = "TRANSPORT_CLOSED";
const list: Promise<unknown> = accessKeys.list({ status });
declare const summary: AccessKeySummary;
void [cause, administratorCause, disabledCause, unknownCause, provenance, actorMultipart, principalMultipart, invalidPrincipalMultipart, typedAdmissionName, typedAdmissionUpload, futureSafeCode, knownCode, list, summary];
`);
    await run(process.execPath, [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict",
      "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", typeProbe], {
      cwd: path.join(dir, "consumer"),
    });
    const generatedTypeProbe = path.join(dir, "consumer", "generated-probe.ts");
    await writeFile(generatedTypeProbe, `
import { Date, Json, Reference, endpointFor, String, table, type AuthGuardedHandler, type EndpointActorMultipartIngressOptions, type EndpointBodyBytes, type EndpointCapsulePrincipalMultipartIngressOptions, type EndpointContext, type EndpointFileAttachmentApi, type EndpointFileAttachmentContext, type EndpointFileAttachmentOptions, type EndpointFileAttachmentOptionsDeclaration, type EndpointFileAttachmentReference, type EndpointFileAttachmentResponse, type EndpointFileIngressApi, type EndpointFileIngressInspection, type EndpointFileIngressLease, type EndpointFileMetadata, type EndpointMultipartAdmissionContext, type EndpointMultipartAdmissionDecision, type EndpointMultipartAdmissionRequest, type EndpointMultipartIngressLimits, type EndpointMultipartIngressOptions, type EndpointRequest, type FileIngressAdmissionContext, type FileIngressAdmissionDecision, type FileIngressAdmissionRequest, type FileIngressOptions, type FileIngressPrincipal, type JsonValue } from ${JSON.stringify(path.join(repoRoot, "dist", "server.js"))};
import type { EndpointBodyBytes as CanonicalBodyBytes, EndpointContext as CanonicalEndpointContext, EndpointFileAttachmentApi as CanonicalAttachmentApi, EndpointFileAttachmentContext as CanonicalAttachmentContext, EndpointFileAttachmentOptions as CanonicalAttachmentFileOptions, EndpointFileAttachmentOptionsDeclaration as CanonicalAttachmentOptions, EndpointFileAttachmentReference as CanonicalAttachmentReference, EndpointFileAttachmentResponse as CanonicalAttachmentResponse, EndpointFileIngressApi as CanonicalIngressApi, EndpointFileIngressInspection as CanonicalIngressInspection, EndpointFileIngressLease as CanonicalIngressLease, EndpointFileMetadata as CanonicalFileMetadata, EndpointMultipartAdmissionContext as CanonicalAdmissionContext, EndpointMultipartAdmissionRequest as CanonicalAdmissionRequest, EndpointMultipartIngressOptions as CanonicalIngressOptions, EndpointRequest as CanonicalEndpointRequest, FileIngressOptions as CanonicalFileIngressOptions } from ${JSON.stringify(path.join(repoRoot, "src", "types", "server.d.ts"))};
const schema = { resources: table({ state: String(), availableAt: Date(), detail: Json(), ownerId: Reference("owners") }) };
const defineEndpoint = endpointFor(schema);
declare const requestHead: FileIngressAdmissionRequest;
const admissionRequest: EndpointMultipartAdmissionRequest = requestHead;
const canonicalRequest: CanonicalAdmissionRequest = admissionRequest;
const generatedRequest: EndpointMultipartAdmissionRequest = canonicalRequest;
declare const admissionContext: EndpointMultipartAdmissionContext;
declare const ingressContext: FileIngressAdmissionContext;
declare const ingressPrincipal: FileIngressPrincipal;
const admissionDecision: EndpointMultipartAdmissionDecision = { allow: true };
const ingressDecision: FileIngressAdmissionDecision = { allow: true, principal: ingressPrincipal };
const ingressLimits: EndpointMultipartIngressLimits = {
  maxFiles: 1, maxFileBytes: 1, maxTotalFileBytes: 1, maxFieldCount: 0, maxFieldBytes: 0, maxTotalFieldBytes: 0,
  allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id",
};
const unboundIngress: EndpointMultipartIngressOptions = {
  ...ingressLimits,
};
const actorIngress: EndpointActorMultipartIngressOptions = { ...ingressLimits, admit: ({ request }) => ({ allow: request === requestHead }) };
const principalIngress: EndpointCapsulePrincipalMultipartIngressOptions = { ...ingressLimits, claimAuthorities: ["capsule-principal"] };
// @ts-expect-error generated schema-bound declarations keep Capsule-principal ingress separate from actor admission
defineEndpoint({ method: "POST", path: "/invalid-principal", body: { multipart: { ...ingressLimits, claimAuthorities: ["capsule-principal"] as const, admit: () => ({ allow: true }) } } }, async () => ({ status: 200 }));
const attachmentOptions: EndpointFileAttachmentOptionsDeclaration = { method: "GET", path: "/attachment", response: { fileAttachment: true } };
const canonicalIngress: CanonicalIngressOptions = unboundIngress;
const generatedIngress: EndpointMultipartIngressOptions = canonicalIngress;
const canonicalContext: CanonicalAdmissionContext = admissionContext;
const generatedContext: EndpointMultipartAdmissionContext = canonicalContext;
const canonicalAttachment: CanonicalAttachmentOptions = attachmentOptions;
const generatedAttachment: EndpointFileAttachmentOptionsDeclaration = canonicalAttachment;
declare const endpointContext: EndpointContext<typeof schema>;
const canonicalEndpointContext: CanonicalEndpointContext<typeof schema> = endpointContext;
const generatedEndpointContext: EndpointContext<typeof schema> = canonicalEndpointContext;
declare const attachmentContext: EndpointFileAttachmentContext<typeof schema>;
const canonicalAttachmentContext: CanonicalAttachmentContext<typeof schema> = attachmentContext;
const generatedAttachmentContext: EndpointFileAttachmentContext<typeof schema> = canonicalAttachmentContext;
declare const endpointRequest: EndpointRequest;
const canonicalEndpointRequest: CanonicalEndpointRequest = endpointRequest;
const generatedEndpointRequest: EndpointRequest = canonicalEndpointRequest;
declare const ingressLease: EndpointFileIngressLease;
const canonicalIngressLease: CanonicalIngressLease = ingressLease;
const generatedIngressLease: EndpointFileIngressLease = canonicalIngressLease;
declare const ingressApi: EndpointFileIngressApi;
const canonicalIngressApi: CanonicalIngressApi = ingressApi;
const generatedIngressApi: EndpointFileIngressApi = canonicalIngressApi;
declare const attachmentApi: EndpointFileAttachmentApi;
const canonicalAttachmentApi: CanonicalAttachmentApi = attachmentApi;
const generatedAttachmentApi: EndpointFileAttachmentApi = canonicalAttachmentApi;
declare const bodyBytes: EndpointBodyBytes;
const canonicalBodyBytes: CanonicalBodyBytes = bodyBytes;
const generatedBodyBytes: EndpointBodyBytes = canonicalBodyBytes;
declare const inspectionResult: EndpointFileIngressInspection;
const canonicalInspectionResult: CanonicalIngressInspection = inspectionResult;
const generatedInspectionResult: EndpointFileIngressInspection = canonicalInspectionResult;
declare const fileMetadata: EndpointFileMetadata;
const canonicalFileMetadata: CanonicalFileMetadata = fileMetadata;
const generatedFileMetadata: EndpointFileMetadata = canonicalFileMetadata;
declare const ingressOptions: FileIngressOptions;
const canonicalFileIngressOptions: CanonicalFileIngressOptions = ingressOptions;
const generatedFileIngressOptions: FileIngressOptions = canonicalFileIngressOptions;
declare const attachmentReference: EndpointFileAttachmentReference;
const canonicalAttachmentReference: CanonicalAttachmentReference = attachmentReference;
const generatedAttachmentReference: EndpointFileAttachmentReference = canonicalAttachmentReference;
declare const attachmentFileOptions: EndpointFileAttachmentOptions;
const canonicalAttachmentFileOptions: CanonicalAttachmentFileOptions = attachmentFileOptions;
const generatedAttachmentFileOptions: EndpointFileAttachmentOptions = canonicalAttachmentFileOptions;
declare const attachmentResponse: EndpointFileAttachmentResponse;
const canonicalAttachmentResponse: CanonicalAttachmentResponse = attachmentResponse;
const generatedAttachmentResponse: EndpointFileAttachmentResponse = canonicalAttachmentResponse;
defineEndpoint({ method: "GET", path: "/attachment", response: { fileAttachment: true } }, async (ctx: EndpointFileAttachmentContext<typeof schema>) => {
  const resource = await ctx.db.resources.where("id", "resource").get();
  return ctx.files.attachment({ id: resource?.id ?? "resource", version: "version" }, { filename: "resource" });
});
declare const guarded: AuthGuardedHandler<(ctx: EndpointContext<typeof schema>) => Promise<{ status: number }>>;
defineEndpoint({ method: "POST", path: "/guarded" }, guarded);
defineEndpoint({ method: "POST", path: "/generated", body: { multipart: {
  maxFiles: 1, maxFileBytes: 1, maxTotalFileBytes: 1, maxFieldCount: 0, maxFieldBytes: 0, maxTotalFieldBytes: 0,
  allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id",
  admit: async ({ db }) => {
    const resource = await db.resources.where("id", "resource").get();
    const state: string | null | undefined = resource?.state;
    const availableAt: string | Date | null | undefined = resource?.availableAt;
    const detail: JsonValue | null | undefined = resource?.detail;
    const ownerId: string | null | undefined = resource?.ownerId;
    // @ts-expect-error generated declaration rejects undeclared admission tables
    await db.missingResources.get();
    // @ts-expect-error generated declaration retains declared row fields
    resource?.missingField;
    return { allow: state === "available" && !!availableAt && detail !== undefined && ownerId !== undefined };
  },
} } }, async (ctx: EndpointContext<typeof schema>) => {
  const lease = ctx.request.multipart?.files[0];
  if (!lease) return { status: "no-file" };
  const file = await ctx.files.claim(lease, { path: "/resources" });
  const inspection = await ctx.files.inspection(lease);
  const status = await ctx.files.status("request", "part");
  return { file, inspection, status };
});
void [admissionRequest, generatedRequest, admissionContext, ingressContext, admissionDecision, ingressDecision, unboundIngress, actorIngress, principalIngress, attachmentOptions, generatedIngress, generatedContext, generatedAttachment, generatedEndpointContext, generatedAttachmentContext, generatedEndpointRequest, generatedIngressLease, generatedIngressApi, generatedAttachmentApi, generatedBodyBytes, generatedInspectionResult, generatedFileMetadata, generatedFileIngressOptions, generatedAttachmentReference, generatedAttachmentFileOptions, generatedAttachmentResponse];
`);
    await run(process.execPath, [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict",
      "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", generatedTypeProbe], {
      cwd: path.join(dir, "consumer"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
