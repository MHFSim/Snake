import Peer, { DataConnection, PeerOptions } from "peerjs";
import { PEER_PREFIX } from "./protocol";

// Verbindungsaufbau über PeerJS (WebRTC). Standard: öffentlicher PeerJS-Server inkl. STUN/TURN.
// Eigener Signaling-Server: ?signal=host:port[/pfad]  (z. B. ?signal=localhost:9000)

export function peerOptions(): PeerOptions {
  const sig = new URLSearchParams(location.search).get("signal");
  const opts: PeerOptions = { debug: 1 };
  if (sig) {
    const m = sig.match(/^([^:/]+)(?::(\d+))?(\/.*)?$/);
    if (m) {
      opts.host = m[1];
      opts.port = m[2] ? Number(m[2]) : 443;
      opts.path = m[3] || "/";
      opts.secure = location.protocol === "https:" && m[1] !== "localhost";
      // lokal: nur direkte Verbindungen
      opts.config = { iceServers: [] };
    }
  }
  return opts;
}

export interface ClientLink {
  peerId: string;
  rel: DataConnection;
  fast: DataConnection | null;
}

export function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  return null;
}

export class HostNet {
  peer!: Peer;
  private links = new Map<string, ClientLink>();
  onLink: (l: ClientLink) => void = () => {};
  onFast: (peerId: string, data: ArrayBuffer) => void = () => {};
  onError: (msg: string) => void = () => {};

  open(code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof RTCPeerConnection === "undefined") {
        reject({ type: "webrtc" });
        return;
      }
      this.peer = new Peer(PEER_PREFIX + code, peerOptions());
      let opened = false;
      setTimeout(() => {
        if (!opened) {
          this.peer.destroy();
          reject({ type: "timeout" });
        }
      }, 12000);
      this.peer.on("open", () => {
        opened = true;
        resolve();
      });
      this.peer.on("error", (err: { type?: string; message?: string }) => {
        if (!opened) reject(err);
        else this.onError(err.type || err.message || "Fehler");
      });
      this.peer.on("disconnected", () => {
        // Nur die Verbindung zum Signaling-Server ist weg. Laufende Spiele gehen weiter.
        setTimeout(() => {
          if (!this.peer.destroyed && this.peer.disconnected) this.peer.reconnect();
        }, 1000);
      });
      this.peer.on("connection", (conn) => this.handle(conn));
    });
  }

  private handle(conn: DataConnection) {
    const id = conn.peer;
    if (conn.label === "fast") {
      conn.on("data", (d) => {
        const buf = toArrayBuffer(d);
        if (buf) this.onFast(id, buf);
      });
      conn.on("open", () => {
        const l = this.links.get(id);
        if (l) l.fast = conn;
        else this.pendingFast.set(id, conn);
      });
      return;
    }
    conn.on("open", () => {
      const link: ClientLink = { peerId: id, rel: conn, fast: this.pendingFast.get(id) ?? null };
      this.pendingFast.delete(id);
      this.links.set(id, link);
      conn.on("close", () => this.links.delete(id));
      this.onLink(link);
    });
  }
  private pendingFast = new Map<string, DataConnection>();

  close() {
    this.peer?.destroy();
  }
}

export class ClientNet {
  peer!: Peer;
  rel!: DataConnection;
  fast!: DataConnection;
  onFast: (data: ArrayBuffer) => void = () => {};
  onRel: (msg: unknown) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private closed = false;

  connect(code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof RTCPeerConnection === "undefined") {
        reject(new Error("webrtc"));
        return;
      }
      this.peer = new Peer(peerOptions());
      let done = false;
      const fail = (why: string) => {
        if (!done) {
          done = true;
          reject(new Error(why));
        } else this.closeWith(why);
      };
      const timer = setTimeout(() => fail("timeout"), 15000);
      this.peer.on("error", (err: { type?: string }) => {
        fail(err.type === "peer-unavailable" ? "notfound" : err.type || "error");
      });
      this.peer.on("open", () => {
        const host = PEER_PREFIX + code;
        this.rel = this.peer.connect(host, { label: "rel", reliable: true, serialization: "binary" });
        this.fast = this.peer.connect(host, { label: "fast", reliable: false, serialization: "raw" });
        this.fast.on("data", (d) => {
          const buf = toArrayBuffer(d);
          if (buf) this.onFast(buf);
        });
        this.rel.on("data", (d) => this.onRel(d));
        this.rel.on("close", () => this.closeWith("hostleft"));
        this.rel.on("error", () => this.closeWith("hostleft"));
        let relOpen = false;
        let fastOpen = false;
        const check = () => {
          if (relOpen && fastOpen && !done) {
            done = true;
            clearTimeout(timer);
            resolve();
          }
        };
        this.rel.on("open", () => {
          relOpen = true;
          check();
        });
        this.fast.on("open", () => {
          fastOpen = true;
          check();
        });
      });
    });
  }

  private closeWith(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.onClose(reason);
  }

  sendRel(msg: unknown) {
    if (this.rel?.open) this.rel.send(msg);
  }
  sendFast(buf: ArrayBuffer) {
    if (this.fast?.open) this.fast.send(buf);
  }

  close() {
    this.closed = true;
    this.peer?.destroy();
  }
}
