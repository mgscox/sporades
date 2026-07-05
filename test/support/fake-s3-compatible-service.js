import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";

export async function withFakeS3CompatibleService(fn) {
  const requests = [];
  const objects = new Map();
  let bucketCreated = false;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/minio/health/ready") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}\n');
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    if (!verifyFakeS3Signature(request, body)) {
      response.writeHead(403);
      response.end();
      return;
    }

    const bucketPrefix = "/sporades-files";
    if (request.url === bucketPrefix) {
      if (request.method === "HEAD") {
        response.writeHead(bucketCreated ? 200 : 404);
        response.end();
        return;
      }
      if (request.method === "PUT") {
        bucketCreated = true;
        response.writeHead(200);
        response.end();
        return;
      }
    }

    if (!request.url?.startsWith(`${bucketPrefix}/`)) {
      response.writeHead(404);
      response.end();
      return;
    }

    const objectKey = decodeURIComponent(request.url.slice(bucketPrefix.length + 1));
    if (request.method === "PUT") {
      objects.set(objectKey, body);
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method === "GET") {
      const stored = objects.get(objectKey);
      if (!stored) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(stored);
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(objectKey);
      response.writeHead(204);
      response.end();
      return;
    }

    response.writeHead(405);
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    return await fn({
      endpoint: `http://127.0.0.1:${address.port}`,
      port: address.port,
      requests,
      objects,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function verifyFakeS3Signature(request, body) {
  const authorization = request.headers.authorization ?? "";
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
    authorization,
  );
  if (!match) {
    return false;
  }
  const [, accessKey, date, region, signedHeadersSource, signature] = match;
  if (accessKey !== "sporades") {
    return false;
  }
  const payloadHash = createHash("sha256").update(body).digest("hex");
  if (request.headers["x-amz-content-sha256"] !== payloadHash) {
    return false;
  }

  const signedHeaders = signedHeadersSource.split(";");
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${String(request.headers[name] ?? "").trim()}\n`).join("");
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const canonicalRequest = [request.method, pathname, "", canonicalHeaders, signedHeadersSource, payloadHash].join("\n");
  const amzDate = request.headers["x-amz-date"];
  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const signingKey = fakeS3SigningKey("sporades-minio-local-secret", date, region);
  const expected = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return expected === signature;
}

function fakeS3SigningKey(secretKey, date, region) {
  const dateKey = createHmac("sha256", `AWS4${secretKey}`).update(date).digest();
  const dateRegionKey = createHmac("sha256", dateKey).update(region).digest();
  const dateRegionServiceKey = createHmac("sha256", dateRegionKey).update("s3").digest();
  return createHmac("sha256", dateRegionServiceKey).update("aws4_request").digest();
}
