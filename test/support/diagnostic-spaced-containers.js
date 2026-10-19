// These are the public paths in the pre-existing exact-output fixtures, already
// stripped of private bytes. The stricter policy retains only the first path on
// each diagnostic line; compare exact output without parsing unsafe input again.
const publicPaths = ['https://example.test/inbox', '//example.test/inbox', '/inbox', './client.js', '../client.js', 'file:///app/client.js', 'ws://example.test/inbox', 'custom+tls://example.test/inbox', '[REDACTED]inbox', '[REDACTED]', '/client.js'];
function throughFirstPublicPath(line) {
  const ends = publicPaths.flatMap(path => {
    const index = line.indexOf(path);
    return index < 0 ? [] : [{ index, end: index + path.length }];
  }).sort((a, b) => a.index - b.index || b.end - a.end);
  return ends.length ? line.slice(0, ends[0].end) : line;
}
export const failClosedProbe = probe => ({
  ...probe,
  safe: probe.safe.split('\n').map(throughFirstPublicPath).join('\n'),
  frames: probe.frames.map(frame => ({ ...frame, filename: throughFirstPublicPath(frame.filename) })),
});

// QA round 12: five forms x four separators x three shapes = sixty cases.
// Also cross EOF/newline, whitespace, and malformed/crossed containers.
const bases = publicPaths.slice(0, 5);
const shapes = [
  ['object', '{"next":" /public qa-private-a qa-private-b"}'],
  ['array', '[" /public qa-private-a qa-private-b"]'],
  ['incomplete object', '{"next":" /public qa-private-a qa-private-b'],
  ['crossed container', '[{"next":" /public qa-private-a qa-private-b"]}'],
];
export const spacedContainerProbes = [];
for (const base of bases) for (const separator of ['?', '#', '%3F', '%23']) {
  for (const [shape, value] of shapes) for (const space of [' ', '\t', ' \t ']) for (const next of ['', '\nNext public #234 line.']) {
    const filename = base.replace('https://example.test/', '[REDACTED]');
    spacedContainerProbes.push({
      name: `spaced ${shape}: ${base}${separator} ${JSON.stringify(space)} newline=${!!next}`,
      message: `Before ${base}${separator}filter=prefix${space}${value}${next}`,
      safe: `Before ${filename}${next}`,
      stack: `Error: diagnostic URL\n    at execute (Before ${base}${separator}filter=prefix${space}${value}:12:8)`,
      frames: [{ filename: `Before ${filename}`, function: 'execute', lineno: 12, colno: 8 }],
    });
  }
}
export const spacedContainerGroups = Array.from({ length: Math.ceil(spacedContainerProbes.length / 16) }, (_, index) => [
  `spaced private containers ${index + 1}`, spacedContainerProbes.slice(index * 16, (index + 1) * 16), { PUBLIC_URL: 'https://example.test/' },
]);
