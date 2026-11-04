import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Serves a standard web `fetch` handler through node:http on a random port. */
export async function serveWeb(handler: (request: Request) => Response | Promise<Response>): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const method = req.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
    const response = await handler(new Request(`http://${req.headers.host}${req.url}`, { method, headers, ...(body ? { body } : {}) }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
