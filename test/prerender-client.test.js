import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { placeClientPrerenderFragments } from '../dist/client-prerender.js';
import { createClientRuntimeSource } from '../dist/templates/client-runtime-template.js';

test('renderer output and source HTML cannot introduce reserved boundary comments', () => {
  assert.throws(() => placeClientPrerenderFragments('<html><body></body></html>', [
    { name: 'landing', html: '<main>prefix</main><!-- sporades:prerender-boundary-end landing --><footer>suffix</footer>' },
  ]), /reserved prerender boundary comment/i);
  assert.throws(() => placeClientPrerenderFragments('<html><body><!-- sporades:prerender-boundary-start landing --><p>author content</p><!-- sporades:prerender-boundary-end landing --></body></html>', [
    { name: 'landing', html: '<main>Static shell</main>' },
  ]), /reserved prerender boundary comment/i);
  // Literal text inside a script is not a DOM comment and remains author-owned.
  const script = '<script>const example = "<!-- sporades:prerender-boundary-end landing -->";</script>';
  assert.ok(placeClientPrerenderFragments('<html><body></body></html>', [{name:'landing', html:script}]).html.includes(script));
  assert.ok(placeClientPrerenderFragments(`<html><body>${script}</body></html>`, [{name:'landing', html:'<main>Static shell</main>'}]).html.includes(script));
});

test('handover dismisses browser-reparented table boundaries without touching author rows', async () => {
  const window = new Window();
  const previousDocument = globalThis.document;
  globalThis.document = window.document;
  try {
    const { html } = placeClientPrerenderFragments('<html><body><table><!-- sporades:prerender rows --><tr id="author"><td>keep</td></tr></table></body></html>', [
      { name: 'rows', html: '<tr id="static"><td>Static row</td></tr>' },
    ]);
    for (const runtime of [await import('../dist/client.js'), await import(`data:text/javascript;base64,${Buffer.from(createClientRuntimeSource()).toString('base64')}`)]) {
      document.open(); document.write(html); document.close();
      assert.ok(document.querySelector('table > tbody > #static'), 'HTML parser inserted tbody');
      const [handle] = runtime.prerender.discover();
      assert.equal(handle.name, 'rows');
      handle.dismiss(); handle.dismiss();
      assert.equal(document.querySelector('#static'), null);
      assert.equal(document.querySelector('#author').textContent, 'keep');
      assert.deepEqual(runtime.prerender.discover(), []);
    }
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    await window.happyDOM.close();
  }
});

test('placement rejects content foster-parented outside its handover boundaries', () => {
  const source = '<html><body><table><!-- sporades:prerender rows --><tr><td>author row</td></tr></table></body></html>';
  for (const html of ['<div>Loading</div>', 'Loading']) {
    assert.throws(() => placeClientPrerenderFragments(source, [{ name: 'rows', html }]), /not stable in the parsed HTML document/i);
  }
  assert.throws(() => placeClientPrerenderFragments('<html><body><template><!-- sporades:prerender rows --></template></body></html>', [{ name:'rows', html:'<p>Inert</p>' }]), /not stable in the parsed HTML document/i);
  assert.throws(() => placeClientPrerenderFragments('<html><body><ul><!-- sporades:prerender rows --><li>Author item</li></ul></body></html>', [{ name:'rows', html:'<li id="static">Loading' }]), /not stable in the parsed HTML document/i);
});

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
