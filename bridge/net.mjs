/**
 * Gate para endereços de rede. Qualquer busca feita pelo processo do JARVIS
 * passa por aqui antes de sair.
 *
 * O processo alcança a rede local do usuário e o endereço de metadados da
 * nuvem (169.254.169.254). Então um URL escolhido pelo modelo nunca pode
 * apontar para esses lugares.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Nomes de máquina que nunca são da internet pública (mDNS, redes internas). */
const BLOCKED_HOSTNAME = /(^|\.)(localhost|local|internal|intranet|home\.arpa)$/i;

/**
 * O endereço resolvido é um que não se deve alcançar?
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function blockedAddress(ip) {
  let addr = String(ip ?? '').toLowerCase().split('%')[0];

  // ::ffff:127.0.0.1 é loopback disfarçado. Desfaz o disfarce antes de avaliar.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) addr = mapped[1];

  if (addr.includes('.')) {
    const parts = addr.split('.').map(Number);
    if (parts.length !== 4) return true;
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local e metadados da nuvem
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 192 && b === 0) return true; // 192.0.0/24
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT e tailnets
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast e reservados
    return false;
  }

  if (addr === '::' || addr === '::1') return true;
  if (/^::ffff:/.test(addr)) return true; // forma hex mapeada que sobrou
  if (/^f[cd]/.test(addr)) return true; // fc00::/7
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10
  if (/^ff/.test(addr)) return true; // multicast
  return false;
}

/**
 * Valida um URL antes de qualquer conexão. Lança Error com `status` se recusar.
 *
 * @param {unknown} raw
 * @returns {URL}
 */
export function vetTarget(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    throw Object.assign(new Error('URL absoluto http(s) é obrigatório.'), { status: 400 });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Object.assign(new Error('URL absoluto http(s) é obrigatório.'), { status: 400 });
  }
  if (!url.hostname) {
    throw Object.assign(new Error('URL absoluto http(s) é obrigatório.'), { status: 400 });
  }
  if (BLOCKED_HOSTNAME.test(url.hostname)) {
    throw Object.assign(new Error('Endereço bloqueado.'), { status: 403 });
  }
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) && blockedAddress(literal)) {
    throw Object.assign(new Error('Endereço bloqueado.'), { status: 403 });
  }
  return url;
}

/**
 * Para onde um nome de máquina aponta, se for um endereço que não se deve usar.
 *
 * Só o texto do URL não basta: um nome público pode resolver para 127.0.0.1.
 * Esta checagem fecha o caso estático. Não prende o endereço que a conexão
 * vai usar, então um nome que troca de IP entre a consulta e a conexão ainda
 * escaparia. Por isso é uma camada, não a única.
 *
 * @param {string} url
 * @param {(host: string, opts: { all: true }) => Promise<{ address: string }[]>} [resolve]
 *   injetável nos testes; por padrão, o DNS do sistema
 * @returns {Promise<string | null>} motivo da recusa, ou null se pode seguir
 */
export async function fetchTargetProblem(url, resolve = dnsLookup) {
  let host;
  try {
    host = vetTarget(url).hostname.replace(/^\[|\]$/g, '');
  } catch (err) {
    return err.message;
  }
  if (isIP(host)) return null; // literais já foram julgados por vetTarget
  let answers;
  try {
    answers = await resolve(host, { all: true });
  } catch {
    return null; // sem resolução: a busca falha sozinha
  }
  const bad = answers.find((a) => blockedAddress(a.address));
  return bad ? `${host} resolve para o endereço privado ${bad.address}` : null;
}
