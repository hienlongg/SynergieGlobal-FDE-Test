const http = require('node:http');
const { findConflicts } = require('./conflicts');
const { loadSeed } = require('./seed');

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function createServer(seed = loadSeed()) {
  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { status: 'ok' });
    }

    if (request.method === 'GET' && url.pathname === '/conflicts') {
      const date = url.searchParams.get('date');
      if (!date) return sendJson(response, 400, { error: 'Query parameter date (YYYY-MM-DD) is required.' });
      try {
        const conflicts = findConflicts(seed.lessons, seed.tutors, date);
        return sendJson(response, 200, { date, conflictCount: conflicts.length, conflicts });
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }

    return sendJson(response, 404, { error: 'Not found. Use GET /conflicts?date=YYYY-MM-DD.' });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => {
    console.log(`Conflict report listening on http://localhost:${port}`);
  });
}

module.exports = { createServer };
