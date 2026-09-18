// Controlled loopback SMTP receiver: acceptance is recorded before its final reply.
import net from 'node:net';
import { once } from 'node:events';

export async function receiver(record, { loseAcknowledgement = false, dropBeforeAcceptance = false } = {}) {
  const accepted = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 experiment.invalid\r\n');
    let buffer = '', data = false, message = [];
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line !== '.') { message.push(line); continue; }
          if (dropBeforeAcceptance) {
            record('smtp-discarded-before-acceptance');
            socket.destroy(); return;
          }
          const owner = message.find(value => value.startsWith('X-Worker: '))?.slice(10);
          const operation = message.find(value => value.startsWith('Message-ID: '))?.slice(12);
          accepted.push({ owner, operation });
          record('smtp-accepted', { owner, operation, acknowledgementLost: loseAcknowledgement });
          data = false; message = [];
          if (loseAcknowledgement) socket.destroy();
          else socket.write('250 accepted\r\n');
        } else if (line === 'DATA') { data = true; socket.write('354 send body\r\n'); }
        else if (/^(EHLO |MAIL FROM:|RCPT TO:)/.test(line)) socket.write('250 OK\r\n');
        else socket.write('500 unsupported\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port, accepted,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
