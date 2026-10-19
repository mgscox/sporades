// Self-contained so the same probe can run inside a generated Capsule Bundle.
export function probeAppBinding(ctx) {
  const app = ctx.app;
  const { writable, configurable } = Object.getOwnPropertyDescriptor(ctx, 'app');
  const forged = { publicOrigin: 'https://forged.example' };
  const attempts = [];
  for (const operation of [
    () => Reflect.set(ctx, 'app', forged),
    () => Reflect.deleteProperty(ctx, 'app'),
    () => Reflect.defineProperty(ctx, 'app', { value: forged }),
  ]) {
    const accepted = operation();
    attempts.push({ accepted, unchanged: ctx.app === app, origin: ctx.app?.publicOrigin });
  }
  return { writable, configurable, attempts };
}

export function expectedAppBinding(origin) {
  return { writable: false, configurable: false,
    attempts: Array.from({ length: 3 }, () => ({ accepted: false, unchanged: true, origin })) };
}
