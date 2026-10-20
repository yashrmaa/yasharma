import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePin, newer, releasePin } from './hugo.mjs';

const digest = 'a'.repeat(64);
const release = { tag_name: 'v0.169.0', draft: false, prerelease: false };
test('accepts the exact extended Debian asset checksum', () => {
  assert.deepEqual(releasePin(release, `${'b'.repeat(64)}  hugo_0.169.0_linux-amd64.deb\n${digest}  hugo_extended_0.169.0_linux-amd64.deb\n`), { version: '0.169.0', sha256: digest });
});
test('rejects drafts, prereleases, malformed versions and ambiguous checksums', () => {
  for (const invalid of [{ ...release, draft: true }, { ...release, prerelease: true }, { ...release, tag_name: 'v0.169.0-rc1' }, { ...release, tag_name: 'v1;echo x' }]) {
    assert.throws(() => releasePin(invalid, ''));
  }
  assert.throws(() => releasePin(release, `${digest} other.deb`));
  assert.throws(() => releasePin(release, `${digest} hugo_extended_0.169.0_linux-amd64.deb\n${digest} hugo_extended_0.169.0_linux-amd64.deb`));
  assert.throws(() => validatePin({ version: '0.169.0', sha256: 'invalid' }));
});
test('compares numeric versions without downgrading', () => {
  assert.equal(newer('0.170.0', '0.99.0'), true);
  assert.equal(newer('0.168.1', '0.168.0'), true);
  assert.equal(newer('0.168.0', '0.168.0'), false);
  assert.equal(newer('0.167.9', '0.168.0'), false);
});
