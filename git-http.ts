// git-http.ts — smart HTTP: info/refs advertisements (v0 + v2), protocol v2 ls-refs and
// fetch, protocol v0 fetch, and receive-pack (push). Works against the grading suite's
// client and against real git.

import {
  ZERO_OID,
  pktLine,
  FLUSH,
  DELIM,
  RESPONSE_END,
  decodePktLines,
  sidebandWrap,
  writePackKnown,
  readPack,
  type KnownObject,
} from './git-core.ts';
import {
  VIEWER,
  getRepo,
  putObject,
  lookupOf,
  headRefName,
  isFastForward,
  setRef,
  deleteRef,
  cachedCommit,
  cachedTree,
  cachedTag,
  peelToCommitCached,
  type Repo,
} from './store.ts';
import { sendJson, sendBytes, sendError, type Ctx } from './context.ts';

const AGENT = 'makefun-github-clone/1.0';

const UPLOAD_V0_CAPS = [
  'multi_ack_detailed',
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'shallow',
  'deepen-relative',
  `symref=HEAD:${'refs/heads/main'}`,
  `agent=${AGENT}`,
].join(' ');

const RECEIVE_V0_CAPS = [
  'report-status',
  'side-band-64k',
  'delete-refs',
  'ofs-delta',
  `agent=${AGENT}`,
].join(' ');

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

export function handleGit(ctx: Ctx, owner: string, repoName: string, tail: string): void {
  if (owner !== VIEWER.login) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const repo = getRepo(owner, repoName);
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  try {
    if (ctx.method === 'GET' && tail === 'info/refs') {
      handleInfoRefs(ctx, repo);
    } else if (ctx.method === 'POST' && tail === 'git-upload-pack') {
      handleUploadPack(ctx, repo);
    } else if (ctx.method === 'POST' && tail === 'git-receive-pack') {
      handleReceivePack(ctx, repo);
    } else {
      sendError(ctx, 404, 'Not Found');
    }
  } catch (err) {
    // A malformed git request must never crash the server or corrupt the repo.
    sendError(ctx, 400, err instanceof Error ? err.message : 'bad request');
  }
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const hit = sortedRefsCache.get(repo);
  if (hit && hit.version === repo.refVersion) return hit.refs;
  const refs = [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  sortedRefsCache.set(repo, { version: repo.refVersion, refs });
  return refs;
}

// Sorted refs, cached per repo and invalidated by refVersion (every advertisement
// and ls-refs re-sorted them from scratch).
const sortedRefsCache = new WeakMap<
  Repo,
  { version: number; refs: Array<{ name: string; oid: string }> }
>();

function peeledOid(repo: Repo, oid: string): string | null {
  if (!cachedTag(repo, oid)) return null;
  return peelToCommitCached(repo, oid);
}

// v0 advertisements, cached per repo + service and invalidated by refVersion:
// the bytes only depend on the ref set.
const v0AdCache = new WeakMap<Repo, Map<string, { version: number; body: Buffer }>>();

function v0Advertisement(ctx: Ctx, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
  let perRepo = v0AdCache.get(repo);
  if (!perRepo) {
    perRepo = new Map();
    v0AdCache.set(repo, perRepo);
  }
  const hit = perRepo.get(service);
  if (hit && hit.version === repo.refVersion) {
    sendBytes(ctx, 200, `application/x-${service}-advertisement`, hit.body);
    return;
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headRefName(repo));
    let first = true;
    if (headOid) {
      parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
      first = false;
    }
    for (const ref of refs) {
      const suffix = first ? `\0${caps}` : '';
      first = false;
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled && ref.name.startsWith('refs/tags/')) {
        parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  perRepo.set(service, { version: repo.refVersion, body });
  sendBytes(ctx, 200, `application/x-${service}-advertisement`, body);
}

// The v2 capability advertisement never changes: build it once.
const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  FLUSH,
]);

function v2Advertisement(ctx: Ctx): void {
  sendBytes(ctx, 200, 'application/x-git-upload-pack-advertisement', V2_ADVERTISEMENT);
}

function handleInfoRefs(ctx: Ctx, repo: Repo): void {
  const service = ctx.url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(ctx, 400, 'unknown service');
    return;
  }
  const protocol = ctx.req.headers['git-protocol'];
  if (service === 'git-upload-pack' && protocol === 'version=2') {
    v2Advertisement(ctx);
    return;
  }
  v0Advertisement(ctx, repo, service);
}

// ---------------------------------------------------------------------------------------------
// protocol v2: ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(ctx: Ctx, repo: Repo, args: LsRefsArgs): void {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headRefName(repo));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  } else {
    if (headOid && keep('HEAD')) {
      const symref = args.symrefs ? ' symref-target:refs/heads/main' : '';
      parts.push(pktLine(`${headOid} HEAD${symref}\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel && ref.name.startsWith('refs/tags/')) {
        const peeled = peeledOid(repo, ref.oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(FLUSH);
  // No response-end packet here: over HTTP, remote-curl validates the ls-refs response
  // and dies on a 0002, then appends one itself for the client.
  sendBytes(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// fetch object selection (shared by v2 and v0)
// ---------------------------------------------------------------------------------------------

export interface FetchSelection {
  objects: KnownObject[];
  shallow: string[];
  unshallow: string[];
}

export function computeFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depthLimit: number | null,
  deepenRelative = false,
): FetchSelection {
  const lookup = lookupOf(repo);
  const shallowSet = new Set(clientShallow);

  // Exclusion: everything the client already holds. Traversal stops at the client's shallow
  // boundaries (their parents are NOT held).
  const exclude = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length) {
    const oid = queue.pop()!;
    if (exclude.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    exclude.add(oid);
    if (object.type === 'commit') {
      const commit = cachedCommit(repo, oid)!;
      queue.push(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(cachedTag(repo, oid)!.object);
    } else if (object.type === 'tree') {
      for (const entry of cachedTree(repo, oid)!) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }

  // Inclusion: walk from the wants. Commit depth is counted in generations from the wants;
  // trees and blobs under an included commit are always fully included. The depth limit is
  // per path: with an absolute deepen it is `depthLimit` from every want; with a relative
  // deepen (`deepen-relative`, sent by real git for `fetch --deepen=N`) a path is unbounded
  // until it passes through one of the client's shallow boundaries, below which it may run
  // `depthLimit` further generations (git's upload-pack computes the new boundaries from
  // the reachable client shallows with depth+1 and adds their parents as extra wants).
  const include = new Set<string>();
  const commitDepth = new Map<string, number>();
  const commitLimit = new Map<string, number>();
  const shallowOut = new Set<string>();
  const commitQueue: Array<{ oid: string; depth: number; limit: number }> = [];
  const includeTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (include.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      include.add(oid);
      if (object.type === 'tree') {
        for (const entry of cachedTree(repo, oid)!) {
          if (entry.mode === '160000') continue;
          if (entry.mode === '40000') stack.push(entry.oid);
          else include.add(entry.oid);
        }
      }
    }
  };
  const includeCommit = (oid: string, depth: number, limit: number): void => {
    const known = commitDepth.get(oid);
    // Keep the shortest path; for equal depth keep the loosest (largest) limit so a path
    // through a deeper shallow boundary is not cut short by a shallower one.
    if (known !== undefined && (known < depth || (known === depth && (commitLimit.get(oid) ?? 0) >= limit))) return;
    commitDepth.set(oid, depth);
    commitLimit.set(oid, limit);
    commitQueue.push({ oid, depth, limit });
  };
  const absoluteLimit = depthLimit === null ? Number.POSITIVE_INFINITY : depthLimit;
  for (const want of wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'commit') includeCommit(want, 1, deepenRelative ? Number.POSITIVE_INFINITY : absoluteLimit);
    else if (object.type === 'tag') {
      include.add(want);
      const target = cachedTag(repo, want)!.object;
      const targetObject = lookup(target);
      if (targetObject?.type === 'commit') includeCommit(target, 1, deepenRelative ? Number.POSITIVE_INFINITY : absoluteLimit);
      else if (targetObject) include.add(target);
    } else if (object.type === 'tree') includeTree(want);
    else include.add(want); // blob
  }
  // Relative deepen, second phase: like git's get_reachable_list, add the parents of every
  // client shallow reachable from the wants as extra wants, so a deeper boundary below an
  // already-cut path still gets its parent (their own limit is boundary depth + deepen).
  if (deepenRelative && depthLimit !== null) {
    const reachable = new Set<string>();
    const stack: string[] = [...wants];
    while (stack.length) {
      const oid = stack.pop()!;
      if (reachable.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      reachable.add(oid);
      if (object.type === 'commit') {
        for (const parent of cachedCommit(repo, oid)!.parents) stack.push(parent);
      } else if (object.type === 'tag') {
        stack.push(cachedTag(repo, oid)!.object);
      }
    }
    // Generation of each reachable client shallow from the wants (shortest path).
    const gen = new Map<string, number>();
    const genQueue: Array<{ oid: string; depth: number }> = [];
    for (const want of wants) {
      const object = lookup(want);
      if (object?.type === 'commit') genQueue.push({ oid: want, depth: 1 });
      else if (object?.type === 'tag') {
        const target = cachedTag(repo, want)!.object;
        if (lookup(target)?.type === 'commit') genQueue.push({ oid: target, depth: 1 });
      }
    }
    while (genQueue.length) {
      const { oid, depth } = genQueue.shift()!;
      if (gen.has(oid)) continue;
      gen.set(oid, depth);
      const commit = cachedCommit(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!gen.has(parent)) genQueue.push({ oid: parent, depth: depth + 1 });
      }
    }
    for (const boundary of clientShallow) {
      if (!reachable.has(boundary)) continue;
      const boundaryDepth = gen.get(boundary);
      if (boundaryDepth === undefined) continue;
      const commit = cachedCommit(repo, boundary);
      if (!commit) continue;
      for (const parent of commit.parents) {
        includeCommit(parent, boundaryDepth + 1, boundaryDepth + depthLimit);
      }
    }
  }
  while (commitQueue.length) {
    const { oid, depth, limit } = commitQueue.shift()!;
    if (commitDepth.get(oid) !== depth || commitLimit.get(oid) !== limit) continue; // superseded
    const commit = cachedCommit(repo, oid);
    if (!commit) continue;
    include.add(oid);
    includeTree(commit.tree);
    if (depth >= limit) {
      // Depth limit reached at this commit: it becomes a shallow boundary.
      if (commit.parents.length > 0) shallowOut.add(oid);
      continue;
    }
    // A relative deepen starts counting below a client shallow boundary on this path.
    const childLimit = deepenRelative && shallowSet.has(oid) && depthLimit !== null
      ? Math.min(limit, depth + depthLimit)
      : limit;
    for (const parent of commit.parents) includeCommit(parent, depth + 1, childLimit);
  }

  // Unshallow: a previous boundary whose parents are now all included.
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    if (!include.has(boundary)) continue;
    const commit = cachedCommit(repo, boundary);
    if (!commit) continue;
    const parents = commit.parents;
    if (parents.length === 0) continue;
    if (parents.every((parent) => include.has(parent))) unshallow.push(boundary);
  }

  const objects: KnownObject[] = [];
  for (const oid of include) {
    if (exclude.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push({ oid, object });
  }
  return { objects, shallow: [...shallowOut], unshallow };
}

// ---------------------------------------------------------------------------------------------
// protocol v2: fetch
// ---------------------------------------------------------------------------------------------

function handleFetchV2(
  ctx: Ctx,
  repo: Repo,
  args: { wants: string[]; haves: string[]; shallow: string[]; depth: number | null; done: boolean; deepenRelative: boolean },
): void {
  const { objects, shallow, unshallow } = computeFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepenRelative);
  const parts: Buffer[] = [];
  const shallowInfo = (): void => {
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(FLUSH);
    }
  };
  const packfile = (): void => {
    // No response-end packet (0002) in a v2 response: over HTTP the whole v2 exchange runs
    // through remote-curl's stateless-connect, which validates the response (and dies on a
    // 0002) and appends one itself for fetch-pack.
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandWrap(writePackKnown(objects), 1));
    parts.push(FLUSH);
  };

  if (!args.done) {
    // A negotiation round (real git fetch with haves): answer acknowledgments only, then
    // either wait for the next round (NAK + flush) or continue to the pack (ACK + ready +
    // delim, per git's process_ack contract: a pack follows if and only if ready was sent).
    const knownHaves = args.haves.filter((have) => repo.objects.has(have));
    parts.push(pktLine('acknowledgments\n'));
    if (knownHaves.length > 0) {
      for (const have of knownHaves) parts.push(pktLine(`ACK ${have}\n`));
      parts.push(pktLine('ready\n'));
      parts.push(DELIM);
      shallowInfo();
      packfile();
    } else {
      parts.push(pktLine('NAK\n'));
      parts.push(FLUSH);
    }
    sendBytes(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }

  // A final request (done): git's client skips the acknowledgments section entirely and
  // expects shallow-info (if any) and then the packfile. Never send acknowledgments here.
  shallowInfo();
  packfile();
  sendBytes(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// protocol v0: fetch
// ---------------------------------------------------------------------------------------------

function handleFetchV0(
  ctx: Ctx,
  repo: Repo,
  args: { wants: string[]; haves: string[]; shallow: string[]; depth: number | null; deepenRelative: boolean },
): void {
  const { objects, shallow, unshallow } = computeFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepenRelative);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const knownHaves = args.haves.filter((have) => repo.objects.has(have));
  if (knownHaves.length > 0) {
    for (const have of knownHaves) parts.push(pktLine(`ACK ${have}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(sidebandWrap(writePackKnown(objects), 1));
  parts.push(FLUSH);
  parts.push(RESPONSE_END);
  sendBytes(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// upload-pack dispatch
// ---------------------------------------------------------------------------------------------

function handleUploadPack(ctx: Ctx, repo: Repo): void {
  const protocol = ctx.req.headers['git-protocol'];
  const packets = decodePktLines(ctx.body);
  if (protocol === 'version=2') {
    // First line is the command; lines after the delim are arguments.
    const dataLines: string[] = [];
    let delimSeen = false;
    let command = '';
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        delimSeen = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.data.toString('utf8');
      if (command === '') {
        command = line.trim();
        continue;
      }
      if (delimSeen) dataLines.push(line.trim());
      // Lines before the delim (agent=, object-format=) are ignored.
    }
    if (command === 'command=ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of dataLines) {
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      handleLsRefs(ctx, repo, args);
      return;
    }
    if (command === 'command=fetch') {
      const args = {
        wants: [] as string[],
        haves: [] as string[],
        shallow: [] as string[],
        depth: null as number | null,
        done: false,
        deepenRelative: false,
      };
      for (const line of dataLines) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line === 'done') args.done = true;
        else if (line === 'deepen-relative') args.deepenRelative = true;
        else if (line.startsWith('deepen ')) {
          const n = Number.parseInt(line.slice(7), 10);
          if (Number.isFinite(n)) args.depth = n;
        }
        // thin-pack, no-progress, ofs-delta, filter: accepted, no action needed.
      }
      if (args.wants.length === 0) {
        sendError(ctx, 400, 'fetch with no wants');
        return;
      }
      handleFetchV2(ctx, repo, args);
      return;
    }
    sendError(ctx, 400, `unknown v2 command ${JSON.stringify(command)}`);
    return;
  }

  // Protocol v0: want lines, flush, have lines, done, flush.
  const args = { wants: [] as string[], haves: [] as string[], shallow: [] as string[], depth: null as number | null, deepenRelative: false };
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8').trim();
    if (line.startsWith('want ')) {
      // The first want line may carry capabilities after a space.
      const rest = line.slice(5);
      args.wants.push(rest.split(' ')[0]!);
      if (rest.includes('deepen-relative')) args.deepenRelative = true;
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      args.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
    // done: no action.
  }
  void seenFlush;
  if (args.wants.length === 0) {
    sendError(ctx, 400, 'fetch with no wants');
    return;
  }
  handleFetchV0(ctx, repo, args);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function validRefName(ref: string): boolean {
  if (!ref.startsWith('refs/')) return false;
  if (/[\s~^:?*\[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock')) return false;
  if (ref.endsWith('.')) return false;
  return true;
}

function handleReceivePack(ctx: Ctx, repo: Repo): void {
  const body = ctx.body;
  // Parse pkt-lines until the first flush; the pack bytes follow in the same body.
  const commands: PushCommand[] = [];
  let offset = 0;
  let packStart = body.length;
  let firstLine = true;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('receive-pack command stream is truncated');
    const raw = body.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(raw, 16);
    if (Number.isNaN(length)) throw new Error('receive-pack command stream is not pkt-lined');
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('receive-pack command stream is truncated');
    let line = body.subarray(offset + 4, offset + length).toString('utf8').trim();
    offset += length;
    if (firstLine) {
      // Capabilities follow a NUL on the first command line.
      const nul = line.indexOf('\0');
      if (nul !== -1) line = line.slice(0, nul);
      firstLine = false;
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) throw new Error(`bad push command ${JSON.stringify(line)}`);
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }

  const reportLines: string[] = [];
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, lookupOf(repo));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack error' });
      continue;
    }
    if (!validRefName(command.ref)) {
      results.push({ ref: command.ref, ok: false, reason: 'invalid ref name' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        continue;
      }
      deleteRef(repo, command.ref);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      const commitOid = peelToCommitCached(repo, command.newOid);
      const commit = repo.objects.get(commitOid);
      if (!commit || commit.type !== 'commit') {
        results.push({ ref: command.ref, ok: false, reason: 'not a commit' });
        continue;
      }
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      setRef(repo, command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    if (!isFastForward(repo, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    setRef(repo, command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }
  if (results.some((result) => result.ok)) repo.updatedAt = new Date().toISOString();

  reportLines.push(unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`);
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason ?? 'failed'}`);
  }
  const report = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), FLUSH]);
  const bodyOut = Buffer.concat([sidebandWrap(report, 1), FLUSH]);
  sendBytes(ctx, 200, 'application/x-git-receive-pack-result', bodyOut);
}
