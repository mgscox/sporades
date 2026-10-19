// Shared receiver/loader cases also drive the disposable Chromium acceptance.
const outerUrls = ['https://example.test/inbox', '//example.test/inbox', '/inbox', './client.js', '../client.js'];
const nestedUrls = ['https://nested.test/public', '//nested.test/public', '/public', './public', '../public', 'https://example.test/public'];
const markers = 'qa-apostrophe-query-marker qa-apostrophe-fragment-marker';
const contexts = [
  ['double value', (base, separator, value) => `${base}${separator}filter=" ${value}"&end=done`, base => base],
  ['single value', (base, separator, value) => `${base}${separator}filter=' ${value}'&end=done`, base => base],
  ['backtick value', (base, separator, value) => `${base}${separator}filter=\` ${value}\`&end=done`, base => base],
  ['double wrapper, single value', (base, separator, value) => `"${base}${separator}filter=' ${value}'&end=done"`, base => `"${base}"`],
  ['single wrapper, double value', (base, separator, value) => `'${base}${separator}filter=" ${value}"&end=done'`, base => `'${base}'`],
  ['double wrapper, double value', (base, separator, value) => `"${base}${separator}filter=" ${value}"&end=done"`, base => `"${base}"`],
  ['JSON-escaped value', (base, separator, value) => JSON.stringify({ url: `${base}${separator}filter=" ${value}"&end=done`, status: 'ready' }), base => JSON.stringify({ url: base, status: 'ready' })],
  ['bare escaped value', (base, separator, value) => `${base}${separator}filter=\\" ${value}\\"&end=done`, base => base],
  ['bracket wrapper', (base, separator, value) => `[${base}${separator}filter=" ${value}"]`, base => `[${base}]`],
  ['array value', (base, separator, value) => `${base}${separator}filter=[" ${value}"]`, base => base],
  ['apostrophes before nested value', (base, separator, value) => `${base}${separator}filter=" O', Reilly's ${value}"&end=done`, base => base],
  ['object value', (base, separator, value) => `${base}${separator}filter={"next":" ${value}"}`, base => base],
];
const envSafe = text => text.replaceAll('https://example.test/', '[REDACTED]');
export const nestedUrlProbes = ['?', '#', '%3F', '%23'].flatMap(separator => nestedUrls.flatMap(nested => contexts.map(([context, diagnostic, clean]) => {
  const diagnostics = outerUrls.map(base => diagnostic(base, separator, `${nested} ${markers}`));
  const safe = outerUrls.map(base => envSafe(clean(base)));
  return {
    name: `${context}: nested ${nested} after ${separator}`,
    message: `Before ${diagnostics.join(' ')}\nNext public #234 line.`,
    safe: `Before ${safe.join(' ')}\nNext public #234 line.`,
    stack: 'Error: diagnostic URL\n' + diagnostics.map(url => `    at execute (${url}:12:8)`).join('\n'),
    frames: safe.reverse().map(filename => ({ filename, function: 'execute', lineno: 12, colno: 8 })),
  };
})));
for (const base of outerUrls) for (const separator of ['?', '#', '%3F', '%23']) {
  const url = `${base}${separator}filter=" /public ${markers}"`;
  nestedUrlProbes.push({
    name: `exact bare quoted nested value: ${base}${separator}`,
    message: `Before ${url}`,
    safe: `Before ${envSafe(base)}`,
    stack: `Error: diagnostic URL\n    at execute (${url}:12:8)`,
    frames: [{ filename: envSafe(base), function: 'execute', lineno: 12, colno: 8 }],
  });
}
for (const base of outerUrls) for (const separator of ['?', '#', '%3F', '%23']) for (const wrapper of ['', '"']) {
  const url = `${wrapper}${base}${separator}filter=" /public ${markers}`;
  nestedUrlProbes.push({
    name: `unterminated nested value, wrapper=${wrapper}: ${base}${separator}`,
    message: `Before ${url}\nNext public #234 line.`,
    safe: `Before ${wrapper}${envSafe(base)}\nNext public #234 line.`,
    stack: `Error: diagnostic URL\n    at execute (${url}:12:8)`,
    frames: [{ filename: wrapper + envSafe(base), function: 'execute', lineno: 12, colno: 8 }],
  });
}
export const wrappedContainerProbes = outerUrls.flatMap(base => ['?', '#', '%3F', '%23'].map(separator => {
  const value = JSON.stringify({ next: ` /public ${markers}` });
  const url = `"${base}${separator}filter=${value}"`;
  const clean = `"${envSafe(base)}"`;
  return {
    name: `wrapped object QA reproduction: ${base}${separator}`,
    message: `Before ${url}\nNext public #234 line.`,
    safe: `Before ${clean}\nNext public #234 line.`,
    stack: `Error: diagnostic URL\n    at execute (${url}:12:8)`,
    frames: [{ filename: clean, function: 'execute', lineno: 12, colno: 8 }],
  };
}));
// Cross enclosing syntax with complete, escaped, and ambiguous private containers.
const containerWrappers = [
  ['double', value => `"${value}"`, base => `"${base}"`, '"'],
  ['single', value => `'${value}'`, base => `'${base}'`, "'"],
  ['backtick', value => `\`${value}\``, base => `\`${base}\``, '`'],
  ['repeated double', value => `""${value}""`, base => `""${base}""`, '""'],
  ['bracket', value => `[${value}]`, base => `[${base}]`, '['],
  ['parenthesis', value => `(${value})`, base => `(${base})`, '('],
  ['JSON string', value => JSON.stringify({ url: value, status: 'ready' }), base => JSON.stringify({ url: base, status: 'ready' }), '{"url":"'],
];
const containerValues = [
  ['object', JSON.stringify({ next: ` /public ${markers}` })],
  ['array', JSON.stringify([` /public ${markers}`])],
  ['crossed nesting', JSON.stringify({ next: [{ deeper: [` /public ${markers}`] }], after: 'done' })],
  ['quoted container delimiters', JSON.stringify({ next: ` }]," /public ${markers}`, after: 'done' })],
  ['escaped backslashes', JSON.stringify({ next: ` \\ /public ${markers} \\`, after: 'done' })],
  ['single quoted string', `{next:' /public ${markers}'}`],
  ['backtick string', '{next:` /public ' + markers + '`}'],
  ['leading spaces', '   ' + JSON.stringify([{ next: ` /public ${markers}` }])],
  ['prefixed container', 'prefix' + JSON.stringify({ next: ` /public ${markers}` })],
  ['unterminated string', `{"next":" /public ${markers}`, true],
  ['crossed closing delimiters', `[{"next":" /public ${markers}"]}`, true],
];
for (const separator of ['?', '#', '%3F', '%23']) {
  for (const [wrapper, wrap, clean, prefix] of containerWrappers) {
    for (const [shape, value, ambiguous] of containerValues) {
      const diagnostics = outerUrls.map(base => wrap(`${base}${separator}filter=${value}`));
      // Separate lines keep an ambiguous container private without borrowing a
      // later line's quotation. Complete cases also prove separate URL fields.
      const join = ambiguous ? '\nBefore ' : ' ';
      const safe = outerUrls.map(base => envSafe(ambiguous ? prefix + base : clean(base)));
      wrappedContainerProbes.push({
        name: `${wrapper} wrapper / ${shape}: ${separator}`,
        message: `Before ${diagnostics.join(join)}\nNext public #234 line.`,
        safe: `Before ${safe.join(join)}\nNext public #234 line.`,
        stack: 'Error: diagnostic URL\n' + diagnostics.map(url => `    at execute (${url}:12:8)`).join('\n'),
        frames: safe.reverse().map(filename => ({ filename, function: 'execute', lineno: 12, colno: 8 })),
      });
    }
  }
}
nestedUrlProbes.push(...wrappedContainerProbes);
export const nestedUrlGroups = Array.from({ length: Math.ceil(nestedUrlProbes.length / 16) }, (_, index) => [
  `nested URL values ${index + 1}`, nestedUrlProbes.slice(index * 16, (index + 1) * 16), { PUBLIC_URL: 'https://example.test/' },
]);
