// mcp.ts — Model Context Protocol over plain JSON-RPC 2.0 (POST /mcp). Implements the
// modern discovery era (server/discover + initialize), tools/list, and tools/call for the
// six forge tools. No SSE, no sessions.

import {
  VIEWER,
  createRepo,
  getRepo,
  createIssue,
  createPull,
  getPull,
  squashMerge,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { sendJson, sendError, newRequestId, type Ctx } from './context.ts';

const SERVER_NAME = 'makefun-github-clone';
const SERVER_VERSION = '1.0.0';
export const SUPPORTED_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// The tool list is built once so two tools/list answers are byte-identical.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The repository owner (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------------------------
// shapes (the same objects the REST surface returns)
// ---------------------------------------------------------------------------------------------

function repoResult(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueResult(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ffffff' })),
    user: { login: issue.user },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullResult(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head },
    base: { ref: pull.base },
    user: { login: pull.user },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------

type JsonRpcId = string | number | null;

function rpcResult(ctx: Ctx, id: JsonRpcId, result: unknown): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(ctx: Ctx, id: JsonRpcId, code: number, message: string, httpStatus = 200): void {
  sendJson(ctx, httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
}

function missingArgs(args: Record<string, unknown>, required: readonly string[]): string | null {
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') {
      return `missing required argument: ${name}`;
    }
  }
  return null;
}

function toolResult(ctx: Ctx, id: JsonRpcId, value: unknown): void {
  const text = JSON.stringify(value);
  rpcResult(ctx, id, {
    content: [{ type: 'text', text }],
    structuredContent: value,
  });
}

function toolError(ctx: Ctx, id: JsonRpcId, message: string): void {
  rpcResult(ctx, id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

// ---------------------------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------------------------

function callTool(ctx: Ctx, id: JsonRpcId, name: string, args: Record<string, unknown>): void {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    rpcError(ctx, id, -32602, `unknown tool: ${name}`);
    return;
  }
  const missing = missingArgs(args, tool.inputSchema.required);
  if (missing) {
    rpcError(ctx, id, -32602, missing);
    return;
  }

  if (name === 'create_repo') {
    const repoName = args.name as string;
    if (getRepo(VIEWER.login, repoName)) {
      toolError(ctx, id, 'name already exists on this account');
      return;
    }
    const repo = createRepo(VIEWER.login, repoName, {
      description: typeof args.description === 'string' ? args.description : undefined,
      private: args.private === true,
    });
    toolResult(ctx, id, repoResult(repo));
    return;
  }

  // The remaining tools all address an existing repository.
  const owner = args.owner as string;
  const repoName = args.repo as string;
  const repo = owner === VIEWER.login ? getRepo(owner, repoName) : undefined;
  if (!repo) {
    toolError(ctx, id, 'Not Found');
    return;
  }

  if (name === 'get_repo') {
    toolResult(ctx, id, repoResult(repo));
    return;
  }
  if (name === 'create_issue') {
    const issue = createIssue(repo, args.title as string, typeof args.body === 'string' ? args.body : '', []);
    toolResult(ctx, id, issueResult(repo, issue));
    return;
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    toolResult(ctx, id, issues.map((issue) => issueResult(repo, issue)));
    return;
  }
  if (name === 'create_pull_request') {
    const head = args.head as string;
    const base = args.base as string;
    if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
      toolError(ctx, id, 'head or base branch does not exist');
      return;
    }
    const duplicate = repo.pulls.find(
      (pull) => pull.state === 'open' && pull.head === head && pull.base === base,
    );
    if (duplicate) {
      toolError(ctx, id, 'A pull request already exists for these branches');
      return;
    }
    const pull = createPull(repo, args.title as string, typeof args.body === 'string' ? args.body : '', head, base);
    toolResult(ctx, id, pullResult(repo, pull));
    return;
  }
  if (name === 'merge_pull_request') {
    const number = args.pull_number as number;
    const pull = getPull(repo, number);
    if (!pull) {
      toolError(ctx, id, 'Not Found');
      return;
    }
    if (pull.merged || pull.state === 'closed') {
      toolError(ctx, id, 'Pull request is already merged');
      return;
    }
    const sha = squashMerge(repo, pull);
    if (sha === null) {
      toolError(ctx, id, 'Merge conflict');
      return;
    }
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = sha;
    pull.updatedAt = new Date().toISOString();
    toolResult(ctx, id, pullResult(repo, pull));
    return;
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

export function handleMcp(ctx: Ctx): void {
  if (ctx.method === 'DELETE') {
    // Session close is best-effort.
    ctx.res.writeHead(200, { 'x-github-request-id': newRequestId() });
    ctx.res.end();
    return;
  }
  if (ctx.method !== 'POST') {
    sendError(ctx, 405, 'Method Not Allowed');
    return;
  }
  let body: unknown;
  try {
    body = ctx.body.length === 0 ? {} : JSON.parse(ctx.body.toString('utf8'));
  } catch {
    rpcError(ctx, null, -32700, 'Parse error', 400);
    return;
  }
  const request = (body ?? {}) as { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: unknown };
  const id: JsonRpcId = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';

  // Notifications carry no id and get no JSON-RPC response.
  if (request.id === undefined) {
    ctx.res.writeHead(202, { 'x-github-request-id': newRequestId() });
    ctx.res.end();
    return;
  }

  if (method === 'server/discover') {
    rpcResult(ctx, id, {
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    });
    return;
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as { protocolVersion?: string };
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    rpcResult(ctx, id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'tools/list') {
    rpcResult(ctx, id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    callTool(ctx, id, toolName, args);
    return;
  }
  if (method === 'ping') {
    rpcResult(ctx, id, {});
    return;
  }
  rpcError(ctx, id, -32601, `Method not found: ${method}`);
}
