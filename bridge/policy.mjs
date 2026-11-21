/**
 * Política do que o Claude pode fazer, decidida em um lugar só.
 *
 * Duas camadas:
 *   decideTool(nome)                  — pelo nome da ferramenta: leitura ou escrita.
 *   checkToolUse(nome, entrada, opts) — o mesmo, mais os argumentos: para onde
 *                                       um arquivo aponta e para onde uma busca vai.
 *
 * A aplicação é feita pelo hook PreToolUse (ver preToolUseHook), que enxerga
 * toda chamada antes de ela rodar, mesmo as que a CLI aprova sozinha. O
 * canUseTool continua como segunda barreira.
 */

import { realpathSync, lstatSync, readlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { fetchTargetProblem } from './net.mjs';

/**
 * Ferramentas que só olham. Qualquer outro nome (Bash, Write, Edit, ferramentas
 * desconhecidas) conta como escrita: na dúvida, bloqueia.
 */
export const READ_ONLY_BUILTINS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'ToolSearch',
]);

/**
 * Se a chamada muda algo.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isWrite(name) {
  return !READ_ONLY_BUILTINS.has(name);
}

/**
 * Se a ferramenta pode rodar, sem olhar os argumentos.
 *
 * @param {string} name
 * @param {{ allowWrites?: boolean }} [opts]
 * @returns {boolean}
 */
export function decideTool(name, { allowWrites = false } = {}) {
  return !isWrite(name) || allowWrites;
}

/** Campo que carrega o caminho, por ferramenta. */
const PATH_FIELDS = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
};

/**
 * Pastas que guardam credenciais. Recusadas mesmo dentro de uma raiz permitida.
 */
const SECRET_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.claude', '.config/gh', '.config/gcloud'];
const SECRET_FILES = /^(\.env(\..*)?|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.claude\.json|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|kdbx))$/i;

/**
 * realpath da parte mais funda de `p` que existe, com o resto recolocado.
 * Segue links simbólicos quebrados à mão: um Write por eles cairia no alvo.
 * Retorna null se houver um laço de links.
 */
function resolveReal(p, hops = 0) {
  let head = p;
  const tail = [];
  for (;;) {
    try {
      return resolvePath(realpathSync(head), ...tail.reverse());
    } catch {
      let link = false;
      try {
        link = lstatSync(head).isSymbolicLink();
      } catch {
        /* não existe nada aqui */
      }
      if (link) {
        if (hops >= 40) return null;
        const target = resolvePath(dirname(head), readlinkSync(head));
        return resolveReal(resolvePath(target, ...tail.reverse()), hops + 1);
      }
      const up = dirname(head);
      if (up === head) return p;
      tail.push(basename(head));
      head = up;
    }
  }
}

/** `target` está dentro de `root`? */
const inside = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Pastas que as ferramentas de arquivo podem tocar: a pasta de trabalho e a
 * pasta temporária.
 *
 * @param {{ workspace: string, extra?: string[] }} args
 * @returns {string[]}
 */
export function fileRoots({ workspace, extra = [] }) {
  return [workspace, tmpdir(), '/tmp', ...extra]
    .filter(Boolean)
    .map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return resolvePath(root);
      }
    });
}

/**
 * Por que `target` não pode ser tocado, ou null se pode.
 *
 * @param {unknown} target
 * @param {{ cwd: string, roots: string[] }} opts
 * @returns {string | null}
 */
export function pathProblem(target, { cwd, roots }) {
  if (typeof target !== 'string' || !target) return null;
  const expanded = target.startsWith('~') ? homedir() + target.slice(1) : target;
  const real = resolveReal(resolvePath(cwd, expanded));
  if (!real) return `${target} não pode ser resolvido`;
  if (!roots.some((root) => inside(root, real))) {
    return `${target} está fora das pastas que o JARVIS pode usar`;
  }
  const home = realpathSync(homedir());
  if (inside(home, real)) {
    // Minúsculas: em volume sem diferença de caixa, ~/.SSH é ~/.ssh.
    const rel = relative(home, real).split(sep).join('/').toLowerCase();
    if (SECRET_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) {
      return `${target} guarda credenciais`;
    }
  }
  if (SECRET_FILES.test(basename(real))) return `${target} guarda credenciais`;
  return null;
}

/**
 * Decisão completa para uma chamada: primeiro o nome, depois os argumentos.
 *
 * @param {string} name
 * @param {unknown} input
 * @param {{ allowWrites?: boolean, cwd: string, roots: string[], resolve?: Function }} opts
 * @returns {Promise<{ allow: true } | { allow: false, reason: string }>}
 */
export async function checkToolUse(name, input, { allowWrites = false, cwd, roots, resolve }) {
  if (!decideTool(name, { allowWrites })) {
    return {
      allow: false,
      reason: 'Bloqueado: nesta fase o JARVIS não faz ações que mudem algo.',
    };
  }
  for (const field of PATH_FIELDS[name] ?? []) {
    const problem = pathProblem(input?.[field], { cwd, roots });
    if (problem) return { allow: false, reason: `Bloqueado: ${problem}.` };
  }
  if (name === 'WebFetch') {
    const problem = await fetchTargetProblem(input?.url, resolve);
    if (problem) return { allow: false, reason: `Bloqueado: ${problem}.` };
  }
  return { allow: true };
}

/**
 * Hook PreToolUse no formato do Agent SDK: nega a chamada quando a política
 * recusa, e deixa passar (objeto vazio) quando permite.
 *
 * @param {{ cwd: string, roots: string[], allowWrites?: boolean, resolve?: Function }} opts
 */
export function preToolUseHook(opts) {
  return async (input) => {
    const verdict = await checkToolUse(input.tool_name, input.tool_input, opts);
    if (verdict.allow) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: verdict.reason,
      },
    };
  };
}
