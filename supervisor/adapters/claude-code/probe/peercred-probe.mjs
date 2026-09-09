// Measure what a Node server can learn about a Unix-socket peer, before designing an
// authenticated principal on top of it. PLAN.md §14.5 wants "a socket peer credential".
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peercred-"));
const sock = path.join(dir, "s.sock");
const out = [];

const server = net.createServer((c) => {
  // Everything the server can see about the connected peer.
  const own = Object.getOwnPropertyNames(c).filter((k) => !k.startsWith("_"));
  out.push(`socket own props: ${own.join(", ") || "(none)"}`);
  out.push(`remoteAddress=${JSON.stringify(c.remoteAddress)} remotePort=${JSON.stringify(c.remotePort)}`);
  out.push(`remoteFamily=${JSON.stringify(c.remoteFamily)}`);
  const handleKeys = c._handle ? Object.keys(Object.getPrototypeOf(c._handle)) : [];
  out.push(`handle proto methods: ${handleKeys.join(", ")}`);
  out.push(`any peer-cred-looking API: ${handleKeys.filter((k) => /cred|peer|uid|pid/i.test(k)).join(", ") || "NONE"}`);
  c.end();
  server.close();
});

server.listen(sock, () => {
  const c = net.createConnection(sock, () => c.end());
  c.on("close", () => {
    setTimeout(() => {
      console.log(out.join("\n"));
      // And the one thing that DOES hold: filesystem permissions on the socket.
      const st = fs.statSync(sock === undefined ? dir : dir);
      console.log(`state dir mode: 0${(st.mode & 0o777).toString(8)}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }, 50);
  });
});
