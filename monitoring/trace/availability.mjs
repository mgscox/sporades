import { createServer } from 'node:http';
import { createBlackboxDiscovery } from './blackbox-config.mjs';
import { createInventoryStore } from './inventory-store.mjs';

// This listener is private to the Compose network. It has no write authority,
// sender credentials or outbound probe loop. Prometheus owns scheduling.
export function createAvailabilityServer({ inventoryDirectory, blackboxDirectory, blackboxReloadUrl }) {
  const store = createInventoryStore(inventoryDirectory);
  const discover = blackboxDirectory ? createBlackboxDiscovery(blackboxDirectory, blackboxReloadUrl) : null;
  return createServer(async (req, res) => {
    if (req.method !== 'GET' || !['/metrics', '/targets'].includes(req.url)) { res.writeHead(404).end(); return; }
    try {
      const inventory = await store.list();
      const probe = req.url === '/targets' && discover ? await discover() : null;
      const targets = [];
      const lines = [];
      const label = value => JSON.stringify(value);
      for (const { inventory: host, acknowledgedAt, expectationSince } of inventory) {
        const active = host.capsules.filter(capsule => ['running', 'failed'].includes(capsule.state));
        const h = `host=${label(host.host)}`;
        lines.push(`sporades_expected_host{${h}} ${active.length ? 1 : 0}`);
        if (active.length) lines.push(`sporades_host_expected_since_seconds{${h}} ${Math.min(...active.map(capsule => Date.parse(expectationSince[capsule.id] ?? acknowledgedAt) / 1000))}`);
        lines.push(`sporades_inventory_acknowledged_seconds{${h}} ${Date.parse(acknowledgedAt) / 1000}`);
        for (const capsule of host.capsules) {
          lines.push(`sporades_inventory_state{${h},service_name=${label(capsule.id)},state=${label(capsule.state)}} 1`);
          if (!active.includes(capsule)) continue;
          lines.push(`sporades_expected_capsule{${h},service_name=${label(capsule.id)}} 1`);
          lines.push(`sporades_capsule_expected_since_seconds{${h},service_name=${label(capsule.id)}} ${Date.parse(expectationSince[capsule.id] ?? acknowledgedAt) / 1000}`);
          for (const target of capsule.targets) {
            targets.push({ targets: [`${target}__sporades/probe`], labels: { host: host.host, service_name: capsule.id, target, ...(probe ? { __param_module: 'sporades_application' } : {}) } });
          }
        }
      }
      res.writeHead(200, { 'content-type': req.url === '/targets' ? 'application/json' : 'text/plain; version=0.0.4', 'cache-control': 'no-store' });
      res.end(req.url === '/targets' ? JSON.stringify(targets) : lines.join('\n') + '\n');
    } catch { res.writeHead(503).end(); }
  });
}
