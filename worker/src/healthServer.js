import http from 'node:http';

// Purely for hosting platforms that require a bound HTTP port to consider a service "up" and to
// auto-spin-down/wake it on inactivity (e.g. Render's free-tier Web Service type, used here to
// run the worker on-demand at zero cost rather than as a paid always-on Background Worker). Has
// no bearing on the worker's actual job - the queue/lease/retry loops in index.js - and is only
// started when PORT is set, which local/background-worker-type deploys never set.
export function startHealthServer(port) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  server.listen(port);
  return server;
}
