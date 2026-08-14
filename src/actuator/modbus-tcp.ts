import { connect } from 'node:net';

import { toLevel } from '../domain/level.ts';
import type { CommandedLevel } from '../domain/level.ts';
import type { VentilationUnit } from './unit.ts';

/**
 * Modbus TCP against the 2VV Daphne, hand-rolled.
 *
 * We need two function codes against one register. A general Modbus library is
 * several thousand lines of protocol we do not use; this is a hundred that can
 * be read in one sitting and tested byte by byte against a fake stream.
 *
 * Every protocol detail below — register number, value encoding, framing,
 * timeout, retries — has been confirmed against the real unit.
 */

// ─────────────────────────────────────────────────────────────────────────────
// WHAT MODBUS IS — background for reading the rest of this file
//
// Modbus is a 1979 industrial protocol. A device exposes an array of 16-bit
// "registers" and you read or write them by number. There are no names, no
// types, no discovery: register 21001 holds the fan speed because the vendor's
// documentation says so, and that is the entire contract.
//
// "Modbus TCP" is that protocol wrapped in a 7-byte header (the MBAP header)
// and sent over an ordinary TCP socket. A request looks like this:
//
//   byte:  0    1    2    3    4    5    6  │ 7      8    9    10   11
//         ┌─────────┬─────────┬─────────┬────┼──────┬─────────┬─────────┐
//         │ trans.  │ protocol│ length  │unit│ func │ register│  value  │
//         │   id    │  id (0) │  of ↓   │ id │ code │  number │         │
//         └─────────┴─────────┴─────────┴────┴──────┴─────────┴─────────┘
//          └───────────── MBAP header ───────┘└──────── PDU ────────────┘
//
//   transaction id  our number; the reply must carry it back, so we can tell
//                   this answer from a stale one
//   protocol id     always 0 for Modbus TCP. A tripwire, nothing more
//   length          how many bytes follow THIS field (so: unit id + PDU).
//                   This is the only thing that says where a frame ends
//   unit id         which device, for gateways that front several. Ours is 1
//   function code   what to do: 0x03 read, 0x06 write
//
// PDU is "Protocol Data Unit" — the function code plus its data, and nothing
// else. It gets its own name because it is *transport-independent*. Modbus
// predates TCP; it ran on RS-485 serial wire in 1979, and that version (Modbus
// RTU) wraps the same PDU differently:
//
//   Modbus RTU:  [address] [ PDU ] [CRC]      ← serial, needs its own checksum
//   Modbus TCP:  [  MBAP header  ] [ PDU ]    ← TCP already guarantees delivery
//
// The command in the middle is byte-for-byte identical either way. One command
// vocabulary, two wire formats — which is the whole reason the split has a name.
//
// Every multi-byte number is big-endian: most significant byte first. That is
// why 21001 (0x5209) goes on the wire as [0x52, 0x09].
//
// The reply repeats the transaction id, protocol id, unit id and function code,
// then carries its own body:
//
//   FC6 (write) reply  echoes the register number and the value it wrote
//   FC3 (read) reply   a byte count, then that many bytes of register data
//
// If the device refuses, it replies with the function code + 0x80 and a single
// "exception code" byte. That is an *answer*, not a network failure — which is
// why this file treats the two differently everywhere below.
// ─────────────────────────────────────────────────────────────────────────────

// 21001, not the 21002 the documentation gives. The usual Modbus convention
// clash: documentation numbers registers from 1, the wire numbers them from 0.
// This is not a bug and must not be "corrected".
//
// The highest-risk constant in the file: every other value here is checkable
// against the Modbus spec, this one only by having driven the real device.
const FAN_SPEED_REGISTER = 21_001;

// The unit stores percent times ten: 400 means 40%. Modbus registers hold
// integers only, so a vendor wanting one decimal place multiplies by ten and
// expects you to know.
const PERCENT_SCALE = 10;

//   0x03 "read holding registers" — read N registers starting at an address
//   0x06 "write single register"  — write one value to one address
const READ_HOLDING_REGISTERS = 0x03;
const WRITE_SINGLE_REGISTER = 0x06;
// A device signals a refusal by setting the top bit of the function code in its
// reply: 0x06 becomes 0x86.
const EXCEPTION_FLAG = 0x80;
// The MBAP header is fixed-width, so every field sits at a known byte. These
// names are the diagram above written down, and both the building and the
// reading side go through them — a byte position should never appear as a bare
// number at a call site.
const TRANSACTION_ID_OFFSET = 0;
const PROTOCOL_ID_OFFSET = 2;
const MBAP_LENGTH_OFFSET = 4;
const UNIT_ID_OFFSET = 6;

// transaction id (2) + protocol id (2) + length (2) + unit id (1).
const MBAP_HEADER_BYTES = 7;
// Every MBAP field except the unit id is two bytes wide. Only this one needs a
// name, because reassembly has to know where the length field ends.
const MBAP_LENGTH_BYTES = 2;

// The PDU starts where the header ends, so this is the same seven. Two names
// because they are two different things: one is how long the header is, the
// other is where the function code lives, and only the second belongs in an
// index.
const FUNCTION_CODE_OFFSET = MBAP_HEADER_BYTES;
// Everything after the function code — the exception code on a refusal, the
// register data otherwise.
const PDU_BODY_OFFSET = FUNCTION_CODE_OFFSET + 1;

// Written on the way out, checked on the way in. Always zero over Modbus TCP,
// which makes it a tripwire rather than information.
const PROTOCOL_ID = 0;
// One unit id plus the largest PDU Modbus allows. 254 = 1 + 253, and the 253 is
// a fossil: a serial Modbus RTU frame could be at most 256 bytes, less the
// address byte and the two CRC bytes. TCP has no such constraint, but the limit
// was kept so that the same PDU stays valid on both transports.
//
// It is also the bound that stops a peer claiming 65535 bytes and making us
// wait out the whole budget for data that will never arrive.
const MAX_MBAP_LENGTH = 254;

/**
 * A raw byte stream, so the protocol can be tested without a socket. Chunk
 * boundaries are deliberately the caller's problem: TCP is free to split a
 * twelve-byte frame in half, and reassembling it is the part worth testing.
 *
 * The seam sits at the *byte* level rather than the frame level on purpose. A
 * fake that handed back whole frames would never exercise reassembly, which is
 * the most common bug in hand-written network clients: people assume one 'data'
 * event equals one message, and it does not.
 */
export interface ByteStream {
  send(bytes: Uint8Array): void;
  listen(onChunk: (chunk: Uint8Array) => void, onError: (error: Error) => void): void;
  close(): void;
}

export type OpenStream = (host: string, port: number, timeoutMs: number) => Promise<ByteStream>;

export interface ModbusUnitOptions {
  readonly host: string;
  readonly port: number;
  readonly unitId: number;
  /** Covers connecting as well as waiting for the answer — see `openTcpStream`. */
  readonly timeout: Temporal.Duration;
  readonly retries: number;
  /** Between attempts. */
  readonly retryPause: Temporal.Duration;
}

export function createModbusUnit(
  options: ModbusUnitOptions,
  openStream: OpenStream = openTcpStream,
): VentilationUnit {
  // The unit id is narrowed because its bad values fail *silently*:
  // Number("banana") is NaN, a Uint8Array coerces NaN to 0, and 0 is the Modbus
  // broadcast address — the unit would act on a write and never reply, so a
  // command that landed would be reported as having failed. (1-247 is the
  // spec's range for addressable devices; 248-255 are reserved.)
  //
  // The host and port get no such guard, deliberately. A nonsense port fails
  // loudly on every attempt with the operating system's own message, which the
  // caller logs and recovers from; there is nothing silent to protect against,
  // and a guard per field would be ceremony rather than defence.
  if (!Number.isInteger(options.unitId) || options.unitId < 1 || options.unitId > 247) {
    throw new Error(`unit id ${options.unitId} is not a Modbus slave address (1-247)`);
  }

  // The one place the option durations become numbers. Everything below is
  // budget arithmetic against performance.now() and setTimeout, both of which
  // speak milliseconds; converting at every use would be ceremony.
  const timeoutMs = options.timeout.total('milliseconds');
  const retryPauseMs = options.retryPause.total('milliseconds');

  // Monotonic across the process, so a reply to an earlier request can never be
  // mistaken for the answer to this one.
  let lastTransactionId = 0;

  // Wraps at 65536 because the field is two bytes. Wrapping to 0 is fine — 0 is
  // a legal transaction id, and each exchange uses a brand-new connection
  // anyway, so two live requests can never share a socket.
  const nextTransactionId = (): number => {
    lastTransactionId = (lastTransactionId + 1) % 0x1_0000;
    return lastTransactionId;
  };

  // One attempt: connect, send, wait for a frame, close. Retries live in `ask`.
  const exchange = async (request: Uint8Array): Promise<Uint8Array> => {
    // A fresh connection per request. At two requests every thirty seconds a
    // persistent socket is state to manage — stale connections, reconnection,
    // half-open detection — bought with nothing.
    //
    // The timeout is the budget for the whole attempt, not for each half of it.
    // Spending a full timeout on connecting and then another on waiting makes a
    // "five second" attempt take ten, and enough of those overrun the thirty
    // second cycle they are supposed to fit inside.
    //
    // performance.now() rather than Date.now() because it is monotonic: it
    // cannot jump backwards when the machine syncs its clock, which would
    // otherwise make `remaining` nonsense.
    const startedAt = performance.now();
    const stream = await openStream(options.host, options.port, timeoutMs);

    try {
      const remaining = timeoutMs - (performance.now() - startedAt);
      if (remaining <= 0) {
        throw new Error(`connecting to ${options.host} used the whole ${timeoutMs} ms`);
      }

      return await sendAndWait(stream, request, remaining);
    } finally {
      // What stops the process leaking a socket per failed attempt, forever. A
      // test counts opens against closes precisely because deleting this line
      // breaks nothing visibly.
      stream.close();
    }
  };

  const ask = async (request: Uint8Array, expectedCode: number): Promise<Uint8Array> => {
    let lastFailure: Error | undefined;

    // `retries: 1` means TWO attempts (0 and 1) — worth knowing when reading
    // main.ts's timing arithmetic.
    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      let response: Uint8Array;

      try {
        response = await exchange(request);
      } catch (error) {
        // Network trouble: a refused connection, a timeout, a dropped socket.
        // Worth another go, after a pause. The catch wraps only `exchange`, so
        // only *transport* failures land here.
        lastFailure = error instanceof Error ? error : new Error(String(error));
        if (attempt < options.retries) await pause(retryPauseMs);
        continue;
      }

      // A frame arrived. Whether or not we like it, asking again gets the same
      // answer — so anything wrong with it here is thrown rather than retried.
      //
      // Note where the line falls: a frame we cannot even delimit, because the
      // declared length is nonsense, fails during reassembly above and *is*
      // retried. That is deliberate. Failing to frame means the connection is
      // not carrying Modbus at all, and a fresh one is worth trying; failing to
      // agree with a frame we did read means the unit has answered and will
      // answer the same way again.
      return readAnswer(response, request, expectedCode, options.unitId);
    }

    // Reachable only if the loop never ran, which needs a negative `retries`.
    throw lastFailure ?? new Error('the unit was never asked');
  };

  return {
    async read() {
      // FC3 asks "give me N registers starting at address A", so the PDU is
      // [function code, address hi, address lo, count hi, count lo].
      const request = buildFrame(nextTransactionId(), options.unitId, [
        READ_HOLDING_REGISTERS,
        ...toBigEndianBytes(FAN_SPEED_REGISTER),
        ...toBigEndianBytes(1),
      ]);

      // For FC3 the body is [byte count, value hi, value lo], so a healthy
      // answer is 3 bytes with a count of 2. Checking both guards a truncated
      // frame and a device that answered about a different number of registers
      // than we asked for.
      const body = await ask(request, READ_HOLDING_REGISTERS);
      if (body.length < 3 || body[0] !== 2) {
        throw new Error(`expected one register back, the unit sent a ${body.length}-byte body`);
      }

      // Offset 1 skips the byte count. `toLevel` then checks the result is one
      // of the nine levels the unit can actually be at, so a register holding
      // 555 (55.5%) becomes an error rather than a lie.
      const raw = readBigEndianUint16(body, 1);
      const level = toLevel(raw / PERCENT_SCALE);
      if (level === undefined) {
        throw new Error(`the unit reported register value ${raw}, which is not a level`);
      }

      return level;
    },

    async set(level: CommandedLevel) {
      const value = level * PERCENT_SCALE;

      // FC6 is [function code, address hi, address lo, value hi, value lo] —
      // the same shape as the read request, a different meaning for the last
      // two bytes.
      const request = buildFrame(nextTransactionId(), options.unitId, [
        WRITE_SINGLE_REGISTER,
        ...toBigEndianBytes(FAN_SPEED_REGISTER),
        ...toBigEndianBytes(value),
      ]);

      // FC6 echoes back the register and the value it wrote. A disagreeing echo
      // means something else is on the wire, and reporting success would leave
      // the caller believing a level the unit never took. The body here is
      // [reg hi, reg lo, value hi, value lo] — four bytes, no byte count.
      const body = await ask(request, WRITE_SINGLE_REGISTER);
      if (body.length < 4) {
        throw new Error(`expected the register and value echoed back, the unit sent a ${body.length}-byte body`);
      }

      const echoedRegister = readBigEndianUint16(body, 0);
      const echoedValue = readBigEndianUint16(body, 2);

      if (echoedRegister !== FAN_SPEED_REGISTER || echoedValue !== value) {
        throw new Error(
          `the unit echoed register ${echoedRegister} = ${echoedValue}, not ${FAN_SPEED_REGISTER} = ${value}`,
        );
      }
    },
  };
}

// MBAP header then PDU. Note the split of responsibilities: callers build the
// PDU — the command itself, which would be identical over serial — and this
// function adds only the TCP-specific wrapper around it.
function buildFrame(transactionId: number, unitId: number, pdu: readonly number[]): Uint8Array {
  const frame = new Uint8Array(MBAP_HEADER_BYTES + pdu.length);

  frame.set(toBigEndianBytes(transactionId), TRANSACTION_ID_OFFSET);
  frame.set(toBigEndianBytes(PROTOCOL_ID), PROTOCOL_ID_OFFSET);
  // The length field counts what FOLLOWS it — the unit id (1 byte) plus the
  // PDU. Hence `+ 1`. Forgetting it is the classic Modbus bug, because "length"
  // reads as the PDU's length and the unit id being counted is the surprise:
  // declare the PDU alone and the device consumes a PDU one byte short, leaving
  // our last byte to be read as the start of the next frame.
  frame.set(toBigEndianBytes(pdu.length + 1), MBAP_LENGTH_OFFSET);
  frame[UNIT_ID_OFFSET] = unitId;
  frame.set(pdu, MBAP_HEADER_BYTES);

  return frame;
}

/** The PDU body after the function code, having checked everything before it. */
// Five checks, in order, each rejecting a different way the answer could be
// wrong. They run before any data is trusted, and every one of them has a test.
// Read this as "what could a reply be, other than our reply?"
function readAnswer(
  response: Uint8Array,
  request: Uint8Array,
  expectedCode: number,
  unitId: number,
): Uint8Array {
  // (1) Long enough to contain a header and a function code at all.
  if (response.length < PDU_BODY_OFFSET) {
    throw new Error(`the unit sent ${response.length} bytes, too short to be a frame`);
  }

  // (2) It answers OUR question. Without this, a late reply to the previous
  // request could be accepted as the answer to this one — which for a read
  // means reporting a stale fan level as current.
  const asked = readBigEndianUint16(request, TRANSACTION_ID_OFFSET);
  const answered = readBigEndianUint16(response, TRANSACTION_ID_OFFSET);
  if (answered !== asked) {
    throw new Error(`answer to transaction ${answered}, but we asked ${asked}`);
  }

  // (3) Always zero over TCP, so anything else means this is not a Modbus TCP
  // frame at all.
  const protocol = readBigEndianUint16(response, PROTOCOL_ID_OFFSET);
  if (protocol !== PROTOCOL_ID) {
    throw new Error(`answer carries protocol id ${protocol}, but Modbus TCP is always 0`);
  }

  // (4) From the device we addressed, not another one behind the same gateway.
  if (response[UNIT_ID_OFFSET] !== unitId) {
    throw new Error(`answer from unit ${String(response[UNIT_ID_OFFSET])}, but we asked unit ${unitId}`);
  }

  // Indexing a Uint8Array can yield `undefined` under this project's
  // `noUncheckedIndexedAccess`, so it has to be handled rather than assumed. In
  // practice check (1) already guarantees this byte exists.
  const code = response[FUNCTION_CODE_OFFSET];
  if (code === undefined) throw new Error('the unit sent a frame with no function code');

  // (5a) The refusal case. The device set the top bit of the function code and
  // appended one byte saying why (2 = "bad address", 3 = "bad value", and so
  // on). This is the device *talking*, so it must not be retried.
  if ((code & EXCEPTION_FLAG) !== 0) {
    const reason = response[PDU_BODY_OFFSET] ?? 0;
    throw new Error(`the unit refused the request with Modbus exception ${reason}`);
  }

  // (5b) It answered the question we asked, not a different one. A well-formed
  // FC3 reply to our FC6 request would otherwise have its first four bytes read
  // as a register echo — someone else's data becoming our confirmation.
  if (code !== expectedCode) {
    throw new Error(`the unit answered function ${code}, but we asked ${expectedCode}`);
  }

  // `slice` copies; `subarray` would return a view onto the same memory, which
  // is a subtle way to leak a buffer.
  return response.slice(PDU_BODY_OFFSET);
}

// The request/response cycle over one already-open stream. The three ways this
// settles are: a complete frame (resolve), the timer firing (reject), or the
// stream erroring (reject).
function sendAndWait(
  stream: ByteStream,
  request: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // TCP hands us arbitrary chunks, so bytes pile up here until they form a
    // whole frame.
    let received: Uint8Array = new Uint8Array(0);

    const timer = setTimeout(() => {
      reject(new Error(`the unit did not answer in the ${Math.round(timeoutMs)} ms left after connecting`));
    }, timeoutMs);

    stream.listen(
      (chunk) => {
        received = concat(received, chunk);

        try {
          const frame = completeFrame(received);
          // `undefined` means "not all here yet" — a partial frame is normal,
          // not an error, so simply wait for more bytes.
          if (frame === undefined) return;

          // A fired timer on a settled promise is harmless, but leaving one
          // armed keeps the process alive.
          clearTimeout(timer);
          resolve(frame);
        } catch (error) {
          // A malformed length claim is the peer answering badly, not silence.
          //
          // This handler is called by the socket's 'data' event, so a throw here
          // does not travel to the caller of `sendAndWait` — there is no call
          // stack connecting them — it becomes an uncaught exception. Catching
          // and rejecting is what routes it back to the awaiting code.
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );

    // Listeners registered BEFORE sending, so an answer that arrives
    // immediately cannot be missed. Ordering here is not cosmetic.
    stream.send(request);
  });
}

// TCP may deliver a frame in any number of chunks. The MBAP length field says
// how many bytes follow it, and is the only way to know where a frame ends.
//
// It is also the one number on this transport that a peer chooses for us, so it
// is bounded. A frame is at most a unit id and a 253-byte PDU; believing a claim
// of 65535 means waiting out the whole budget for bytes that will never arrive,
// while buffering whatever does — and then retrying the same garbage.
function completeFrame(received: Uint8Array): Uint8Array | undefined {
  // The length field occupies bytes 4 and 5, so six bytes must have arrived
  // before it can be read at all.
  const bytesThroughLengthField = MBAP_LENGTH_OFFSET + MBAP_LENGTH_BYTES;
  if (received.length < bytesThroughLengthField) return undefined;

  const declared = readBigEndianUint16(received, MBAP_LENGTH_OFFSET);
  if (declared > MAX_MBAP_LENGTH) {
    throw new Error(`the answer declares ${declared} bytes, more than a Modbus frame can hold`);
  }

  // The length field counts bytes after itself, so the total frame size is
  // everything through that field plus whatever it declares.
  const total = bytesThroughLengthField + declared;
  // Anything beyond `total` is left alone. On a one-request connection there
  // should be nothing, and if there is, it is not ours to interpret.
  return received.length < total ? undefined : received.slice(0, total);
}

// Split a number into two bytes, most significant first: 21001 = 0x5209 becomes
// [0x52, 0x09].
//
// A tuple rather than `number[]` because the arity is load-bearing and nothing
// else states it: every offset in `buildFrame` is spaced two bytes apart
// precisely because this returns two. A third element would still produce a
// well-formed frame — the length field is computed from `pdu.length` — with
// every field after it silently shifted, which is the worst shape a bug can
// take here.
function toBigEndianBytes(value: number): readonly [number, number] {
  return [(value >> 8) & 0xff, value & 0xff];
}

// The other direction: the two bytes at `offset` back into a number.
//
// Not a strict mirror of the above, which is why the names are not a matched
// pair either: this reads a two-byte window out of a whole frame rather than
// handing back a standalone one, so it takes an offset and has to defend
// against the frame ending inside the field it was asked for.
function readBigEndianUint16(bytes: Uint8Array, offset: number): number {
  const high = bytes[offset];
  const low = bytes[offset + 1];

  if (high === undefined || low === undefined) {
    throw new Error(`the frame ends before offset ${offset + 1}`);
  }

  return (high << 8) | low;
}

// Frames are twelve bytes, so allocating and copying on every join costs
// nothing worth avoiding.
function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// The only function here that touches a real socket, and the default value of
// the `openStream` parameter above. Everything else is testable without it;
// this is tested against a loopback server.
function openTcpStream(host: string, port: number, timeoutMs: number): Promise<ByteStream> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });

    // Connecting has to sit inside the budget. Left to the operating system, an
    // address that has stopped answering SYNs blocks for over a minute per
    // attempt — with retries, minutes against an API caller waiting for the
    // answer.
    //
    // An explicit timer rather than `socket.setTimeout`, which reads zero as "no
    // timeout at all" — so a misconfigured budget would hang here forever rather
    // than failing immediately, which is the failure this exists to prevent.
    //
    // `destroy(error)` tears the socket down AND emits that error, which the
    // listener below turns into a rejection. One mechanism, not two.
    const connectTimer = setTimeout(() => {
      socket.destroy(new Error(`no connection to ${host}:${port} within ${timeoutMs} ms`));
    }, timeoutMs);

    // Deliberately left attached after the promise settles. Rejecting a settled
    // promise is a no-op, and it means the socket is never for one instant
    // without an error listener — which Node turns into process termination
    // rather than a catchable throw.
    socket.once('error', (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });

    socket.once('connect', () => {
      clearTimeout(connectTimer);

      // Wrapped only once actually connected, so nothing above this line can be
      // handed a socket that is still dialling.
      resolve({
        send: (bytes) => void socket.write(bytes),
        listen: (onChunk, onError) => {
          socket.on('data', onChunk);
          socket.on('error', onError);
          // A unit that accepts the connection and then closes it without
          // answering produces no data and no error, so without this the
          // exchange waits out its whole timeout for a socket already gone.
          // Small embedded stacks shed load exactly this way.
          //
          // This also fires on our own `close()` after a successful exchange,
          // where rejecting a settled promise does nothing.
          socket.on('close', () => onError(new Error('the unit closed the connection')));
        },
        close: () => void socket.destroy(),
      });
    });
  });
}
