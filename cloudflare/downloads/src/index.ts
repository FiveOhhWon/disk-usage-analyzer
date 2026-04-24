import {
  assertReleaseChannel,
  assertReleasePlatform,
  type ReleaseArtifact,
  type ReleaseChannel,
  type ReleaseManifest,
  validateManifest,
} from "./manifest";

const jsonHeaders = {
  "content-type": "application/json;charset=UTF-8",
};

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...jsonHeaders,
      ...Object.fromEntries(new Headers(init?.headers)),
    },
  });
}

function isUnsafeSegment(rawSegment: string) {
  const lower = rawSegment.toLowerCase();
  if (lower.includes("%2f") || lower.includes("%5c")) return true;
  try {
    const decoded = decodeURIComponent(rawSegment);
    return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
  } catch {
    return true;
  }
}

function decodeSafeSegment(rawSegment: string) {
  if (isUnsafeSegment(rawSegment)) {
    throw new Response(JSON.stringify({ error: "invalid_artifact_path" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
  return decodeURIComponent(rawSegment);
}

function attachmentFileName(fileName: string) {
  return fileName.replaceAll("\\", "_").replaceAll('"', '\\"');
}

async function readJsonObject<T>(bucket: R2Bucket, key: string, notFoundError: string): Promise<T> {
  const object = await bucket.get(key);
  if (!object) {
    throw new Response(JSON.stringify({ error: notFoundError }), {
      status: 404,
      headers: jsonHeaders,
    });
  }
  return JSON.parse(await object.text()) as T;
}

async function readLatestManifest(env: Env, channel: ReleaseChannel): Promise<ReleaseManifest> {
  const manifest = await readJsonObject<ReleaseManifest>(env.RELEASES, `manifests/${channel}/latest.json`, "manifest_not_found");
  return validateManifest(manifest);
}

async function streamArtifact(env: Env, key: string, artifact?: ReleaseArtifact, method = "GET") {
  let object = await env.RELEASES.get(key);
  if (!object && key.includes("%")) {
    object = await env.RELEASES.get(decodeURIComponent(key));
  }
  if (!object) {
    return jsonResponse({ error: "artifact_not_found" }, { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");

  if (artifact) {
    headers.set("content-disposition", `attachment; filename="${attachmentFileName(artifact.fileName)}"`);
    headers.set("x-checksum-sha256", artifact.sha256);
    headers.set("content-length", String(artifact.size));
  }

  return new Response(method === "HEAD" ? null : object.body, { headers });
}

async function handleLatestManifest(request: Request, env: Env) {
  const url = new URL(request.url);
  const channel = assertReleaseChannel(url.searchParams.get("channel") ?? "nightly");
  const manifest = await readLatestManifest(env, channel);
  return jsonResponse(manifest, {
    headers: {
      "cache-control": "public, max-age=60",
    },
  });
}

async function handleLatestDownload(parts: string[], env: Env, method: string) {
  const channel = assertReleaseChannel(parts[1]);
  const platform = assertReleasePlatform(parts[2]);
  const manifest = await readLatestManifest(env, channel);
  const artifact = manifest.artifacts.find((item) => item.platform === platform);
  if (!artifact) {
    return jsonResponse({ error: "platform_not_found" }, { status: 404 });
  }
  return streamArtifact(env, artifact.r2Key, artifact, method);
}

async function handlePinnedArtifact(parts: string[], env: Env, method: string) {
  if ((parts.length !== 4 && parts.length !== 5) || parts.some(isUnsafeSegment)) {
    return jsonResponse({ error: "invalid_artifact_path" }, { status: 400 });
  }
  const channel = assertReleaseChannel(parts[1]);
  const decodedParts = parts.map(decodeSafeSegment);

  if (parts.length === 5) {
    assertReleasePlatform(parts[3]);
    return streamArtifact(env, decodedParts.join("/"), undefined, method);
  }

  const version = decodedParts[2];
  const fileName = decodedParts[3];
  const prefix = `artifacts/${channel}/${version}/`;
  const listed = await env.RELEASES.list({ prefix, limit: 100 });
  const match = listed.objects.find((object) => object.key.split("/").at(-1) === fileName);
  if (!match) {
    return jsonResponse({ error: "artifact_not_found" }, { status: 404 });
  }
  return streamArtifact(env, match.key, undefined, method);
}

async function route(request: Request, env: Env) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
  }

  try {
    if (url.pathname === "/api/releases/latest") {
      return await handleLatestManifest(request, env);
    }
    if (parts[0] === "download") {
      return await handleLatestDownload(parts, env, request.method);
    }
    if (parts[0] === "artifacts") {
      return await handlePinnedArtifact(parts, env, request.method);
    }
    return env.ASSETS.fetch(request);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error("download worker error", error);
    return jsonResponse({ error: "internal_error" }, { status: 500 });
  }
}

export default {
  fetch: route,
} satisfies ExportedHandler<Env>;
