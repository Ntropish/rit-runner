import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Repository } from 'rit';
import { openSqliteStore } from 'rit/src/store/sqlite.js';
import { handleRefs, handlePush, handlePull } from 'rit/src/sync/handlers.js';
import { SchemaRegistry, EntityStore } from 'rit/packages/rit-schema/src/index.js';
import { ModuleSchema, FunctionSchema, TypeDefSchema, VariableSchema } from 'rit/packages/rit-sync/src/schemas.js';
import { PipelineSchema, StepSchema } from 'rit/packages/rit-sync/src/ci-schemas.js';
import { JsonFileSchema } from 'rit/packages/rit-sync/src/index.js';
import { RawFileSchema } from 'rit/packages/rit-sync/src/index.js';
import { executePipeline } from './pipeline.js';
import { SecretsStore } from './secrets.js';

const reposDir = resolve(process.argv[2] ?? './repos');
const port = parseInt(process.env.PORT ?? '4580', 10);
const authIssuer = process.env.AUTH_ISSUER ?? 'https://auth.trivorn.org';
const statusUrl = process.env.STATUS_URL ?? '';  // URL to POST status updates to

if (!existsSync(reposDir)) mkdirSync(reposDir, { recursive: true });

const secretsStore = new SecretsStore(reposDir);

// ── Auth ──────────────────────────────────────────────────────

let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
  if (!cachedJWKS) {
    cachedJWKS = createRemoteJWKSet(
      new URL(`${authIssuer.replace(/\/$/, '')}/.well-known/jwks.json`)
    );
  }
  return cachedJWKS;
}

async function verifyToken(authHeader: string | null): Promise<boolean> {
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  try {
    await jwtVerify(match[1], getJWKS(), { issuer: authIssuer });
    return true;
  } catch {
    return false;
  }
}

// ── Repo access ───────────────────────────────────────────────

const repoCache = new Map<string, { repo: Repository; close: () => void }>();

async function getRepo(name: string): Promise<{ repo: Repository } | null> {
  const key = name.replace(/\.rit$/, '');
  if (repoCache.has(key)) return repoCache.get(key)!;

  const filePath = join(reposDir, `${key}.rit`);
  try {
    const { store, refStore, close } = openSqliteStore(filePath);
    const repo = await Repository.init(store, refStore);
    const entry = { repo, close };
    repoCache.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

async function getOrCreateRepo(name: string): Promise<{ repo: Repository }> {
  const existing = await getRepo(name);
  if (existing) return existing;

  const key = name.replace(/\.rit$/, '');
  const filePath = join(reposDir, `${key}.rit`);
  const { store, refStore, close } = openSqliteStore(filePath);
  const repo = await Repository.init(store, refStore);
  const entry = { repo, close };
  repoCache.set(key, entry);
  return entry;
}

// ── Helpers ───────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ── Pipeline trigger ─────────────────────────────────────────

async function triggerPipelines(repoName: string, branch: string, commitHash: string) {
  // Re-open repo fresh to see updated data
  const key = repoName.replace(/\.rit$/, '');
  const cached = repoCache.get(key);
  if (cached) cached.close();
  repoCache.delete(key);

  const r = await getRepo(repoName);
  if (!r) {
    console.error(`Failed to open repo ${repoName} for pipeline trigger`);
    return;
  }

  // Set up entity store with pipeline schemas
  const { store, refStore, close } = openSqliteStore(join(reposDir, `${key}.rit`));
  const repo = await Repository.init(store, refStore);
  const registry = new SchemaRegistry();
  registry.register(PipelineSchema);
  registry.register(StepSchema);
  registry.register(ModuleSchema);
  registry.register(FunctionSchema);
  registry.register(TypeDefSchema);
  registry.register(VariableSchema);
  registry.register(JsonFileSchema);
  registry.register(RawFileSchema);
  const entityStore = new EntityStore(repo, registry);

  // Find pipelines that match this trigger
  const allPipelines = await entityStore.list(PipelineSchema);
  const trigger = `push:${branch}`;

  for (const pipeline of allPipelines) {
    const pipelineTrigger = pipeline.trigger as string;
    if (pipelineTrigger === trigger || pipelineTrigger === 'push:*') {
      const pipelineName = pipeline.name as string;
      console.log(`Triggering pipeline '${pipelineName}' for ${repoName}@${branch}`);

      // Get steps for this pipeline
      const pipelineRef = `pipeline:${pipelineName}`;
      const allSteps = await entityStore.list(StepSchema, { pipeline: pipelineRef });
      const sortedSteps = allSteps.sort((a, b) => (a.order as number) - (b.order as number));

      // Execute pipeline in background
      executePipeline({
        repoName,
        branch,
        commitHash,
        pipelineName,
        steps: sortedSteps,
        entityStore,
        repo,
        reposDir,
        statusUrl,
        secrets: secretsStore.getAll(repoName),
      }).catch(err => {
        console.error(`Pipeline '${pipelineName}' failed:`, err);
      });
    }
  }

  close();
}

// ── Server ────────────────────────────────────────────────────

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Auth check on all /api routes
    if (path.startsWith('/api/')) {
      const valid = await verifyToken(req.headers.get('authorization'));
      if (!valid) return error('Not authenticated', 401);
    }

    // GET /api/repos - list repos
    if (path === '/api/repos' && method === 'GET') {
      try {
        const entries = readdirSync(reposDir).filter(e => e.endsWith('.rit'));
        const repos = entries.map(e => e.replace(/\.rit$/, ''));
        return json(repos);
      } catch {
        return json([]);
      }
    }

    // ── Sync protocol endpoints ──────────────────────────────

    // GET /api/repos/:name/info/refs
    const refsMatch = path.match(/^\/api\/repos\/([^/]+)\/info\/refs$/);
    if (refsMatch && method === 'GET') {
      const name = decodeURIComponent(refsMatch[1]);
      const r = await getRepo(name);
      if (!r) return json({ type: 'ref-advertise', branches: {} });
      const result = await handleRefs(r.repo);
      return json(result);
    }

    // POST /api/repos/:name/push
    const pushMatch = path.match(/^\/api\/repos\/([^/]+)\/push$/);
    if (pushMatch && method === 'POST') {
      const name = decodeURIComponent(pushMatch[1]);
      const r = await getOrCreateRepo(name);
      const body = await req.json();
      const result = await handlePush(r.repo, body);

      if (result.accepted) {
        const branch = body.branch as string;
        const commitHash = body.commitHash as string;
        // Trigger pipelines asynchronously
        triggerPipelines(name, branch, commitHash);
      }

      return json(result);
    }

    // POST /api/repos/:name/pull
    const pullMatch = path.match(/^\/api\/repos\/([^/]+)\/pull$/);
    if (pullMatch && method === 'POST') {
      const name = decodeURIComponent(pullMatch[1]);
      const r = await getRepo(name);
      if (!r) return error('Repo not found', 404);
      const pullBody = await req.json();
      const result = await handlePull(r.repo, pullBody);
      return json(result);
    }

    // ── Secrets API ───────────────────────────────────────────

    // PUT /api/repos/:name/secrets/:key - set a secret
    const secretSetMatch = path.match(/^\/api\/repos\/([^/]+)\/secrets\/([^/]+)$/);
    if (secretSetMatch && method === 'PUT') {
      const name = decodeURIComponent(secretSetMatch[1]);
      const key = decodeURIComponent(secretSetMatch[2]);
      const body = await req.json() as { value: string };
      if (!body.value) return error('Missing "value" in body');
      secretsStore.set(name, key, body.value);
      return json({ ok: true });
    }

    // DELETE /api/repos/:name/secrets/:key - remove a secret
    if (secretSetMatch && method === 'DELETE') {
      const name = decodeURIComponent(secretSetMatch[1]);
      const key = decodeURIComponent(secretSetMatch[2]);
      const deleted = secretsStore.delete(name, key);
      if (!deleted) return error('Secret not found', 404);
      return json({ ok: true });
    }

    // GET /api/repos/:name/secrets - list secret names (not values)
    const secretListMatch = path.match(/^\/api\/repos\/([^/]+)\/secrets$/);
    if (secretListMatch && method === 'GET') {
      const name = decodeURIComponent(secretListMatch[1]);
      return json(secretsStore.list(name));
    }

    // Health check
    if (path === '/health' && method === 'GET') {
      return json({ status: 'ok', repos: reposDir });
    }

    return error('Not found', 404);
  },
});

console.log(`Rit runner listening on http://localhost:${server.port}`);
console.log(`Repos directory: ${reposDir}`);
if (statusUrl) console.log(`Status reporting to: ${statusUrl}`);
