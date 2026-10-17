import assert from "node:assert/strict";
import { test } from "node:test";
import * as server from "sporades/server";
import { parseFragment } from "parse5";

test("escapeHtml encodes text and both quoted attribute delimiters", () => {
  assert.equal(server.escapeHtml(`& < > " '`), "&amp; &lt; &gt; &quot; &#39;");
  assert.equal(server.escapeHtml(null), "");
  assert.equal(server.escapeHtml(undefined), "");
  assert.equal(server.escapeHtml(42), "42");
  const value = `x' onload="bad" <&>`;
  const fragment = parseFragment(`<a title='${server.escapeHtml(value)}'>${server.escapeHtml(value)}</a>`);
  assert.deepEqual(fragment.childNodes[0].attrs, [{ name: "title", value }]);
  assert.equal(fragment.childNodes[0].childNodes[0].value, value);
});

test("html escapes interpolations, joins nested arrays and preserves only trusted fragments", () => {
  const { html } = server;
  const name = `<img src=x onerror="bad">&'`;
  const nested = html`<b>${name}</b>`;
  const result = html`<p title="${name}">${[nested, [null, undefined, 42, false], "<&>"]}${html.raw("<br>")}</p>`;
  assert.equal(String(result), '<p title="&lt;img src=x onerror=&quot;bad&quot;&gt;&amp;&#39;"><b>&lt;img src=x onerror=&quot;bad&quot;&gt;&amp;&#39;</b>42false&lt;&amp;&gt;<br></p>');
  assert.equal(String(html`${{ toString: () => "<b>forged</b>" }}`), "&lt;b&gt;forged&lt;/b&gt;");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(String(html`${String(nested)}`), "&lt;b&gt;&amp;lt;img src=x onerror=&amp;quot;bad&amp;quot;&amp;gt;&amp;amp;&amp;#39;&lt;/b&gt;");
});
