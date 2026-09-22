import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { placeClientPrerenderFragments } from '../dist/client-prerender.js';
import { createClientRuntimeSource } from '../dist/templates/client-runtime-template.js';

test('prerender handover exposes opaque snapshots and deliberate idempotent dismissal in head and body', async () => {
  const window = new Window();
  const previousDocument = globalThis.document;
  globalThis.document = window.document;
  try {
    const { html } = placeClientPrerenderFragments('<html><head><!-- sporades:prerender head --></head><body><p id="before">keep</p><!-- sporades:prerender landing --><hr><!-- sporades:prerender landing --><!-- sporades:prerender retained --><p id="after">keep</p></body></html>', [
      {name:'head', html:'<meta name="static-shell" content="yes">'},
      {name:'landing', html:'<main>Static landing</main><aside>Second root</aside>'},
      {name:'retained', html:'<footer>Keep this fragment</footer>'},
    ]);
    window.document.write(html);
    for (const runtime of [
      await import('../dist/client.js'),
      await import(`data:text/javascript;base64,${Buffer.from(createClientRuntimeSource()).toString('base64')}`),
    ]) {
      document.open(); document.write(html); document.close();
      const api = runtime.prerender;
      assert.ok(api, 'prerender must be exported by both shipped client surfaces');
      assert.equal(document.querySelectorAll('main').length, 2, 'importing never dismisses');
      const snapshot = api.discover();
      assert.ok(Object.isFrozen(snapshot));
      assert.deepEqual(snapshot.map((handle) => handle.name), ['head', 'landing', 'landing', 'retained']);
      assert.notEqual(snapshot[1], snapshot[2]);
      for (const handle of snapshot) {
        assert.deepEqual(Object.keys(handle).sort(), ['dismiss', 'name']);
        assert.ok(Object.isFrozen(handle));
      }
      snapshot[1].dismiss(); snapshot[1].dismiss();
      assert.equal(document.querySelectorAll('main').length, 1);
      assert.equal(document.querySelectorAll('aside').length, 1);
      assert.equal(snapshot.length, 4, 'snapshot is not live');
      assert.equal(api.discover().length, 3);
      api.dismiss('missing');
      for (const handle of snapshot.filter((handle) => handle.name === 'head')) handle.dismiss();
      assert.equal(document.querySelector('meta[name="static-shell"]'), null);
      api.dismiss('landing'); api.dismiss('landing');
      assert.equal(document.querySelector('main'), null);
      assert.equal(document.querySelector('aside'), null);
      assert.equal(document.querySelector('footer').textContent, 'Keep this fragment');
      assert.deepEqual(api.discover().map((handle) => handle.name), ['retained']);
      api.dismiss(); api.dismiss();
      assert.equal(document.querySelector('footer'), null);
      assert.equal(document.querySelector('#before').textContent, 'keep');
      assert.equal(document.querySelector('#after').textContent, 'keep');
      assert.ok(document.querySelector('hr'));
      assert.deepEqual(api.discover(), []);
      for (const handle of snapshot) handle.dismiss();
    }
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    await window.happyDOM.close();
  }
});
