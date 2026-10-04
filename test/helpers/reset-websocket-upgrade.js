// Self-contained so the same TCP reset probe can run inside the Base image,
// without Docker's port proxy hiding the reset from the runtime socket.
export async function resetWebSocketUpgrade(base, target, headers = {}) {
  const { connect } = await import('node:net');
  const url = new URL(base);
  await new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('reset probe timeout')); }, 5000);
    socket.on('error', error => {
      if (!['ECONNRESET', 'EPIPE'].includes(error.code)) reject(error);
    });
    socket.on('close', () => { clearTimeout(timer); resolve(); });
    socket.on('connect', () => {
      const lines = [
        `GET ${target} HTTP/1.1`, `Host: ${url.host}`, 'Connection: Upgrade',
        'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', '',
      ];
      socket.write(lines.join('\r\n'), () => socket.resetAndDestroy());
    });
  });
  // Allow the peer's queued write/error events to run before checking availability.
  await new Promise(resolve => setTimeout(resolve, 20));
}
