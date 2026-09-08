'use strict';

const $ = (id) => document.getElementById(id);

const drop = $('drop');
const dropEmpty = $('dropEmpty');
const dropFilled = $('dropFilled');
const appIcon = $('appIcon');
const appNameEl = $('appName');
const appIdEl = $('appId');
const appBadge = $('appBadge');
const configCard = $('configCard');
const nameEl = $('name');
const nameHint = $('nameHint');
const isolateEl = $('isolate');
const stripEl = $('stripSchemes');
const desktopEl = $('desktop');
const modeRow = $('modeRow');
const modeLink = $('modeLink');
const cloneBtn = $('clone');
const cloneLabel = cloneBtn.querySelector('.btn-label');
const resultCard = $('result');
const resultIcon = $('resultIcon');
const resultText = $('resultText');
const doneActions = $('doneActions');
const logEl = $('log');

let selected = null; // { path, name, bundleId, isElectron, icon }
let clonedName = null;
let clonedDest = null;
let plat = { isWindows: false, isMac: true, extension: '.app' };

// ---------- platform ----------

// The two platforms differ enough in vocabulary and options that the UI adapts
// rather than showing macOS wording to Windows users.
async function initPlatform() {
  try {
    plat = await window.dualizer.getPlatform();
  } catch {
    return;
  }
  if (!plat.isWindows) return;

  $('tagline').textContent =
    'Run two independent copies of a Windows app — separate data, separate login.';
  $('dropHint').innerHTML = 'Drag a program here <span>or</span>';
  $('browse').textContent = 'Browse Programs…';
  $('reveal').textContent = 'Show in Explorer';
  modeRow.classList.remove('hidden');
  $('desktopOpt').classList.remove('hidden');
  $('stripOpt').classList.add('hidden'); // URL schemes are registry-based on Windows
  syncMode();
}

// In shortcut-only mode nothing is copied, so there is no app.asar to inject.
function syncMode() {
  if (!plat.isWindows) return;
  const link = modeLink.checked;
  isolateEl.disabled = link;
  isolateEl.parentElement.classList.toggle('is-disabled', link);
}

if (modeRow) {
  modeRow.addEventListener('change', syncMode);
}
initPlatform();

// ---------- selection ----------

function select(app) {
  if (!app) return;
  selected = app;
  if (app.icon) appIcon.src = app.icon;
  appNameEl.textContent = app.name;
  appIdEl.textContent = app.bundleId || app.version || 'unknown identifier';
  if (app.isElectron && app.hasAsarIntegrity) {
    // We cannot patch such an app, so isolation comes from the shortcut alone.
    appBadge.textContent = 'Electron · isolated via shortcut';
    appBadge.className = 'badge electron';
  } else if (app.isElectron) {
    appBadge.textContent = 'Electron · full isolation';
    appBadge.className = 'badge electron';
  } else {
    appBadge.textContent = plat.isWindows ? 'Not Electron · limited' : 'Native · identity only';
    appBadge.className = 'badge native';
  }

  dropEmpty.classList.add('hidden');
  dropFilled.classList.remove('hidden');
  configCard.classList.remove('is-disabled');

  if (!nameEl.value.trim()) nameEl.value = `${app.name} 2`;
  nameEl.focus();
  validate();
}

function reset() {
  selected = null;
  dropFilled.classList.add('hidden');
  dropEmpty.classList.remove('hidden');
  configCard.classList.add('is-disabled');
  cloneBtn.disabled = true;
}

$('browse').addEventListener('click', async () => {
  select(await window.dualizer.pickApp());
});
$('change').addEventListener('click', reset);

// ---------- drag & drop ----------

['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
  })
);
drop.addEventListener('drop', async (e) => {
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const p = file.path || '';
  if (!p.toLowerCase().endsWith(plat.extension)) {
    flashHint(
      plat.isWindows
        ? 'That doesn’t look like a program (.exe).'
        : 'That doesn’t look like an .app bundle.'
    );
    return;
  }
  const info = await window.dualizer.inspectApp(p);
  if (!info) {
    flashHint('Could not read that app.');
    return;
  }
  select(info);
});

// ---------- validation ----------

nameEl.addEventListener('input', validate);

function validate() {
  const name = nameEl.value.trim();
  let msg = '';
  if (name && /["'\\]/.test(name)) msg = 'Name can’t contain quotes or backslashes.';
  else if (name && selected && name === selected.name) msg = 'Pick a different name than the original.';
  nameHint.textContent = msg;
  nameHint.classList.toggle('err', !!msg);
  cloneBtn.disabled = !(selected && name && !msg);
  return !cloneBtn.disabled;
}

function flashHint(text) {
  nameHint.textContent = text;
  nameHint.classList.add('err');
}

// ---------- clone ----------

cloneBtn.addEventListener('click', async () => {
  if (!validate()) return;
  const name = nameEl.value.trim();
  clonedName = name;

  cloneBtn.classList.add('busy');
  cloneBtn.disabled = true;
  cloneLabel.textContent = 'Cloning…';
  resultCard.classList.add('hidden');
  logEl.textContent = '';

  const result = await window.dualizer.cloneApp({
    source: selected.path,
    name,
    isolate: isolateEl.checked,
    stripSchemes: stripEl.checked,
    mode: plat.isWindows && modeLink.checked ? 'link' : 'clone',
    desktop: plat.isWindows && desktopEl.checked,
  });

  cloneBtn.classList.remove('busy');
  cloneLabel.textContent = 'Clone app';
  cloneBtn.disabled = false;

  resultCard.classList.remove('hidden');
  const notes = $('resultNotes');
  notes.classList.add('hidden');
  notes.textContent = '';

  if (result.ok) {
    resultIcon.textContent = '✓';
    resultIcon.className = 'result-badge ok';
    resultText.textContent = `"${name}" is ready.`;
    doneActions.classList.remove('hidden');
    clonedDest = result.dest || null;
    // Link mode copies nothing, so there is no clone folder to reveal.
    $('reveal').classList.toggle('hidden', plat.isWindows && !clonedDest);
    if (result.warnings && result.warnings.length) {
      notes.textContent = result.warnings.join(' · ');
      notes.classList.remove('hidden');
    }
  } else {
    resultIcon.textContent = '✕';
    resultIcon.className = 'result-badge err';
    resultText.textContent = `Clone failed (exit ${result.code}).${result.error ? ' ' + result.error : ''}`;
    doneActions.classList.add('hidden');
  }
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'end' });
});

$('launch').addEventListener('click', () => {
  if (clonedName) window.dualizer.launchApp(clonedName);
});
$('reveal').addEventListener('click', () => {
  if (clonedDest) {
    window.dualizer.revealApp(clonedDest);
  } else if (selected && clonedName && !plat.isWindows) {
    const dir = selected.path.slice(0, selected.path.lastIndexOf('/'));
    window.dualizer.revealApp(`${dir}/${clonedName}.app`);
  }
});

// ---------- log ----------

window.dualizer.onLog((line) => {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  logEl.textContent += line;
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
});
