import path from 'node:path';
import { inspect } from 'node:util';

// Structured progress reaches the watchdog even when a later test never exits.
export default async function* (source) {
  for await (const event of source) {
    let { type, data } = event;
    if (type === 'test:complete') {
      if (!data.entryFile && data.file && path.resolve(data.name) !== data.file) data = { ...data, entryFile: data.file };
    }
    if (['test:complete', 'test:summary', 'test:diagnostic', 'test:stdout', 'test:stderr'].includes(type)) {
      yield JSON.stringify({ type, data: { ...data, details: data.details && {
        ...data.details, error: data.details.error && inspect(data.details.error, { depth: 5, colors: false }),
      } } }) + '\n';
    }
  }
}
