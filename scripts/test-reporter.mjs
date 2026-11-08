import path from 'node:path';
import { inspect } from 'node:util';

// Structured progress reaches the watchdog even when a later test never exits.
export default async function* (source) {
  for await (const event of source) {
    let { type, data } = event;
    if (type === 'test:complete' || type === 'test:enqueue') {
      if (!data.entryFile && data.file && path.resolve(data.name) !== data.file) data = { ...data, entryFile: data.file };
    }
    if (['test:enqueue', 'test:complete', 'test:summary', 'test:diagnostic', 'test:stdout', 'test:stderr'].includes(type)) {
      yield JSON.stringify({ type, data: { ...data, details: data.details && {
        ...data.details,
        resourceSignal: data.details.error?.signal ?? data.details.error?.cause?.signal,
        capturedStderr: [data.details.error, data.details.error?.cause].some(error => error?.stderr != null),
        resourceFailure: [data.details.error, data.details.error?.cause].some(error =>
          error?.code === 'ENOMEM' || error?.code === 'ERR_WORKER_OUT_OF_MEMORY' || error?.signal === 'SIGKILL' ||
          (error?.signal === 'SIGABRT' && /FATAL ERROR:.*(?:heap|memory)/.test(String(error.stderr ?? '')))),
        error: data.details.error && inspect(data.details.error, { depth: 5, colors: false }),
      } } }) + '\n';
    }
  }
}
