'use strict';

// RTX Remix games: Portal with RTX, Portal: Prelude RTX, Half-Life 2 RTX and
// every community Remix mod. None of them is the game its executable says it
// is. hl2.exe is a 32-bit DirectX 9 program, but the frame is path traced by a
// 64-bit Vulkan runtime, `.trex\d3d9.dll`, in a separate process the bridge
// starts. That runtime carries its own DLSS, so a ReShade route aimed at the
// executable either does nothing or sits in front of the bridge and breaks it.
//
// The neural pass therefore goes inside the runtime, right after its upscaler
// and before bloom and tone mapping: a community build of NVIDIA's open-source
// dxvk-remix with DLSS-NR added, pinned below exactly as OptiScaler is.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pe = require('./pe');
const journal = require('./file-journal');
const { cached, fetchVerified } = require('./runtime-components');

const RELEASES = Object.freeze([
  Object.freeze({
    tag: 'dlssnr-v1',
    repo: 'lunks/dxvk-remix-plus-dlssnr',
    commit: 'fc4de144b3',
    // Upstream's release notes: verified running in Portal with RTX from the
    // runtime log, "NVIDIA DLSS-NR evaluated", not only from how it looked.
    files: Object.freeze([
      Object.freeze({
        name: 'd3d9.dll',
        url: 'https://github.com/lunks/dxvk-remix-plus-dlssnr/releases/download/dlssnr-v1/d3d9.dll',
        size: 152830464,
        sha256: '266815aa70e1c314a98430fcf953d31709026c0634153399bcf033d7cba5b214'
      }),
      // Every gated NGX snippet export checks that its caller's path contains
      // "nvngx.dll". This shim is what satisfies that, and it must keep its name.
      Object.freeze({
        name: 'remix_nvngx.dll',
        url: 'https://github.com/lunks/dxvk-remix-plus-dlssnr/releases/download/dlssnr-v1/remix_nvngx.dll',
        size: 10752,
        sha256: 'b3aa9600cb155cc3e2459507a98772c928d9f50127dfba1f360db04ef03c6684'
      })
    ])
  })
]);
const RELEASE = RELEASES[0];

// Which runtime build a d3d9.dll is, read from the option names compiled into
// it. lunks' build says rtx.neuralRendering; Kim2091's GTA IV fork says
// rtx.neuralUplift. A mod that already ships either is left as it is.
const FLAVOURS = Object.freeze([
  Object.freeze({ id: 'neuralRendering', marker: 'rtx.neuralRendering', key: 'rtx.neuralRendering.enable' }),
  Object.freeze({ id: 'neuralUplift', marker: 'rtx.neuralUplift', key: 'rtx.neuralUplift.enable' })
]);
const RUNTIME = 'd3d9.dll';
const MODEL = 'nvngx_dlssnr.dll';
const BRIDGE = 'NvRemixBridge.exe';
const CONFIG = 'rtx.conf';

function fail(code, message = code) { return Object.assign(new Error(message), { code }); }

// The runtime folder the scan found, as the nearest `.trex` holding a runtime.
// Portal with RTX keeps it in bin\.trex, a 64-bit mod beside the executable.
function isRuntimeFile(file) {
  return path.basename(file).toLowerCase() === RUNTIME &&
    path.basename(path.dirname(file)).toLowerCase() === '.trex';
}
function describe(gameDir, runtimeFile) {
  const dir = path.dirname(runtimeFile);
  return {
    dir,
    rel: path.relative(gameDir, dir),
    runtime: runtimeFile,
    bridge: fs.existsSync(path.join(dir, BRIDGE)),
    bitness: pe.getBitness(runtimeFile)
  };
}
function pickRuntime(gameDir, runtimeFiles) {
  const found = runtimeFiles.filter(isRuntimeFile)
    .map(file => describe(gameDir, file))
    .filter(item => item.bitness === 64)
    .sort((a, b) => a.rel.split(path.sep).length - b.rel.split(path.sep).length || a.rel.localeCompare(b.rel));
  return found[0] || null;
}

// A 150-230 MB file read in overlapping chunks, so a marker split across a
// boundary is still found. Only ever called for an install or a sheet.
function flavourOf(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  const markers = FLAVOURS.map(f => Buffer.from(f.marker, 'ascii'));
  const overlap = Math.max(...markers.map(m => m.length));
  const size = 4 * 1024 * 1024;
  const buffer = Buffer.alloc(size + overlap);
  const seen = new Set();
  try {
    let position = 0;
    let carry = 0;
    while (true) {
      const read = fs.readSync(fd, buffer, carry, size, position);
      if (!read) break;
      const view = buffer.subarray(0, carry + read);
      markers.forEach((marker, index) => { if (view.includes(marker)) seen.add(index); });
      if (seen.has(0)) break;
      position += read;
      carry = Math.min(overlap, view.length);
      view.copy(buffer, 0, view.length - carry);
    }
  } finally { fs.closeSync(fd); }
  // The neural-rendering name wins when a build carries both.
  for (let i = 0; i < FLAVOURS.length; i++) if (seen.has(i)) return FLAVOURS[i];
  return null;
}

function digest(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}
async function isPinnedRuntime(file, release = RELEASE) {
  const pinned = release.files.find(f => f.name === RUNTIME);
  try {
    if (fs.statSync(file).size !== pinned.size) return false;
    return (await digest(file)) === pinned.sha256;
  } catch { return false; }
}

async function ensureRuntime(cacheRoot, release = RELEASE) {
  const base = path.join(path.resolve(cacheRoot), 'components', `remix-${release.tag}`);
  for (const item of release.files) {
    const file = path.join(base, item.name);
    if (!cached(file, item.sha256)) await fetchVerified(item.url, item.sha256, file);
  }
  return base;
}
function validateRuntime(root, release = RELEASE) {
  for (const item of release.files) {
    const file = journal.safePath(root, item.name);
    if (pe.getBitness(file) !== 64) throw fail('errRemixPayload');
  }
}

// A runtime is only as good as the libraries beside it. The neural build was
// compiled against a newer Remix than Portal with RTX or Half-Life 2 RTX ship:
// it imports USD as usd_ar.dll, usd_sdf.dll and so on, plus libxess.dll, where
// those games carry one usd_ms.dll. Windows then refuses to load it, the bridge
// waits for a runtime that never arrives, and the game runs with no window and
// no error at all. So every import is checked before a single file moves.
function missingDependencies(runtimeFile, runtimeDir, {
  extra = [], systemRoot = process.env.SystemRoot, readImports = pe.getImports
} = {}) {
  let present;
  try { present = new Set(fs.readdirSync(runtimeDir).map(name => name.toLowerCase())); } catch { present = new Set(); }
  for (const name of extra) present.add(String(name).toLowerCase());
  const system = systemRoot ? path.join(systemRoot, 'System32') : null;
  return [...new Set((readImports(runtimeFile) || []).map(name => String(name).toLowerCase()))]
    .filter(name => !/^(?:api|ext)-ms-/.test(name))
    .filter(name => !present.has(name))
    .filter(name => !(system && fs.existsSync(path.join(system, name))));
}

// rtx.conf is read from beside the runtime's parent first, then from the game
// folder. It is also the file Remix's own menu saves into, so it is edited one
// line at a time and never restored wholesale over settings chosen since.
function configPath(gameDir, runtimeDir) {
  const candidates = [path.join(path.dirname(runtimeDir), CONFIG), path.join(gameDir, CONFIG)];
  return candidates.find(file => fs.existsSync(file)) || candidates[0];
}
const lineFor = key => new RegExp(`^\\s*${key.replace(/\./g, '\\.')}\\s*=`, 'i');
function eolOf(text) { return /\r\n/.test(text) ? '\r\n' : '\n'; }
function currentLine(text, key) {
  return String(text || '').split(/\r?\n/).find(line => lineFor(key).test(line)) ?? null;
}
function setLine(text, key, line) {
  const source = String(text || '');
  const eol = eolOf(source);
  const lines = source.length ? source.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out = [];
  let placed = false;
  for (const current of lines) {
    if (!lineFor(key).test(current)) { out.push(current); continue; }
    if (!placed && line !== null) out.push(line);
    placed = true;
  }
  if (!placed && line !== null) out.push(line);
  return out.length ? out.join(eol) + eol : '';
}
const enable = (text, key) => setLine(text, key, `${key} = True`);

async function install(config, log = () => {}) {
  const { beginManifest, copyTracked, saveActiveManifest } = require('./apply');
  const { gameDir, exePath, api, remix, remixRoot, source } = config;
  if (!remix || !fs.existsSync(remix.runtime)) throw fail('errRemixMissing');
  if (pe.getBitness(remix.runtime) !== 64) throw fail('errRemixRuntime');
  const trex = journal.safePath(gameDir, remix.rel);
  const model = source && source.payload && source.payload.find(f => f.name.toLowerCase() === MODEL);
  if (!model || pe.getBitness(model.path) !== 64) throw fail('errNoNeuralRuntime');

  const manifest = beginManifest(gameDir, exePath, api);
  manifest.route = 'remix';
  manifest.game.apiLabel = config.apiLabel;

  // The runtime. A mod that already ships a neural-capable build keeps it: it
  // may carry fixes of its own that a swap would take away.
  const runtimeFile = path.join(trex, RUNTIME);
  const pinned = await isPinnedRuntime(runtimeFile);
  let flavour = pinned ? FLAVOURS[0] : flavourOf(runtimeFile);
  let swapped = false;
  if (!flavour) {
    validateRuntime(remixRoot);
    const missing = missingDependencies(path.join(remixRoot, RUNTIME), trex, {
      extra: RELEASE.files.map(item => item.name), readImports: config.readImports
    });
    if (missing.length) {
      throw fail('errRemixDependencies', `${RELEASE.tag} needs ${missing.join(', ')}, which ${remix.rel} does not have. Nothing in the game was changed.`);
    }
    for (const item of RELEASE.files) {
      const rel = await copyTracked(manifest, gameDir, path.join(remixRoot, item.name), path.join(trex, item.name), { kind: 'remix' });
      log({ code: 'added', params: { rel } });
    }
    flavour = FLAVOURS[0];
    swapped = true;
    log({ code: 'remixRuntimeSwapped', params: { tag: RELEASE.tag } });
  } else {
    log({ code: 'remixRuntimeKept', params: { flavour: flavour.id } });
    // lunks' build cannot start its pass without the shim beside it.
    const shim = path.join(trex, 'remix_nvngx.dll');
    if (flavour.id === 'neuralRendering' && !fs.existsSync(shim)) {
      validateRuntime(remixRoot);
      await copyTracked(manifest, gameDir, path.join(remixRoot, 'remix_nvngx.dll'), shim, { kind: 'remix' });
    }
  }

  // The model. The runtime loads it from its own folder, bypassing the
  // driver's NGX loader. A model already there - a build for an older card,
  // supplied by its owner - is never overwritten.
  const modelDest = path.join(trex, MODEL);
  if (fs.existsSync(modelDest)) log({ code: 'neuralModelKept', params: { rel: path.relative(gameDir, modelDest) } });
  else await copyTracked(manifest, gameDir, model.path, modelDest, { kind: 'runtime', newVersion: model.version });

  // One line of rtx.conf, recorded so restore can put back exactly what was there.
  const conf = configPath(gameDir, trex);
  journal.safePath(gameDir, path.relative(gameDir, conf));
  const existed = fs.existsSync(conf);
  const before = existed ? fs.readFileSync(conf, 'utf8') : '';
  const previous = manifest.remix && manifest.remix.conf === path.relative(gameDir, conf)
    ? manifest.remix : { previousLine: currentLine(before, flavour.key), confCreated: !existed };
  manifest.remix = {
    tag: swapped ? RELEASE.tag : (manifest.remix && manifest.remix.tag) || null,
    runtime: remix.rel,
    swapped: swapped || Boolean(manifest.remix && manifest.remix.swapped),
    flavour: flavour.id,
    key: flavour.key,
    conf: path.relative(gameDir, conf),
    previousLine: previous.previousLine,
    confCreated: previous.confCreated
  };
  await saveActiveManifest(gameDir, manifest);
  await journal.capture(gameDir, conf);
  const after = enable(before, flavour.key);
  if (after !== before) {
    try { await fs.promises.chmod(conf, 0o666); } catch { /* absent is normal */ }
    await fs.promises.writeFile(conf, after, 'utf8');
  }
  log({ code: 'remixConfigured', params: { rel: manifest.remix.conf, key: flavour.key } });
  await saveActiveManifest(gameDir, manifest);
  return manifest;
}

// Called by restore after the runtime files are back. Only our line changes.
async function unconfigure(gameDir, manifest, log = () => {}) {
  const info = manifest && manifest.remix;
  if (!info || !info.conf || !info.key) return;
  const conf = journal.safePath(gameDir, info.conf);
  if (!fs.existsSync(conf)) return;
  const before = fs.readFileSync(conf, 'utf8');
  const after = setLine(before, info.key, info.previousLine ?? null);
  await journal.capture(gameDir, conf);
  if (info.confCreated && !after.trim()) {
    await fs.promises.unlink(conf);
    log({ code: 'deleted', params: { rel: info.conf } });
  } else if (after !== before) {
    await fs.promises.writeFile(conf, after, 'utf8');
    log({ code: 'restored', params: { rel: info.conf, version: null, kind: 'config' } });
  }
}

// Installed means: the runtime is neural-capable, the model and (for lunks'
// build) its shim are beside it, and rtx.conf still turns the pass on.
function installedState(gameDir, data) {
  const info = data && data.remix;
  if (!info) return null;
  try {
    const trex = journal.safePath(gameDir, info.runtime);
    const conf = journal.safePath(gameDir, info.conf);
    const line = fs.existsSync(conf) ? currentLine(fs.readFileSync(conf, 'utf8'), info.key) : null;
    const files = [RUNTIME, MODEL, ...(info.flavour === 'neuralRendering' ? ['remix_nvngx.dll'] : [])];
    return {
      ...info,
      installed: files.every(name => fs.existsSync(path.join(trex, name))) && Boolean(line && /=\s*true\s*$/i.test(line))
    };
  } catch { return { ...info, installed: false }; }
}

module.exports = {
  RELEASE, RELEASES, FLAVOURS, isRuntimeFile, pickRuntime, flavourOf, isPinnedRuntime, missingDependencies,
  ensureRuntime, validateRuntime, configPath, currentLine, setLine, enable,
  install, unconfigure, installedState
};
