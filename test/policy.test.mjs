import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { blockedAddress, vetTarget, fetchTargetProblem } from '../bridge/net.mjs';
import {
  isWrite,
  decideTool,
  pathProblem,
  fileRoots,
  checkToolUse,
  preToolUseHook,
} from '../bridge/policy.mjs';

/** Pasta de trabalho temporária, real, para os testes de caminho. */
function workspace() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-ws-')));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.txt'), 'ok');
  return dir;
}

/** Resolvedor falso de DNS: devolve os endereços dados. */
const resolvesTo = (...addresses) => async () => addresses.map((address) => ({ address }));

test('ferramentas de leitura passam; escrita e desconhecidas são barradas', () => {
  assert.equal(isWrite('Read'), false);
  assert.equal(isWrite('WebFetch'), false);
  assert.equal(isWrite('Bash'), true);
  assert.equal(isWrite('Write'), true);
  assert.equal(isWrite('ferramenta_nova'), true, 'nome desconhecido conta como escrita');
  assert.equal(decideTool('Read'), true);
  assert.equal(decideTool('Bash'), false);
  assert.equal(decideTool('Bash', { allowWrites: true }), true);
});

test('caminho dentro da pasta de trabalho é permitido', () => {
  const cwd = workspace();
  const roots = fileRoots({ workspace: cwd });
  assert.equal(pathProblem('src/a.txt', { cwd, roots }), null);
  assert.equal(pathProblem(join(cwd, 'src', 'a.txt'), { cwd, roots }), null);
});

test('caminho fora das pastas permitidas é barrado', () => {
  const cwd = workspace();
  const roots = fileRoots({ workspace: cwd });
  assert.match(pathProblem('../../../../etc/hosts', { cwd, roots }), /fora das pastas/);
});

test('arquivos e pastas de credenciais são barrados mesmo dentro da raiz', () => {
  const cwd = workspace();
  const roots = [realpathSync(homedir())]; // raiz larga, como JARVIS_FILE_ROOTS faria
  assert.match(pathProblem('~/.ssh/id_ed25519', { cwd, roots }), /credenciais/);
  assert.match(pathProblem('~/.aws/credentials', { cwd, roots }), /credenciais/);

  const inWs = fileRoots({ workspace: cwd });
  writeFileSync(join(cwd, '.env'), 'X=1');
  assert.match(pathProblem('.env', { cwd, roots: inWs }), /credenciais/);
  writeFileSync(join(cwd, 'chave.pem'), 'x');
  assert.match(pathProblem('chave.pem', { cwd, roots: inWs }), /credenciais/);
});

test('link simbólico que sai da pasta é barrado', () => {
  const cwd = workspace();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-out-')));
  writeFileSync(join(outside, 'segredo.txt'), 'x');
  symlinkSync(outside, join(cwd, 'atalho'));
  const roots = [cwd];
  assert.match(pathProblem('atalho/segredo.txt', { cwd, roots }), /fora das pastas/);
});

test('endereços privados, loopback, metadados e mapeados são bloqueados', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) {
    assert.equal(blockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
    assert.equal(blockedAddress(ip), false, ip);
  }
});

test('vetTarget recusa esquema, host local e IP privado', () => {
  assert.throws(() => vetTarget('file:///etc/passwd'), { status: 400 });
  assert.throws(() => vetTarget('http://printer.local/'), { status: 403 });
  assert.throws(() => vetTarget('http://127.0.0.1:8787/health'), { status: 403 });
  assert.throws(() => vetTarget('http://169.254.169.254/latest'), { status: 403 });
  assert.equal(vetTarget('https://example.com/a').hostname, 'example.com');
});

test('fetchTargetProblem pega nome público que resolve para endereço privado', async () => {
  const problem = await fetchTargetProblem('https://exemplo.com/x', resolvesTo('127.0.0.1'));
  assert.match(problem, /endereço privado 127\.0\.0\.1/);
  assert.equal(await fetchTargetProblem('https://exemplo.com/x', resolvesTo('93.184.216.34')), null);
  assert.match(await fetchTargetProblem('http://[::1]/', resolvesTo()), /bloqueado/);
});

test('checkToolUse: escrita e arquivo fora são recusados com motivo', async () => {
  const cwd = workspace();
  const roots = fileRoots({ workspace: cwd });
  const write = await checkToolUse('Write', { file_path: 'novo.txt' }, { cwd, roots });
  assert.equal(write.allow, false);
  assert.match(write.reason, /não faz ações que mudem algo/);

  const read = await checkToolUse('Read', { file_path: 'src/a.txt' }, { cwd, roots });
  assert.deepEqual(read, { allow: true });

  const outside = await checkToolUse('Read', { file_path: '/etc/hosts' }, { cwd, roots });
  assert.equal(outside.allow, false);
});

test('checkToolUse: WebFetch para endereço privado é recusado', async () => {
  const cwd = workspace();
  const roots = fileRoots({ workspace: cwd });
  const verdict = await checkToolUse('WebFetch', { url: 'http://127.0.0.1:8787/' }, { cwd, roots });
  assert.equal(verdict.allow, false);
});

test('hook PreToolUse devolve deny com motivo, ou {} quando permite', async () => {
  const cwd = workspace();
  const roots = fileRoots({ workspace: cwd });
  const hook = preToolUseHook({ cwd, roots, resolve: resolvesTo('8.8.8.8') });

  const denied = await hook({ tool_name: 'Bash', tool_input: { command: 'cat ~/.ssh/id_rsa' } });
  assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Bloqueado/);

  assert.deepEqual(await hook({ tool_name: 'Read', tool_input: { file_path: 'src/a.txt' } }), {});
});
