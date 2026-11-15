import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";

async function keyPanel(accessKeys) {
  const source = await readFile(new URL("../examples/todo-mcp/client/index.tsx", import.meta.url), "utf8");
  const { code } = await transform(`${source}\nexport { Keys };`, { loader: "tsx", format: "cjs", jsxFactory: "element" });
  const states = [], effects = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = value; }];
    },
    useEffect(effect) { effects.push(effect); },
  };
  const sdk = { accessKeys, createHooks: () => ({ useQuery: () => ({ data: [] }), useMutation: () => ({}) }) };
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    require(name) {
      if (name === "react") return hooks;
      if (name === "react-dom/client") return { createRoot: () => ({ render() {} }) };
      if (name === "sporades/client") return sdk;
      if (name === "./style.css") return {};
      throw new Error(`Unexpected import: ${name}`);
    },
    document: { getElementById() {} },
    element: (tag, props, ...children) => ({ tag, props, children: children.flat().filter(Boolean) }),
  });
  const render = () => { cursor = 0; return module.exports.Keys(); };
  render();
  for (const effect of effects.splice(0)) effect();
  const find = predicate => {
    const visit = node => predicate(node) ? node : node.children?.map(visit).find(Boolean);
    return visit(render());
  };
  return {
    notice: () => find(node => node.tag === "p" && node.props?.role === "status").children.join(""),
    keyNames: () => find(node => node.tag === "ul").children.map(node => node.children[0]),
    issue: () => find(node => node.tag === "form").props.onSubmit({ preventDefault() {} }),
  };
}

test("key panel loads existing keys silently and reports Saved only after an action", async () => {
  const load = Promise.withResolvers();
  let listCalls = 0, issueCalls = 0;
  const panel = await keyPanel({
    list: () => { listCalls++; return load.promise; },
    issue: async () => { issueCalls++; return { data: {}, error: null }; },
  });
  assert.equal(panel.notice(), "");
  load.resolve({ data: { accessKeys: [{ id: "existing", name: "Existing key", status: "active" }] }, error: null });
  await setImmediate();
  assert.equal(listCalls, 1);
  assert.equal(panel.keyNames().join(","), "Existing key");
  assert.equal(panel.notice(), "");
  assert.equal(issueCalls, 0);
  panel.issue();
  await setImmediate();
  assert.equal(issueCalls, 1);
  assert.equal(listCalls, 2);
  assert.equal(panel.notice(), "Saved");
});

test("key panel shows an initial list error", async () => {
  const panel = await keyPanel({ list: async () => ({ data: null, error: { message: "Unable to load keys" } }) });
  await setImmediate();
  assert.equal(panel.notice(), "Unable to load keys");
});
