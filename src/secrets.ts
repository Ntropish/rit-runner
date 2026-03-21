import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * File-based secrets store. Secrets are stored per repo in a
 * .secrets directory as JSON files. Values are not encrypted
 * (the runner's filesystem is the trust boundary).
 */
export class SecretsStore {
  private secretsDir: string;

  constructor(baseDir: string) {
    this.secretsDir = join(baseDir, '.secrets');
    if (!existsSync(this.secretsDir)) {
      mkdirSync(this.secretsDir, { recursive: true });
    }
  }

  private repoFile(repoName: string): string {
    return join(this.secretsDir, `${repoName}.json`);
  }

  private load(repoName: string): Record<string, string> {
    const file = this.repoFile(repoName);
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      return {};
    }
  }

  private save(repoName: string, secrets: Record<string, string>): void {
    writeFileSync(this.repoFile(repoName), JSON.stringify(secrets, null, 2));
  }

  set(repoName: string, key: string, value: string): void {
    const secrets = this.load(repoName);
    secrets[key] = value;
    this.save(repoName, secrets);
  }

  delete(repoName: string, key: string): boolean {
    const secrets = this.load(repoName);
    if (!(key in secrets)) return false;
    delete secrets[key];
    this.save(repoName, secrets);
    return true;
  }

  list(repoName: string): string[] {
    return Object.keys(this.load(repoName));
  }

  /** Get all secrets for a repo (used at pipeline execution time). */
  getAll(repoName: string): Record<string, string> {
    return this.load(repoName);
  }
}
