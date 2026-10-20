import test from 'node:test';
import assert from 'node:assert/strict';
import { safePackageChange, safeActionChange, mergeTestedUpdate } from './dependabot.mjs';

test('permits only pinned dependency versions and action commit changes', () => {
  assert.equal(safePackageChange('{"scripts":{"x":"safe"},"devDependencies":{"a":"1.0.0"}}', '{"scripts":{"x":"safe"},"devDependencies":{"a":"2.0.0"}}'), true);
  assert.equal(safePackageChange('{"scripts":{"x":"safe"}}', '{"scripts":{"x":"curl evil"}}'), false);
  assert.equal(safePackageChange('{"devDependencies":{"a":"1.0.0"}}', '{"devDependencies":{"a":"1.1.0","b":"1.0.0"}}'), false);
  assert.equal(safeActionChange(`      - uses: actions/checkout@${'a'.repeat(40)} # v7\n`, `      - uses: actions/checkout@${'b'.repeat(40)} # v8\n`), true);
  assert.equal(safeActionChange('run: echo safe\n', 'run: curl evil\n'), false);
  assert.equal(safeActionChange(`uses: actions/checkout@${'a'.repeat(40)}`, `uses: evil/checkout@${'b'.repeat(40)}`), false);
});

const event = { repository: { full_name: 'owner/site' }, workflow_run: {
  event: 'pull_request', conclusion: 'success', path: '.github/workflows/hugo.yaml',
  repository: { full_name: 'owner/site' }, pull_requests: [{ number: 1 }], head_sha: 'tested',
} };
const pr = { number: 1, user: { login: 'dependabot[bot]', type: 'Bot' }, state: 'open', draft: false,
  base: { ref: 'main', sha: 'base' }, head: { repo: { full_name: 'owner/site' }, sha: 'tested' }, changed_files: 1 };

function fixture({ pull = pr, files = [{ filename: 'package-lock.json', status: 'modified' }], behind = 0, merged = true } = {}) {
  const writes = [];
  const api = async (path, method = 'GET', body) => {
    if (method !== 'GET') { writes.push({ path, method, body }); return { merged }; }
    if (path.endsWith('/pulls/1')) return pull;
    if (path.includes('/files?')) return files;
    if (path.includes('/compare/')) return { behind_by: behind };
    if (path.includes('/contents/')) return { encoding: 'base64', content: Buffer.from('run: dangerous change').toString('base64') };
    throw new Error(`Unexpected API path ${path}`);
  };
  return { api, writes };
}
test('merges only the tested head and explicitly dispatches deployment', async () => {
  const { api, writes } = fixture();
  assert.equal(await mergeTestedUpdate(event, api), true);
  assert.equal(writes[0].body.sha, 'tested');
  assert.equal(writes[1].body.ref, 'main');
});
test('untrusted authors, forks, changed heads and stale bases cannot merge', async () => {
  for (const pull of [{ ...pr, user: { login: 'someone', type: 'User' } }, { ...pr, head: { ...pr.head, sha: 'untested' } }, { ...pr, head: { ...pr.head, repo: { full_name: 'attacker/fork' } } }]) {
    const { api, writes } = fixture({ pull });
    assert.equal(await mergeTestedUpdate(event, api), false);
    assert.equal(writes.length, 0);
  }
  const { api, writes } = fixture({ behind: 1 });
  assert.equal(await mergeTestedUpdate(event, api), false);
  assert.equal(writes.length, 0);
});
test('other files and unsuccessful runs cannot merge', async () => {
  const { api, writes } = fixture({ files: [{ filename: 'tools/note-publisher/src/worker.mjs', status: 'modified' }] });
  assert.equal(await mergeTestedUpdate(event, api), false);
  assert.equal(await mergeTestedUpdate({ ...event, workflow_run: { ...event.workflow_run, conclusion: 'failure' } }, api), false);
  assert.equal(writes.length, 0);
});
test('a rejected merge fails visibly and never dispatches deployment', async () => {
  const { api, writes } = fixture({ merged: false });
  await assert.rejects(mergeTestedUpdate(event, api), /not merged/);
  assert.equal(writes.length, 1);
});
