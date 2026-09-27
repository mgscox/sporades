import { createGateway } from '../../monitoring/trace/gateway.mjs';

const gateway = createGateway({
  ingestToken: 'test-token', uiUser: 'viewer', uiPassword: 'secret',
  collectorUrl: process.env.TEST_COLLECTOR_URL,
  jaegerUrl: 'http://127.0.0.1:1',
});
gateway.listen(0, '127.0.0.1', () => process.stdout.write(`${gateway.address().port}\n`));
