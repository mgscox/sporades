import assert from 'node:assert/strict';
import test from 'node:test';
import { redactDiagnosticText } from '../dist/runtime-log-policy.js';

const bases = ['https://example.test/inbox', '//example.test/inbox', '/inbox', './client.js', '../client.js'];
const separators = ['?', '#', '%3F', '%23'];
const markers = 'qa-private-a qa-private-b';

test('QA round 12: a bare URL owns the spaced private container through line end', () => {
  assert.equal(redactDiagnosticText('Before /inbox?filter=prefix {"next":" /public qa-private-a qa-private-b"}'), 'Before /inbox');
});

test('arbitrary prefixes and private container syntax cannot expose suffix bytes', () => {
  let state = 23412;
  const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const alphabet = [...'abc XYZ\t\'"`[]{}<>(),;:=é🍋'];
  const values = [
    `prefix {"next":" /public ${markers}"}`,
    `prefix [" /public ${markers}"]`,
    `prefix {"next":" /public ${markers}`,
    `prefix [{"next":" /public ${markers}"]}`,
    `prefix O', Reilly's /public ${markers}`,
    `prefix \t {"next":[" /public ${markers}"]}`,
    `prefix /public ${markers}`,
  ];
  for (let i = 0; i < 3000; i++) {
    const prefix = Array.from({ length: random(40) }, () => alphabet[random(alphabet.length)]).join('');
    const base = bases[i % bases.length], separator = separators[random(separators.length)];
    const wrapper = ['', '"', "'", '`', '(', '[', '{', '<', '\\"'][random(9)];
    const input = `${prefix} \t${wrapper}${base}${separator}filter=${values[random(values.length)]}`;
    const safe = redactDiagnosticText(input, { PUBLIC_URL: 'https://example.test/' });
    assert.doesNotMatch(safe, /qa-private-|filter=|next|Reilly|public/, input);
    assert.equal(safe, `${prefix} \t${wrapper}${base.replace('https://example.test/', '[REDACTED]')}`, input);
    assert.equal(redactDiagnosticText(input + '\nNext public line.').split('\n').at(-1), 'Next public line.');
  }
});
