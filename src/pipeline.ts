import { mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

// Resolve the runner's own node_modules/.bin at load time so pipeline steps can use installed bins (fr, rit-hono-materialize)
const runnerBinDir = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', 'node_modules', '.bin');
const pathSep = process.platform === 'win32' ? ';' : ':';
import { Repository } from '@rit/core';
import { EntityStore } from '@rit/schema';

export interface PipelineContext {
  repoName: string;
  branch: string;
  commitHash: string;
  pipelineName: string;
  steps: Array<Record<string, unknown>>;
  entityStore: EntityStore;
  repo: Repository;
  reposDir: string;
  statusUrl: string;
  secrets: Record<string, string>;
}

export interface StepResult {
  name: string;
  status: 'running' | 'success' | 'failed' | 'skipped';
  output?: string;
  error?: string;
  duration?: number;
}

export interface PipelineEvent {
  type: 'pipeline-start' | 'step-start' | 'step-complete' | 'pipeline-complete';
  repoName: string;
  pipelineName: string;
  branch: string;
  commitHash: string;
  step?: StepResult;
  steps?: StepResult[];
  status?: 'success' | 'failed';
  timestamp: string;
}

// Service client auth for reporting status to RitCan
let cachedServiceToken: string | null = null;
let tokenExpiry = 0;

async function getServiceToken(): Promise<string | null> {
  if (cachedServiceToken && Date.now() < tokenExpiry) return cachedServiceToken;

  const clientId = process.env.SERVICE_CLIENT_ID;
  const clientSecret = process.env.SERVICE_CLIENT_SECRET;
  const issuer = process.env.AUTH_ISSUER ?? 'https://auth.trivorn.org';

  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'openid',
      }),
    });
    if (!res.ok) return null;
    const body = await res.json() as { access_token: string; expires_in?: number };
    cachedServiceToken = body.access_token;
    tokenExpiry = Date.now() + ((body.expires_in ?? 600) - 30) * 1000;
    return cachedServiceToken;
  } catch {
    return null;
  }
}

async function reportStatus(statusUrl: string, event: PipelineEvent) {
  if (!statusUrl) {
    console.log(`[${event.type}]`, JSON.stringify(event, null, 2));
    return;
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = await getServiceToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await fetch(statusUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
    });
  } catch (err) {
    console.error('Failed to report status:', err);
  }
}

export async function executePipeline(ctx: PipelineContext) {
  const { repoName, branch, commitHash, pipelineName, steps, entityStore, repo, reposDir, statusUrl, secrets } = ctx;

  // Always inject a fresh OIDC token for Verdaccio auth. Static tokens expire;
  // the service client provides a fresh one for each pipeline run.
  const serviceToken = await getServiceToken();
  if (serviceToken) secrets.NPM_TOKEN = serviceToken;
  const results: StepResult[] = [];
  let pipelineStatus: 'success' | 'failed' = 'success';

  // Report pipeline start
  await reportStatus(statusUrl, {
    type: 'pipeline-start',
    repoName,
    pipelineName,
    branch,
    commitHash,
    steps: steps.map(s => ({ name: s.name as string, status: 'running' as const })),
    timestamp: new Date().toISOString(),
  });

  // Use a stable working directory per repo+pipeline (persists across runs for deploy)
  const workDir = join(reposDir, '.deploys', `${repoName}-${pipelineName}`);
  mkdirSync(workDir, { recursive: true });

  try {
    for (const step of steps) {
      const stepName = step.name as string;
      const command = step.command as string;
      const stepEnv = step.env ? JSON.parse(step.env as string) : {};

      // Report step start
      await reportStatus(statusUrl, {
        type: 'step-start',
        repoName,
        pipelineName,
        branch,
        commitHash,
        step: { name: stepName, status: 'running' },
        timestamp: new Date().toISOString(),
      });

      const start = Date.now();

      try {
        // Execute shell command
        const proc = Bun.spawn(['bash', '-c', command], {
          cwd: workDir,
          env: { ...process.env, ...secrets, ...stepEnv, PATH: `${runnerBinDir}${pathSep}${process.env.PATH ?? ''}`, RIT_REPO: repoName, RIT_BRANCH: branch, RIT_COMMIT: commitHash },
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        const duration = Date.now() - start;

        if (exitCode !== 0) {
          const result: StepResult = { name: stepName, status: 'failed', duration, output: stdout, error: stderr };
          results.push(result);
          pipelineStatus = 'failed';
          await reportStatus(statusUrl, {
            type: 'step-complete',
            repoName,
            pipelineName,
            branch,
            commitHash,
            step: result,
            timestamp: new Date().toISOString(),
          });
          // Stop pipeline on failure
          break;
        }

        const result: StepResult = { name: stepName, status: 'success', duration, output: stdout };
        results.push(result);
        await reportStatus(statusUrl, {
          type: 'step-complete',
          repoName,
          pipelineName,
          branch,
          commitHash,
          step: result,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        const duration = Date.now() - start;
        const result: StepResult = { name: stepName, status: 'failed', duration, error: err.message };
        results.push(result);
        pipelineStatus = 'failed';
        await reportStatus(statusUrl, {
          type: 'step-complete',
          repoName,
          pipelineName,
          branch,
          commitHash,
          step: result,
          timestamp: new Date().toISOString(),
        });
        break;
      }
    }

    // Mark remaining steps as skipped
    for (const step of steps) {
      const stepName = step.name as string;
      if (!results.some(r => r.name === stepName)) {
        results.push({ name: stepName, status: 'skipped' });
      }
    }
  } finally {
    // Report pipeline complete
    await reportStatus(statusUrl, {
      type: 'pipeline-complete',
      repoName,
      pipelineName,
      branch,
      commitHash,
      steps: results,
      status: pipelineStatus,
      timestamp: new Date().toISOString(),
    });

    // Prune dangling Docker images to prevent disk fill-up
    try {
      const pruneProc = Bun.spawn(['docker', 'image', 'prune', '-f'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const pruneOut = await new Response(pruneProc.stdout).text();
      const pruneErr = await new Response(pruneProc.stderr).text();
      const pruneExit = await pruneProc.exited;
      if (pruneExit === 0) {
        console.log(`[docker-prune] ${pruneOut.trim()}`);
      } else {
        console.error(`[docker-prune] failed (exit ${pruneExit}): ${pruneErr.trim()}`);
      }
    } catch (err: any) {
      console.error(`[docker-prune] error: ${err.message}`);
    }
  }
}
