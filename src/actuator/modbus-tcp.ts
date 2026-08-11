import { connect } from 'node:net';

import { assertCommandedLevel, toLevel } from '../domain/level.ts';
import type { CommandedLevel } from '../domain/level.ts';
import type { VentilationUnit } from './unit.ts';

/**
 * Modbus TCP against the 2VV Daphne, hand-rolled.
 *
 * We need two function codes against one register. A general Modbus library is
 * several thousand lines of protocol we do not use; this is a hundred that can
 * be read in one sitting and tested byte by byte against a fake stream.
 *
 * Everything below was recovered from earlier C# spikes proven against the real
 * unit: address, unit id, register number, value encoding, timeout, retries.
 */

// ─────────────────────────────────────────────────────────────────────────────
// TEACHING NOTES — what Modbus actually is, for reading the rest of this file
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
// **PDU** is "Protocol Data Unit" — the function code plus its data, and nothing
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

// **21001, not the 21002 the documentation gives.** The usual Modbus convention
// clash: documentation numbers registers from 1, the wire numbers them from 0.
// This is not a bug and must not be "corrected".
//
// TEACHING: this single line is the highest-risk constant in the file. Every
// other value here is checkable against the Modbus spec; this one is only
// knowable by having tried it against the actual device. Both C# spikes used
// 21001, and this client has now driven the real unit with it.
const FAN_SPEED_REGISTER = 21_001;

// The unit stores percent times ten: 400 means 40%.
//
// TEACHING: Modbus registers hold integers only — there are no floats and no
// units. A vendor wanting one decimal place multiplies by ten and expects you
// to know. 50% travels as 500; reading 500 back means 50%.
const PERCENT_SCALE = 10;

// TEACHING: the two function codes we use, from the Modbus spec.
//   0x03 "read holding registers" — read N registers starting at an address
//   0x06 "write single register"  — write one value to one address
const READ_HOLDING_REGISTERS = 0x03;
const WRITE_SINGLE_REGISTER = 0x06;
// TEACHING: a device signals a refusal by setting the top bit of the function
// code in its reply: 0x06 becomes 0x86. `code & 0x80` is how you detect it.
const EXCEPTION_FLAG = 0x80;
// TEACHING: transaction id (2) + protocol id (2) + length (2) + unit id (1).
const MBAP_HEADER_BYTES = 7;
// TEACHING: where the length field starts, i.e. byte 4 of the header.
const MBAP_LENGTH_OFFSET = 4;
// One unit id plus the largest PDU Modbus allows.
//
// TEACHING: 254 = 1 + 253, and the 253 is a fossil. A serial Modbus RTU frame
// could be at most 256 bytes; take off the address byte and the two CRC bytes
// and the PDU has 253 left. TCP has no such constraint, but the limit was kept
// so that the same PDU stays valid on both transports.
//
// So the bound below — the thing that stops a peer claiming 65535 bytes and
// making us wait out the whole budget — is enforcing an RS-485 framing limit
// from 1979 over a modern socket. Correct, and worth knowing where it came from.
const MAX_MBAP_LENGTH = 254;

/**
 * A raw byte stream, so the protocol can be tested without a socket. Chunk
 * boundaries are deliberately the caller's problem: TCP is free to split a
 * twelve-byte frame in half, and reassembling it is the part worth testing.
 */
// TEACHING: this interface is the *seam* — the point where the code can be
// swapped without editing anything that uses it. Everything above it is pure
// protocol logic that can be tested with a fake three-method object; everything
// below it (`openTcpStream`) is real socket plumbing tested against loopback.
//
// The seam is deliberately at the *byte* level rather than at the frame level.
// A fake that handed back whole frames would never exercise reassembly, which
// is the single most common bug in hand-written network clients: people assume
// one 'data' event equals one message, and it does not.
export interface ByteStream {
  send(bytes: Uint8Array): void;
  listen(onChunk: (chunk: Uint8Array) => void, onError: (error: Error) => void): void;
  close(): void;
}

// TEACHING: a function type, so tests can pass their own opener instead of the
// real TCP one. The default is supplied in `createModbusUnit` below.
export type OpenStream = (host: string, port: number, timeoutMs: number) => Promise<ByteStream>;

export interface ModbusUnitOptions {
  readonly host: string;
  readonly port: number;
  readonly unitId: number;
  /** Covers connecting as well as waiting for the answer — see `openTcpStream`. */
  readonly timeoutMs: number;
  readonly retries: number;
  /** Between attempts. Reconnecting the instant a device refused you is the
   * least likely attempt to succeed, and four of those inside a millisecond is
   * one attempt wearing a disguise. */
  readonly retryPauseMs: number;
}

// TEACHING: a factory function, not a class. It returns an object holding two
// methods that close over `options` and the transaction counter. This is how the
// project does "an object with private state" without `class` or `this`.
export function createModbusUnit(
  options: ModbusUnitOptions,
  openStream: OpenStream = openTcpStream,
): VentilationUnit {
  // The unit id is narrowed because its bad values fail *silently*:
  // Number("banana") is NaN, a Uint8Array coerces NaN to 0, and 0 is the Modbus
  // broadcast address — the unit would act on a write and never reply, so a
  // command that landed would be reported as having failed.
  //
  // The host and port get no such guard, deliberately. A nonsense port fails
  // loudly on every attempt with the operating system's own message, which the
  // loop logs and recovers from; there is nothing silent to protect against, and
  // a guard per field would be ceremony rather than defence.
  //
  // TEACHING: 1–247 is the Modbus spec's range for addressable devices. 0 is
  // "broadcast to everyone, nobody replies"; 248–255 are reserved.
  if (!Number.isInteger(options.unitId) || options.unitId < 1 || options.unitId > 247) {
    throw new Error(`unit id ${options.unitId} is not a Modbus slave address (1-247)`);
  }

  // Monotonic across the process, so a reply to an earlier request can never be
  // mistaken for the answer to this one.
  let lastTransactionId = 0;

  // TEACHING: wraps at 65536 because the field is two bytes. Wrapping to 0 is
  // fine — 0 is a legal transaction id, and each exchange uses a brand-new
  // connection anyway, so two live requests can never share a socket.
  const nextTransactionId = (): number => {
    lastTransactionId = (lastTransactionId + 1) % 0x1_0000;
    return lastTransactionId;
  };

  // TEACHING: ONE attempt. Connect, send, wait for a frame, close. The retry
  // logic lives one level up in `ask`.
  const exchange = async (request: Uint8Array): Promise<Uint8Array> => {
    // A fresh connection per request. At two requests every thirty seconds a
    // persistent socket is state to manage — stale connections, reconnection,
    // half-open detection — bought with nothing.
    //
    // `timeoutMs` is the budget for the whole attempt, not for each half of it.
    // Spending a full timeout on connecting and then another on waiting makes a
    // "five second" attempt take ten, and enough of those overrun the thirty
    // second cycle they are supposed to fit inside.
    //
    // TEACHING: `performance.now()` rather than `Date.now()` because it is
    // monotonic — it cannot jump backwards when the machine syncs its clock,
    // which would otherwise make `remaining` nonsense.
    const startedAt = performance.now();
    const stream = await openStream(options.host, options.port, options.timeoutMs);

    try {
      const remaining = options.timeoutMs - (performance.now() - startedAt);
      if (remaining <= 0) {
        throw new Error(`connecting to ${options.host} used the whole ${options.timeoutMs} ms`);
      }

      return await sendAndWait(stream, request, remaining);
    } finally {
      // TEACHING: `finally` runs on every exit — success, timeout, malformed
      // frame, or the throw just above. This one line is what stops the process
      // leaking a socket per failed attempt, forever. A test counts opens
      // against closes precisely because deleting it breaks nothing visibly.
      stream.close();
    }
  };

  // TEACHING: the retry policy. Note what it retries and what it does not —
  // that distinction is the interesting part of this function.
  const ask = async (request: Uint8Array, expectedCode: number): Promise<Uint8Array> => {
    let lastFailure: Error | undefined;

    // TEACHING: `retries: 1` means TWO attempts (0 and 1). Off-by-one worth
    // knowing when reading main.ts's timing arithmetic.
    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      let response: Uint8Array;

      try {
        response = await exchange(request);
      } catch (error) {
        // Network trouble: a refused connection, a timeout, a dropped socket.
        // Worth another go, after a pause.
        //
        // TEACHING: the `catch` only wraps `exchange`, so only *transport*
        // failures land here. Everything after this block is a frame we
        // actually received, and it is deliberately outside the try.
        lastFailure = error instanceof Error ? error : new Error(String(error));
        if (attempt < options.retries) await pause(options.retryPauseMs);
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

    // TEACHING: reachable only if the loop never ran, which needs a negative
    // `retries`. The `??` keeps the type honest rather than asserting.
    throw lastFailure ?? new Error('the unit was never asked');
  };

  return {
    async read() {
      // TEACHING: FC3 asks "give me N registers starting at address A", so the
      // PDU is [function code, address hi, address lo, count hi, count lo].
      // We want exactly one register, hence `toBigEndian(1)`.
      const request = buildFrame(nextTransactionId(), options.unitId, [
        READ_HOLDING_REGISTERS,
        ...toBigEndian(FAN_SPEED_REGISTER),
        ...toBigEndian(1),
      ]);

      // TEACHING: `body` is everything after the function code. For FC3 that is
      // [byte count, value hi, value lo] — so a healthy answer is 3 bytes with
      // a count of 2. Checking both guards a truncated frame and a device that
      // answered about a different number of registers than we asked for.
      const body = await ask(request, READ_HOLDING_REGISTERS);
      if (body.length < 3 || body[0] !== 2) {
        throw new Error(`expected one register back, the unit sent a ${body.length}-byte body`);
      }

      // TEACHING: offset 1 skips the byte count. 500 / 10 = 50, and `toLevel`
      // then checks 50 is one of the nine levels the unit can actually be at —
      // so a register holding 555 (55.5%) becomes an error rather than a lie.
      const raw = fromBigEndian(body, 1);
      const level = toLevel(raw / PERCENT_SCALE);
      if (level === undefined) {
        throw new Error(`the unit reported register value ${raw}, which is not a level`);
      }

      return level;
    },

    async set(level: CommandedLevel) {
      // The runtime half of the type, at the one place a level stops being a
      // TypeScript union and becomes two bytes on a wire. Type stripping checks
      // nothing, and the intake grille cannot pass the air above the ceiling.
      //
      // TEACHING: `CommandedLevel` is a compile-time-only guarantee. Node strips
      // types without checking them, so at runtime this function would happily
      // accept 100 from any JavaScript caller. `assertCommandedLevel` is the
      // same guarantee expressed in a way that survives to runtime.
      const checked = assertCommandedLevel(level);
      const value = checked * PERCENT_SCALE;

      // TEACHING: FC6 is [function code, address hi, address lo, value hi,
      // value lo] — same shape as the read request, different meaning for the
      // last two bytes.
      const request = buildFrame(nextTransactionId(), options.unitId, [
        WRITE_SINGLE_REGISTER,
        ...toBigEndian(FAN_SPEED_REGISTER),
        ...toBigEndian(value),
      ]);

      // FC6 echoes back the register and the value it wrote. A disagreeing echo
      // means something else is on the wire, and reporting success would leave
      // the loop believing a level the unit never took.
      //
      // TEACHING: for FC6 the body is [reg hi, reg lo, value hi, value lo] —
      // four bytes, no byte count. Hence the different length check from read().
      const body = await ask(request, WRITE_SINGLE_REGISTER);
      if (body.length < 4) {
        throw new Error(`expected the register and value echoed back, the unit sent a ${body.length}-byte body`);
      }

      const echoedRegister = fromBigEndian(body, 0);
      const echoedValue = fromBigEndian(body, 2);

      if (echoedRegister !== FAN_SPEED_REGISTER || echoedValue !== value) {
        throw new Error(
          `the unit echoed register ${echoedRegister} = ${echoedValue}, not ${FAN_SPEED_REGISTER} = ${value}`,
        );
      }
    },
  };
}

// MBAP header then PDU: transaction id, protocol id (always zero over TCP), the
// length of everything after this field, unit id.
//
// TEACHING: assembles the diagram at the top of this file. `Uint8Array` is a
// fixed-length array of bytes; `.set(source, offset)` copies bytes into it at a
// position. The frame is allocated at exactly the right size up front, so every
// write below lands in already-reserved space.
//
// Note the split of responsibilities: callers build the PDU — the command
// itself, which would be identical over serial — and this function adds only the
// TCP-specific wrapper around it.
function buildFrame(transactionId: number, unitId: number, pdu: readonly number[]): Uint8Array {
  const frame = new Uint8Array(MBAP_HEADER_BYTES + pdu.length);

  frame.set(toBigEndian(transactionId), 0); // bytes 0-1
  frame.set(toBigEndian(0), 2); // bytes 2-3, protocol id: always zero
  // TEACHING: the length field counts what FOLLOWS it — the unit id (1 byte)
  // plus the PDU. Hence `+ 1`. Getting this wrong is the classic Modbus bug:
  // the device waits forever for bytes you never promised to send.
  frame.set(toBigEndian(pdu.length + 1), MBAP_LENGTH_OFFSET); // bytes 4-5
  frame[6] = unitId; // byte 6
  frame.set(pdu, MBAP_HEADER_BYTES); // bytes 7 onward

  return frame;
}

/** The PDU body after the function code, having checked everything before it. */
// TEACHING: five checks, in order, each rejecting a different way the answer
// could be wrong. They run before any data is trusted, and every one of them
// has a test. Read this as "what could a reply be, other than our reply?"
function readAnswer(
  response: Uint8Array,
  request: Uint8Array,
  expectedCode: number,
  unitId: number,
): Uint8Array {
  // (1) Long enough to contain a header and a function code at all.
  if (response.length < MBAP_HEADER_BYTES + 1) {
    throw new Error(`the unit sent ${response.length} bytes, too short to be a frame`);
  }

  // (2) It answers OUR question. Without this, a late reply to the previous
  // request could be accepted as the answer to this one — which for a read
  // means reporting a stale fan level as current.
  const asked = fromBigEndian(request, 0);
  const answered = fromBigEndian(response, 0);
  if (answered !== asked) {
    throw new Error(`answer to transaction ${answered}, but we asked ${asked}`);
  }

  // The one header field that carried no check. It is always zero over TCP, so
  // anything else means this is not a Modbus TCP frame at all.
  const protocol = fromBigEndian(response, 2);
  if (protocol !== 0) {
    throw new Error(`answer carries protocol id ${protocol}, but Modbus TCP is always 0`);
  }

  // (4) From the device we addressed, not another one behind the same gateway.
  if (response[6] !== unitId) {
    throw new Error(`answer from unit ${String(response[6])}, but we asked unit ${unitId}`);
  }

  // TEACHING: indexing a Uint8Array can yield `undefined` under this project's
  // `noUncheckedIndexedAccess` setting, so it has to be handled rather than
  // assumed. In practice check (1) already guarantees this byte exists.
  const code = response[MBAP_HEADER_BYTES];
  if (code === undefined) throw new Error('the unit sent a frame with no function code');

  // The original C# spike swallowed these in an empty catch, which is how a
  // refused write became a silent no-op.
  //
  // TEACHING: (5a) the refusal case. The device set the top bit of the function
  // code and appended one byte saying why (2 = "bad address", 3 = "bad value",
  // and so on). This is the device *talking*, so it must not be retried.
  if ((code & EXCEPTION_FLAG) !== 0) {
    const reason = response[MBAP_HEADER_BYTES + 1] ?? 0;
    throw new Error(`the unit refused the request with Modbus exception ${reason}`);
  }

  // (5b) It answered the question we asked, not a different one. A well-formed
  // FC3 reply to our FC6 request would otherwise have its first four bytes read
  // as a register echo — someone else's data becoming our confirmation.
  if (code !== expectedCode) {
    throw new Error(`the unit answered function ${code}, but we asked ${expectedCode}`);
  }

  // TEACHING: hand back only the part the caller cares about — everything after
  // the function code. `slice` copies; `subarray` would return a view onto the
  // same memory, which is a subtle way to leak a buffer.
  return response.slice(MBAP_HEADER_BYTES + 1);
}

// TEACHING: the request/response cycle over one already-open stream. Wrapped in
// a Promise because the answer arrives later, in a callback, and the caller
// wants to `await` it. The three ways this settles are: a complete frame
// (resolve), the timer firing (reject), or the stream erroring (reject).
function sendAndWait(
  stream: ByteStream,
  request: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // TEACHING: the accumulator. TCP hands us arbitrary chunks, so bytes pile up
    // here until they form a whole frame.
    let received: Uint8Array = new Uint8Array(0);

    const timer = setTimeout(() => {
      reject(new Error(`the unit did not answer in the ${Math.round(timeoutMs)} ms left after connecting`));
    }, timeoutMs);

    stream.listen(
      (chunk) => {
        received = concat(received, chunk);

        try {
          const frame = completeFrame(received);
          // TEACHING: `undefined` means "not all here yet" — a partial frame is
          // normal, not an error, so simply return and wait for more bytes.
          if (frame === undefined) return;

          // TEACHING: clearing the timer matters. A fired timer on a settled
          // promise is harmless, but leaving it armed keeps the process alive.
          clearTimeout(timer);
          resolve(frame);
        } catch (error) {
          // A malformed length claim is the peer answering badly, not silence.
          // Escaping this handler would put it on the socket instead.
          //
          // TEACHING: this handler is called by the socket's 'data' event. A
          // throw here does not travel to the caller of `sendAndWait` — there is
          // no call stack connecting them — it becomes an uncaught exception.
          // Catching and rejecting is what routes it back to the awaiting code.
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );

    // TEACHING: listeners registered BEFORE sending, so an answer that arrives
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
  // TEACHING: 6 bytes — we cannot even read the length field until the first six
  // have arrived, since it occupies bytes 4 and 5.
  if (received.length < MBAP_HEADER_BYTES - 1) return undefined;

  const declared = fromBigEndian(received, MBAP_LENGTH_OFFSET);
  if (declared > MAX_MBAP_LENGTH) {
    throw new Error(`the answer declares ${declared} bytes, more than a Modbus frame can hold`);
  }

  // TEACHING: the length field counts bytes after itself, and it ends at byte 5 —
  // so the total frame size is 6 plus whatever it declares.
  const total = MBAP_LENGTH_OFFSET + 2 + declared;
  // TEACHING: anything beyond `total` is left alone. On a one-request connection
  // there should be nothing, and if there is, it is not ours to interpret.
  return received.length < total ? undefined : received.slice(0, total);
}

// TEACHING: split a number into two bytes, most significant first.
//   21001 = 0x5209 → [0x52, 0x09]
//   `>> 8` shifts the high byte down into position; `& 0xff` keeps only the
//   lowest eight bits, discarding anything above.
function toBigEndian(value: number): readonly number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

// TEACHING: the inverse — two bytes back into a number.
//   [0x01, 0xf4] → (0x01 << 8) | 0xf4 = 256 + 244 = 500
function fromBigEndian(bytes: Uint8Array, offset: number): number {
  const high = bytes[offset];
  const low = bytes[offset + 1];

  if (high === undefined || low === undefined) {
    throw new Error(`the frame ends before offset ${offset + 1}`);
  }

  return (high << 8) | low;
}

// TEACHING: Uint8Array has no `concat`, so joining means allocating a new array
// and copying both halves in. Fine at these sizes — frames are twelve bytes.
function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

// TEACHING: `await pause(250)` — the idiomatic way to sleep in async code.
function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// TEACHING: the only function in this file that touches a real socket, and the
// default value of the `openStream` parameter at the top. Everything above is
// testable without it; this is tested against a loopback server.
function openTcpStream(host: string, port: number, timeoutMs: number): Promise<ByteStream> {
  return new Promise((resolve, reject) => {
    // TEACHING: `connect` returns immediately with a socket that is not yet
    // connected. The 'connect' event below is when it actually becomes usable.
    const socket = connect({ host, port });

    // Connecting has to sit inside the budget. Left to the operating system, an
    // address that has stopped answering SYNs blocks for over a minute per
    // attempt, against a thirty-second control cycle.
    //
    // An explicit timer rather than `socket.setTimeout`, which reads zero as "no
    // timeout at all" — so a misconfigured budget would hang here forever rather
    // than failing immediately, which is the failure this exists to prevent.
    //
    // TEACHING: `destroy(error)` tears the socket down AND emits that error,
    // which the listener below turns into a rejection. One mechanism, not two.
    const connectTimer = setTimeout(() => {
      socket.destroy(new Error(`no connection to ${host}:${port} within ${timeoutMs} ms`));
    }, timeoutMs);

    // Deliberately left attached after the promise settles. Rejecting a settled
    // promise is a no-op, and it means the socket is never for one instant
    // without an error listener — which is what Node turns into a crash.
    //
    // TEACHING: that last clause is a real Node behaviour, not caution. An
    // 'error' event with no listener does not throw — it terminates the process.
    socket.once('error', (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });

    socket.once('connect', () => {
      clearTimeout(connectTimer);

      // TEACHING: the socket is only wrapped in a `ByteStream` once it is
      // actually connected, so nothing above this line can be handed a socket
      // that is still dialling.
      resolve({
        // TEACHING: `void` discards `write`'s return value (a backpressure hint
        // that is meaningless for a single twelve-byte write) and satisfies the
        // interface's `void` return type.
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
