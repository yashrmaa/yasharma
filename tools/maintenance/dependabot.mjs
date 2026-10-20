import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function safePackageChange(before, after) {
  const a = JSON.parse(before), b = JSON.parse(after);
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const obj of [a, b]) {
      if (obj[section]) {
        for (const name of Object.keys(obj[section])) {
          if (!/^\d+\.\d+\.\d+$/.test(obj[section][name])) return false;
          obj[section][name] = '<version>';
        }
      }
    }
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export function safeActionChange(before, after) {
  const normalize = text => text.replace(/^(\s*(?:-\s*)?uses:\s*[\w./-]+)@[a-f0-9]{40}(?:\s+#.*)?$/gm, '$1@<pinned-commit>');
  return normalize(before) === normalize(after);
}

export async function mergeTestedUpdate(event, api) {
  const run = event.workflow_run;
  const repo = event.repository.full_name;
  const root = `/repos/${repo}`;
  if (run.event !== 'pull_request' || run.conclusion !== 'success' ||
      run.path !== '.github/workflows/hugo.yaml' || run.repository?.full_name !== repo) return false;
  const refs = run.pull_requests;
  if (refs?.length !== 1) return false;
  const pr = await api(`${root}/pulls/${refs[0].number}`);
  if (pr.user.login !== 'dependabot[bot]' || pr.user.type !== 'Bot' || pr.state !== 'open' || pr.draft ||
      pr.base.ref !== 'main' || pr.head.repo?.full_name !== repo || pr.head.sha !== run.head_sha ||
      pr.changed_files > 10) return false;
  const files = await api(`${root}/pulls/${pr.number}/files?per_page=100`);
  if (!files.length || files.length !== pr.changed_files || files.some(file => file.status !== 'modified')) return false;
  const getFile = async (path, ref) => {
    const file = await api(`${root}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (file.encoding !== 'base64') throw new Error('Unexpected repository file encoding');
    return Buffer.from(file.content, 'base64').toString('utf8');
  };
  for (const file of files) {
    if (file.filename === 'package-lock.json') continue;
    if (file.filename !== 'package.json' && !/^\.github\/workflows\/[\w-]+\.ya?ml$/.test(file.filename)) return false;
    const before = await getFile(file.filename, pr.base.sha);
    const after = await getFile(file.filename, pr.head.sha);
    const safe = file.filename === 'package.json' ? safePackageChange(before, after) : safeActionChange(before, after);
    if (!safe) return false;
  }
  // Require a current base: a passing test from before another main commit is insufficient.
  const comparison = await api(`${root}/compare/main...${pr.head.sha}`);
  if (comparison.behind_by !== 0) {
    console.log(`Dependency PR #${pr.number} needs a fresh base and checks; leaving it open.`);
    return false;
  }
  const result = await api(`${root}/pulls/${pr.number}/merge`, 'PUT', { sha: pr.head.sha, merge_method: 'squash' });
  if (!result.merged) throw new Error(`Dependency PR #${pr.number} was not merged`);
  await api(`${root}/actions/workflows/hugo.yaml/dispatches`, 'POST', { ref: 'main' });
  console.log(`Merged tested dependency PR #${pr.number} and dispatched site deployment.`);
  return true;
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GitHub maintenance request failed: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  await mergeTestedUpdate(event, api);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
