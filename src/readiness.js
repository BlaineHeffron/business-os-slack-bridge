import http from 'node:http';

export function startReadinessServer({ port, isReady }) {
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/ready') {
      response.writeHead(404).end('not found\n');
      return;
    }
    const ready = isReady();
    response.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain' });
    response.end(ready ? 'ready\n' : 'not ready\n');
  });
  server.listen(port, '127.0.0.1');
  return server;
}
