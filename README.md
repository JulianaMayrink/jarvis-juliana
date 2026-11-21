# JARVIS pessoal

Assistente de voz pessoal, reconstruído do zero. Cada etapa vai numa branch,
é revisada e testada antes de entrar na `main`.

## Status

**Fase 0 — fundação.** Projeto TypeScript + Vite + React com uma tela mínima.
Sem voz, sem ponte com o Claude e sem ações.

## Requisitos

- Node.js 20 ou superior
- npm

## Rodar

```bash
npm ci --ignore-scripts
npm run dev
```

Abre em `http://127.0.0.1:5173`.

## Scripts

| Comando | O que faz |
| --- | --- |
| `npm run dev` | servidor de desenvolvimento em 127.0.0.1 |
| `npm run typecheck` | checagem de tipos (`tsc -b`) |
| `npm run build` | checagem de tipos e build de produção |
| `npm run preview` | serve o build gerado |

## Princípios

- Dependências são poucas e cada uma tem motivo. Instalar com
  `npm ci --ignore-scripts`; nenhum script de instalação de terceiros roda sem revisão.
- Nada que muda algo no mundo acontece sem confirmação falada explícita
  (a partir da fase em que isso for introduzido).
- Tudo escuta só em 127.0.0.1.
