import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A renderer fixture is a separate project. Parent checkout package/tsconfig
// settings must not turn its default CommonJS or sloppy-mode cases into ESM or
// strict code. Individual tests can replace either boundary when that is the case.
export async function createPrerenderFixture(prefix) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  try {
    await writeFile(path.join(root, 'package.json'), '{"type":"commonjs"}\n');
    await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{}}\n');
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
