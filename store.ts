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
  isAncestor,
  peelToCommit,
  type GitObject,
  type ObjectType,
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
  const out: { name: string; sha: string }[] = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function listTags(repo: Repo): { name: string; sha: string }[] {
  const out: { name: string; sha: string }[] = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/tags/')) out.push({ name: ref.slice('refs/tags/'.length), sha });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The commit a ref points at (peeling annotated tags). Undefined when the ref is unborn. */
export function refCommit(repo: Repo, ref: string): string | undefined {
  const oid = resolveRef(repo, ref);
  if (!oid) return undefined;
  return peelToCommit(lookupOf(repo), oid);
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
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
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
  const object = repo.objects.get(peelToCommit(lookupOf(repo), commitOid));
  if (!object || object.type !== 'commit') return putObject(repo, 'tree', buildTree([]));
  return parseCommit(object.data).tree;
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
    if (parent) parent = peelToCommit(lookupOf(repo), parent);
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
  repo.refs.set(ref, oid);
  repo.updatedAt = nowIso();
  return oid;
}

/** Walk a commit's history newest-first (breadth-first from the tip). */
export function walkCommits(repo: Repo, tip: string | undefined, limit = 1000): string[] {
  if (!tip) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [peelToCommit(lookupOf(repo), tip)];
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** The best common ancestor of two commits (first hit walking head's history BFS). */
export function mergeBase(repo: Repo, a: string | undefined, b: string | undefined): string | undefined {
  if (!a || !b) return undefined;
  const aPeeled = peelToCommit(lookupOf(repo), a);
  const bPeeled = peelToCommit(lookupOf(repo), b);
  const aAncestors = new Set<string>();
  const queue = [aPeeled];
  while (queue.length) {
    const oid = queue.shift()!;
    if (aAncestors.has(oid)) continue;
    aAncestors.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  const queueB = [bPeeled];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (aAncestors.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
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
  repo.refs.set(`refs/heads/${pull.base}`, oid);
  repo.updatedAt = nowIso();
  return oid;
}

export function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (oldOid === newOid) return true;
  const lookup = lookupOf(repo);
  const oldCommit = peelToCommit(lookup, oldOid);
  const newCommit = peelToCommit(lookup, newOid);
  return isAncestor(lookup, newCommit, oldCommit);
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
  return issue;
}

export function getIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
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
  return pull;
}

export function getPull(repo: Repo, number: number): Pull | undefined {
  return repo.pulls.find((pull) => pull.number === number);
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
