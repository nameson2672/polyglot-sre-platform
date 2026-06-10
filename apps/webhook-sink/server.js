// Local webhook sink for the notifier-worker delivery leg.
// Self-contained: plain Node http, no npm dependencies. Returns 200 so the
// orders.events -> notifier-worker -> webhook pipeline completes end-to-end,
// and logs each received notification so the full loop is observable.

const http = require('node:http');

const PORT = Number(process.env.PORT ?? 8083);
const EXPECTED_FIELDS = ['event_id', 'event_type', 'order_id', 'customer_id', 'occurred_at'];

function log(level, msg, fields) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, service: 'webhook-sink', msg, ...fields }) +
      '\n',
  );
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        log('warn', 'Received non-JSON webhook body', { bytes: raw.length });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"received"}');
        return;
      }

      const missing = EXPECTED_FIELDS.filter((f) => event[f] === undefined || event[f] === '');
      if (missing.length > 0) {
        // Lightweight end-to-end contract check: surface any producer/consumer drift.
        log('warn', 'Notification missing expected fields', {
          missing,
          event_id: event.event_id ?? null,
        });
      }

      log('info', 'Notification received', {
        event_id: event.event_id ?? null,
        event_type: event.event_type ?? null,
        order_id: event.order_id ?? null,
        traceparent: req.headers.traceparent ?? null,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"received"}');
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  log('info', `webhook-sink listening on :${PORT}`, { port: PORT });
});
