import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Repository } from 'rit';
import { EntityStore } from 'rit/packages/rit-schema/src/index.js';
import { ModuleSchema } from 'rit/packages/rit-sync/src/schemas.js';
import { FileMaterializer, typescriptPlugin } from 'rit/packages/rit-sync/src/index.js';

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

async function reportStatus(statusUrl: string, event: PipelineEvent) {
  if (!statusUrl) {
    console.log(`[${event.type}]`, JSON.stringify(event, null, 2));
    return;
  }
  try {
    await fetch(statusUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch (err) {
    console.error('Failed to report status:', err);
  }
}

export async function executePipeline(ctx: PipelineContext) {
  const { repoName, branch, commitHash, pipelineName, steps, entityStore, repo, reposDir, statusUrl } = ctx;
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
        // Special built-in steps
        if (command === '__materialize__') {
          await materializeRepo(entityStore, workDir);
          const duration = Date.now() - start;
          const result: StepResult = { name: stepName, status: 'success', duration, output: `Materialized to ${workDir}` };
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
          continue;
        }

        if (command === '__init__') {
          // Create package.json with rit dependency and install
          const pkg = { name: repoName, type: 'module', dependencies: { rit: 'github:Ntropish/rit' } };
          writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg, null, 2));
          const proc = Bun.spawn(['bun', 'install'], { cwd: workDir, stdout: 'pipe', stderr: 'pipe' });
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;
          const duration = Date.now() - start;
          if (exitCode !== 0) {
            const result: StepResult = { name: stepName, status: 'failed', duration, output: stdout, error: stderr };
            results.push(result);
            pipelineStatus = 'failed';
            await reportStatus(statusUrl, { type: 'step-complete', repoName, pipelineName, branch, commitHash, step: result, timestamp: new Date().toISOString() });
            break;
          }
          const result: StepResult = { name: stepName, status: 'success', duration, output: stdout };
          results.push(result);
          await reportStatus(statusUrl, { type: 'step-complete', repoName, pipelineName, branch, commitHash, step: result, timestamp: new Date().toISOString() });
          continue;
        }

        // Execute shell command
        const proc = Bun.spawn(['bash', '-c', command], {
          cwd: workDir,
          env: { ...process.env, ...stepEnv, RIT_REPO: repoName, RIT_BRANCH: branch, RIT_COMMIT: commitHash },
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

    // Work directory is preserved for deploy pipelines (processes may still be running)
  }
}

async function materializeRepo(entityStore: EntityStore, outputDir: string) {
  const modules = await entityStore.list(ModuleSchema);
  const materializer = new FileMaterializer(entityStore);

  for (const mod of modules) {
    const modulePath = mod.path as string;
    try {
      const source = await materializer.materialize(modulePath, typescriptPlugin);
      const outPath = join(outputDir, `${modulePath}.ts`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, source);
      console.log(`  Materialized: ${modulePath}.ts`);
    } catch (err: any) {
      console.error(`  Failed to materialize ${modulePath}: ${err.message}`);
    }
  }
}
