import { createGateway } from '../../monitoring/trace/gateway.mjs';

const gateway = createGateway({
  ingestToken: 'test-token', uiUser: 'viewer', uiPassword: 'secret',
  collectorUrl: process.env.TEST_COLLECTOR_URL,
  jaegerUrl: process.env.TEST_UI_URL ?? 'http://127.0.0.1:1',
  uiRequestDeadlineMs: Number(process.env.TEST_UI_DEADLINE_MS) || undefined,
});
gateway.listen(0, '127.0.0.1', () => process.stdout.write(`${gateway.address().port}\n`));
