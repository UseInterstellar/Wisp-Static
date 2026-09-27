import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

const BUFFER_SIZE = 128;

const PACKET_CONNECT = 0x01;
const PACKET_DATA = 0x02;
const PACKET_CONTINUE = 0x03;
const PACKET_CLOSE = 0x04;

const CLOSE_UNKNOWN = 0x01;
const CLOSE_VOLUNTARY = 0x02;
const CLOSE_NETWORK = 0x03;
const CLOSE_INVALID = 0x41;
const CLOSE_UNREACHABLE = 0x42;

function packet(type, streamId, payload = new Uint8Array()) {
  const out = new Uint8Array(5 + payload.length);
  const view = new DataView(out.buffer);

  out[0] = type;
  view.setUint32(1, streamId, true);
  out.set(payload, 5);

  return out;
}

function continuePacket(streamId, amount) {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, amount, true);
  return packet(PACKET_CONTINUE, streamId, payload);
}

function closePacket(streamId, reason) {
  return packet(PACKET_CLOSE, streamId, new Uint8Array([reason]));
}

function parsePacket(data) {
  const bytes = new Uint8Array(data);

  if (bytes.length < 5) {
    throw new Error("Wisp packet too short");
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  return {
    type: bytes[0],
    streamId: view.getUint32(1, true),
    payload: bytes.slice(5),
  };
}

function nginxPage() {
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

export default {
  async fetch(request, env) {
    const upgrade = request.headers.get("Upgrade");

    // Wisp WebSocket connection
    if (upgrade?.toLowerCase() === "websocket") {
      const id = env.WISP.idFromName("wisp");
      const stub = env.WISP.get(id);

      return stub.fetch(request);
    }

    // Normal HTTP request
    return new Response(nginxPage(), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=UTF-8",
        "Cache-Control": "no-store",
      },
    });
  },
};

export class WispServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.streams = new Map();
  }

  async fetch(request) {
    const upgrade = request.headers.get("Upgrade");

    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", {
        status: 426,
        headers: {
          "Upgrade": "websocket",
        },
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    server.binaryType = "arraybuffer";

    server.addEventListener("message", (event) => {
      this.handleMessage(server, event.data).catch((error) => {
        console.error("Wisp message error:", error);

        try {
          server.close(1011, "Wisp server error");
        } catch {}
      });
    });

    server.addEventListener("close", () => {
      this.closeAllStreams();
    });

    server.addEventListener("error", () => {
      this.closeAllStreams();
    });

    // Wisp v1 starts with a CONTINUE packet.
    server.send(continuePacket(0, BUFFER_SIZE));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleMessage(ws, data) {
    if (typeof data === "string") {
      return;
    }

    const packetData =
      data instanceof ArrayBuffer
        ? data
        : await data.arrayBuffer();

    const p = parsePacket(packetData);

    switch (p.type) {
      case PACKET_CONNECT:
        await this.handleConnect(ws, p);
        break;

      case PACKET_DATA:
        await this.handleData(ws, p);
        break;

      case PACKET_CLOSE:
        this.handleClose(p);
        break;

      default:
        break;
    }
  }

  async handleConnect(ws, p) {
    if (p.streamId === 0 || this.streams.has(p.streamId)) {
      ws.send(closePacket(p.streamId, CLOSE_INVALID));
      return;
    }

    if (p.payload.length < 3) {
      ws.send(closePacket(p.streamId, CLOSE_INVALID));
      return;
    }

    // Wisp stream type:
    // 0x01 = TCP
    // 0x02 = UDP
    const streamType = p.payload[0];

    // Cloudflare Workers implementation is TCP-only.
    if (streamType !== 0x01) {
      ws.send(closePacket(p.streamId, CLOSE_INVALID));
      return;
    }

    const view = new DataView(
      p.payload.buffer,
      p.payload.byteOffset,
      p.payload.byteLength
    );

    const port = view.getUint16(1, true);

    if (port < 1 || port > 65535) {
      ws.send(closePacket(p.streamId, CLOSE_INVALID));
      return;
    }

    const hostname = new TextDecoder().decode(
      p.payload.slice(3)
    );

    if (!hostname || hostname.length > 253) {
      ws.send(closePacket(p.streamId, CLOSE_INVALID));
      return;
    }

    let socket;

    try {
      socket = connect({
        hostname,
        port,
      });
    } catch (error) {
      console.error(
        `Wisp connect failed: ${hostname}:${port}`,
        error
      );

      ws.send(closePacket(p.streamId, CLOSE_UNREACHABLE));
      return;
    }

    const writer = socket.writable.getWriter();

    const stream = {
      socket,
      writer,
      closed: false,
      writeChain: Promise.resolve(),
    };

    this.streams.set(p.streamId, stream);

    // Allow the client to start sending data.
    ws.send(continuePacket(p.streamId, BUFFER_SIZE));

    this.readFromSocket(ws, p.streamId, stream).catch((error) => {
      console.error(
        `Wisp read failed for ${hostname}:${port}:`,
        error
      );

      this.destroyStream(
        ws,
        p.streamId,
        CLOSE_NETWORK
      );
    });
  }

  async handleData(ws, p) {
    const stream = this.streams.get(p.streamId);

    if (!stream || stream.closed) {
      ws.send(closePacket(p.streamId, CLOSE_UNKNOWN));
      return;
    }

    stream.writeChain = stream.writeChain
      .then(() => stream.writer.write(p.payload))
      .then(() => {
        if (
          !stream.closed &&
          ws.readyState === WebSocket.OPEN
        ) {
          ws.send(continuePacket(p.streamId, 1));
        }
      })
      .catch((error) => {
        console.error("Wisp TCP write failed:", error);

        this.destroyStream(
          ws,
          p.streamId,
          CLOSE_NETWORK
        );
      });

    await stream.writeChain;
  }

  handleClose(p) {
    this.destroyStream(
      null,
      p.streamId,
      CLOSE_VOLUNTARY
    );
  }

  async readFromSocket(ws, streamId, stream) {
    const reader = stream.socket.readable.getReader();

    try {
      while (!stream.closed) {
        const { value, done } = await reader.read();

        if (done) {
          this.destroyStream(
            ws,
            streamId,
            CLOSE_NETWORK
          );
          break;
        }

        if (!value || value.byteLength === 0) {
          continue;
        }

        if (ws.readyState !== WebSocket.OPEN) {
          break;
        }

        ws.send(
          packet(
            PACKET_DATA,
            streamId,
            value
          )
        );
      }
    } finally {
      reader.releaseLock();
    }
  }

  destroyStream(ws, streamId, reason) {
    const stream = this.streams.get(streamId);

    if (!stream) {
      return;
    }

    stream.closed = true;
    this.streams.delete(streamId);

    try {
      stream.writer.close();
    } catch {}

    try {
      stream.socket.close();
    } catch {}

    if (
      ws &&
      ws.readyState === WebSocket.OPEN
    ) {
      try {
        ws.send(
          closePacket(
            streamId,
            reason
          )
        );
      } catch {}
    }
  }

  closeAllStreams() {
    for (const [streamId, stream] of this.streams) {
      stream.closed = true;

      try {
        stream.writer.close();
      } catch {}

      try {
        stream.socket.close();
      } catch {}

      this.streams.delete(streamId);
    }
  }
}