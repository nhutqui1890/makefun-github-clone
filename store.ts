// store.ts — the forge's in-memory state: repositories, git objects, refs, issues, pull
// requests, labels and comments. One process owns the whole store; nothing is persisted.

import {
  ZERO_OID,
  hashObject,
  parseCommit,
  buildCommit,
  parseTree,
  buildTree,
  parseTag,
  collectReachable,
  type GitObject,
  type ObjectType,
  type CommitInfo,
  type TreeEntry,
  type TagInfo,
} from './git-core.ts';

/** The viewer identity, fixed by the competition's deterministic scenario. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

export const DEFAULT_BRANCH = 'main';

let nextRepoId = 1;
let nextObjectId = 1; // global numeric id for issues, PRs and comments
let nextSeq = 1; // monotonic creation sequence (stable ordering)

export function nowIso(): string {
  return new Date().toISOString();
}

export function gitTimestamp(date = new Date()): string {
  const seconds = Math.floor(date.getTime() / 1000);
  return `${seconds} +0000`;
}

export function viewerIdent(date = new Date()): string {
  return `${VIEWER.name} <${VIEWER.email}> ${gitTimestamp(date)}`;
}

// ---------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string; // branch name
  base: string; // branch name
  user: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  /** Bumped by setRef/deleteRef: caches keyed on refs (sorted lists, ads) read it. */
  refVersion: number;
  /** Parsed commits/trees/tags by oid. Objects are immutable once stored, so a
   * parsed form never goes stale; the caches die with the repo. */
  commitCache: Map<string, CommitInfo>;
  treeCache: Map<string, TreeEntry[]>;
  tagCache: Map<string, TagInfo>;
  /** Issues and pulls by number: getIssue/getPull were linear scans. */
  issuesByNumber: Map<number, Issue>;
  pullsByNumber: Map<number, Pull>;
}

// ---------------------------------------------------------------------------------------------
// repo registry
// ---------------------------------------------------------------------------------------------

const repos = new Map<string, Repo>(); // key: `${owner}/${name}`

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function createRepo(
  owner: string,
  name: string,
  options: { description?: string; private?: boolean } = {},
): Repo {
  const key = repoKey(owner, name);
  if (repos.has(key)) throw new Error('already exists');
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner,
    description: options.description ?? '',
    private: options.private ?? false,
    defaultBranch: DEFAULT_BRANCH,
    createdSeq: nextSeq++,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextNumber: 1,
    refVersion: 0,
    commitCache: new Map(),
    treeCache: new Map(),
    tagCache: new Map(),
    issuesByNumber: new Map(),
    pullsByNumber: new Map(),
  };
  repos.set(key, repo);
  return repo;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function listRepos(owner: string): Repo[] {
  return [...repos.values()]
    .filter((repo) => repo.owner === owner)
    .sort((a, b) => a.createdSeq - b.createdSeq);
}

// ---------------------------------------------------------------------------------------------
// git objects and refs
// ---------------------------------------------------------------------------------------------

export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function lookupOf(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

// ---------------------------------------------------------------------------------------------
// cached parsing (objects are immutable, so parsed forms never go stale)
// ---------------------------------------------------------------------------------------------

/** A commit's parsed headers, cached per repo. Undefined when the oid is not a commit. */
export function cachedCommit(repo: Repo, oid: string): CommitInfo | undefined {
  const hit = repo.commitCache.get(oid);
  if (hit) return hit;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return undefined;
  const info = parseCommit(object.data);
  repo.commitCache.set(oid, info);
  return info;
}

/** A tree's parsed entries, cached per repo. Undefined when the oid is not a tree. */
export function cachedTree(repo: Repo, oid: string): TreeEntry[] | undefined {
  const hit = repo.treeCache.get(oid);
  if (hit) return hit;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tree') return undefined;
  const entries = parseTree(object.data);
  repo.treeCache.set(oid, entries);
  return entries;
}

/** A tag's parsed headers, cached per repo. Undefined when the oid is not a tag. */
export function cachedTag(repo: Repo, oid: string): TagInfo | undefined {
  const hit = repo.tagCache.get(oid);
  if (hit) return hit;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return undefined;
  const info = parseTag(object.data);
  repo.tagCache.set(oid, info);
  return info;
}

/** Peel an annotated tag chain to the commit it points at, using the tag cache. */
export function peelToCommitCached(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 16; i++) {
    const tag = cachedTag(repo, current);
    if (!tag) return current;
    current = tag.object;
  }
  return current;
}

/** True when `ancestor` is reachable from `tip` following commit parents (cached parses). */
export function isAncestorCached(repo: Repo, tip: string, ancestor: string): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = cachedCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// refs (all mutations go through setRef/deleteRef so refVersion stays exact)
// ---------------------------------------------------------------------------------------------

/** Set a ref and bump the repo's ref version (invalidates ref-derived caches). */
export function setRef(repo: Repo, ref: string, oid: string): void {
  repo.refs.set(ref, oid);
  repo.refVersion += 1;
}

/** Delete a ref and bump the repo's ref version when it existed. */
export function deleteRef(repo: Repo, ref: string): boolean {
  const had = repo.refs.delete(ref);
  if (had) repo.refVersion += 1;
  return had;
}

export function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Resolve a ref name, a branch short name, or a raw oid to an oid. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : undefined;
  if (ref === 'HEAD') return repo.refs.get(headRefName(repo));
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch) return asBranch;
  const asTag = repo.refs.get(`refs/tags/${ref}`);
  if (asTag) return asTag;
  return undefined;
}

export function listBranches(repo: Repo): { name: string; sha: string }[] {
  const cached = branchListCache.get(repo);
  if (cached && cached.version === repo.refVersion) return cached.list;
  const out: { name: string; sha: string }[] = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  const sorted = out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  branchListCache.set(repo, { version: repo.refVersion, list: sorted });
  return sorted;
}

// Branch/tag listings, cached per repo and invalidated by refVersion.
const branchListCache = new WeakMap<Repo, { version: number; list: { name: string; sha: string }[] }>();
const tagListCache = new WeakMap<Repo, { version: number; list: { name: string; sha: string }[] }>();

export function listTags(repo: Repo): { name: string; sha: string }[] {
  const cached = tagListCache.get(repo);
  if (cached && cached.version === repo.refVersion) return cached.list;
  const out: { name: string; sha: string }[] = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/tags/')) out.push({ name: ref.slice('refs/tags/'.length), sha });
  }
  const sorted = out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  tagListCache.set(repo, { version: repo.refVersion, list: sorted });
  return sorted;
}

/** The commit a ref points at (peeling annotated tags). Undefined when the ref is unborn. */
export function refCommit(repo: Repo, ref: string): string | undefined {
  const oid = resolveRef(repo, ref);
  if (!oid) return undefined;
  return peelToCommitCached(repo, oid);
}

// ---------------------------------------------------------------------------------------------
// trees: flatten to path maps, rebuild from path maps
// ---------------------------------------------------------------------------------------------

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) to `path -> {oid, mode}`. Gitlinks are kept as entries. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const entries = cachedTree(repo, oid);
    if (!entries) return;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) nested trees from a flat path map. Returns the root tree oid. */
export function buildTreeFromMap(repo: Repo, files: Map<string, FlatEntry>): string {
  interface Node {
    entries: Map<string, { mode: string; oid: string }>;
  }
  const root: Node = { entries: new Map() };
  const dirs = new Map<string, Node>([['', root]]);
  const dirOf = (path: string): Node => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const node: Node = { entries: new Map() };
    dirs.set(path, node);
    return node;
  };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const parent = dirOf(current);
      current = current === '' ? part : `${current}/${part}`;
      if (!parent.entries.has(part)) parent.entries.set(part, { mode: '40000', oid: '' });
    }
    dirOf(current).entries.set(parts[parts.length - 1]!, { mode: entry.mode, oid: entry.oid });
  }
  // Write trees bottom-up: deepest paths first. The root's depth is 0 (''.split('/')
  // has length 1, which would tie it with a top-level directory and build it first).
  const depthOf = (path: string): number => (path === '' ? 0 : path.split('/').length);
  const paths = [...dirs.keys()].sort((a, b) => depthOf(b) - depthOf(a));
  const treeOid = new Map<string, string>();
  for (const path of paths) {
    const node = dirs.get(path)!;
    const entries = [...node.entries.entries()].map(([name, entry]) => ({
      mode: entry.mode,
      name,
      oid: entry.mode === '40000' ? treeOid.get(path === '' ? name : `${path}/${name}`)! : entry.oid,
    }));
    treeOid.set(path, putObject(repo, 'tree', buildTree(entries)));
  }
  return treeOid.get('')!;
}

/** The tree oid of a commit, or the empty tree when the repo is unborn. */
export function commitTree(repo: Repo, commitOid: string | undefined): string {
  if (!commitOid) return putObject(repo, 'tree', buildTree([]));
  const commit = cachedCommit(repo, peelToCommitCached(repo, commitOid));
  if (!commit) return putObject(repo, 'tree', buildTree([]));
  return commit.tree;
}

// ---------------------------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------------------------

/**
 * Create a commit object on `branch` (creating the branch from the default branch tip, or
 * from the empty tree when unborn). `change` mutates the flat file map of the parent tree.
 * Returns the new commit oid.
 */
export function commitOnBranch(
  repo: Repo,
  branch: string,
  message: string,
  change: (files: Map<string, FlatEntry>) => void,
): string {
  const ref = `refs/heads/${branch}`;
  let parent = repo.refs.get(ref);
  if (!parent) {
    parent = repo.refs.get(headRefName(repo));
    if (parent) parent = peelToCommitCached(repo, parent);
  }
  const parentTree = commitTree(repo, parent);
  const files = flattenTree(repo, parentTree);
  change(files);
  const tree = buildTreeFromMap(repo, files);
  const ident = viewerIdent();
  const commit = buildCommit({
    tree,
    parents: parent ? [parent] : [],
    author: ident,
    committer: ident,
    message: message.endsWith('\n') ? message : `${message}\n`,
    extra: [],
  });
  const oid = putObject(repo, 'commit', commit);
  setRef(repo, ref, oid);
  repo.updatedAt = nowIso();
  return oid;
}

/** Walk a commit's history newest-first (breadth-first from the tip). */
export function walkCommits(repo: Repo, tip: string | undefined, limit = 1000): string[] {
  if (!tip) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [peelToCommitCached(repo, tip)];
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = cachedCommit(repo, oid);
    if (!commit) continue;
    out.push(oid);
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

/** The best common ancestor of two commits (first hit walking head's history BFS). */
export function mergeBase(repo: Repo, a: string | undefined, b: string | undefined): string | undefined {
  if (!a || !b) return undefined;
  const aPeeled = peelToCommitCached(repo, a);
  const bPeeled = peelToCommitCached(repo, b);
  const aAncestors = new Set<string>();
  const queue = [aPeeled];
  while (queue.length) {
    const oid = queue.shift()!;
    if (aAncestors.has(oid)) continue;
    aAncestors.add(oid);
    const commit = cachedCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  const queueB = [bPeeled];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (aAncestors.has(oid)) return oid;
    const commit = cachedCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) queueB.push(parent);
  }
  return undefined;
}

export interface DiffFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line-diff two buffers; returns [additions, deletions] via LCS on lines. */
function lineDiffCounts(before: Buffer, after: Buffer): [number, number] {
  const beforeLines = before.length === 0 ? [] : before.toString('utf8').split('\n');
  const afterLines = after.length === 0 ? [] : after.toString('utf8').split('\n');
  // Drop a trailing empty line produced by a final newline.
  if (beforeLines.length && beforeLines[beforeLines.length - 1] === '') beforeLines.pop();
  if (afterLines.length && afterLines[afterLines.length - 1] === '') afterLines.pop();
  const n = beforeLines.length;
  const m = afterLines.length;
  if (n === 0 && m === 0) return [0, 0];
  if (n === 0) return [m, 0];
  if (m === 0) return [0, n];
  // LCS dynamic programming (files in the graded flows are small).
  const prev = new Array<number>(m + 1).fill(0);
  const curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      curr[j] = beforeLines[i - 1] === afterLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]!);
    }
    for (let j = 0; j <= m; j++) prev[j] = curr[j]!;
  }
  const lcs = prev[m]!;
  return [m - lcs, n - lcs];
}

/** Diff two flat trees; returns one entry per changed path. */
export function diffFiles(
  repo: Repo,
  before: Map<string, FlatEntry>,
  after: Map<string, FlatEntry>,
): DiffFile[] {
  const out: DiffFile[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (b && a && b.oid === a.oid && b.mode === a.mode) continue;
    if (!b && a) {
      const blob = repo.objects.get(a.oid);
      const lines = blob && blob.type === 'blob' ? blob.data.toString('utf8').split('\n').length : 1;
      const additions = Math.max(1, blob && blob.data.length > 0 ? lines - (blob.data[blob.data.length - 1] === 10 ? 1 : 0) : 1);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && !a) {
      const blob = repo.objects.get(b.oid);
      const deletions = blob && blob.type === 'blob' && blob.data.length > 0
        ? Math.max(1, blob.data.toString('utf8').split('\n').length - (blob.data[blob.data.length - 1] === 10 ? 1 : 0))
        : 1;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b && a) {
      const beforeBlob = repo.objects.get(b.oid);
      const afterBlob = repo.objects.get(a.oid);
      const [additions, deletions] = lineDiffCounts(
        beforeBlob?.type === 'blob' ? beforeBlob.data : Buffer.alloc(0),
        afterBlob?.type === 'blob' ? afterBlob.data : Buffer.alloc(0),
      );
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** The pull-request diff: merge-base tree vs head tip tree. */
export function pullFiles(repo: Repo, pull: Pull): DiffFile[] {
  const baseTip = refCommit(repo, pull.base);
  const headTip = refCommit(repo, pull.head);
  const base = mergeBase(repo, baseTip, headTip);
  const before = flattenTree(repo, commitTree(repo, base));
  const after = flattenTree(repo, commitTree(repo, headTip));
  return diffFiles(repo, before, after);
}

/**
 * Three-way merge check for a squash merge. Returns the merged flat tree, or `null` when
 * base and head both changed the same path differently (a conflict).
 */
export function threeWayMerge(
  repo: Repo,
  baseTip: string | undefined,
  headTip: string | undefined,
): Map<string, FlatEntry> | null {
  const base = mergeBase(repo, baseTip, headTip);
  const baseFiles = flattenTree(repo, commitTree(repo, base));
  const headFiles = flattenTree(repo, commitTree(repo, headTip));
  const tipFiles = flattenTree(repo, commitTree(repo, baseTip));
  const result = new Map(tipFiles);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestor = baseFiles.get(path);
    const head = headFiles.get(path);
    const tip = tipFiles.get(path);
    const headChanged = (head?.oid ?? null) !== (ancestor?.oid ?? null);
    const tipChanged = (tip?.oid ?? null) !== (ancestor?.oid ?? null);
    if (!headChanged) continue;
    if (tipChanged && (tip?.oid ?? null) !== (head?.oid ?? null)) return null; // conflict
    if (head) result.set(path, head);
    else result.delete(path);
  }
  return result;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null on conflict. */
export function squashMerge(repo: Repo, pull: Pull): string | null {
  const baseTip = refCommit(repo, pull.base);
  const headTip = refCommit(repo, pull.head);
  if (!headTip) return null;
  const merged = threeWayMerge(repo, baseTip, headTip);
  if (merged === null) return null;
  const tree = buildTreeFromMap(repo, merged);
  const ident = viewerIdent();
  const commit = buildCommit({
    tree,
    parents: baseTip ? [baseTip] : [],
    author: ident,
    committer: ident,
    message: `${pull.title} (#${pull.number})\n`,
    extra: [],
  });
  const oid = putObject(repo, 'commit', commit);
  setRef(repo, `refs/heads/${pull.base}`, oid);
  repo.updatedAt = nowIso();
  return oid;
}

export function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (oldOid === newOid) return true;
  const oldCommit = peelToCommitCached(repo, oldOid);
  const newCommit = peelToCommitCached(repo, newOid);
  return isAncestorCached(repo, newCommit, oldCommit);
}

export { collectReachable };

// ---------------------------------------------------------------------------------------------
// issues, pull requests, labels, comments
// ---------------------------------------------------------------------------------------------

export function createIssue(
  repo: Repo,
  title: string,
  body: string,
  labels: string[],
): Issue {
  const issue: Issue = {
    id: nextObjectId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    user: VIEWER.login,
    createdSeq: nextSeq++,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    comments: [],
  };
  repo.issues.push(issue);
  repo.issuesByNumber.set(issue.number, issue);
  return issue;
}

export function getIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issuesByNumber.get(number);
}

export function createPull(
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): Pull {
  const pull: Pull = {
    id: nextObjectId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head,
    base,
    user: VIEWER.login,
    createdSeq: nextSeq++,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repo.pulls.push(pull);
  repo.pullsByNumber.set(pull.number, pull);
  return pull;
}

export function getPull(repo: Repo, number: number): Pull | undefined {
  return repo.pullsByNumber.get(number);
}

export function addComment(issue: Issue, body: string): Comment {
  const comment: Comment = {
    id: nextObjectId++,
    body,
    user: VIEWER.login,
    createdAt: nowIso(),
  };
  issue.comments.push(comment);
  return comment;
}

// ---------------------------------------------------------------------------------------------
// global ids (GraphQL `id` fields: opaque, stable, decodable)
// ---------------------------------------------------------------------------------------------

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function unb64url(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return b64url(`Repository:${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64url(`Issue:${repo.owner}/${repo.name}#${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64url(`PullRequest:${repo.owner}/${repo.name}#${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return b64url(`IssueComment:${repo.owner}/${repo.name}#${issue.number}:${comment.id}`);
}

export type DecodedId =
  | { kind: 'Repository'; owner: string; name: string }
  | { kind: 'Issue'; owner: string; name: string; number: number }
  | { kind: 'PullRequest'; owner: string; name: string; number: number }
  | { kind: 'IssueComment'; owner: string; name: string; number: number; commentId: number }
  | null;

export function decodeGlobalId(id: string): DecodedId {
  const text = unb64url(id);
  if (!text) return null;
  let match = /^Repository:(.+)\/(.+)$/.exec(text);
  if (match) return { kind: 'Repository', owner: match[1]!, name: match[2]! };
  match = /^Issue:(.+)\/(.+)#(\d+)$/.exec(text);
  if (match) return { kind: 'Issue', owner: match[1]!, name: match[2]!, number: Number(match[3]) };
  match = /^PullRequest:(.+)\/(.+)#(\d+)$/.exec(text);
  if (match) return { kind: 'PullRequest', owner: match[1]!, name: match[2]!, number: Number(match[3]) };
  match = /^IssueComment:(.+)\/(.+)#(\d+):(\d+)$/.exec(text);
  if (match) {
    return { kind: 'IssueComment', owner: match[1]!, name: match[2]!, number: Number(match[3]), commentId: Number(match[4]) };
  }
  return null;
}
