/** Compiled client in a browser fixture; no live Host or model calls. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { SliceSessionStore } from '../../packages/dsh-slides-host/dist/slice-session.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const root = resolve(import.meta.dirname, '..');
const { launchPinnedChromium } = await import(pathToFileURL(resolve(homedir(), '.codex/playwright-runtime/runtime.mjs')));
const source = await readFile(resolve(root, 'lib/client.js'), 'utf8');
const react = await readFile(resolve(root, 'node_modules/react/umd/react.production.min.js'), 'utf8');
const reactDOM = await readFile(resolve(root, 'node_modules/react-dom/umd/react-dom.production.min.js'), 'utf8');
const escapeScript = value => value.replaceAll('</script', '<\\/script');

test('Work history has no prompt box; its action opens the exact deck with and without Personal', async () => {
  const scratch = mkdtempSync(resolve(tmpdir(), 'slides-history-'));
  const store = new SliceSessionStore(scratch);
  const { binding } = store.openProject({ dshSessionId: 'deck-session', title: 'History fixture', design: { kind: 'self-directed' }, provider: { providerId: 'test', modelId: 'test' } });
  const realState = store.inspect('deck-session');
  const browser = await launchPinnedChromium();
  const out = resolve(root, '.local/session-entry-test');
  await mkdir(out, { recursive: true });
  try {
    for (const personal of [true, false]) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('http://slidestudio.test/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/slides/state/')) return route.fulfill({ json: realState });
        if (url.pathname.startsWith('/app/')) return route.fulfill({ body: '<h1>Exact deck fixture</h1>', contentType: 'text/html' });
        return route.fulfill({ body: `<!doctype html><meta charset="utf-8"><div id="root"></div><script>${escapeScript(react)}</script><script>${escapeScript(reactDOM)}</script><script>
        window.__ModuleLoader__={load:({factory})=>window.plugin=factory(name=>name==='react'?React:{jsx:React.createElement,jsxs:React.createElement})};
        </script><script>${escapeScript(source)}</script><script>
        const h=React.createElement,entries=[],listeners=new Set(); let version=0,current='deck-session',opened=null,panel=null;
        const list={getSnapshot:()=>({byId:{'deck-session':{projectionValues:{agentPreset:'slides'}},ordinary:{projectionValues:{agentPreset:'standard'}}}}),subscribe:fn=>()=>{}};
        const personal=${personal}?{register:()=>()=>{},open:id=>{opened=id;notify();return true}}:undefined;
        const notify=()=>{version++;listeners.forEach(fn=>fn())};
        const ctx={get:name=>name==='sessions'?{list}:name==='personal'?personal:name==='layout'?{selectPanel:id=>{panel=id;notify()}}:undefined,
        effect:fn=>fn(),inject:(deps,fn)=>{if(deps[0]==='sessions'||deps[0]==='personal'&&personal)fn({...ctx,personal})},
        slots:{inject:(name,fn)=>fn(),register:(options,component)=>{const e={options,component};entries.push(e);return()=>entries.splice(entries.indexOf(e),1)}}};
        plugin.apply(ctx);
        function App(){React.useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>version);const e=entries.find(e=>e.options.name==='conversation.composer'&&e.options.select({sessionId:current}));const main=entries.find(e=>e.options.name==='main');return h('main',null,h('h1',null,'Work history fixture'),h('button',{onClick:()=>{current='ordinary';notify()}},'Ordinary session'),e?h(e.component,{matched:current}):h('textarea',{'aria-label':'Normal prompt'}),(opened||panel)&&h(main.component));}
        ReactDOM.createRoot(document.getElementById('root')).render(h(App));
        window.inspect=()=>({opened,panel,entries:entries.map(e=>e.options.name)});
        </script>`, contentType: 'text/html' });
      });
      await page.goto('http://slidestudio.test/');
      await page.getByRole('button', { name: '在演示文稿中继续' }).waitFor();
      assert.equal(await page.getByRole('textbox').count(), 0);
      await page.getByRole('button', { name: '在演示文稿中继续' }).click();
      await page.frameLocator('iframe').getByRole('heading', { name: 'Exact deck fixture' }).waitFor();
      const src = await page.locator('iframe').getAttribute('src');
      const url = new URL(src, 'http://slidestudio.test');
      assert.equal(url.searchParams.get('session'), 'deck-session');
      assert.equal(url.searchParams.get('project'), binding.projectRoot);
      const state = await page.evaluate(() => window.inspect());
      assert.equal(personal ? state.opened : state.panel, 'slides');
      await page.screenshot({ path: resolve(out, `history-${personal ? 'personal' : 'standalone'}.png`) });
      await page.getByRole('button', { name: 'Ordinary session' }).click();
      await page.getByRole('textbox', { name: 'Normal prompt' }).fill('Work still editable');
      assert.equal(await page.getByRole('button', { name: '在演示文稿中继续' }).count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
    await writeFile(resolve(out, 'result.json'), JSON.stringify({ fixtureOnly: true, personal: 'pass', standalone: 'pass', workEditable: 'pass' }, null, 2));
  } finally { await browser.close(); rmSync(scratch, { recursive: true, force: true }); }
});
