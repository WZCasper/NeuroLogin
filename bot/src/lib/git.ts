import { execFile } from 'child_process';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: REPO_ROOT }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

let queue: Promise<void> = Promise.resolve();

/**
 * Commits and pushes any pending changes under /data to the repository.
 * Calls are serialized so concurrent Telegram updates never race on git state.
 */
export function commitDataChanges(message: string): Promise<void> {
  queue = queue.then(() => doCommit(message)).catch((err) => {
    console.error('Git commit failed:', err.message);
  });
  return queue;
}

async function doCommit(message: string): Promise<void> {
  const token = process.env.GH_TOKEN;
  const repo = process.env.GH_REPO; // format: owner/repo

  await run('git', ['add', 'data']);

  const status = await run('git', ['status', '--porcelain', '--', 'data']);
  if (!status) {
    return; // nothing changed
  }

  await run('git', ['-c', 'user.email=neurologin-bot@users.noreply.github.com', '-c', 'user.name=NeuroLogin Bot', 'commit', '-m', message]);

  if (token && repo) {
    const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
    try {
      await run('git', ['pull', '--rebase', remote, 'main']);
    } catch (err) {
      console.warn('Rebase pull skipped or failed, continuing with push:', (err as Error).message);
    }
    await run('git', ['push', remote, 'HEAD:main']);
  } else {
    // Local/dev fallback: push to whatever origin is already configured.
    await run('git', ['push', 'origin', 'HEAD:main']);
  }
}
