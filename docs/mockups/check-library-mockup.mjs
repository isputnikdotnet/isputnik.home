// Browser-only verification of the standalone mock. Never connects to the app or DB.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const base = path.join(import.meta.dirname, 'library-control-panel');
const screenshots = path.join(import.meta.dirname, 'library-control-panel-preview');
fs.mkdirSync(screenshots, { recursive: true });
const executable = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
if (!executable) throw new Error('A local Chrome or Edge installation is required.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'isputnik-mock-qa-'));
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-extensions', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
let serial = 0;
const errors = [];
const pending = new Map();
function send(method, params = {}) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function capture(name) {
  await evaluate('document.querySelector("#toast").classList.remove("visible")');
  await sleep(150);
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(screenshots, `${name}.png`), Buffer.from(result.data, 'base64'));
}
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i=0;i<80&&!fs.existsSync(portFile);i++) await sleep(150);
  if (!fs.existsSync(portFile)) throw new Error('Browser did not start.');
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(x => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1160, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: pathToFileURL(path.join(base, 'dist/index.html')).href });
  for (let i=0;i<40;i++) { if (await evaluate('Boolean(document.querySelector("h1"))')) break; await sleep(100); }
  assert.equal(await evaluate('document.querySelector("h1").textContent'), 'Libraries');
  for (const page of ['libraries', 'organization', 'device-sync', 'storage', 'contents']) {
    await evaluate(`location.hash=${JSON.stringify(page)}`); await sleep(150);
    assert.equal(await evaluate('document.querySelector("[aria-current=page]").dataset.page'), page);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Desktop overflow: ${page}`);
    await capture(page);
  }
  await evaluate('location.hash="libraries"'); await sleep(150);
  assert.equal(await evaluate('document.querySelectorAll("#library-rows tr").length'), 5);
  await evaluate('document.querySelector("#library-type").value="Video";document.querySelector("#library-type").dispatchEvent(new Event("change"))');
  assert.equal(await evaluate('document.querySelectorAll("#library-rows tr").length'), 2);
  await evaluate('document.querySelector("[data-action=manage]").click()');
  assert.equal(await evaluate('document.querySelector("dialog").open'), true);
  assert.equal(await evaluate('document.querySelector("#dialog-title").textContent'), 'Movies');
  await capture('manage-library');
  await evaluate('document.querySelector("dialog").close();location.hash="device-sync"'); await sleep(150);
  await evaluate('document.querySelector("[data-action=personal-settings]").click()');
  await capture('device-sync-settings');
  await evaluate('document.querySelector("#sync-quota").value="150";document.querySelector("#dialog-save").click()'); await sleep(150);
  assert.equal(await evaluate('document.querySelector(".setting-row .value").textContent.includes("150 GB")'), true);
  await evaluate('location.hash="storage"'); await sleep(100);
  await evaluate('document.querySelector("details.advanced").open=true');
  assert.equal(await evaluate('document.querySelector("details.advanced").open'), true);
  await evaluate('location.hash="contents"'); await sleep(100);
  await evaluate('document.querySelector("#contents-filter").value="orphan";document.querySelector("#contents-filter").dispatchEvent(new Event("change"))');
  assert.equal(await evaluate('document.querySelectorAll("#file-rows tr").length'), 1);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const page of ['libraries', 'organization', 'device-sync', 'storage', 'contents']) {
    await evaluate(`location.hash=${JSON.stringify(page)}`); await sleep(150);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Mobile overflow: ${page}`);
    await capture(`${page}-mobile`);
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS: five desktop/mobile pages, navigation, filtering, dialogs, settings save, storage expansion, orphan filter; no JS errors.');
  console.log(`Screenshots: ${screenshots}`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); socket.close(); }
  browser.kill();
}
