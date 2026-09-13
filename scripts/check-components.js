'use strict';
// What the community has published since each component was pinned.
//
// Read-only. Nothing is downloaded and no pin is changed: a newer release is a
// candidate, and moving a pin means reading its notes, testing it and writing
// its digest by hand, exactly as the current ones were. Run: npm run components
const optiscaler = require('../src/core/optiscaler');
const feeder = require('../src/core/feeder-release');
const remix = require('../src/core/remix');
const { DGVOODOO } = require('../src/core/runtime-components');

const WATCH = [
  { name: 'DLSS5-Swapper (upstream app)', repo: 'rakanki911/DLSS5-Swapper', pinned: `v${require('../package.json').version}` },
  { name: 'RTX Remix runtime with DLSS-NR', repo: remix.RELEASE.repo, pinned: remix.RELEASE.tag, tag: /^dlssnr/i },
  { name: 'OptiScaler DLSS-NR', repo: 'Dagherbou/OptiScaler_DLSSNR', pinned: `v${optiscaler.RELEASE.version}` },
  { name: 'DLSS5-Feeder', repo: 'jlrouzies-fr/DLSS5-Feeder', pinned: `v${feeder.version}` },
  { name: 'dgVoodoo2', repo: 'dege-diosg/dgVoodoo2', pinned: `v${DGVOODOO.version}` },
  // Upstream of the Remix build: new NVIDIA runtime work lands here first.
  { name: 'NVIDIA dxvk-remix (reference)', repo: 'NVIDIAGameWorks/dxvk-remix', pinned: null }
];

async function releases(repo) {
  const headers = { 'User-Agent': 'DLSS5-Swapper-fork', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return (await response.json()).filter(r => !r.draft);
}

(async () => {
  let newer = 0;
  for (const item of WATCH) {
    try {
      const list = (await releases(item.repo)).filter(r => !item.tag || item.tag.test(r.tag_name));
      const latest = list[0];
      if (!latest) { console.log(`- ${item.name}: no releases`); continue; }
      const current = item.pinned && latest.tag_name.replace(/^v/, '') === item.pinned.replace(/^v/, '');
      if (item.pinned && !current) newer++;
      console.log(`${current || !item.pinned ? '-' : '*'} ${item.name}: pinned ${item.pinned || 'n/a'}, latest ${latest.tag_name} (${latest.published_at.slice(0, 10)})`);
      if (item.pinned && !current) console.log(`    ${latest.html_url}`);
    } catch (error) {
      console.log(`? ${item.name}: ${error.message}`);
    }
  }
  console.log(newer ? `\n${newer} component(s) have a newer release to review.` : '\nEvery pinned component is on its latest release.');
})();
