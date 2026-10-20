import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function validatePin(pin) {
  if (!/^\d+\.\d+\.\d+$/.test(pin.version) || !/^[a-f0-9]{64}$/.test(pin.sha256)) {
    throw new Error('Invalid Hugo version or SHA-256');
  }
  return pin;
}

export function newer(a, b) {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (aa[i] !== bb[i]) return aa[i] > bb[i];
  }
  return false;
}

export function releasePin(release, checksums) {
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error('Only official stable Hugo releases are accepted');
  }
  const version = release.tag_name.slice(1);
  const filename = `hugo_extended_${version}_linux-amd64.deb`;
  const matches = checksums.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length === 2 && parts[1] === filename);
  if (matches.length !== 1) throw new Error('Missing or ambiguous Hugo checksum');
  return validatePin({ version, sha256: matches[0][0] });
}

async function fetchText(url, authenticated = false) {
  const headers = { 'User-Agent': 'yasharma-maintenance' };
  if (authenticated && process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(url, { headers, redirect: authenticated ? 'error' : 'follow', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Hugo release request failed: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('Oversized Hugo release response');
  return text;
}

async function main() {
  const path = 'tools/hugo-version.json';
  const original = await readFile(path, 'utf8');
  let pin = validatePin(JSON.parse(original));
  let changed = false;
  if (process.argv[2] === 'update') {
    const release = JSON.parse(await fetchText('https://api.github.com/repos/gohugoio/hugo/releases/latest', true));
    if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
      throw new Error('Invalid stable release');
    }
    if (newer(release.tag_name.slice(1), pin.version)) {
      const checksums = await fetchText(`https://github.com/gohugoio/hugo/releases/download/${release.tag_name}/hugo_${release.tag_name.slice(1)}_checksums.txt`);
      pin = releasePin(release, checksums);
      await writeFile(path, `${JSON.stringify(pin, null, 2)}\n`);
      changed = true;
    }
  }
  const outputs = { ...pin, changed, content: Buffer.from(await readFile(path)).toString('base64') };
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
  }
  console.log(`Hugo ${pin.version}${changed ? ' prepared for validation' : ' pinned'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
