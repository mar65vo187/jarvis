import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface TestServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  server: TestServer,
) => void | Promise<void>;

/** Kleiner lokaler HTTP-Server für Integrationstests. */
export async function startServer(handler: Handler): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '', headers: req.headers, body });
      Promise.resolve(handler(req, res, body, api)).catch((error: unknown) => {
        res.statusCode = 500;
        res.end(String(error));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  const api: TestServer = {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  return api;
}

export function sse(res: http.ServerResponse, payloads: string[], options: { event?: string } = {}): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const payload of payloads) {
    if (options.event) res.write(`event: ${options.event}\n`);
    res.write(`data: ${payload}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

export function ndjson(res: http.ServerResponse, lines: string[]): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const line of lines) res.write(`${line}\n`);
  res.end();
}

export function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function text(res: http.ServerResponse, status: number, body: string, contentType = 'application/json'): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}
