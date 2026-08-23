import http, { type ServerResponse } from 'node:http';
import { createConflictReport } from './conflicts';
import { parseLocalDate, type SeedData } from './domain';
import { loadSeed } from './seed';

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Invalid request';
}

export const createServer = (seed: SeedData = loadSeed()): http.Server =>
  http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/conflicts') {
      const requestedDate = url.searchParams.get('date');
      if (!requestedDate) {
        sendJson(response, 400, { error: 'Query parameter date (YYYY-MM-DD) is required.' });
        return;
      }

      let date;
      try {
        date = parseLocalDate(requestedDate);
      } catch (error: unknown) {
        sendJson(response, 400, { error: errorMessage(error) });
        return;
      }

      try {
        sendJson(response, 200, createConflictReport(seed.lessons, seed.tutors, date));
      } catch (error: unknown) {
        console.error('Unable to create conflict report:', error);
        sendJson(response, 500, { error: 'Unable to create conflict report.' });
      }
      return;
    }

    sendJson(response, 404, { error: 'Not found. Use GET /conflicts?date=YYYY-MM-DD.' });
  });

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => {
    console.log(`Conflict report listening on http://localhost:${port}`);
  });
}
