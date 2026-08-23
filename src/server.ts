import { mkdirSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import {
  CancellationStore,
  ServiceError,
  WebhookNotificationSender,
  parseCancellationCommand,
  type NotificationSender
} from './cancellations';
import { loadSeed } from './seed';

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function serviceError(error: unknown): ServiceError {
  return error instanceof ServiceError
    ? error
    : new ServiceError(500, 'internal_error', 'Unable to process the request.');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new ServiceError(413, 'body_too_large', 'Request body must be no larger than 64 KiB.');
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ServiceError(400, 'invalid_json', 'Request body must contain valid JSON.');
  }
}

function matchLessonPath(pathname: string, suffix = ''): string | null {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^/lessons/(L\\d+)${escapedSuffix}$`).exec(pathname);
  return match?.[1] ?? null;
}

export const createServer = (
  store: CancellationStore = new CancellationStore(':memory:', loadSeed()),
  sender?: NotificationSender
): http.Server => http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    const lessonId = matchLessonPath(url.pathname);
    if (request.method === 'GET' && lessonId) {
      const lesson = store.getLesson(lessonId);
      if (!lesson) throw new ServiceError(404, 'lesson_not_found', `Lesson ${lessonId} was not found.`);
      sendJson(response, 200, lesson);
      return;
    }

    const cancellationLessonId = matchLessonPath(url.pathname, '/cancellation');
    if (request.method === 'POST' && cancellationLessonId) {
      const contentType = request.headers['content-type'] ?? '';
      const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        throw new ServiceError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
      }
      const header = request.headers['idempotency-key'];
      if (typeof header !== 'string') {
        throw new ServiceError(400, 'missing_idempotency_key', 'Idempotency-Key header is required.');
      }

      const command = parseCancellationCommand(await readJson(request));
      let result = store.cancel(cancellationLessonId, command, header);
      await store.deliver(result.notification.notificationId, sender);
      result = store.refresh(result);
      sendJson(response, 201, result);
      return;
    }

    sendJson(response, 404, {
      error: { code: 'not_found', message: 'Use POST /lessons/:lessonId/cancellation or GET /lessons/:lessonId.' }
    });
  } catch (error: unknown) {
    const problem = serviceError(error);
    if (problem.statusCode === 500) console.error('Request failed:', error);
    sendJson(response, problem.statusCode, { error: { code: problem.code, message: problem.message } });
  }
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const dataDirectory = path.resolve(process.env.DATA_DIR || 'data');
  mkdirSync(dataDirectory, { recursive: true });
  const store = new CancellationStore(path.join(dataDirectory, 'bright-path.sqlite'), loadSeed());
  const sender = process.env.TUTOR_NOTIFICATION_WEBHOOK_URL
    ? new WebhookNotificationSender(process.env.TUTOR_NOTIFICATION_WEBHOOK_URL)
    : undefined;

  createServer(store, sender).listen(port, async () => {
    console.log(`Cancellation desk listening on http://localhost:${port}`);
    if (!sender) {
      console.warn('TUTOR_NOTIFICATION_WEBHOOK_URL is not set; notifications will remain pending.');
      return;
    }
    await store.deliverOutstanding(sender);
  });
}
