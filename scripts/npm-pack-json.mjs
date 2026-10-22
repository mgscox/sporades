/** Normalize npm pack --json output across the flat and package-keyed formats. */
export function parseNpmPackJson(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) throw new Error("npm pack did not report a tarball filename.");

  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error("npm pack returned invalid JSON output.");
  }

  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > 1) throw new Error("npm pack output must describe exactly one package.");
  let artifact = entries[0];
  if (artifact && typeof artifact === "object" && !Array.isArray(artifact) && !Object.hasOwn(artifact, "filename")) {
    const packages = Object.values(artifact);
    if (packages.length > 1) throw new Error("npm pack output must describe exactly one package.");
    artifact = packages[0];
  }
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) ||
      typeof artifact.filename !== "string" || !artifact.filename.trim()) {
    throw new Error("npm pack output did not include a tarball filename.");
  }
  return [artifact];
}
