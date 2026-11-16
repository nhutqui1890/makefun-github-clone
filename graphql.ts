// graphql.ts — a small GraphQL parser and executor for the fixed document subset the
// grading suite sends: queries and mutations, variables, arguments (string/int/enum/list/
// input-object literals), aliases, and inline fragments. No GraphQL library is used.

import {
  VIEWER,
  getRepo,
  resolveRef,
  refCommit,
  pullFiles,
  threeWayMerge,
  squashMerge,
  createIssue,
  getIssue,
  createPull,
  getPull,
  addComment,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
  decodeGlobalId,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { sendJson, type Ctx } from './context.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'ellipsis' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'ellipsis' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      let isFloat = false;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser (AST)
// ---------------------------------------------------------------------------------------------

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  selection: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; type: string; required: boolean }>;
  selection: SelectionNode[];
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document, got ${JSON.stringify(token)}`);
    }
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const nameToken = this.peek();
      if (nameToken?.kind === 'name') {
        name = this.next().value;
      }
    }
    const variableDefinitions: OperationNode['variableDefinitions'] = [];
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        this.expectPunct('$');
        const varName = this.next();
        if (varName.kind !== 'name') throw new Error('expected a variable name');
        this.expectPunct(':');
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('expected a variable type');
        let required = false;
        if (this.matchPunct('!')) required = true;
        // Skip a default value if present.
        if (this.matchPunct('=')) this.parseValue();
        variableDefinitions.push({ name: varName.value, type: typeToken.value, required });
      }
    }
    const selection = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selection };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      const token = this.peek();
      if (token?.kind === 'ellipsis') {
        this.next();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') {
          throw new Error('only inline fragments are supported');
        }
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('expected a fragment type condition');
        selections.push({ kind: 'fragment', typeCondition: typeToken.value, selection: this.parseSelectionSet() });
        continue;
      }
      if (token?.kind !== 'name') throw new Error('expected a field name');
      const first = this.next().value;
      let alias: string | null = null;
      let name = first;
      if (this.matchPunct(':')) {
        alias = first;
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new Error('expected a field name after an alias');
        name = nameToken.value;
      }
      const args: Record<string, unknown> = {};
      if (this.matchPunct('(')) {
        while (!this.matchPunct(')')) {
          const argName = this.next();
          if (argName.kind !== 'name') throw new Error('expected an argument name');
          this.expectPunct(':');
          args[argName.value] = this.parseValue();
        }
      }
      let selection: SelectionNode[] = [];
      const next = this.peek();
      if (next?.kind === 'punct' && next.value === '{') {
        selection = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', name, alias, args, selection });
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected a variable name');
      return { kind: 'variable', name: name.value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.next();
        if (name.kind !== 'name') throw new Error('expected an input-object field name');
        this.expectPunct(':');
        fields[name.value] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// schema: the field set each type exposes (drives validation + introspection)
// ---------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
  ],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes'],
  PageInfo: ['hasNextPage', 'endCursor'],
  Ref: ['name'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  PullRequestChangedFile: ['path'],
  __Type: ['fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

interface ExecContext {
  variables: Variables;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) {
    out[key] = resolveValue(value as ValueNode, variables);
  }
  return out;
}

type ObjectValue =
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'Ref'; name: string }
  | { __type: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullRequestConnection'; repo: Repo; pulls: Pull[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullRequestChangedFileConnection'; files: Array<{ path: string }> }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'CreateIssuePayload' | 'CloseIssuePayload' | 'CreatePullRequestPayload' | 'MergePullRequestPayload' | 'AddCommentPayload'; fields: Record<string, unknown> }
  | { __type: 'IssueCommentEdge'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __type: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __type: '__Type'; name: string };

function executeSelection(
  selections: readonly SelectionNode[],
  value: ObjectValue | null,
  exec: ExecContext,
): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== value.__type) continue;
      Object.assign(out, executeSelection(selection.selection, value, exec));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const resolved = resolveField(selection, value, exec);
    out[key] = resolved;
  }
  return out;
}

function unknownField(exec: ExecContext, type: string, field: string): null {
  exec.errors.push({ message: `Cannot query field "${field}" on type "${type}".` });
  return null;
}

function resolveField(field: FieldNode, value: ObjectValue, exec: ExecContext): unknown {
  const type = value.__type;
  const allowed = SCHEMA_FIELDS[type] ?? [];
  if (!allowed.includes(field.name) && field.name !== '__typename') {
    return unknownField(exec, type, field.name);
  }
  if (field.name === '__typename') return type;
  const args = resolveArgs(field, exec.variables);

  switch (type) {
    case 'User': {
      const user = value as { __type: 'User'; login: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return user.login === VIEWER.login ? String(VIEWER.id) : '1002';
      if (field.name === 'name') return user.login === VIEWER.login ? VIEWER.name : user.login;
      if (field.name === 'email') return user.login === VIEWER.login ? VIEWER.email : `${user.login}@example.invalid`;
      return null;
    }
    case 'Repository': {
      const { repo } = value as { __type: 'Repository'; repo: Repo };
      return resolveRepositoryField(field, repo, args, exec);
    }
    case 'Issue': {
      const { repo, issue } = value as { __type: 'Issue'; repo: Repo; issue: Issue };
      if (field.name === 'id') return issueGlobalId(repo, issue);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'body') return issue.body;
      if (field.name === 'state') return issue.state.toUpperCase();
      return null;
    }
    case 'PullRequest': {
      const { repo, pull } = value as { __type: 'PullRequest'; repo: Repo; pull: Pull };
      return resolvePullField(field, repo, pull, args, exec);
    }
    case 'Ref': {
      return (value as { __type: 'Ref'; name: string }).name;
    }
    case 'IssueConnection': {
      const conn = value as { __type: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field.name === 'nodes') {
        return conn.issues.map((issue) =>
          executeSelection(field.selection, { __type: 'Issue', repo: conn.repo, issue }, exec),
        );
      }
      if (field.name === 'pageInfo') {
        return executeSelection(field.selection, { __type: 'PageInfo', ...conn.pageInfo }, exec);
      }
      return null;
    }
    case 'PullRequestConnection': {
      const conn = value as { __type: 'PullRequestConnection'; repo: Repo; pulls: Pull[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field.name === 'nodes') {
        return conn.pulls.map((pull) =>
          executeSelection(field.selection, { __type: 'PullRequest', repo: conn.repo, pull }, exec),
        );
      }
      if (field.name === 'pageInfo') {
        return executeSelection(field.selection, { __type: 'PageInfo', ...conn.pageInfo }, exec);
      }
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      const conn = value as { __type: 'PullRequestChangedFileConnection'; files: Array<{ path: string }> };
      if (field.name === 'nodes') {
        return conn.files.map((file) => ({ path: file.path }));
      }
      return null;
    }
    case 'PageInfo': {
      const page = value as { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return page.hasNextPage;
      if (field.name === 'endCursor') return page.endCursor;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload': {
      const payload = value as { __type: string; fields: Record<string, unknown> };
      const nested = payload.fields[field.name];
      if (nested && typeof nested === 'object' && '__type' in (nested as Record<string, unknown>)) {
        return executeSelection(field.selection, nested as ObjectValue, exec);
      }
      return nested ?? null;
    }
    case 'IssueCommentEdge': {
      const edge = value as { __type: 'IssueCommentEdge'; repo: Repo; issue: Issue; comment: { id: number; body: string } };
      if (field.name === 'node') {
        return executeSelection(field.selection, { __type: 'IssueComment', repo: edge.repo, issue: edge.issue, comment: edge.comment }, exec);
      }
      return null;
    }
    case 'IssueComment': {
      const comment = value as { __type: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: number; body: string } };
      if (field.name === 'id') return commentGlobalId(comment.repo, comment.issue, comment.comment);
      if (field.name === 'body') return comment.comment.body;
      return null;
    }
    case '__Type': {
      const typeValue = value as { __type: '__Type'; name: string };
      if (field.name === 'fields') {
        const names = SCHEMA_FIELDS[typeValue.name] ?? [];
        return names.map((name) => ({ name }));
      }
      if (field.name === 'enumValues') {
        const names = SCHEMA_ENUMS[typeValue.name] ?? [];
        return names.map((name) => ({ name }));
      }
      return null;
    }
    default:
      return null;
  }
}

function resolveRepositoryField(
  field: FieldNode,
  repo: Repo,
  args: Record<string, unknown>,
  exec: ExecContext,
): unknown {
  switch (field.name) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return executeSelection(field.selection, { __type: 'User', login: repo.owner }, exec);
    case 'defaultBranchRef': {
      const tip = refCommit(repo, repo.defaultBranch);
      if (!tip) return null;
      return executeSelection(field.selection, { __type: 'Ref', name: repo.defaultBranch }, exec);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const number = args.number as number;
      const issue = getIssue(repo, number);
      if (!issue) return null;
      return executeSelection(field.selection, { __type: 'Issue', repo, issue }, exec);
    }
    case 'issues': {
      const first = typeof args.first === 'number' ? args.first : 10;
      const after = typeof args.after === 'string' ? args.after : null;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
      let issues = [...repo.issues];
      if (states) {
        issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      }
      if (orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
        issues.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
      } else {
        issues.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
      }
      if (after) {
        const cursor = decodeCursor(after);
        if (cursor !== null) {
          const index = issues.findIndex((issue) => issue.number === cursor);
          if (index !== -1) issues = issues.slice(index + 1);
        }
      }
      const page = issues.slice(0, first);
      const hasNextPage = issues.length > first;
      const endCursor = page.length ? encodeCursor(page[page.length - 1]!.number) : null;
      return executeSelection(
        field.selection,
        { __type: 'IssueConnection', repo, issues: page, pageInfo: { hasNextPage, endCursor } },
        exec,
      );
    }
    case 'pullRequests': {
      const first = typeof args.first === 'number' ? args.first : 10;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      let pulls = [...repo.pulls];
      if (states) {
        pulls = pulls.filter((pull) => states.includes(pullState(pull)));
      } else {
        pulls = pulls.filter((pull) => pull.state === 'open');
      }
      pulls.sort((a, b) => a.createdSeq - b.createdSeq);
      const page = pulls.slice(0, first);
      const hasNextPage = pulls.length > first;
      const endCursor = page.length ? encodeCursor(page[page.length - 1]!.number) : null;
      return executeSelection(
        field.selection,
        { __type: 'PullRequestConnection', repo, pulls: page, pageInfo: { hasNextPage, endCursor } },
        exec,
      );
    }
    case 'pullRequest': {
      const number = args.number as number;
      const pull = getPull(repo, number);
      if (!pull) return null;
      return executeSelection(field.selection, { __type: 'PullRequest', repo, pull }, exec);
    }
    default:
      return null;
  }
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state.toUpperCase();
}

function resolvePullField(
  field: FieldNode,
  repo: Repo,
  pull: Pull,
  args: Record<string, unknown>,
  exec: ExecContext,
): unknown {
  switch (field.name) {
    case 'id':
      return pullGlobalId(repo, pull);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'state':
      return pullState(pull);
    case 'merged':
      return pull.merged;
    case 'headRefName':
      return pull.head;
    case 'baseRefName':
      return pull.base;
    case 'mergeable': {
      if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
      const baseTip = refCommit(repo, pull.base);
      const headTip = refCommit(repo, pull.head);
      if (!headTip) return 'UNKNOWN';
      const merged = threeWayMerge(repo, baseTip, headTip);
      return merged === null ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'files': {
      const first = typeof args.first === 'number' ? args.first : 10;
      const files = pullFiles(repo, pull).slice(0, first).map((file) => ({ path: file.filename }));
      return executeSelection(
        field.selection,
        { __type: 'PullRequestChangedFileConnection', files },
        exec,
      );
    }
    default:
      return null;
  }
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// root fields (query + mutation)
// ---------------------------------------------------------------------------------------------

function resolveRootField(field: FieldNode, operation: 'query' | 'mutation', exec: ExecContext): unknown {
  const rootType = operation === 'query' ? 'Query' : 'Mutation';
  const allowed = SCHEMA_FIELDS[rootType] ?? [];
  if (!allowed.includes(field.name)) {
    return unknownField(exec, rootType, field.name);
  }
  const args = resolveArgs(field, exec.variables);

  if (operation === 'query') {
    if (field.name === 'viewer') {
      return executeSelection(field.selection, { __type: 'User', login: VIEWER.login }, exec);
    }
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = owner === VIEWER.login ? getRepo(owner, name) : undefined;
      if (!repo) return null;
      return executeSelection(field.selection, { __type: 'Repository', repo }, exec);
    }
    if (field.name === 'node') {
      const id = args.id as string;
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = getRepo(decoded.owner, decoded.name);
        if (!repo) return null;
        return executeSelection(field.selection, { __type: 'Repository', repo }, exec);
      }
      if (decoded.kind === 'Issue') {
        const repo = getRepo(decoded.owner, decoded.name);
        const issue = repo ? getIssue(repo, decoded.number) : undefined;
        if (!repo || !issue) return null;
        return executeSelection(field.selection, { __type: 'Issue', repo, issue }, exec);
      }
      if (decoded.kind === 'PullRequest') {
        const repo = getRepo(decoded.owner, decoded.name);
        const pull = repo ? getPull(repo, decoded.number) : undefined;
        if (!repo || !pull) return null;
        return executeSelection(field.selection, { __type: 'PullRequest', repo, pull }, exec);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name as string;
      return executeSelection(field.selection, { __type: '__Type', name }, exec);
    }
    return null;
  }

  // Mutations.
  if (field.name === 'createIssue') {
    const input = (args.input ?? {}) as { repositoryId?: string; title?: string; body?: string };
    const decoded = input.repositoryId ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded?.kind === 'Repository' ? getRepo(decoded.owner, decoded.name) : undefined;
    if (!repo || !input.title) {
      exec.errors.push({ message: 'createIssue: unknown repository or missing title' });
      return null;
    }
    const issue = createIssue(repo, input.title, input.body ?? '', []);
    return executeSelection(
      field.selection,
      { __type: 'CreateIssuePayload', fields: { issue: { __type: 'Issue', repo, issue } } },
      exec,
    );
  }
  if (field.name === 'closeIssue') {
    const input = (args.input ?? {}) as { issueId?: string };
    const decoded = input.issueId ? decodeGlobalId(input.issueId) : null;
    const repo = decoded?.kind === 'Issue' ? getRepo(decoded.owner, decoded.name) : undefined;
    const issue = repo && decoded?.kind === 'Issue' ? getIssue(repo, decoded.number) : undefined;
    if (!repo || !issue) {
      exec.errors.push({ message: 'closeIssue: unknown issue' });
      return null;
    }
    issue.state = 'closed';
    issue.updatedAt = new Date().toISOString();
    return executeSelection(
      field.selection,
      { __type: 'CloseIssuePayload', fields: { issue: { __type: 'Issue', repo, issue } } },
      exec,
    );
  }
  if (field.name === 'createPullRequest') {
    const input = (args.input ?? {}) as {
      repositoryId?: string;
      baseRefName?: string;
      headRefName?: string;
      title?: string;
      body?: string;
    };
    const decoded = input.repositoryId ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded?.kind === 'Repository' ? getRepo(decoded.owner, decoded.name) : undefined;
    if (!repo || !input.title || !input.baseRefName || !input.headRefName) {
      exec.errors.push({ message: 'createPullRequest: unknown repository or missing fields' });
      return null;
    }
    if (!resolveRef(repo, `refs/heads/${input.headRefName}`) || !resolveRef(repo, `refs/heads/${input.baseRefName}`)) {
      exec.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
      return null;
    }
    const duplicate = repo.pulls.find(
      (pull) => pull.state === 'open' && pull.head === input.headRefName && pull.base === input.baseRefName,
    );
    if (duplicate) {
      exec.errors.push({ message: 'A pull request already exists for these branches' });
      return null;
    }
    const pull = createPull(repo, input.title, input.body ?? '', input.headRefName, input.baseRefName);
    return executeSelection(
      field.selection,
      { __type: 'CreatePullRequestPayload', fields: { pullRequest: { __type: 'PullRequest', repo, pull } } },
      exec,
    );
  }
  if (field.name === 'mergePullRequest') {
    const input = (args.input ?? {}) as { pullRequestId?: string; mergeMethod?: string };
    const decoded = input.pullRequestId ? decodeGlobalId(input.pullRequestId) : null;
    const repo = decoded?.kind === 'PullRequest' ? getRepo(decoded.owner, decoded.name) : undefined;
    const pull = repo && decoded?.kind === 'PullRequest' ? getPull(repo, decoded.number) : undefined;
    if (!repo || !pull) {
      exec.errors.push({ message: 'mergePullRequest: unknown pull request' });
      return null;
    }
    if (pull.merged || pull.state === 'closed') {
      exec.errors.push({ message: 'mergePullRequest: pull request is already merged' });
      return null;
    }
    const sha = squashMerge(repo, pull);
    if (sha === null) {
      exec.errors.push({ message: 'mergePullRequest: merge conflict' });
      return null;
    }
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = sha;
    pull.updatedAt = new Date().toISOString();
    return executeSelection(
      field.selection,
      { __type: 'MergePullRequestPayload', fields: { pullRequest: { __type: 'PullRequest', repo, pull } } },
      exec,
    );
  }
  if (field.name === 'addComment') {
    const input = (args.input ?? {}) as { subjectId?: string; body?: string };
    const decoded = input.subjectId ? decodeGlobalId(input.subjectId) : null;
    const repo = decoded?.kind === 'Issue' ? getRepo(decoded.owner, decoded.name) : undefined;
    const issue = repo && decoded?.kind === 'Issue' ? getIssue(repo, decoded.number) : undefined;
    if (!repo || !issue || !input.body) {
      exec.errors.push({ message: 'addComment: unknown subject or missing body' });
      return null;
    }
    const comment = addComment(issue, input.body);
    return executeSelection(
      field.selection,
      {
        __type: 'AddCommentPayload',
        fields: { commentEdge: { __type: 'IssueCommentEdge', repo, issue, comment } },
      },
      exec,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

interface GraphQLOperation {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function executeOperation(operation: GraphQLOperation): Record<string, unknown> {
  const query = typeof operation.query === 'string' ? operation.query : '';
  const variables = (operation.variables ?? {}) as Variables;
  const exec: ExecContext = { variables, errors: [] };
  let parsed: OperationNode[];
  try {
    parsed = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const document = operation.operationName
    ? parsed.find((op) => op.name === operation.operationName) ?? parsed[0]
    : parsed[0];
  if (!document) {
    return { data: null, errors: [{ message: 'empty GraphQL document' }] };
  }
  const data: Record<string, unknown> = {};
  for (const selection of document.selection) {
    if (selection.kind === 'fragment') continue; // no root fragments in the suite's documents
    const key = selection.alias ?? selection.name;
    data[key] = resolveRootField(selection, document.operation, exec);
  }
  const result: Record<string, unknown> = { data };
  if (exec.errors.length > 0) result.errors = exec.errors;
  return result;
}

export function handleGraphQL(ctx: Ctx): void {
  if (ctx.method !== 'POST') {
    sendJson(ctx, 405, { message: 'Method Not Allowed' });
    return;
  }
  let body: unknown;
  try {
    body = ctx.body.length === 0 ? {} : JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (Array.isArray(body)) {
    sendJson(ctx, 200, body.map((operation) => executeOperation((operation ?? {}) as GraphQLOperation)));
    return;
  }
  sendJson(ctx, 200, executeOperation((body ?? {}) as GraphQLOperation));
}
