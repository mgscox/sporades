export async function verifyAvailabilityRules({ run, repo, project }) {
  try {
    return await run('docker', ['run', '--rm', '--name', project + '-rules', '--entrypoint', 'promtool', '-v', repo + ':/workspace:ro', '-w', '/workspace/test/fixtures', 'prom/prometheus:v3.13.3', 'test', 'rules', 'availability-rules.test.yaml'], { timeout: 30_000 });
  } catch (failure) {
    const stderr = String(failure?.stderr ?? '');
    const permission = /permission denied/i.test(stderr) && /\/workspace|availability-rules(?:\.test)?\.yaml/i.test(stderr);
    const missing = /no file match pattern[^\n]*availability-rules\.yaml/i.test(stderr);
    const error = new Error(permission || missing
      ? 'Availability rule preflight failed before stack launch: pinned promtool runs as non-root and cannot discover or read the mounted rules. A mode-0700 source directory, missing rule file or unreadable fixture can block validation. Use a disposable readable copy containing only the rule fixtures; do not relax permissions on protected operator data.'
      : 'Availability rule preflight failed before stack launch: pinned promtool did not validate the rule fixtures. Check Docker daemon access, the pinned image and rule syntax; this is not a notification-delivery result.');
    error.code = permission ? 'AVAILABILITY_RULE_PREFLIGHT_PERMISSION' : missing ? 'AVAILABILITY_RULE_PREFLIGHT_SOURCE' : 'AVAILABILITY_RULE_PREFLIGHT_FAILED';
    throw error;
  }
}
