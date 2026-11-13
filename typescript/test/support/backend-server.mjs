// A minimal RFC 6455 server for Backend Connection tests: enough framing to
// exercise the SDK through Node.js's real WebSocket client, without adding a
// dependency. Text, close, ping and pong frames; no fragmentation or extensions.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const hello = (overrides = {}) => ({
  jsonrpc: "2.0",
  method: "hello",
  params: {
    connectionId: `bconn_${"0".repeat(32)}`,
    maxSessions: 1024,
    claimWindowMs: 5000,
    heartbeatMs: 20000,
    maxFrameBytes: 4 * 1024 * 1024,
    ...overrides,
  },
});

/**
 * Start a server. `onConnection(peer)` runs for each upgraded socket; by
 * default the server sends `hello` first, unless `sendHello` is false.
 */
export async function backendServer({ onConnection, sendHello = true, helloParams, reject, http } = {}) {
  const peers = [];
  const waiting = [];
  // REST routes of the same core, for calls that go over HTTP.
  const server = createServer((req, res) =>
    http ? http(req, res) : res.writeHead(404).end(),
  );
  server.on("upgrade", (request, socket) => {
    const status = reject?.(request);
    if (status) {
      socket.end(`HTTP/1.1 ${status} Refused\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
      return;
    }
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}${GUID}`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        ...(protocols.length ? [`Sec-WebSocket-Protocol: ${protocols[0]}`] : []),
        "",
        "",
      ].join("\r\n"),
    );
    const peer = new Peer(socket, request);
    peers.push(peer);
    if (sendHello) peer.send(hello(helloParams));
    onConnection?.(peer);
    const next = waiting.shift();
    next?.(peer);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    url: `ws://127.0.0.1:${port}/api/v1/org/backend/ws`,
    peers,
    /** The next connection, or one already made and not yet taken. */
    connection(index) {
      if (index !== undefined && peers[index]) return Promise.resolve(peers[index]);
      return new Promise((resolve) => waiting.push(resolve));
    },
    async close() {
      for (const peer of peers) peer.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

class Peer {
  #buffer = Buffer.alloc(0);
  #messages = [];
  #readers = [];
  #closed;
  #resolveClosed;

  constructor(socket, request) {
    this.socket = socket;
    this.request = request;
    this.pongs = 0;
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    socket.on("data", (chunk) => this.#read(chunk));
    socket.on("close", () => this.#resolveClosed({ code: 1006, reason: "" }));
    socket.on("error", () => undefined);
  }

  /** Resolves with the close frame the client sent, or 1006 when it vanished. */
  get closed() {
    return this.#closed;
  }

  send(value) {
    this.#frame(1, Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));
  }

  ping() {
    this.#frame(9, Buffer.alloc(0));
  }

  close(code = 1000, reason = "") {
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.#frame(8, payload);
    this.socket.end();
  }

  destroy() {
    this.socket.destroy();
  }

  /** The next JSON message from the client. */
  next() {
    const message = this.#messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve) => this.#readers.push(resolve));
  }

  /** The next request with this method, answered by `respond` when given. */
  async expect(method, respond) {
    for (;;) {
      const message = await this.next();
      if (message.method !== method) continue;
      if (respond) {
        const answer = await respond(message);
        if (answer !== undefined) this.send({ jsonrpc: "2.0", id: message.id, ...answer });
      }
      return message;
    }
  }

  #frame(opcode, payload) {
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    if (!this.socket.destroyed) this.socket.write(Buffer.concat([header, payload]));
  }

  #read(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#buffer.length < 2) return;
      const opcode = this.#buffer[0] & 0x0f;
      let length = this.#buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        length = Number(this.#buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (this.#buffer[1] & 0x80) !== 0;
      const mask = masked ? this.#buffer.subarray(offset, offset + 4) : undefined;
      if (masked) offset += 4;
      if (this.#buffer.length < offset + length) return;
      const payload = Buffer.from(this.#buffer.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.#buffer = this.#buffer.subarray(offset + length);
      if (opcode === 1) {
        const message = JSON.parse(payload.toString("utf8"));
        const reader = this.#readers.shift();
        if (reader) reader(message);
        else this.#messages.push(message);
      } else if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.#resolveClosed({ code, reason: payload.subarray(2).toString("utf8") });
        if (!this.socket.destroyed) {
          this.#frame(8, payload.subarray(0, 2));
          this.socket.end();
        }
      } else if (opcode === 9) {
        this.#frame(10, payload);
      } else if (opcode === 10) {
        this.pongs += 1;
      }
    }
  }
}
