import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'acorn';

// Keep PDF loader probes out of dist: parallel npm pack/parity checks must see
// an immutable generated tree. Absolute imports retain the real dependencies.
export async function isolatedIngressRuntime(source) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sporades-ingress-runtime-'));
  try {
    const imports = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.filter(node => node.type === 'ImportDeclaration');
    const original = new URL('../../dist/file-ingress-runtime.js', import.meta.url);
    for (const node of imports.reverse()) {
      const specifier = node.source.value;
      const resolved = specifier.startsWith('.') ? new URL(specifier, original).href : import.meta.resolve(specifier);
      source = source.slice(0, node.source.start) + JSON.stringify(resolved) + source.slice(node.source.end);
    }
    const runtimeUrl = pathToFileURL(path.join(directory, 'runtime.mjs'));
    await writeFile(runtimeUrl, source);
    return { directory, runtimeUrl };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
