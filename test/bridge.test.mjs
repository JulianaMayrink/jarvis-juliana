import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startBridge } from '../bridge/server.mjs';
import { baseOptions, DENIED_MESSAGE } from '../bridge/session.mjs';

/**
 * `query` falso: para cada mensagem do usuário responde com um eco e um
 * resultado, sem falar com o Claude de verdade.
 */
function fakeQuery(captured = []) {
  return ({ prompt, options }) => {
    captured.push({ options });
    const stream = (async function* () {
      for await (const msg of prompt) {
        const text = msg.message.content;
        yield { type: 'assistant', message: { content: [{ type: 'text', text: `eco: ${text}` }] } };
        yield { type: 'result', subtype: 'success', result: text };
      }
    })();
    return Object.assign(stream, { close() {} });
  };
}

/** Requisição HTTP crua, para controlar Host e Origin. */
function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Abre /events e devolve um leitor de eventos SSE. */
function openEvents(port) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      const events = [];
      let buffer = '';
      let waiter = null;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            events.push(JSON.parse(line.slice(6)));
            if (waiter) waiter();
          }
        }
      });
      resolve({
        next(predicate, timeoutMs = 2000) {
          return new Promise((res2, rej) => {
            const timer = setTimeout(() => rej(new Error('tempo esgotado')), timeoutMs);
            const check = () => {
              const found = events.find(predicate);
              if (found) {
                clearTimeout(timer);
                waiter = null;
                res2(found);
              } else {
                waiter = check;
              }
            };
            check();
          });
        },
        close() {
          req.destroy();
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const json = (text) => ({
  method: 'POST',
  path: '/ask',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text }),
});

test('health responde ok em 127.0.0.1', async (t) => {
  const bridge = await startBridge({ query: fakeQuery(), port: 0 });
  t.after(() => bridge.close());
  const res = await call(bridge.port, { path: '/health' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test('POST /ask envia o texto à conversa e o eco chega por /events', async (t) => {
  const bridge = await startBridge({ query: fakeQuery(), port: 0 });
  t.after(() => bridge.close());
  const events = await openEvents(bridge.port);
  t.after(() => events.close());

  const res = await call(bridge.port, json('oi jarvis'));
  assert.equal(res.status, 202);

  const result = await events.next((e) => e.type === 'result');
  assert.equal(result.result, 'oi jarvis');
});

test('a mesma conversa mantém várias mensagens em sequência', async (t) => {
  const captured = [];
  const bridge = await startBridge({ query: fakeQuery(captured), port: 0 });
  t.after(() => bridge.close());
  const events = await openEvents(bridge.port);
  t.after(() => events.close());

  await call(bridge.port, json('primeira'));
  await events.next((e) => e.type === 'result' && e.result === 'primeira');
  await call(bridge.port, json('segunda'));
  await events.next((e) => e.type === 'result' && e.result === 'segunda');

  assert.equal(captured.length, 1, 'uma única chamada a query() para a conversa');
});

test('a conversa nasce sem ferramentas e nega qualquer permissão', async (t) => {
  const captured = [];
  const bridge = await startBridge({ query: fakeQuery(captured), port: 0 });
  t.after(() => bridge.close());
  await call(bridge.port, json('teste'));

  const { options } = captured[0];
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, ['user']);
  assert.deepEqual(options.settings, { disableAllHooks: true });
  const decision = await options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal });
  assert.deepEqual(decision, { behavior: 'deny', message: DENIED_MESSAGE });
});

test('baseOptions é fixo: lê só o usuário, sem hooks e sem ferramentas', () => {
  const options = baseOptions('/tmp/x');
  assert.equal(options.cwd, '/tmp/x');
  assert.deepEqual(options.settingSources, ['user']);
  assert.deepEqual(options.settings, { disableAllHooks: true });
  assert.deepEqual(options.tools, []);
});

test('rejeita Host estranho (DNS rebinding)', async (t) => {
  const bridge = await startBridge({ query: fakeQuery(), port: 0 });
  t.after(() => bridge.close());
  const res = await call(bridge.port, { path: '/health', headers: { host: 'evil.example' } });
  assert.equal(res.status, 403);
});

test('rejeita Origin que não é da interface', async (t) => {
  const bridge = await startBridge({ query: fakeQuery(), port: 0 });
  t.after(() => bridge.close());
  const res = await call(bridge.port, {
    ...json('oi'),
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
});

test('aceita Origin da interface em dev', async (t) => {
  const bridge = await startBridge({ query: fakeQuery(), port: 0 });
  t.after(() => bridge.close());
  const res = await call(bridge.port, {
    ...json('oi'),
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
  });
  assert.equal(res.status, 202);
});

test('rejeita POST que não é application/json', async (t) => {
  const bridge = await startBridge({ query: fakeQuery(), port: 0 });
  t.after(() => bridge.close());
  const res = await call(bridge.port, {
    method: 'POST',
    path: '/ask',
    headers: { 'content-type': 'text/plain' },
    body: '{"text":"oi"}',
  });
  assert.equal(res.status, 415);
});

test('rejeita texto vazio e JSON inválido', async (t) => {
  const bridge = await startBridge({ query: fakeQuery(), port: 0 });
  t.after(() => bridge.close());
  const empty = await call(bridge.port, json('   '));
  assert.equal(empty.status, 400);
  const broken = await call(bridge.port, {
    method: 'POST',
    path: '/ask',
    headers: { 'content-type': 'application/json' },
    body: '{nao-json',
  });
  assert.equal(broken.status, 400);
});

test('rejeita texto acima do limite', async (t) => {
  const bridge = await startBridge({ query: fakeQuery(), port: 0 });
  t.after(() => bridge.close());
  const res = await call(bridge.port, json('a'.repeat(4001)));
  assert.equal(res.status, 400);
});

test('rota desconhecida dá 404', async (t) => {
  const bridge = await startBridge({ query: fakeQuery(), port: 0 });
  t.after(() => bridge.close());
  const res = await call(bridge.port, { path: '/nada' });
  assert.equal(res.status, 404);
});

test('erro da conversa vira evento bridge_error e a próxima mensagem abre outra', async (t) => {
  let calls = 0;
  const failing = ({ prompt }) => {
    calls += 1;
    const stream = (async function* () {
      for await (const msg of prompt) {
        if (msg.message.content === 'quebra') throw new Error('falhou de propósito');
        yield { type: 'result', subtype: 'success', result: msg.message.content };
      }
    })();
    return Object.assign(stream, { close() {} });
  };
  const bridge = await startBridge({ query: failing, port: 0 });
  t.after(() => bridge.close());
  const events = await openEvents(bridge.port);
  t.after(() => events.close());

  await call(bridge.port, json('quebra'));
  const err = await events.next((e) => e.type === 'bridge_error');
  assert.equal(err.message, 'falhou de propósito');

  await call(bridge.port, json('de novo'));
  await events.next((e) => e.type === 'result' && e.result === 'de novo');
  assert.equal(calls, 2);
});

test('sempre escuta em 127.0.0.1', async () => {
  // A API não expõe `host`: o servidor sempre sobe em 127.0.0.1.
  const bridge = await startBridge({ query: fakeQuery(), port: 0 });
  try {
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await bridge.close();
  }
});
