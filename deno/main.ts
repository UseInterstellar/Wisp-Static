// deno-lint-ignore-file no-explicit-any
// Version is pinned in deno.json's import map.
import { logging, server as wisp } from "@mercuryworkshop/wisp-js/server";

const PORT = Number(Deno.env.get("PORT")) || 5001;
const HOST = Deno.env.get("HOST") || "0.0.0.0";

const level = Deno.env.get("LOG_LEVEL")?.toUpperCase();
logging.set_level((logging as any)[level ?? ""] ?? logging.INFO);

wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
wisp.options.stream_limit_total = 256;

function nginxPage(): string {
  return `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
    body {
        width: 35em;
        margin: 0 auto;
        font-family: Tahoma, Verdana, Arial, sans-serif;
    }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;
}

async function handleWisp(
  socket: WebSocket,
  path: string,
  wispVersion: 1 | 2,
  clientIp: string,
) {
  logging.info(`new connection on ${path} from ${clientIp}`);

  try {
    const conn = new (wisp as any).ServerConnection(socket, path, {
      wisp_version: wispVersion,
    });

    await conn.setup();
    await conn.run();
  } catch (error) {
    try {
      socket.close();
    } catch { /* already closed */ }

    const name = (error as Error)?.constructor?.name;
    if (name === "HandshakeError" || name === "AccessDeniedError") return;

    logging.error(
      "Uncaught server error:\n" + ((error as Error)?.stack ?? error),
    );
  }
}

const server = Deno.serve({
  port: PORT,
  hostname: HOST,
  onListen: ({ hostname, port }) => {
    console.log(`Wisp server listening on ${hostname}:${port}`);
  },
}, (request, info) => {
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const offered = request.headers.get("sec-websocket-protocol");
    const useV2 = Boolean(offered) && wisp.options.wisp_version === 2;


    const clientIp = info.remoteAddr.transport === "tcp"
      ? info.remoteAddr.hostname
      : "unknown";
    const path = new URL(request.url).pathname;

    const { socket, response } = Deno.upgradeWebSocket(
      request,
      useV2 ? { protocol: "wisp-v2" } : {},
    );

    socket.binaryType = "arraybuffer";

    handleWisp(socket, path, useV2 ? 2 : 1, clientIp);

    return response;
  }

  return new Response(nginxPage(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
      "Server": "nginx",
    },
  });
});

const signals: Deno.Signal[] = Deno.build.os === "windows"
  ? ["SIGINT", "SIGBREAK"]
  : ["SIGTERM", "SIGINT"];

for (const signal of signals) {
  Deno.addSignalListener(signal, async () => {
    console.log(`${signal} received, shutting down`);
    await server.shutdown();
    Deno.exit(0);
  });
}
