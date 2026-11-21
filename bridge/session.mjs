/**
 * Conversa multi-turno com o Claude através do Agent SDK.
 *
 * Nesta fase nenhuma ação está habilitada: o Claude não recebe ferramentas
 * (`tools: []`), não usa hooks das configurações do usuário
 * (`disableAllHooks`) e toda permissão pedida é negada (`canUseTool`).
 * Lê só as configurações do usuário (`settingSources: ['user']`) para
 * encontrar o login (`apiKeyHelper`). Projeto e local ficam de fora.
 * A política de segurança real entra na fase 2.
 */

/** Mensagem devolvida ao Claude quando ele tenta usar uma ferramenta. */
export const DENIED_MESSAGE = 'Nenhuma ação está habilitada nesta fase.';

/**
 * Opções fixas da conversa. Função pura para que os testes possam conferi-las.
 *
 * @param {string} cwd diretório de trabalho da sessão
 * @returns {Record<string, unknown>}
 */
export function baseOptions(cwd) {
  return {
    cwd,
    settingSources: ['user'],
    settings: { disableAllHooks: true },
    tools: [],
    canUseTool: async () => ({ behavior: 'deny', message: DENIED_MESSAGE }),
  };
}

/**
 * Fila assíncrona que alimenta o `prompt` em modo streaming do SDK.
 * Cada `push` vira uma mensagem de usuário; `close` encerra a entrada.
 */
export function createInbox() {
  /** @type {unknown[]} */
  const items = [];
  /** @type {((r: IteratorResult<unknown>) => void) | null} */
  let waiting = null;
  let closed = false;

  return {
    /** @param {unknown} item */
    push(item) {
      if (closed) throw new Error('Entrada fechada.');
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: item, done: false });
      } else {
        items.push(item);
      }
    },
    close() {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
      };
    },
  };
}

/**
 * Abre uma conversa com o Claude.
 *
 * @param {object} args
 * @param {(input: any) => AsyncIterable<any> & { close?: () => void }} args.query
 *   função `query` do SDK (injetável nos testes)
 * @param {string} args.cwd
 * @param {(message: unknown) => void} args.onMessage recebe cada mensagem do SDK
 * @param {() => void} [args.onEnd] chamado quando o fluxo termina ou falha
 * @returns {{ send: (text: string) => void, close: () => void }}
 */
export function createConversation({ query, cwd, onMessage, onEnd }) {
  const inbox = createInbox();
  const stream = query({ prompt: inbox, options: baseOptions(cwd) });

  (async () => {
    try {
      for await (const message of stream) onMessage(message);
    } catch (err) {
      onMessage({
        type: 'bridge_error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inbox.close();
      onEnd?.();
    }
  })();

  return {
    send(text) {
      inbox.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
      });
    },
    close() {
      inbox.close();
      stream.close?.();
    },
  };
}
