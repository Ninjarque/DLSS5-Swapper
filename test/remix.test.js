'use strict';
// RTX Remix games draw through `.trex\d3d9.dll`, a 64-bit Vulkan runtime the
// bridge loads, whatever the executable beside it imports. The neural pass
// goes inside that runtime; nothing about ReShade applies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writePe } = require('./fixtures/pe');
const remix = require('../src/core/remix');
const routes = require('../src/shared/install-routes');
const { scanGame } = require('../src/core/scan');
const backends = require('../src/core/backend-manager');

function temp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Portal with RTX, in miniature: a 32-bit DX9 hl2.exe, the 32-bit bridge in
// bin\, and the 64-bit runtime with the game's DLSS in bin\.trex.
function portal(t, { runtimeText = 'stock remix runtime vulkan-1.dll', conf = 'rtx.dlfg.maxInterpolatedFrames = 3\r\nrtx.qualityDLSS = 3\r\n' } = {}) {
  const dir = temp(t, 'remix-game-');
  writePe(path.join(dir, 'hl2.exe'), { bitness: 32, text: 'Direct3DCreate9', imports: ['d3d9.dll'] });
  writePe(path.join(dir, 'bin', 'd3d9.dll'), { bitness: 32, text: 'NvRemixBridge' });
  writePe(path.join(dir, 'bin', '.trex', 'd3d9.dll'), { bitness: 64, text: runtimeText });
  writePe(path.join(dir, 'bin', '.trex', 'NvRemixBridge.exe'), { bitness: 64, text: 'NvRemixBridge' });
  writePe(path.join(dir, 'bin', '.trex', 'nvngx_dlss.dll'), { bitness: 64, text: 'dlss' });
  if (conf !== null) fs.writeFileSync(path.join(dir, 'rtx.conf'), conf);
  return dir;
}
// What ensureRuntime would have cached, and the app payload's model.
function payload(t) {
  const root = temp(t, 'remix-payload-');
  writePe(path.join(root, 'runtime', 'd3d9.dll'), { bitness: 64, text: 'rtx.neuralRendering.enable community build' });
  writePe(path.join(root, 'runtime', 'remix_nvngx.dll'), { bitness: 64, text: 'nvngx.dll shim' });
  const model = writePe(path.join(root, 'nvngx_dlssnr.dll'), { bitness: 64, text: 'neural model' });
  return { remixRoot: path.join(root, 'runtime'), source: { payload: [{ name: 'nvngx_dlssnr.dll', path: model, version: '310.8.0.0' }] } };
}
async function installInto(dir, extra) {
  const scan = await scanGame(dir);
  return {
    scan,
    manifest: await backends.install({
      gameDir: dir, exePath: scan.chosen.path, api: scan.chosen.api, apiLabel: scan.chosen.apiLabel,
      bitness: scan.chosen.bitness, route: 'remix', remix: scan.remix, ...extra
    }, () => {})
  };
}

test('rtx.conf is edited one line at a time, keeping its line endings', () => {
  const key = 'rtx.neuralRendering.enable';
  const crlf = 'rtx.a = 1\r\nrtx.neuralRendering.enable = False\r\nrtx.b = 2\r\nRTX.NEURALRENDERING.ENABLE=False\r\n';
  const on = remix.enable(crlf, key);
  assert.equal(on, 'rtx.a = 1\r\nrtx.neuralRendering.enable = True\r\nrtx.b = 2\r\n', 'replaced in place, duplicate dropped');
  assert.equal(remix.enable(on, key), on, 'idempotent');
  assert.equal(remix.enable('rtx.a = 1', key), 'rtx.a = 1\nrtx.neuralRendering.enable = True\n', 'appended with a final newline');
  assert.equal(remix.enable('', key), 'rtx.neuralRendering.enable = True\n');
  assert.equal(remix.currentLine(crlf, key), 'rtx.neuralRendering.enable = False');
  assert.equal(remix.setLine(on, key, null), 'rtx.a = 1\r\nrtx.b = 2\r\n', 'removed');
  assert.equal(remix.setLine(on, key, 'rtx.neuralRendering.enable = False'), crlf.replace('RTX.NEURALRENDERING.ENABLE=False\r\n', ''));
  // A key that merely starts the same is someone else's setting.
  assert.equal(remix.enable('rtx.neuralRendering.enableDebug = True\n', key), 'rtx.neuralRendering.enableDebug = True\nrtx.neuralRendering.enable = True\n');
});

test('a Remix game offers the runtime route alone, whatever its executable says', async (t) => {
  const dir = portal(t);
  const scan = await scanGame(dir);
  assert.equal(scan.chosen.rel, 'hl2.exe', 'the bridge is never the game');
  assert.equal(scan.chosen.bitness, 32);
  assert.equal(scan.remix.rel, path.join('bin', '.trex'));
  assert.equal(scan.remix.bridge, true);
  assert.deepEqual(routes.routesFor(scan.chosen), ['remix']);
  assert.equal(routes.recommendedRoute(scan), 'remix');
  for (const api of ['dxgi', 'vulkan', 'd3d9']) assert.deepEqual(routes.routesFor({ ...scan.chosen, api }), ['remix']);
  assert.equal(scan.exeCandidates.some(e => /nvremixbridge/i.test(e.name)), false);

  // Without a runtime the same folder is an ordinary DX9 game again.
  fs.rmSync(path.join(dir, 'bin', '.trex'), { recursive: true });
  const plain = await scanGame(dir);
  assert.equal(plain.remix, null);
  assert.equal(routes.routesFor(plain.chosen).includes('remix'), false);
});

test('a 32-bit or empty .trex is not a Remix runtime', async (t) => {
  const dir = temp(t, 'remix-not-');
  writePe(path.join(dir, 'Game.exe'), { bitness: 64, text: 'D3D12CreateDevice', imports: ['d3d12.dll'] });
  writePe(path.join(dir, '.trex', 'd3d9.dll'), { bitness: 32, text: 'not ours' });
  fs.mkdirSync(path.join(dir, 'other', '.trex'), { recursive: true });
  assert.equal((await scanGame(dir)).remix, null);
});

test('the runtime flavour is read from the option names compiled into it, across chunk boundaries', (t) => {
  const dir = temp(t, 'remix-flavour-');
  const file = path.join(dir, 'd3d9.dll');
  const size = 4 * 1024 * 1024 + 64;
  const bytes = Buffer.alloc(size);
  const marker = 'rtx.neuralRendering';
  bytes.write(marker, 4 * 1024 * 1024 - 7, 'ascii');
  fs.writeFileSync(file, bytes);
  assert.equal(remix.flavourOf(file).id, 'neuralRendering');
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(1024), Buffer.from('rtx.neuralUplift.enable')]));
  assert.equal(remix.flavourOf(file).key, 'rtx.neuralUplift.enable');
  fs.writeFileSync(file, Buffer.alloc(2048));
  assert.equal(remix.flavourOf(file), null);
});

test('install swaps the stock runtime, adds the model and one rtx.conf line; restore undoes exactly that', async (t) => {
  const dir = portal(t);
  const trex = path.join(dir, 'bin', '.trex');
  const originalRuntime = fs.readFileSync(path.join(trex, 'd3d9.dll'));
  const originalConf = fs.readFileSync(path.join(dir, 'rtx.conf'), 'utf8');
  const { manifest } = await installInto(dir, payload(t));

  assert.equal(manifest.route, 'remix');
  assert.match(fs.readFileSync(path.join(trex, 'd3d9.dll'), 'latin1'), /rtx\.neuralRendering/);
  assert.ok(fs.existsSync(path.join(trex, 'remix_nvngx.dll')));
  assert.match(fs.readFileSync(path.join(trex, 'nvngx_dlssnr.dll'), 'latin1'), /neural model/);
  assert.equal(fs.readFileSync(path.join(dir, 'rtx.conf'), 'utf8'), originalConf + 'rtx.neuralRendering.enable = True\r\n');
  assert.equal(manifest.remix.swapped, true);
  assert.equal(manifest.remix.previousLine, null);
  assert.equal(manifest.remix.conf, 'rtx.conf');
  assert.deepEqual(manifest.replaced.map(r => r.rel), [path.join('bin', '.trex', 'd3d9.dll')], 'rtx.conf is never restored wholesale');

  const rescanned = await scanGame(dir);
  assert.equal(rescanned.install.route, 'remix');
  assert.equal(rescanned.install.remix.installed, true);

  // Remix's own menu saves into rtx.conf after the install. That must survive.
  fs.appendFileSync(path.join(dir, 'rtx.conf'), 'rtx.pathMaxBounces = 8\r\n');
  await backends.restore(dir, () => {});
  assert.deepEqual(fs.readFileSync(path.join(trex, 'd3d9.dll')), originalRuntime);
  assert.equal(fs.existsSync(path.join(trex, 'remix_nvngx.dll')), false);
  assert.equal(fs.existsSync(path.join(trex, 'nvngx_dlssnr.dll')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'rtx.conf'), 'utf8'), originalConf + 'rtx.pathMaxBounces = 8\r\n');
  assert.ok(fs.existsSync(path.join(trex, 'nvngx_dlss.dll')), 'the game’s DLSS is never touched');
});

test('a runtime that is already neural-capable, a model the owner supplied and a prior setting are all kept', async (t) => {
  const dir = portal(t, { runtimeText: 'mod build rtx.neuralRendering', conf: 'rtx.neuralRendering.enable = False\n' });
  const trex = path.join(dir, 'bin', '.trex');
  writePe(path.join(trex, 'nvngx_dlssnr.dll'), { bitness: 64, text: 'sm_89 model for an Ada card' });
  const runtime = fs.readFileSync(path.join(trex, 'd3d9.dll'));
  const { manifest } = await installInto(dir, payload(t));
  assert.deepEqual(fs.readFileSync(path.join(trex, 'd3d9.dll')), runtime);
  assert.match(fs.readFileSync(path.join(trex, 'nvngx_dlssnr.dll'), 'latin1'), /sm_89/);
  assert.equal(manifest.remix.swapped, false);
  assert.ok(fs.existsSync(path.join(trex, 'remix_nvngx.dll')), 'the shim that build needs is added');
  assert.equal(fs.readFileSync(path.join(dir, 'rtx.conf'), 'utf8'), 'rtx.neuralRendering.enable = True\n');

  // A second install must not forget what the line said before the first.
  await installInto(dir, payload(t));
  await backends.restore(dir, () => {});
  assert.equal(fs.readFileSync(path.join(dir, 'rtx.conf'), 'utf8'), 'rtx.neuralRendering.enable = False\n');
  assert.equal(fs.existsSync(path.join(trex, 'remix_nvngx.dll')), false);
  assert.match(fs.readFileSync(path.join(trex, 'nvngx_dlssnr.dll'), 'latin1'), /sm_89/);
});

test('an rtx.conf the install had to create is removed again when nothing else was saved into it', async (t) => {
  const dir = portal(t, { conf: null });
  const { manifest } = await installInto(dir, payload(t));
  assert.equal(manifest.remix.confCreated, true);
  assert.ok(fs.existsSync(path.join(dir, 'bin', 'rtx.conf')), 'created beside the runtime’s parent');
  await backends.restore(dir, () => {});
  assert.equal(fs.existsSync(path.join(dir, 'bin', 'rtx.conf')), false);
});

test('a runtime whose libraries the game lacks is refused before anything moves', async (t) => {
  // What happened in Portal with RTX: the neural build imports USD split into
  // usd_*.dll plus libxess.dll, the game ships one usd_ms.dll, Windows refuses
  // the runtime and the game runs with no window.
  const dir = portal(t);
  const trex = path.join(dir, 'bin', '.trex');
  writePe(path.join(trex, 'usd_ms.dll'), { bitness: 64 });
  writePe(path.join(trex, 'rtxio.dll'), { bitness: 64 });
  const before = new Map(fs.readdirSync(trex).map(name => [name, fs.readFileSync(path.join(trex, name))]));
  const conf = fs.readFileSync(path.join(dir, 'rtx.conf'), 'utf8');
  const imports = () => ['kernel32.dll', 'api-ms-win-crt-runtime-l1-1-0.dll', 'rtxio.dll', 'usd_ar.dll', 'usd_sdf.dll', 'libxess.dll', 'remix_nvngx.dll'];

  assert.deepEqual(remix.missingDependencies(path.join(trex, 'd3d9.dll'), trex, { readImports: imports, extra: ['remix_nvngx.dll'] }),
    ['usd_ar.dll', 'usd_sdf.dll', 'libxess.dll'], 'system DLLs, API sets, the folder and files the release adds all count as present');

  await assert.rejects(installInto(dir, { ...payload(t), readImports: imports }), (error) => {
    assert.equal(error.code, 'errRemixDependencies');
    assert.match(error.message, /usd_ar\.dll, usd_sdf\.dll, libxess\.dll/);
    return true;
  });
  assert.deepEqual(fs.readdirSync(trex).sort(), [...before.keys()].sort(), 'no file added');
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(trex, name)), bytes, `${name} untouched`);
  assert.equal(fs.readFileSync(path.join(dir, 'rtx.conf'), 'utf8'), conf);
  assert.equal(fs.existsSync(path.join(dir, '_DLSS5_Backup', 'manifest.json')), false, 'no install recorded');
});

test('the pinned runtime is identified by size and digest, and every pin is a real SHA-256', async (t) => {
  for (const release of remix.RELEASES) {
    for (const file of release.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.ok(file.url.startsWith(`https://github.com/${release.repo}/releases/download/${release.tag}/`));
    }
  }
  const dir = temp(t, 'remix-pin-');
  const file = writePe(path.join(dir, 'd3d9.dll'), { bitness: 64 });
  assert.equal(await remix.isPinnedRuntime(file), false);
});
