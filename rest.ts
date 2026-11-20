// rest.ts — GitHub REST API v3 surface: repos, branches, commits, git refs, contents,
// labels, issues, comments and pull requests.

import { buildCommit } from './git-core.ts';
import {
  VIEWER,
  createRepo,
  getRepo,
  deleteRepo,
  listRepos,
  putObject,
  getObject,
  resolveRef,
  listBranches,
  refCommit,
  flattenTree,
  commitTree,
  commitOnBranch,
  walkCommits,
  pullFiles,
  threeWayMerge,
  squashMerge,
  createIssue,
  getIssue,
  createPull,
  getPull,
  addComment,
  buildTreeFromMap,
  viewerIdent,
  cachedCommit,
  setRef,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { sendJson, sendError, sendNoContent, notFound, jsonBody, decodeSegment, type Ctx } from './context.ts';

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userShape(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER.login ? VIEWER.id : 1002, type: 'User' };
}

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userShape(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function labelShape(name: string, color: string): Record<string, unknown> {
  return { name, color };
}

function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return labelShape(name, label?.color ?? 'ffffff');
    }),
    user: userShape(issue.user),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentShape(comment: { id: number; body: string; user: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userShape(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function pullShape(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = refCommit(repo, pull.head) ?? '';
  const baseSha = refCommit(repo, pull.base) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    user: userShape(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitShape(repo: Repo, sha: string): Record<string, unknown> | null {
  const commit = cachedCommit(repo, sha);
  if (!commit) return null;
  const author = commit.author.replace(/ \d+ [+-]\d{4}$/, '');
  // Git stores the message with a trailing newline; GitHub's API answers without it.
  const message = commit.message.replace(/\r?\n$/, '');
  return {
    sha,
    commit: {
      message,
      author: { name: author, email: VIEWER.email, date: repo.updatedAt },
      committer: { name: author, email: VIEWER.email, date: repo.updatedAt },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

function pagination(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(ctx.url.searchParams.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(ctx.url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Math.min(100, Math.max(1, Number.isFinite(perPageRaw) ? perPageRaw : 30));
  return { page, perPage };
}

function linkHeader(ctx: Ctx, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const origin = `http://${ctx.req.headers.host ?? 'localhost'}`;
  const path = ctx.url.pathname;
  const base = `${origin}${path}`;
  const other = new URLSearchParams(ctx.url.searchParams);
  const pageUrl = (p: number): string => {
    const params = new URLSearchParams(other);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${base}?${params.toString()}`;
  };
  const links: string[] = [`<${pageUrl(1)}>; rel="first"`, `<${pageUrl(totalPages)}>; rel="last"`];
  if (page < totalPages) links.push(`<${pageUrl(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${pageUrl(page - 1)}>; rel="prev"`);
  return links.join(', ');
}

function paged<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

export function handleRest(ctx: Ctx): void {
  const path = ctx.url.pathname;
  const method = ctx.method;
  // Strip the /api/v3 prefix.
  const rest = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
  const segments = rest.split('/').filter((segment) => segment !== '').map(decodeSegment);

  try {
    if (rest === '/' || rest === '') {
      if (method === 'GET') {
        sendJson(ctx, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }
      notFound(ctx);
      return;
    }
    if (segments[0] === 'meta' && segments.length === 1) {
      if (method === 'GET') {
        sendJson(ctx, 200, { installed_version: '1.0.0' });
        return;
      }
      notFound(ctx);
      return;
    }
    if (segments[0] === 'user') {
      handleUser(ctx, method, segments.slice(1));
      return;
    }
    if (segments[0] === 'repos' && segments.length >= 3) {
      handleRepo(ctx, method, segments[1]!, segments[2]!, segments.slice(3));
      return;
    }
    notFound(ctx);
  } catch (err) {
    if (err instanceof SyntaxError) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return;
    }
    throw err;
  }
}

function handleUser(ctx: Ctx, method: string, tail: string[]): void {
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, {
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: VIEWER.type,
      });
      return;
    }
    notFound(ctx);
    return;
  }
  if (tail[0] === 'repos' && tail.length === 1) {
    if (method === 'GET') {
      const { page, perPage } = pagination(ctx);
      const all = listRepos(VIEWER.login);
      const link = linkHeader(ctx, page, perPage, all.length);
      sendJson(ctx, 200, paged(all, page, perPage).map(repoShape), link ? { link } : {});
      return;
    }
    if (method === 'POST') {
      const body = jsonBody<{ name?: string; private?: boolean; description?: string }>(ctx) ?? {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') {
        sendError(ctx, 422, 'name is required');
        return;
      }
      if (getRepo(VIEWER.login, name)) {
        sendError(ctx, 422, `name already exists on this account`);
        return;
      }
      const repo = createRepo(VIEWER.login, name, {
        description: typeof body.description === 'string' ? body.description : undefined,
        private: body.private === true,
      });
      sendJson(ctx, 201, repoShape(repo));
      return;
    }
    notFound(ctx);
    return;
  }
  notFound(ctx);
}

/** Resolve the repo for a /repos/{owner}/{repo} route. 404 when the owner is a stranger. */
function resolveRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

function handleRepo(ctx: Ctx, method: string, owner: string, name: string, tail: string[]): void {
  if (tail.length === 0) {
    if (method === 'GET') {
      const repo = resolveRepo(ctx, owner, name);
      if (repo) sendJson(ctx, 200, repoShape(repo));
      return;
    }
    if (method === 'PATCH') {
      const repo = resolveRepo(ctx, owner, name);
      if (!repo) return;
      const body = jsonBody<{ description?: string; private?: boolean }>(ctx) ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.updatedAt = new Date().toISOString();
      sendJson(ctx, 200, repoShape(repo));
      return;
    }
    if (method === 'DELETE') {
      const repo = resolveRepo(ctx, owner, name);
      if (!repo) return;
      deleteRepo(owner, name);
      sendNoContent(ctx);
      return;
    }
    notFound(ctx);
    return;
  }

  const section = tail[0];
  if (section === 'branches') return handleBranches(ctx, method, owner, name, tail.slice(1));
  if (section === 'commits') return handleCommits(ctx, method, owner, name, tail.slice(1));
  if (section === 'git') return handleGitRefs(ctx, method, owner, name, tail.slice(1));
  if (section === 'contents') return handleContents(ctx, method, owner, name, tail.slice(1));
  if (section === 'labels') return handleLabels(ctx, method, owner, name, tail.slice(1));
  if (section === 'issues') return handleIssues(ctx, method, owner, name, tail.slice(1));
  if (section === 'pulls') return handlePulls(ctx, method, owner, name, tail.slice(1));
  notFound(ctx);
}

// ---------------------------------------------------------------------------------------------
// branches
// ---------------------------------------------------------------------------------------------

function handleBranches(ctx: Ctx, method: string, owner: string, name: string, tail: string[]): void {
  if (method !== 'GET') {
    notFound(ctx);
    return;
  }
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return;
  if (tail.length === 0) {
    const branches = listBranches(repo).map((branch) => {
      const shape = commitShape(repo, branch.sha);
      return {
        name: branch.name,
        commit: { sha: branch.sha, commit: { message: shape ? (shape.commit as { message: string }).message : '' } },
      };
    });
    sendJson(ctx, 200, branches);
    return;
  }
  const branchName = tail.join('/');
  const sha = repo.refs.get(`refs/heads/${branchName}`);
  if (!sha) {
    sendError(ctx, 404, 'Branch not found');
    return;
  }
  const shape = commitShape(repo, sha);
  sendJson(ctx, 200, {
    name: branchName,
    commit: { sha, commit: { message: shape ? (shape.commit as { message: string }).message : '' } },
  });
}

// ---------------------------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------------------------

function handleCommits(ctx: Ctx, method: string, owner: string, name: string, tail: string[]): void {
  if (method !== 'GET' || tail.length > 1) {
    notFound(ctx);
    return;
  }
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return;
  if (tail.length === 1) {
    const sha = resolveRef(repo, tail[0]!);
    const shape = sha ? commitShape(repo, sha) : null;
    if (!shape) {
      sendError(ctx, 404, 'No commit found for SHA');
      return;
    }
    sendJson(ctx, 200, shape);
    return;
  }
  const ref = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
  const tip = refCommit(repo, ref);
  if (!tip) {
    sendError(ctx, 404, 'No commit found for SHA');
    return;
  }
  const commits = walkCommits(repo, tip)
    .map((sha) => commitShape(repo, sha))
    .filter((shape): shape is Record<string, unknown> => shape !== null);
  sendJson(ctx, 200, commits);
}

// ---------------------------------------------------------------------------------------------
// git refs
// ---------------------------------------------------------------------------------------------

function handleGitRefs(ctx: Ctx, method: string, owner: string, name: string, tail: string[]): void {
  if (tail[0] !== 'refs') {
    notFound(ctx);
    return;
  }
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return;
  const refTail = tail.slice(1);
  if (method === 'GET' && refTail.length === 0) {
    const refs = [...repo.refs.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([ref, sha]) => ({ ref, object: { sha, type: getObject(repo, sha)?.type ?? 'commit' } }));
    sendJson(ctx, 200, refs);
    return;
  }
  if (method === 'GET') {
    const ref = `refs/${refTail.join('/')}`;
    const sha = repo.refs.get(ref);
    if (!sha) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, { ref, object: { sha, type: getObject(repo, sha)?.type ?? 'commit' } });
    return;
  }
  if (method === 'POST' && refTail.length === 0) {
    const body = jsonBody<{ ref?: string; sha?: string }>(ctx) ?? {};
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
      sendError(ctx, 422, 'Invalid ref or sha');
      return;
    }
    if (repo.refs.has(ref)) {
      sendError(ctx, 422, 'Reference already exists');
      return;
    }
    const target = getObject(repo, sha);
    if (!target) {
      sendError(ctx, 422, 'Object does not exist');
      return;
    }
    setRef(repo, ref, sha);
    sendJson(ctx, 201, { ref, object: { sha, type: target.type } });
    return;
  }
  notFound(ctx);
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(ctx: Ctx, method: string, owner: string, name: string, tail: string[]): void {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return;
  const path = tail.join('/');

  if (method === 'GET') {
    const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
    const tip = refCommit(repo, ref);
    if (!tip) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const files = flattenTree(repo, commitTree(repo, tip));
    const file = files.get(path);
    if (file) {
      const blob = getObject(repo, file.oid);
      const data = blob?.type === 'blob' ? blob.data : Buffer.alloc(0);
      sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop(),
        path,
        content: data.toString('base64'),
        sha: file.oid,
      });
      return;
    }
    // Directory listing (or the repo root when the path is empty).
    const prefix = path === '' ? '' : `${path}/`;
    const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.set(rest, { type: 'file', name: rest, path: filePath, sha: entry.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!entries.has(dir)) {
          entries.set(dir, { type: 'dir', name: dir, path: `${prefix}${dir}`, sha: '' });
        }
      }
    }
    if (entries.size === 0) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
    return;
  }

  if (method === 'PUT') {
    const body = jsonBody<{ message?: string; content?: string; branch?: string; sha?: string }>(ctx) ?? {};
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    if (typeof body.content !== 'string') {
      sendError(ctx, 422, 'content is required');
      return;
    }
    let data: Buffer;
    try {
      data = Buffer.from(body.content, 'base64');
    } catch {
      sendError(ctx, 400, 'content is not valid base64');
      return;
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = refCommit(repo, branch) ?? refCommit(repo, repo.defaultBranch);
    const files = flattenTree(repo, commitTree(repo, tip));
    const existing = files.get(path);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined) {
      if (!existing) {
        sendError(ctx, 422, 'file does not exist');
        return;
      }
      if (existing.oid !== givenSha) {
        sendError(ctx, 409, 'sha does not match the current file');
        return;
      }
    } else if (existing) {
      sendError(ctx, 422, 'file already exists');
      return;
    }
    const blobOid = putObject(repo, 'blob', data);
    const isCreate = !existing;
    const commitOid = commitOnBranch(repo, branch, message, (flat) => {
      flat.set(path, { oid: blobOid, mode: '100644' });
    });
    sendJson(ctx, isCreate ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitOid, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = jsonBody<{ message?: string; sha?: string }>(ctx) ?? {};
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof (body as { branch?: string }).branch === 'string' && (body as { branch?: string }).branch !== ''
      ? (body as { branch: string }).branch
      : repo.defaultBranch;
    const tip = refCommit(repo, branch);
    if (!tip) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const files = flattenTree(repo, commitTree(repo, tip));
    const existing = files.get(path);
    if (!existing) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      sendError(ctx, 409, 'sha does not match the current file');
      return;
    }
    const commitOid = commitOnBranch(repo, branch, message, (flat) => {
      flat.delete(path);
    });
    sendJson(ctx, 200, { commit: { sha: commitOid, message } });
    return;
  }

  notFound(ctx);
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

function handleLabels(ctx: Ctx, method: string, owner: string, name: string, tail: string[]): void {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return;
  if (method === 'GET' && tail.length === 0) {
    sendJson(ctx, 200, [...repo.labels.values()].map((label) => labelShape(label.name, label.color)));
    return;
  }
  if (method === 'POST' && tail.length === 0) {
    const body = jsonBody<{ name?: string; color?: string }>(ctx) ?? {};
    const labelName = typeof body.name === 'string' ? body.name.trim() : '';
    if (labelName === '') {
      sendError(ctx, 422, 'name is required');
      return;
    }
    if (repo.labels.has(labelName)) {
      sendError(ctx, 422, 'already_exists');
      return;
    }
    const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ffffff';
    repo.labels.set(labelName, { name: labelName, color });
    sendJson(ctx, 201, labelShape(labelName, color));
    return;
  }
  notFound(ctx);
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function handleIssues(ctx: Ctx, method: string, owner: string, name: string, tail: string[]): void {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return;
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = jsonBody<{ title?: string; body?: string; labels?: string[] }>(ctx) ?? {};
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') {
        sendError(ctx, 422, 'title is required');
        return;
      }
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendError(ctx, 422, `Label does not exist: ${label}`);
          return;
        }
      }
      const issue = createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
      sendJson(ctx, 201, issueShape(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const sort = ctx.url.searchParams.get('sort') ?? 'created';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page, perPage } = pagination(ctx);
      const link = linkHeader(ctx, page, perPage, issues.length);
      sendJson(ctx, 200, paged(issues, page, perPage).map((issue) => issueShape(repo, issue)), link ? { link } : {});
      return;
    }
    notFound(ctx);
    return;
  }
  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isInteger(number)) {
    notFound(ctx);
    return;
  }
  const issue = getIssue(repo, number);
  if (tail.length === 1) {
    if (method === 'GET') {
      if (!issue) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, issueShape(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      if (!issue) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      const body = jsonBody<{ state?: string; title?: string; body?: string; labels?: string[] }>(ctx) ?? {};
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendError(ctx, 422, `Label does not exist: ${label}`);
            return;
          }
        }
        issue.labels = labels;
      }
      issue.updatedAt = new Date().toISOString();
      sendJson(ctx, 200, issueShape(repo, issue));
      return;
    }
    notFound(ctx);
    return;
  }
  if (tail[1] === 'comments' && tail.length === 2) {
    if (!issue) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, issue.comments.map(commentShape));
      return;
    }
    if (method === 'POST') {
      const body = jsonBody<{ body?: string }>(ctx) ?? {};
      if (typeof body.body !== 'string' || body.body === '') {
        sendError(ctx, 422, 'body is required');
        return;
      }
      const comment = addComment(issue, body.body);
      sendJson(ctx, 201, commentShape(comment));
      return;
    }
    notFound(ctx);
    return;
  }
  notFound(ctx);
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(ctx: Ctx, method: string, owner: string, name: string, tail: string[]): void {
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return;
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = jsonBody<{ title?: string; body?: string; head?: string; base?: string }>(ctx) ?? {};
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      if (title === '' || head === '' || base === '') {
        sendError(ctx, 422, 'title, head and base are required');
        return;
      }
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        sendError(ctx, 422, 'head or base branch does not exist');
        return;
      }
      const duplicate = repo.pulls.find(
        (pull) => pull.state === 'open' && pull.head === head && pull.base === base,
      );
      if (duplicate) {
        sendError(ctx, 422, 'A pull request already exists for these branches');
        return;
      }
      const pull = createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
      sendJson(ctx, 201, pullShape(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, perPage } = pagination(ctx);
      const link = linkHeader(ctx, page, perPage, pulls.length);
      sendJson(ctx, 200, paged(pulls, page, perPage).map((pull) => pullShape(repo, pull)), link ? { link } : {});
      return;
    }
    notFound(ctx);
    return;
  }
  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isInteger(number)) {
    notFound(ctx);
    return;
  }
  const pull = getPull(repo, number);
  if (tail.length === 1) {
    if (method === 'GET') {
      if (!pull) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, pullShape(repo, pull));
      return;
    }
    notFound(ctx);
    return;
  }
  if (tail[1] === 'files' && tail.length === 2 && method === 'GET') {
    if (!pull) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, pullFiles(repo, pull));
    return;
  }
  if (tail[1] === 'merge' && tail.length === 2 && method === 'PUT') {
    if (!pull) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (pull.merged || pull.state === 'closed') {
      sendError(ctx, 405, 'Pull request is already merged');
      return;
    }
    const body = jsonBody<{ merge_method?: string }>(ctx) ?? {};
    const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    if (mergeMethod !== 'merge' && mergeMethod !== 'squash' && mergeMethod !== 'rebase') {
      sendError(ctx, 405, 'Invalid merge method');
      return;
    }
    const baseTip = refCommit(repo, pull.base);
    const headTip = refCommit(repo, pull.head);
    if (!headTip) {
      sendError(ctx, 405, 'Head branch has no commits');
      return;
    }
    if (mergeMethod === 'merge') {
      // A merge commit needs a clean three-way merge too.
      const merged = threeWayMerge(repo, baseTip, headTip);
      if (merged === null) {
        sendError(ctx, 405, 'Merge conflict');
        return;
      }
      const sha = mergeCommit(repo, pull, merged);
      if (sha === null) {
        sendError(ctx, 405, 'Merge conflict');
        return;
      }
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = sha;
      pull.updatedAt = new Date().toISOString();
      sendJson(ctx, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    const sha = squashMerge(repo, pull);
    if (sha === null) {
      sendError(ctx, 405, 'Merge conflict');
      return;
    }
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = sha;
    pull.updatedAt = new Date().toISOString();
    sendJson(ctx, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  notFound(ctx);
}

/** Create a two-parent merge commit from a merged flat tree; returns the oid. */
function mergeCommit(
  repo: Repo,
  pull: Pull,
  merged: Map<string, { oid: string; mode: string }>,
): string | null {
  const baseTip = refCommit(repo, pull.base);
  const headTip = refCommit(repo, pull.head);
  if (!headTip) return null;
  const tree = buildTreeFromMap(repo, merged);
  const ident = viewerIdent();
  const commit = buildCommit({
    tree,
    parents: baseTip ? [baseTip, headTip] : [headTip],
    author: ident,
    committer: ident,
    message: `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`,
    extra: [],
  });
  const oid = putObject(repo, 'commit', commit);
  setRef(repo, `refs/heads/${pull.base}`, oid);
  repo.updatedAt = new Date().toISOString();
  return oid;
}
