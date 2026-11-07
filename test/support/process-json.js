// First-response setup for a spawned CLI or generated Capsule. Product request
// and transport deadlines are asserted separately from process startup.
export function waitForProcessJson(child, { timeoutMs = 60000, label = 'Process' } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for JSON output.\nstdout:\n${stdout}\nstderr:\n${stderr}`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const finish = (error, value) => { cleanup(); error ? reject(error) : resolve(value); };
    const onStdout = chunk => {
      stdout += chunk;
      const lines = stdout.split('\n');
      const index = lines.findIndex(candidate => candidate.trim());
      if (index < 0) return;
      const line = lines[index];
      try { finish(null, JSON.parse(line)); }
      catch (error) { if (index < lines.length - 1) finish(error); }
    };
    const onStderr = chunk => { stderr += chunk; };
    const onExit = code => finish(new Error(`${label} exited with ${code} before JSON output.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    const onError = error => finish(error);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}
