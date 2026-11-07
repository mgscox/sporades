// Compiler startup is fixture setup, not a product latency assertion. Keep one
// bounded budget for parallel Bundle fixtures and report early child exits.
export async function waitForHttp(url, child, expectedStatus = 'ok') {
  const deadline = performance.now() + 30000;
  let lastError;
  let stderr = '';
  const onStderr = chunk => { stderr = (stderr + chunk).slice(-4096); };
  child.stderr?.on('data', onStderr);
  try {
    while (performance.now() < deadline) {
      if (child.exitCode !== null || child.signalCode != null) throw Error(`Server exited before serving ${url}: ${stderr}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (expectedStatus === 'any' || (expectedStatus === 'ok' || expectedStatus === null ? response.ok : response.status === expectedStatus)) return response;
        await response.body?.cancel();
        lastError = Error(`Unexpected status ${response.status}`);
      } catch (error) { lastError = error; }
      finally { clearTimeout(timer); }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`Server readiness timed out: ${lastError?.message ?? 'no response'} ${stderr}`);
  } finally { child.stderr?.off('data', onStderr); }
}
