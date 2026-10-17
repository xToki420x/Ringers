/**
 * A minimal MQTT 3.1.1 client over WebSocket — just what online rooms need:
 * connect (with a last-will message), subscribe, publish (QoS 0, optionally
 * retained) and keep-alive pings. Messages travel through a public relay
 * ("broker"), so it works on any network, behind any router, with no server
 * of our own to run.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function str(s: string): Uint8Array {
  const b = enc.encode(s);
  const out = new Uint8Array(b.length + 2);
  out[0] = b.length >> 8;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function remainingLength(n: number): number[] {
  const out: number[] = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    out.push(d);
  } while (n > 0);
  return out;
}

function packet(type: number, ...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const head = [type, ...remainingLength(len)];
  const out = new Uint8Array(head.length + len);
  out.set(head, 0);
  let o = head.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface MqttWill {
  topic: string;
  payload: string;
}

export class MqttLink {
  private ws: WebSocket | null = null;
  private buf = new Uint8Array(0);
  private pingTimer = 0;
  private packetId = 1;
  private closed = false;
  connected = false;
  onMessage: (topic: string, payload: string) => void = () => {};
  onDown: () => void = () => {};

  constructor(
    readonly url: string,
    private readonly clientId: string,
    private readonly will?: MqttWill,
    private readonly keepAlive = 30,
  ) {}

  /** Resolves once the broker accepts the connection (rejects after `timeoutMs`). */
  connect(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why: string) => {
        if (settled) return;
        settled = true;
        this.teardown();
        reject(new Error(why));
      };
      const timer = window.setTimeout(() => fail('timeout'), timeoutMs);
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url, ['mqtt']);
      } catch (e) {
        window.clearTimeout(timer);
        fail(String(e));
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        let flags = 0x02; // clean session
        const payload: Uint8Array[] = [str(this.clientId)];
        if (this.will) {
          flags |= 0x04; // will flag, QoS 0, not retained
          payload.push(str(this.will.topic), str(this.will.payload));
        }
        const vh = new Uint8Array([0, 4, 0x4d, 0x51, 0x54, 0x54, 4, flags, this.keepAlive >> 8, this.keepAlive & 0xff]);
        ws.send(packet(0x10, vh, ...payload));
      };
      ws.onmessage = (ev) => {
        const data = new Uint8Array(ev.data as ArrayBuffer);
        const merged = new Uint8Array(this.buf.length + data.length);
        merged.set(this.buf);
        merged.set(data, this.buf.length);
        this.buf = merged;
        this.drain((type, body) => {
          if (type === 0x20) {
            window.clearTimeout(timer);
            if (body[1] !== 0) return fail(`refused (${body[1]})`);
            settled = true;
            this.connected = true;
            this.pingTimer = window.setInterval(() => this.send(new Uint8Array([0xc0, 0])), (this.keepAlive * 1000) / 2);
            resolve();
          }
        });
      };
      ws.onerror = () => fail('socket error');
      ws.onclose = () => {
        window.clearTimeout(timer);
        const was = this.connected;
        this.teardown();
        if (!settled) fail('closed');
        else if (was && !this.closed) this.onDown();
      };
    });
  }

  private drain(onControl: (type: number, body: Uint8Array) => void) {
    for (;;) {
      if (this.buf.length < 2) return;
      let mul = 1, len = 0, i = 1, byte = 0;
      do {
        if (i >= this.buf.length) return;
        byte = this.buf[i++];
        len += (byte & 0x7f) * mul;
        mul *= 128;
      } while (byte & 0x80);
      if (this.buf.length < i + len) return;
      const head = this.buf[0];
      const body = this.buf.subarray(i, i + len);
      const type = head & 0xf0;
      if (type === 0x30) {
        const tl = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tl));
        const qos = (head >> 1) & 3;
        const start = 2 + tl + (qos > 0 ? 2 : 0);
        const payload = dec.decode(body.subarray(start));
        try {
          this.onMessage(topic, payload);
        } catch (e) {
          console.error(e);
        }
      } else onControl(type, body);
      this.buf = this.buf.slice(i + len);
    }
  }

  private send(p: Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(p);
  }

  subscribe(topic: string) {
    const id = this.packetId++ & 0xffff || 1;
    this.send(packet(0x82, new Uint8Array([id >> 8, id & 0xff]), str(topic), new Uint8Array([0])));
  }

  publish(topic: string, payload: string, retain = false) {
    this.send(packet(0x30 | (retain ? 1 : 0), str(topic), enc.encode(payload)));
  }

  close() {
    this.closed = true;
    this.send(new Uint8Array([0xe0, 0]));
    this.teardown();
  }

  private teardown() {
    this.connected = false;
    window.clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }
}
