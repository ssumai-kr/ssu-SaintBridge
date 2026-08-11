import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export interface RecordedMockRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Uint8Array;
}

export interface MockUpstreamResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export interface MockUpstreamRoute {
  readonly method: string;
  readonly path: string;
  readonly handler: (
    request: RecordedMockRequest,
  ) => MockUpstreamResponse | Promise<MockUpstreamResponse>;
}

export interface MockUpstreamServer {
  readonly origin: string;
  readonly requests: readonly RecordedMockRequest[];
  url(path: string): URL;
  close(): Promise<void>;
}

const listen = async (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

export const startMockUpstreamServer = async (
  routes: readonly MockUpstreamRoute[],
): Promise<MockUpstreamServer> => {
  const requests: RecordedMockRequest[] = [];

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of incoming) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }

      const request: RecordedMockRequest = {
        method: incoming.method ?? "GET",
        path: incoming.url ?? "/",
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(request);

      const route = routes.find(
        (candidate) =>
          candidate.method.toUpperCase() === request.method.toUpperCase() &&
          candidate.path === request.path,
      );

      if (route === undefined) {
        outgoing.writeHead(404, { connection: "close", "content-type": "text/plain" });
        outgoing.end("No mock route matched.");
        return;
      }

      const response = await route.handler(request);
      outgoing.writeHead(response.status ?? 200, {
        connection: "close",
        ...response.headers,
      });
      outgoing.end(response.body);
    })().catch(() => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { connection: "close", "content-type": "text/plain" });
      }
      outgoing.end("Mock handler failed.");
    });
  });

  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The mock upstream server did not expose a TCP port.");
  }

  const origin = `http://127.0.0.1:${address.port}`;
  let closed = false;

  return {
    origin,
    requests,
    url: (path) => new URL(path, origin),
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
};
