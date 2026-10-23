/**
 * Legacy-encoding-aware collect readers for foreground shell output.
 *
 * The stock collectors hardcode `toString('utf8')`, so a native tool writing
 * OEM 936 (GBK) or UTF-16LE through the shell pipeline garbles. The runtime
 * cannot intercept the stock collector, but it CAN rewrite a collect-mode
 * spawn to `'pipe'`, consume the raw bytes itself, and serve the
 * `SubprocessOutputReader` contract from a decoded UTF-8 text buffer.
 *
 * Encoding is decided once per stream, at the first non-empty read, from the
 * bytes accumulated so far (reusing the fs sniffer). Mixed-encoding streams
 * are out of scope — real tool output is single-encoding in practice.
 *
 * Contract kept: offsets are byte coordinates into the UTF-8 text this reader
 * serves; overflow keeps the TAIL and flags `lossy`. Spill files are not
 * produced (the `spillPath` field is optional by contract).
 */

import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { decodeLegacy, sniff, type SniffVerdict } from './fs.ts'

export interface OutputRead {
  text: string
  nextOffset: number
  lossy: boolean
  spillPath?: string
}

let spillCounter = 0

export class DecodingCollector {
  private chunks: Buffer[] = []
  private rawBytes = 0
  private totalRaw = 0
  private verdict: SniffVerdict | undefined
  /** UTF-8 text bytes discarded from the front of the window (whole-stream coordinates). */
  private slid = 0
  /** UTF-8 text bytes of raw chunks dropped by the retention cap in push(). */
  private droppedTextBytes = 0
  private window = Buffer.alloc(0)
  private spillFd: number | undefined
  private spillFile: string | undefined
  private spillDead = false

  constructor(private readonly maxBytes: number, private readonly spillMaxBytes?: number) {}

  /** Mirror of the stock semantics: raw bytes, created on first overflow, discarded past the cap. */
  private spillWrite(chunk: Buffer, priorChunks: Buffer[]): void {
    if (this.spillMaxBytes === undefined || this.spillDead) return
    if (this.totalRaw > this.spillMaxBytes) {
      this.spillDead = true
      if (this.spillFd !== undefined) {
        try { closeSync(this.spillFd) } catch { /* already closed */ }
        try { unlinkSync(this.spillFile!) } catch { /* already gone */ }
        this.spillFd = undefined
        this.spillFile = undefined
      }
      return
    }
    try {
      if (this.spillFd === undefined) {
        // Recreated on every open rather than cached for the process lifetime:
        // Windows temp cleaners (火绒, CCleaner, Storage Sense) delete
        // %TEMP%\dsh-* mid-session, and a cached directory handle turns the
        // next spill into an ENOENT thrown from a stream 'data' listener
        // (deepseek-harness#2252, still reproducible at rc.6). `recursive`
        // makes the re-check free when the directory survives.
        const dir = join(tmpdir(), `dsh-win32-spill-${process.pid}`)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        this.spillFile = join(dir, `stream-${spillCounter++}`)
        this.spillFd = openSync(this.spillFile, 'wx', 0o600)
        for (const prior of priorChunks) writeSync(this.spillFd, prior)
      } else {
        writeSync(this.spillFd, chunk)
      }
    } catch {
      // Spilling is best-effort: the in-memory tail still serves reads, so a
      // failure here must never reach push()'s caller (the 'data' listener).
      this.spillDead = true
      if (this.spillFd !== undefined) {
        try { closeSync(this.spillFd) } catch { /* already gone */ }
      }
      this.spillFd = undefined
      this.spillFile = undefined
    }
  }

  push(chunk: Buffer): void {
    const overflowing = this.totalRaw + chunk.length > this.maxBytes
    const prior = this.spillFd === undefined && overflowing ? [...this.chunks, chunk] : []
    this.chunks.push(chunk)
    this.rawBytes += chunk.length
    this.totalRaw += chunk.length
    if (overflowing) this.spillWrite(chunk, prior)
    // Raw retention is bounded too: keep double the window for decode context.
    const rawCap = Math.max(this.maxBytes * 2, 65536)
    const droppedChunks: Buffer[] = []
    while (this.rawBytes > rawCap && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.rawBytes -= dropped.length
      droppedChunks.push(dropped)
    }
    if (droppedChunks.length > 0) {
      // The dropped prefix leaves the retained raw mid-stream, so its decoded
      // length has to join the whole-stream accounting in refresh(): without
      // it `slid` understates where the retained text begins and readFrom()
      // serves mid-stream bytes under early offsets without flagging lossy.
      this.droppedTextBytes += this.textByteLength(Buffer.concat(droppedChunks))
    }
    this.refresh()
  }

  /** UTF-8 byte length of raw bytes decoded the way refresh() would decode them. */
  private textByteLength(raw: Buffer): number {
    const verdict = this.verdict ?? sniff(raw)
    const decoded = verdict === 'utf8' || verdict === 'unknown'
      ? raw.toString('utf8')
      : decodeLegacy(raw, verdict)
    return Buffer.from(decoded, 'utf8').length
  }

  private refresh(): void {
    const raw = Buffer.concat(this.chunks)
    if (this.verdict === undefined || this.verdict === 'unknown') {
      if (raw.length === 0) return
      // 'unknown' stays provisional: a cut multi-byte sequence can look
      // undecodable until the rest of the chunk arrives.
      this.verdict = sniff(raw)
    }
    const decoded = this.verdict === 'utf8' || this.verdict === 'unknown'
      ? raw.toString('utf8')
      : decodeLegacy(raw, this.verdict)
    let text = Buffer.from(decoded, 'utf8')
    // The window is rebuilt from the full retained raw on every refresh, so
    // the cut is absolute, not incremental: adding each refresh's `overflow`
    // to the prior `slid` counts the same discarded prefix once per push and
    // inflates every offset (nextOffset can pass the bytes actually served).
    const overflow = Math.max(0, text.length - this.maxBytes)
    this.slid = this.droppedTextBytes + overflow
    if (overflow > 0) {
      text = text.subarray(overflow)
      // Drop already-window-external raw bytes opportunistically for legacy
      // fixed-width encodings; variable-width GBK keeps raw context instead.
      if (this.verdict === 'utf16le' || this.verdict === 'utf16be') {
        // safe: 2-byte units; recompute from tail next time
      }
    }
    this.window = text
  }

  readFrom(fromByte: number): OutputRead {
    const start = this.slid
    const end = this.slid + this.window.length
    if (fromByte >= end) return { text: '', nextOffset: end, lossy: false }
    if (fromByte < start) {
      return { text: this.window.toString('utf8'), nextOffset: end, lossy: true, ...this.spillPathField() }
    }
    return {
      text: this.window.subarray(fromByte - start).toString('utf8'),
      nextOffset: end,
      lossy: false,
      ...this.spillPathField(),
    }
  }

  private spillPathField(): { spillPath?: string } {
    return this.spillFile !== undefined && !this.spillDead ? { spillPath: this.spillFile } : {}
  }
}

/** Collect until end, error, or close (including an already closed pipe). */
export function collectStream(stream: Readable, maxBytes: number, spillMaxBytes?: number): { reader: DecodingCollector, done: Promise<void> } {
  const reader = new DecodingCollector(maxBytes, spillMaxBytes)
  const onData = (chunk: Buffer): void => { reader.push(chunk) }
  stream.on('data', onData)
  const done = finished(stream, { readable: true, writable: false, cleanup: true })
    // A closed/broken output pipe still leaves its captured tail readable.
    .catch(() => {})
    .finally(() => { stream.off('data', onData) })
  return { reader, done }
}
