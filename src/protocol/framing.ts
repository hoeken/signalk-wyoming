/**
 * Wyoming wire framing — encoder + incremental decoder.
 *
 * Wire format (reference rhasspy/wyoming 1.10.0, `wyoming/event.py`):
 *
 *     <header JSON, one line, UTF-8>\n
 *     <data JSON, exactly data_length bytes>     (only when data_length > 0)
 *     <payload, exactly payload_length bytes>    (only when payload_length > 0)
 *
 * - `data_length`/`payload_length` are BYTE counts (UTF-8), omitted entirely
 *   when the data dict / payload is empty.
 * - No newline after the data block or payload; the next header starts
 *   immediately after the payload's last byte.
 * - An inline header `data` object is accepted on read and merged UNDER the
 *   out-of-line data block (block keys win).
 * - `version` in the header is informational only.
 * - Malformed header/data JSON is a protocol violation: the reference reader
 *   treats it as a disconnect. Here `EventDecoder.feed()` throws a
 *   `FramingError`; callers must drop the connection.
 */

import type { WyomingEvent } from "./events.js";

/** Protocol version written into every header (never validated by readers). */
export const WYOMING_VERSION = "1.10.0";

/** Sanity limit for the header line (reference asyncio default is 64 KiB). */
export const MAX_HEADER_BYTES = 1024 * 1024;

/** Sanity limit for data/payload blocks (reference has no limit). */
export const MAX_BLOCK_BYTES = 64 * 1024 * 1024;

/** Thrown by `EventDecoder.feed()` on malformed input. Treat as disconnect. */
export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

/** Encode one event to wire bytes. */
export function encodeEvent(event: WyomingEvent): Buffer {
  const header: Record<string, unknown> = {
    type: event.type,
    version: WYOMING_VERSION,
  };
  let dataBuf: Buffer | undefined;
  if (event.data !== undefined && Object.keys(event.data).length > 0) {
    const json = JSON.stringify(event.data);
    dataBuf = Buffer.from(json, "utf8");
    header.data_length = Buffer.byteLength(json, "utf8");
  }
  if (event.payload !== undefined && event.payload.length > 0) {
    header.payload_length = event.payload.length;
  }
  const parts: Buffer[] = [Buffer.from(JSON.stringify(header) + "\n", "utf8")];
  if (dataBuf !== undefined) parts.push(dataBuf);
  if (event.payload !== undefined && event.payload.length > 0) {
    parts.push(event.payload);
  }
  return Buffer.concat(parts);
}

interface PendingHeader {
  type: string;
  inlineData?: Record<string, unknown>;
  dataLength: number;
  payloadLength: number;
}

/**
 * Incremental push-parser. Feed it socket chunks; it returns every complete
 * event, buffering partial reads across header/data/payload boundaries.
 *
 * Once `feed()` has thrown a `FramingError` the decoder is dead: the caller
 * must discard it and drop the connection (further `feed()` calls throw).
 */
export class EventDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;
  private failed = false;
  private header: PendingHeader | null = null;
  private data: Record<string, unknown> | undefined;
  private dataDone = false;

  feed(chunk: Buffer): WyomingEvent[] {
    if (this.failed) {
      throw new FramingError("decoder already failed; drop the connection");
    }
    this.append(chunk);
    const events: WyomingEvent[] = [];
    for (;;) {
      if (this.header === null) {
        if (!this.readHeader()) break;
      }
      if (!this.dataDone) {
        if (!this.readData()) break;
      }
      const payload = this.readPayload();
      if (payload === null) break;
      const header = this.header as PendingHeader;
      const event: WyomingEvent = {
        type: header.type,
        data: this.data ?? {},
      };
      if (header.payloadLength > 0) event.payload = payload;
      events.push(event);
      this.header = null;
      this.data = undefined;
      this.dataDone = false;
    }
    this.compact();
    return events;
  }

  private fail(message: string): never {
    this.failed = true;
    throw new FramingError(message);
  }

  private append(chunk: Buffer): void {
    if (this.pos === this.buf.length) {
      this.buf = chunk;
    } else {
      this.buf = Buffer.concat([this.buf.subarray(this.pos), chunk]);
    }
    this.pos = 0;
  }

  private compact(): void {
    if (this.pos > 0) {
      this.buf = this.buf.subarray(this.pos);
      this.pos = 0;
    }
  }

  private available(): number {
    return this.buf.length - this.pos;
  }

  /** Returns false when more bytes are needed. */
  private readHeader(): boolean {
    const nl = this.buf.indexOf(0x0a, this.pos);
    if (nl === -1) {
      if (this.available() > MAX_HEADER_BYTES) {
        this.fail(`header line exceeds ${MAX_HEADER_BYTES} bytes`);
      }
      return false;
    }
    if (nl - this.pos > MAX_HEADER_BYTES) {
      this.fail(`header line exceeds ${MAX_HEADER_BYTES} bytes`);
    }
    const line = this.buf.subarray(this.pos, nl).toString("utf8");
    this.pos = nl + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail("malformed header JSON");
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      this.fail("header is not a JSON object");
    }
    const h = parsed as Record<string, unknown>;
    if (typeof h.type !== "string" || h.type.length === 0) {
      this.fail('header missing "type"');
    }
    const header: PendingHeader = {
      type: h.type,
      dataLength: this.lengthField(h.data_length, "data_length"),
      payloadLength: this.lengthField(h.payload_length, "payload_length"),
    };
    // Inline header data is accepted on read (never written by the
    // reference); the out-of-line block is merged on top of it.
    if (
      h.data !== null &&
      typeof h.data === "object" &&
      !Array.isArray(h.data)
    ) {
      header.inlineData = h.data as Record<string, unknown>;
    }
    this.header = header;
    if (header.dataLength === 0) {
      // data_length 0 / absent: inline data (if any) is the event data.
      this.data = header.inlineData;
      this.dataDone = true;
    }
    return true;
  }

  /** null/absent/0 => 0; otherwise a validated non-negative integer. */
  private lengthField(value: unknown, name: string): number {
    if (value === undefined || value === null) return 0;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      this.fail(`invalid ${name}`);
    }
    if (value > MAX_BLOCK_BYTES) {
      this.fail(`${name} ${value} exceeds ${MAX_BLOCK_BYTES} bytes`);
    }
    return value;
  }

  /** Returns false when more bytes are needed. Requires this.header set. */
  private readData(): boolean {
    const header = this.header as PendingHeader;
    if (this.available() < header.dataLength) return false;
    const raw = this.buf
      .subarray(this.pos, this.pos + header.dataLength)
      .toString("utf8");
    this.pos += header.dataLength;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.fail("malformed data JSON");
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      this.fail("data block is not a JSON object");
    }
    this.data = {
      ...(header.inlineData ?? {}),
      ...(parsed as Record<string, unknown>),
    };
    this.dataDone = true;
    return true;
  }

  /** Returns null when more bytes are needed. Requires this.header set. */
  private readPayload(): Buffer | null {
    const header = this.header as PendingHeader;
    if (header.payloadLength === 0) return Buffer.alloc(0);
    if (this.available() < header.payloadLength) return null;
    // Copy so emitted payloads do not pin the (possibly large) feed buffer.
    const payload = Buffer.from(
      this.buf.subarray(this.pos, this.pos + header.payloadLength),
    );
    this.pos += header.payloadLength;
    return payload;
  }
}
