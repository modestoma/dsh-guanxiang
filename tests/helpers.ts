import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostStore, MirrorStore, RepoService, resolveConfig as resolveRepoConfig, runGit } from 'dsh-repo'
import type { GitRunner } from 'dsh-repo'

/** The bundled example application repository. */
export const EXAMPLE_APP = fileURLToPath(new URL('../examples/order-service', import.meta.url))

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

/** Run git synchronously in a directory. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' })
}

/** A temporary directory removed by the returned cleanup. */
export async function tempDir(prefix = 'guanxiang-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/**
 * Create a git repository at `dir` from the example app, optionally replacing
 * files, and commit it on branch `main`.
 */
export async function createAppRepo(dir: string, files: Record<string, string> = {}): Promise<string> {
  await cp(EXAMPLE_APP, dir, { recursive: true })
  for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

/** Commit a change to an existing repository. */
export async function commitFile(dir: string, path: string, content: string): Promise<string> {
  await writeFile(join(dir, path), content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', `update ${path}`)
  return git(dir, 'rev-parse', 'HEAD').trim()
}

/** Wait until a predicate holds, polling every 10 ms. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!await predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Serve the bare repositories under `root` over smart HTTP (`git http-backend`),
 * answering 401 unless the request carries Basic credentials `username:password`.
 * @returns the base URL and a close function.
 */
export async function serveGitOverHttp(root: string, username: string, password: string): Promise<{ base: string; close: () => Promise<void> }> {
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const backend = join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend')
  const server = createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const child = spawn(backend, [], {
      env: {
        ...gitEnv,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: username,
        ...req.headers['content-encoding'] === undefined ? {} : { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] },
        ...req.headers['git-protocol'] === undefined ? {} : { GIT_PROTOCOL: String(req.headers['git-protocol']) },
      },
    })
    req.pipe(child.stdin)
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    child.on('close', () => {
      const output = Buffer.concat(chunks)
      const split = output.indexOf('\r\n\r\n')
      const headers = output.subarray(0, split).toString('utf8').split('\r\n')
      let status = 200
      for (const line of headers) {
        const [name = '', ...rest] = line.split(':')
        const value = rest.join(':').trim()
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10)
        else res.setHeader(name, value)
      }
      res.writeHead(status)
      res.end(output.subarray(split + 4))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { base, close: () => new Promise(resolve => { server.close(() => { resolve() }) }) }
}

/** In-memory DSH credential store. */
export function memoryCredentials(values: Record<string, string> = {}) {
  const store = { ...values }
  return {
    values: store,
    resolve: async (ref: string) => store[ref] === undefined ? undefined : { value: store[ref], source: 'file' },
    describe: async (ref: string) => ({ configured: store[ref] !== undefined, ...store[ref] === undefined ? {} : { source: 'file' }, writable: true }),
    set: async (ref: string, value: string) => { store[ref] = value },
    unset: async (ref: string) => { delete store[ref] },
  }
}

/**
 * A real dsh-repo `dshRepos` service keeping its mirrors and added hosts
 * under `root`.
 * @param root - directory for mirrors and the added-hosts file.
 * @param config - dsh-repo `config` block.
 * @param credentials - credential store the service reads and writes.
 * @param git - git runner of the mirrors.
 * @returns the service.
 */
export function createRepos(root: string, config: Record<string, unknown> = {}, credentials = memoryCredentials(), git: GitRunner = runGit): RepoService {
  const resolved = resolveRepoConfig({ mirror: { dir: join(root, 'mirrors') }, hostsFile: join(root, 'hosts.json'), ...config })
  return new RepoService(resolved, {
    credentials,
    hosts: new HostStore(resolved.hosts, join(root, 'hosts.json')),
    mirrors: new MirrorStore({ git, root: join(root, 'mirrors'), timeoutMs: 30_000, maxFileBytes: resolved.limits.maxFileBytes, maxTreeEntries: resolved.limits.maxTreeEntries }),
  })
}
