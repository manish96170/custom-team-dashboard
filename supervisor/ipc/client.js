// client.js — a minimal test/demo client for the wire protocol in protocol.js.
// Not a production CTO/TUI client; just enough to drive the adversarial tests
// in test/ against a real socket with real id correlation.

import net from "node:net";
import { randomUUID } from "node:crypto";
import { LineFramer } from "./protocol.js";

export function connect(sockPath, { maxLineBytes } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    const framer = new LineFramer(maxLineBytes ? { maxBytes: maxLineBytes } : undefined);
    const pending = new Map(); // id -> { resolve, reject, streaming, onFrame }
    const streamHandlers = new Map(); // id -> (frame) => void, for observe-style subscriptions

    socket.on("connect", () => resolve(client));
    socket.on("error", reject); // connect-time errors only reject the promise; see note below.
    socket.on("data", (chunk) => {
      const { lines } = framer.push(chunk);
      for (const line of lines) {
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        const handler = streamHandlers.get(frame.id);
        if (handler) {
          handler(frame);
          continue;
        }
        const waiter = pending.get(frame.id);
        if (waiter) {
          pending.delete(frame.id);
          waiter.resolve(frame);
        }
      }
    });

    const client = {
      socket,
      send(cmd, params = {}) {
        const id = params.id ?? randomUUID();
        const payload = { id, cmd, ...params };
        delete payload.id;
        payload.id = id;
        return new Promise((res) => {
          pending.set(id, { resolve: res });
          socket.write(JSON.stringify(payload) + "\n");
        });
      },
      /** Register a handler for every frame carrying this id (for observe-style streams). Returns an unsubscribe fn. */
      onStream(id, handler) {
        streamHandlers.set(id, handler);
        return () => streamHandlers.delete(id);
      },
      writeRaw(bytes) {
        socket.write(bytes);
      },
      close() {
        socket.destroy();
      },
    };
  });
}
