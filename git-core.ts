// git-core.ts — git object model, packfile read/write, pkt-line codec.
// Node stdlib only. No dependencies, no git binary.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const PKT_LINE_MAX = 65520;

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 object id of `<type> <size>\0<data>`. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// commit / tree / tag parsing and building
// ---------------------------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Raw header lines after the committer line (gpgsig etc.), preserved verbatim. */
  extra: string[];
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else if (line !== '') extra.push(line);
  }
  return { tree, parents, author, committer, message, extra };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  for (const line of info.extra) lines.push(line);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('tree entry has no mode');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) throw new Error('tree entry has no name terminator');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    // git sorts by name, with directories treated as if the name ends in '/'.
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries (gitlinks
 * skipped), tag -> its target, blob -> nothing. Throws on a missing object unless
 * `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` following commit parents. */
export function isAncestor(lookup: ObjectLookup, tip: string, ancestor: string): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Peel an annotated tag chain to the commit it points at (or the oid itself). */
export function peelToCommit(lookup: ObjectLookup, oid: string): string {
  let current = oid;
  for (let i = 0; i < 16; i++) {
    const object = lookup(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------------------------
// packfile read (full objects + OFS_DELTA + REF_DELTA, thin packs resolve against `lookup`)
// ---------------------------------------------------------------------------------------------

const PACK_TYPE_NAMES: Record<number, ObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a packfile. Deltas resolve against objects in the same pack first, then against
 * `lookup` (the repo store, for thin packs from real git clients).
 */
export function readPack(pack: Buffer, lookup: ObjectLookup = () => undefined): PackReadResult {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    type: number;
    size: number;
    data: Buffer;
    deltaKind: 'ofs' | 'ref' | null;
    deltaBase: number | string;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  const end = pack.length - 20;
  for (let i = 0; i < count; i++) {
    if (offset >= end) throw new Error('pack ended before its declared object count');
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(pack, offset);
    const type = (first >> 4) & 0x7;
    offset = next;
    let deltaKind: 'ofs' | 'ref' | null = null;
    let deltaBase: number | string = 0;
    if (type === 6) {
      const { baseOffset, next: after } = readOfsDeltaBase(pack, offset);
      deltaKind = 'ofs';
      deltaBase = entryOffset - baseOffset;
      offset = after;
    } else if (type === 7) {
      if (offset + 20 > end) throw new Error('ref-delta has no base oid');
      deltaKind = 'ref';
      deltaBase = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, next: afterData } = inflateAt(pack, offset);
    if (data.length !== size) throw new Error(`pack entry inflated to ${data.length} bytes, expected ${size}`);
    offset = afterData;
    raw.push({ offset: entryOffset, type, size, data, deltaKind, deltaBase });
  }

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  const resolve = (entry: RawEntry, depth: number): GitObject => {
    if (depth > 64) throw new Error('delta chain too deep');
    const cached = byOffset.get(entry.offset);
    if (cached) return cached;
    if (entry.deltaKind === null) {
      const type = PACK_TYPE_NAMES[entry.type];
      if (!type) throw new Error(`unknown pack object type ${entry.type}`);
      const object: GitObject = { type, data: entry.data };
      byOffset.set(entry.offset, object);
      return object;
    }
    deltaCount += 1;
    let base: GitObject | undefined;
    if (entry.deltaKind === 'ofs') {
      const baseEntry = raw.find((candidate) => candidate.offset === entry.deltaBase);
      if (!baseEntry) throw new Error('ofs-delta base offset is not in this pack');
      base = resolve(baseEntry, depth + 1);
    } else {
      const baseOid = entry.deltaBase as string;
      base = lookup(baseOid);
      if (!base) {
        // The base may itself be a delta in this pack; find it by oid after resolving all.
        for (const candidate of raw) {
          if (candidate.offset === entry.offset) continue;
          const resolved = resolve(candidate, depth + 1);
          if (hashObject(resolved.type, resolved.data) === baseOid) {
            base = resolved;
            break;
          }
        }
      }
      if (!base) throw new Error(`ref-delta base ${entry.deltaBase} is not available`);
    }
    const object: GitObject = { type: base.type, data: applyDelta(base.data, entry.data) };
    byOffset.set(entry.offset, object);
    return object;
  };
  for (const entry of raw) {
    const object = resolve(entry, 0);
    objects.set(hashObject(object.type, object.data), object);
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// packfile write (no deltas — every object stored whole)
// ---------------------------------------------------------------------------------------------

/** Serialize objects as a packfile v2 with no deltas. Order is stable (sorted by oid). */
// Deflated object bytes, cached by oid: git objects are immutable, and the same objects
// are packed over and over (fifty concurrent clones of one repo pack the same tip). The
// cache is capped and simply cleared when full, so memory stays bounded.
const DEFLATE_CACHE_MAX = 20000;
const deflateCache = new Map<string, Buffer>();

function deflated(oid: string, data: Buffer): Buffer {
  const hit = deflateCache.get(oid);
  if (hit) return hit;
  const out = deflateSync(data);
  if (deflateCache.size >= DEFLATE_CACHE_MAX) deflateCache.clear();
  deflateCache.set(oid, out);
  return out;
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  // Hash each object once, then sort by oid (hashing inside the comparator would
  // re-hash every object on every comparison — O(n log n) hashes).
  const list = [...objects]
    .map((object) => ({ object, oid: hashObject(object.type, object.data) }))
    .sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  const typeNumbers: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const { object, oid } of list) {
    const size = object.data.length;
    const type = typeNumbers[object.type];
    // Size varint: first byte holds 4 low bits of size + type in bits 4-6, MSB = continue.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (type << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflated(oid, object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The 32-byte empty pack (0 objects). */
export function emptyPack(): Buffer {
  return writePack([]);
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line of ${length} bytes exceeds the limit`);
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
/** The stateless-RPC response-end packet (0002). */
export const RESPONSE_END = Buffer.from('0002', 'ascii');

/** A parsed pkt-line stream: data packets in order, flush/delim positions kept as markers. */
export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  data: Buffer;
}

export function decodePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line stream is truncated');
    const raw = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(raw, 16);
    if (Number.isNaN(length) || length < 0 || length > PKT_LINE_MAX) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(raw)}`);
    }
    if (length === 0) {
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('pkt-line stream is truncated');
    packets.push({ kind: 'data', data: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** Split a sideband stream: band 1 = data, band 2 = progress, band 3 = error. */
export function splitSideband(packets: readonly PktPacket[]): { band1: Buffer; band2: string; band3: string } {
  const chunks1: Buffer[] = [];
  const chunks2: Buffer[] = [];
  const chunks3: Buffer[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.data.length === 0) continue;
    const band = packet.data[0];
    const payload = packet.data.subarray(1);
    if (band === 1) chunks1.push(payload);
    else if (band === 2) chunks2.push(payload);
    else if (band === 3) chunks3.push(payload);
  }
  return {
    band1: Buffer.concat(chunks1),
    band2: Buffer.concat(chunks2).toString('utf8'),
    band3: Buffer.concat(chunks3).toString('utf8'),
  };
}

/** Wrap bytes in sideband band-1 pkt-lines (chunked to fit the pkt-line limit). */
export function sidebandWrap(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const maxPayload = PKT_LINE_MAX - 5; // 4 length bytes + 1 band byte
  for (let offset = 0; offset < data.length; offset += maxPayload) {
    const chunk = data.subarray(offset, offset + maxPayload);
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}
