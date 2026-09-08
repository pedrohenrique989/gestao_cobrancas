# FASE 3 — Sincronização Google Sheets (implementação completa)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completar a FASE 3 — todas as Edge Functions de sincronização com o Google Sheets real (a planilha "Dados - Meta - API"), com write-back e conciliação funcionando de ponta a ponta, testado primeiro numa cópia da planilha antes de tocar produção.

**Architecture:** `preview-google-sheets-import` já está implementada e validada contra a planilha real (159 recebíveis, 6 abas). As demais funções (initialize, import, synchronize, write-back, process-sync-queue, resolve-conflict) seguem o mesmo padrão: Deno Edge Functions em `supabase/functions/*`, autenticadas via `requireMasterAdmin`, usando `_shared/google.ts` para falar com a Sheets API e o client `service_role` do Supabase para o Postgres. O parser de 2 linhas por projeto (hoje só dentro de `preview-google-sheets-import`) é extraído para `_shared/sheetParser.ts` e reusado por `import-google-sheets`.

**Decisão de design chave:** o `ID_COBRANCA` escrito na planilha (coluna R, cabeçalho oculto) **é o próprio `receivables.id`** (mesmo UUID), não uma chave estrangeira separada. `initialize-google-sheets` gera o UUID e escreve na planilha; `import-google-sheets` faz `insert into receivables (id, ...) values (<esse mesmo uuid>, ...)`. Isso elimina a necessidade de uma coluna de mapeamento extra e casa com "duas linhas da planilha = uma linha em receivables".

**Tech Stack:** Deno (Edge Functions), Supabase (Postgres + Auth + service_role), Google Sheets API v4 (Service Account, JWT RS256 já implementado em `_shared/google.ts`).

---

## Pré-requisitos já resolvidos nesta sessão (não repetir)

- Service Account `sheets-sync@gestaodecobrancas.iam.gserviceaccount.com` criada, sem IAM role no projeto Cloud.
- Secrets locais em `supabase/functions/.env` (gitignored): `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SPREADSHEET_ID`.
- **Importante (confirmado pelo usuário):** o `GOOGLE_SPREADSHEET_ID` atual (`1lW3SM1Z8avcmayqtwGgNclON548Br4ItlxiLmRnm_VA`) é a **planilha de TESTE**, não a de produção. Nada nesta sessão — nem leitura, nem escrita — tocou a planilha real do time até agora. O ID da planilha REAL de produção ainda não foi informado; só é necessário na Task 12.
- `google-sheets-health-check` e `preview-google-sheets-import` implementadas e validadas contra a planilha de teste (estrutura idêntica à real, então as conclusões abaixo valem, mas os *dados* em si são de teste).
- Estrutura confirmada: 17 colunas usadas (A–Q), coluna R livre, 2 linhas por projeto (linha prevista sempre com Tipo preenchido; linha recebida abaixo, às vezes em branco, só G/H diferem), bloco de totais no fim de cada aba mensal (coluna Fundação = "TOTAL A/B/C").
- 4 códigos de fase fora de A–D encontrados na planilha de teste: `F` (1x), `BACKLOG` (6x), `PERDIDO` (2x), `D (PERDIDO)` (1x).
- 2 divergências de saldo encontradas pelo preview (uma delas com saldo negativo — recebido > previsto) — como é a planilha de teste, não precisam ser resolvidas com o time antes de prosseguir; servem só pra confirmar que o preview detecta esse tipo de problema.

## Scope Check

Este plano cobre um único subsistema coeso (sincronização com uma fonte externa), mas é grande porque a fonte é uma planilha editada por humanos, com side-effects (escrita real numa planilha). Cada task abaixo produz software testável isoladamente contra a planilha de TESTE já configurada; a task 12 (corte pra produção) é a única que toca a planilha real, e só deve rodar depois que 1–11 estiverem verdes.

---

## Task 1: Mapear os códigos legados encontrados

**Files:**
- Nenhum arquivo de código — é uma decisão de negócio + 1 statement SQL rodado manualmente no Studio local (ou psql).

Antes de importar de verdade, os códigos fora de A–D precisam de uma entrada em `legacy_code_mapping` (`mapped_to`: `stage` | `status` | `ignore`, `target_value`). Meu chute, baseado no enum `project_status` (`active|backlog|lost|archived`) e no nome literal dos códigos:

| legacy_code | mapped_to | target_value | por quê |
|---|---|---|---|
| `BACKLOG` | `status` | `backlog` | bate com `project_status.backlog` |
| `PERDIDO` | `status` | `lost` | bate com `project_status.lost` |
| `D (PERDIDO)` | `status` | `lost` | fase D que também foi perdida — situação, não fase nova |
| `F` | ? | ? | sem contexto suficiente — **decisão do time**, não adivinho |

- [ ] **Passo 1: Confirmar com o time o significado de `F`** (a Legenda da planilha só documenta A–D). Pode ser um código de digitação errada, uma fase extra, ou algo a ignorar.

- [ ] **Passo 2: Rodar no SQL Editor do Studio local** (http://127.0.0.1:55323, depois de `npx supabase start`) — ajuste `F` conforme a resposta do time:

```sql
insert into public.legacy_code_mapping (legacy_code, mapped_to, target_value, occurrences)
values
  ('BACKLOG', 'status', 'backlog', 6),
  ('PERDIDO', 'status', 'lost', 2),
  ('D (PERDIDO)', 'status', 'lost', 1),
  ('F', 'ignore', null, 1)  -- AJUSTAR conforme decisão do time
on conflict (legacy_code) do update set mapped_to = excluded.mapped_to, target_value = excluded.target_value;
```

- [ ] **Passo 3: Verificar**

```sql
select legacy_code, mapped_to, target_value from public.legacy_code_mapping order by legacy_code;
```

Esperado: as 4 linhas acima, sem `mapped_to` nulo.

---

## Task 2: Liberar escrita na planilha de testes já configurada

**Files:**
- Nenhum arquivo de código — `GOOGLE_SPREADSHEET_ID` em `supabase/functions/.env` já aponta pra planilha de teste (`1lW3SM1Z8avcmayqtwGgNclON548Br4ItlxiLmRnm_VA`), não precisa trocar.

A planilha de teste já existe e já está configurada. Falta só a permissão: hoje a Service Account só tem **Leitor** nela (suficiente pro `preview`), mas a partir da Task 5 (`initialize-google-sheets`) o sistema precisa **escrever**.

- [ ] **Passo 1:** Confirmar que `1lW3SM1Z8avcmayqtwGgNclON548Br4ItlxiLmRnm_VA` é mesmo descartável (pode ganhar colunas extras, ter linhas alteradas etc. sem problema).
- [ ] **Passo 2:** Nessa planilha de teste → Compartilhar → achar `sheets-sync@gestaodecobrancas.iam.gserviceaccount.com` (já deve estar na lista, como Leitor) → trocar a permissão dela para **Editor**.
- [ ] **Passo 3:** Confirmar que a health-check ainda funciona (a troca de Leitor pra Editor não deveria quebrar nada):

```bash
# obter token do usuário master_admin de teste, depois:
curl -s -X POST "http://127.0.0.1:55321/functions/v1/google-sheets-health-check" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <TOKEN>"
```

Expected: `"healthy":true`.

---

## Task 3: Extrair o parser compartilhado

**Files:**
- Create: `supabase/functions/_shared/sheetParser.ts`
- Modify: `supabase/functions/preview-google-sheets-import/index.ts`

O parser de 2 linhas por projeto (hoje só dentro de `preview-google-sheets-import`) precisa ser reusado por `import-google-sheets`. Extrai sem mudar comportamento.

- [ ] **Passo 1: Criar `supabase/functions/_shared/sheetParser.ts`**

```typescript
// Parser de 2 linhas por projeto das abas mensais ("JUL - A Receber" etc.).
// Layout confirmado contra a planilha real: colunas A-Q usadas, R livre (ID_COBRANCA).
export interface CellRow { values?: { formattedValue?: string }[] }
export interface RangeSheet { data?: { rowData?: CellRow[] }[] }

export const COL = { tipo: 0, hub: 1, min: 2, inst: 3, fund: 4, nome: 5, plProjeto: 6, plInnovatis: 7,
  status: 8, motivo: 9, acao: 10, responsavel: 11, prazo: 12, arProjeto: 13, arInnovatis: 14, flag: 15, statusCalc: 16, idCobranca: 17 } as const;
export const FASES = new Set(["A", "B", "C", "D"]);

export function cell(row: CellRow | undefined, idx: number): string {
  return row?.values?.[idx]?.formattedValue?.trim() ?? "";
}
export function isBlankRow(row: CellRow | undefined): boolean {
  return !row?.values?.some((v) => v.formattedValue?.trim());
}
export function parseBRL(s: string): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export interface ParsedProjectRow {
  rowIndex: number;              // índice 0-based dentro de `rows` (linha "prevista")
  receivedRowIndex: number | null; // índice 0-based da linha "recebida", se existir
  tipo: string; hub: string; min: string; inst: string; fund: string; nome: string;
  plProjeto: number | null; plInnovatis: number | null;
  recProjeto: number; recInnovatis: number;
  statusLabel: string; motivo: string; acao: string; responsavel: string; prazo: string;
  arProjetoPlanilha: number | null; arInnovatisPlanilha: number | null;
  idCobranca: string;
}

/** Percorre `rows` (rowData de uma aba, já incluindo o cabeçalho na posição 0) e retorna
 * os pares de linha por projeto, parando ao encontrar o bloco de totais (coluna Fundação = "TOTAL..."). */
export function parseSheetRows(rows: CellRow[]): { projects: ParsedProjectRow[]; orphanRows: number[] } {
  const projects: ParsedProjectRow[] = [];
  const orphanRows: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (isBlankRow(row)) continue;
    const tipo = cell(row, COL.tipo);
    if (!tipo) {
      if (cell(row, COL.fund).toUpperCase().startsWith("TOTAL")) break;
      orphanRows.push(i);
      continue;
    }
    let recProjeto = 0, recInnovatis = 0, receivedRowIndex: number | null = null;
    const next = rows[i + 1];
    if (next && !isBlankRow(next) && !cell(next, COL.tipo) && !cell(next, COL.fund).toUpperCase().startsWith("TOTAL")) {
      recProjeto = parseBRL(cell(next, COL.plProjeto)) ?? 0;
      recInnovatis = parseBRL(cell(next, COL.plInnovatis)) ?? 0;
      receivedRowIndex = i + 1;
      i++;
    }
    projects.push({
      rowIndex: receivedRowIndex ? i - 1 : i, receivedRowIndex,
      tipo, hub: cell(row, COL.hub), min: cell(row, COL.min), inst: cell(row, COL.inst), fund: cell(row, COL.fund),
      nome: cell(row, COL.nome), plProjeto: parseBRL(cell(row, COL.plProjeto)), plInnovatis: parseBRL(cell(row, COL.plInnovatis)),
      recProjeto, recInnovatis, statusLabel: cell(row, COL.status), motivo: cell(row, COL.motivo), acao: cell(row, COL.acao),
      responsavel: cell(row, COL.responsavel), prazo: cell(row, COL.prazo),
      arProjetoPlanilha: parseBRL(cell(row, COL.arProjeto)), arInnovatisPlanilha: parseBRL(cell(row, COL.arInnovatis)),
      idCobranca: cell(row, COL.idCobranca),
    });
  }
  return { projects, orphanRows };
}
```

- [ ] **Passo 2: Reescrever `supabase/functions/preview-google-sheets-import/index.ts` usando o parser compartilhado** (mesmo comportamento, menos código):

```typescript
// FASE 3 — preview-google-sheets-import
// Contrato: ver src/integrations/receivables-source/types.ts e docs/fase-3-google-sheets.md.
// Dry-run: lê as abas ativas de sheet_competence_map, aplica o parser de 2 linhas por projeto,
// classifica fase e conta IDs presentes/ausentes/duplicados. Não escreve nada.
import { requireMasterAdmin } from "../_shared/auth.ts";
import { accessToken, json, loadConfig, sheetsGet } from "../_shared/google.ts";
import { FASES, parseSheetRows, type CellRow, type RangeSheet } from "../_shared/sheetParser.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try { await requireMasterAdmin(req); } catch (e) { return json({ error: (e as Error).message }, 401); }
  const cfg = loadConfig();
  if ("missing" in cfg) return json({ error: `Configuração pendente: secrets ausentes (${cfg.missing.join(", ")})` }, 503);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: sheetsMap, error: mapErr } = await admin
    .from("sheet_competence_map").select("sheet_name, competence_month, competence_year").eq("active", true);
  if (mapErr) return json({ error: mapErr.message }, 500);
  if (!sheetsMap?.length) return json({ error: "Nenhuma aba ativa em sheet_competence_map." }, 503);

  const { data: legacyRows } = await admin.from("legacy_code_mapping").select("legacy_code, mapped_to");
  const mappedCodes = new Set((legacyRows ?? []).filter((r) => r.mapped_to).map((r) => r.legacy_code));

  const token = await accessToken(cfg, "https://www.googleapis.com/auth/spreadsheets.readonly");

  const result = {
    sheets: [] as { name: string; isMonthly: boolean; competence?: string }[],
    receivables: 0, idsPresent: 0, idsMissing: 0, duplicates: 0,
    stagesFound: {} as Record<string, number>,
    issues: [] as string[],
  };
  const idCounts = new Map<string, number>();
  const unmapped = new Map<string, number>();

  for (const sm of sheetsMap) {
    const competence = `${sm.competence_year}-${String(sm.competence_month).padStart(2, "0")}-01`;
    result.sheets.push({ name: sm.sheet_name, isMonthly: true, competence });

    let rows: CellRow[] = [];
    try {
      const range = `?ranges=${encodeURIComponent(`'${sm.sheet_name}'!A1:R2000`)}&fields=${encodeURIComponent("sheets(data.rowData.values(formattedValue))")}&includeGridData=true`;
      const res = await sheetsGet<{ sheets?: RangeSheet[] }>(cfg, token, range);
      rows = res.sheets?.[0]?.data?.[0]?.rowData ?? [];
    } catch (e) {
      result.issues.push(`Aba "${sm.sheet_name}": falha ao ler (${(e as Error).message}).`);
      continue;
    }

    const { projects, orphanRows } = parseSheetRows(rows);
    for (const i of orphanRows) result.issues.push(`Aba "${sm.sheet_name}", linha ${i + 1}: sem Tipo e fora de um par esperado — ignorada.`);

    for (const p of projects) {
      if (FASES.has(p.tipo) || mappedCodes.has(p.tipo)) result.stagesFound[p.tipo] = (result.stagesFound[p.tipo] ?? 0) + 1;
      else unmapped.set(p.tipo, (unmapped.get(p.tipo) ?? 0) + 1);

      if (p.plProjeto != null && p.arProjetoPlanilha != null) {
        const saldoCalculado = Math.max(p.plProjeto - p.recProjeto, 0);
        if (Math.abs(saldoCalculado - p.arProjetoPlanilha) > 0.01) {
          result.issues.push(`Aba "${sm.sheet_name}", linha ${p.rowIndex + 1} (${p.nome || "sem nome"}): saldo da planilha (R$ ${p.arProjetoPlanilha.toFixed(2)}) diverge do calculado (R$ ${saldoCalculado.toFixed(2)}).`);
        }
      }

      if (p.idCobranca) { result.idsPresent++; idCounts.set(p.idCobranca, (idCounts.get(p.idCobranca) ?? 0) + 1); }
      else result.idsMissing++;
      result.receivables++;
    }
  }

  for (const [code, count] of unmapped) result.issues.push(`Código de fase não mapeado "${code}": ${count} ocorrência(s). Cadastre em legacy_code_mapping.`);
  for (const count of idCounts.values()) if (count > 1) result.duplicates += count - 1;

  return json(result);
});
```

- [ ] **Passo 3: Verificar que o resultado não mudou** (mesma planilha, mesmos números de antes — mas agora contra a cópia de teste, então os números serão os mesmos da planilha original já que é cópia fiel):

```bash
# token do master_admin de teste, depois:
curl -s -X POST "http://127.0.0.1:55321/functions/v1/preview-google-sheets-import" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <TOKEN>" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.receivables, j.idsMissing, JSON.stringify(j.stagesFound));})"
```

Expected: `159 159 {"A":102,"B":18,"C":14,"D":15}` (mesmos números da Task anterior, já que a cópia é idêntica à produção no momento da cópia).

- [ ] **Passo 4: Commit**

```bash
git add supabase/functions/_shared/sheetParser.ts supabase/functions/preview-google-sheets-import/index.ts
git commit -m "refactor: extrai parser de planilha compartilhado para reuso no import"
```

---

## Task 4: Helpers de escrita em `_shared/google.ts`

**Files:**
- Modify: `supabase/functions/_shared/google.ts`

Hoje só existe `sheetsGet` (leitura). Escrita precisa de 2 chamadas novas: `values.batchUpdate` (gravar células) e `spreadsheets.batchUpdate` (ocultar coluna). Mais um hash estável pro `synchronize`.

- [ ] **Passo 1: Adicionar ao final de `supabase/functions/_shared/google.ts`**

```typescript
export async function sheetsValuesBatchUpdate(cfg: GoogleConfig, token: string, data: { range: string; values: string[][] }[]): Promise<void> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheetId}/values:batchUpdate`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });
  if (!res.ok) throw new Error(`Sheets API batchUpdate ${res.status}: ${await res.text()}`);
}

export async function sheetsStructuralBatchUpdate(cfg: GoogleConfig, token: string, requests: unknown[]): Promise<void> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheetId}:batchUpdate`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Sheets API structural batchUpdate ${res.status}: ${await res.text()}`);
}

/** Hash estável (SHA-256, hex) do conteúdo relevante de um recebível, para detectar mudanças externas. */
export async function stableHash(parts: (string | number | null)[]): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|")));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Passo 2: Commit**

```bash
git add supabase/functions/_shared/google.ts
git commit -m "feat: adiciona helpers de escrita e hash em _shared/google.ts"
```

---

## Task 5: `initialize-google-sheets`

**Files:**
- Modify: `supabase/functions/initialize-google-sheets/index.ts`

Detecta a coluna livre pelo **cabeçalho** (nunca assume letra fixa), grava `ID_COBRANCA` + um UUID por par de linhas (mesmo UUID nas duas), oculta a coluna, registra em `sync_runs`. Idempotente: só preenche células vazias.

- [ ] **Passo 1: Implementar**

```typescript
// FASE 3 — initialize-google-sheets
// Contrato: ver src/integrations/receivables-source/types.ts e docs/fase-3-google-sheets.md.
// Escreve na planilha: cabeçalho ID_COBRANCA numa coluna livre + 1 UUID por par de linhas (mesmo
// UUID nas duas). Idempotente — só preenche células que ainda estão vazias. Oculta a coluna no fim.
import { requireMasterAdmin } from "../_shared/auth.ts";
import { accessToken, json, loadConfig, sheetsGet, sheetsStructuralBatchUpdate, sheetsValuesBatchUpdate } from "../_shared/google.ts";
import { isBlankRow, parseSheetRows, type RangeSheet } from "../_shared/sheetParser.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function colLetter(idx: number): string {
  let s = "", n = idx + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

Deno.serve(async (req) => {
  let ctx;
  try { ctx = await requireMasterAdmin(req); } catch (e) { return json({ error: (e as Error).message }, 401); }
  const cfg = loadConfig();
  if ("missing" in cfg) return json({ error: `Configuração pendente: secrets ausentes (${cfg.missing.join(", ")})` }, 503);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: sheetsMap, error: mapErr } = await admin
    .from("sheet_competence_map").select("sheet_name").eq("active", true);
  if (mapErr) return json({ error: mapErr.message }, 500);
  if (!sheetsMap?.length) return json({ error: "Nenhuma aba ativa em sheet_competence_map." }, 503);

  const { data: run } = await admin.from("sync_runs").insert({ type: "initialize", started_by: ctx.user.id }).select("id").single();
  const runId = run!.id;
  let created = 0, skipped = 0;
  const issues: string[] = [];

  try {
    const token = await accessToken(cfg); // escopo completo (leitura+escrita)

    for (const sm of sheetsMap) {
      // 1) cabeçalho: acha "ID_COBRANCA" existente ou a primeira coluna livre após o cabeçalho usado
      const headerRes = await sheetsGet<{ sheets?: { properties: { sheetId: number }; data?: { rowData?: { values?: { formattedValue?: string }[] }[] } }[] }>(
        cfg, token, `?ranges=${encodeURIComponent(`'${sm.sheet_name}'!A1:Z1`)}&fields=${encodeURIComponent("sheets(properties.sheetId,data.rowData.values(formattedValue))")}&includeGridData=true`);
      const sheetMeta = headerRes.sheets?.[0];
      const headerCells = sheetMeta?.data?.[0]?.rowData?.[0]?.values ?? [];
      let colIdx = headerCells.findIndex((c) => c.formattedValue?.trim() === "ID_COBRANCA");
      if (colIdx === -1) {
        let lastUsed = -1;
        headerCells.forEach((c, i) => { if (c.formattedValue?.trim()) lastUsed = i; });
        colIdx = lastUsed + 1;
        await sheetsValuesBatchUpdate(cfg, token, [{ range: `'${sm.sheet_name}'!${colLetter(colIdx)}1`, values: [["ID_COBRANCA"]] }]);
        await sheetsStructuralBatchUpdate(cfg, token, [{
          updateDimensionProperties: {
            range: { sheetId: sheetMeta!.properties.sheetId, dimension: "COLUMNS", startIndex: colIdx, endIndex: colIdx + 1 },
            properties: { hiddenByUser: true }, fields: "hiddenByUser",
          },
        }]);
      }

      // 2) linhas: lê o range inteiro incluindo a coluna do ID, gera UUIDs só onde falta
      const colL = colLetter(colIdx);
      const rowsRes = await sheetsGet<{ sheets?: RangeSheet[] }>(cfg, token,
        `?ranges=${encodeURIComponent(`'${sm.sheet_name}'!A1:${colL}2000`)}&fields=${encodeURIComponent("sheets(data.rowData.values(formattedValue))")}&includeGridData=true`);
      const rows = rowsRes.sheets?.[0]?.data?.[0]?.rowData ?? [];
      const { projects } = parseSheetRows(rows);

      const writes: { range: string; values: string[][] }[] = [];
      for (const p of projects) {
        if (p.idCobranca) { skipped++; continue; } // já inicializado — idempotente
        const id = crypto.randomUUID();
        writes.push({ range: `'${sm.sheet_name}'!${colL}${p.rowIndex + 1}`, values: [[id]] });
        if (p.receivedRowIndex != null) writes.push({ range: `'${sm.sheet_name}'!${colL}${p.receivedRowIndex + 1}`, values: [[id]] });
        created++;
      }
      if (writes.length) await sheetsValuesBatchUpdate(cfg, token, writes);
    }
  } catch (e) {
    issues.push((e as Error).message);
    await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), status: "error", error_message: (e as Error).message }).eq("id", runId);
    return json({ error: (e as Error).message, runId }, 500);
  }

  await admin.from("sync_runs").update({
    finished_at: new Date().toISOString(), status: issues.length ? "partial" : "success",
    records_created: created, records_ignored: skipped, details: { issues },
  }).eq("id", runId);

  return json({ runId, created, skipped, issues });
});
```

- [ ] **Passo 2: Rodar contra a CÓPIA de teste (nunca produção nesta etapa)**

```bash
# token do master_admin de teste
curl -s -X POST "http://127.0.0.1:55321/functions/v1/initialize-google-sheets" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <TOKEN>"
```

Expected: `{"runId":"...","created":159,"skipped":0,"issues":[]}`

- [ ] **Passo 3: Rodar de novo (idempotência)**

```bash
curl -s -X POST "http://127.0.0.1:55321/functions/v1/initialize-google-sheets" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <TOKEN>"
```

Expected: `{"runId":"...","created":0,"skipped":159,"issues":[]}` — a segunda chamada não deve gerar nenhum UUID novo.

- [ ] **Passo 4: Confirmar no preview que os IDs agora aparecem**

```bash
curl -s -X POST "http://127.0.0.1:55321/functions/v1/preview-google-sheets-import" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <TOKEN>" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log('idsPresent',j.idsPresent,'idsMissing',j.idsMissing,'duplicates',j.duplicates);})"
```

Expected: `idsPresent 159 idsMissing 0 duplicates 0`

- [ ] **Passo 5: Commit**

```bash
git add supabase/functions/initialize-google-sheets/index.ts
git commit -m "feat: implementa initialize-google-sheets (grava ID_COBRANCA, idempotente)"
```

---

## Task 6: `import-google-sheets`

**Files:**
- Modify: `supabase/functions/import-google-sheets/index.ts`

Upsert de `projects`/`receivables` usando o `ID_COBRANCA` (= `receivables.id`) já gravado pela Task 5. Casa projeto por `(normalized_name, hub)`; nunca funde por nome quando há ambiguidade (reporta em vez de adivinhar). Detecta ID duplicado entre abas (planilha copiada por engano) antes de escrever qualquer coisa.

- [ ] **Passo 1: Implementar**

```typescript
// FASE 3 — import-google-sheets
// Contrato: ver src/integrations/receivables-source/types.ts e docs/fase-3-google-sheets.md.
// Upsert por ID_COBRANCA (= receivables.id). Projeto casado por (normalized_name, hub); ambíguo
// vira issue, nunca funde às cegas. source_hash grava o estado no momento da importação.
import { requireMasterAdmin } from "../_shared/auth.ts";
import { accessToken, json, loadConfig, sheetsGet, stableHash } from "../_shared/google.ts";
import { FASES, parseSheetRows, type ParsedProjectRow, type RangeSheet } from "../_shared/sheetParser.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const DIACRITICS = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g");
const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(DIACRITICS, "").replace(/\s+/g, " ").trim();

Deno.serve(async (req) => {
  let ctx;
  try { ctx = await requireMasterAdmin(req); } catch (e) { return json({ error: (e as Error).message }, 401); }
  const cfg = loadConfig();
  if ("missing" in cfg) return json({ error: `Configuração pendente: secrets ausentes (${cfg.missing.join(", ")})` }, 503);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: sheetsMap, error: mapErr } = await admin
    .from("sheet_competence_map").select("sheet_name, competence_month, competence_year").eq("active", true);
  if (mapErr) return json({ error: mapErr.message }, 500);
  if (!sheetsMap?.length) return json({ error: "Nenhuma aba ativa em sheet_competence_map." }, 503);

  const { data: stages } = await admin.from("project_stage_catalog").select("id, code");
  const stageId = new Map((stages ?? []).map((s) => [s.code, s.id]));
  const { data: legacy } = await admin.from("legacy_code_mapping").select("legacy_code, mapped_to, target_value");
  const legacyMap = new Map((legacy ?? []).map((r) => [r.legacy_code, r]));
  const { data: statusCat } = await admin.from("collection_status_catalog").select("id, hub, source_label");
  const statusId = new Map((statusCat ?? []).map((c) => [`${c.hub}::${c.source_label}`, c.id]));

  const { data: run } = await admin.from("sync_runs").insert({ type: "import", started_by: ctx.user.id }).select("id").single();
  const runId = run!.id;
  const result = { runId, read: 0, created: 0, updated: 0, ignored: 0, errors: 0, conflicts: 0 };
  const issues: string[] = [];

  const token = await accessToken(cfg, "https://www.googleapis.com/auth/spreadsheets.readonly");

  // 1ª passada: ler tudo e detectar ID duplicado ENTRE abas antes de escrever qualquer coisa.
  type Row = ParsedProjectRow & { sheetName: string; competence: string };
  const allRows: Row[] = [];
  for (const sm of sheetsMap) {
    const competence = `${sm.competence_year}-${String(sm.competence_month).padStart(2, "0")}-01`;
    let rows: RangeSheet["data"];
    try {
      const range = `?ranges=${encodeURIComponent(`'${sm.sheet_name}'!A1:R2000`)}&fields=${encodeURIComponent("sheets(data.rowData.values(formattedValue))")}&includeGridData=true`;
      const res = await sheetsGet<{ sheets?: RangeSheet[] }>(cfg, token, range);
      rows = res.sheets?.[0]?.data ?? [];
    } catch (e) {
      issues.push(`Aba "${sm.sheet_name}": falha ao ler (${(e as Error).message}).`); result.errors++; continue;
    }
    const { projects } = parseSheetRows(rows[0]?.rowData ?? []);
    for (const p of projects) allRows.push({ ...p, sheetName: sm.sheet_name, competence });
  }

  const idToSheets = new Map<string, string[]>();
  for (const r of allRows) { if (r.idCobranca) idToSheets.set(r.idCobranca, [...(idToSheets.get(r.idCobranca) ?? []), r.sheetName]); }
  const blockedIds = new Set<string>();
  for (const [id, sheetsFor] of idToSheets) {
    if (sheetsFor.length > 1) { issues.push(`ID_COBRANCA "${id}" aparece em mais de uma aba (${sheetsFor.join(", ")}) — verifique se uma aba foi duplicada por engano. Essas linhas foram ignoradas.`); blockedIds.add(id); }
  }

  for (const r of allRows) {
    result.read++;
    if (!r.idCobranca) { issues.push(`Aba "${r.sheetName}", linha ${r.rowIndex + 1} (${r.nome}): sem ID_COBRANCA — rode initialize-google-sheets antes de importar.`); result.errors++; continue; }
    if (blockedIds.has(r.idCobranca)) { result.ignored++; continue; }

    // fase / status a partir do Tipo
    let projectStageId: string | null = null, stagePending = false, projectStatus: "active" | "backlog" | "lost" = "active";
    if (FASES.has(r.tipo)) projectStageId = stageId.get(r.tipo) ?? null;
    else {
      const mapped = legacyMap.get(r.tipo);
      if (mapped?.mapped_to === "stage") projectStageId = stageId.get(mapped.target_value!) ?? null;
      else if (mapped?.mapped_to === "status") projectStatus = mapped.target_value as "backlog" | "lost";
      else if (mapped?.mapped_to !== "ignore") { stagePending = true; issues.push(`Aba "${r.sheetName}", linha ${r.rowIndex + 1}: código de fase "${r.tipo}" sem mapeamento — projeto marcado como fase pendente.`); }
    }

    // acha ou cria o projeto por (normalized_name, hub)
    const normalizedName = normalize(r.nome);
    const { data: existing, error: findErr } = await admin.from("projects").select("id").eq("normalized_name", normalizedName).eq("hub", r.hub).eq("active", true);
    if (findErr) { issues.push(`Erro ao buscar projeto "${r.nome}": ${findErr.message}`); result.errors++; continue; }
    let projectId: string;
    if (existing && existing.length > 1) { issues.push(`Aba "${r.sheetName}", linha ${r.rowIndex + 1}: mais de um projeto ativo chamado "${r.nome}" no HUB ${r.hub} — resolva manualmente antes de importar esta linha.`); result.errors++; continue; }
    if (existing && existing.length === 1) {
      projectId = existing[0].id;
      await admin.from("projects").update({
        project_stage_id: projectStageId, stage_pending: stagePending, legacy_stage_code: FASES.has(r.tipo) ? null : r.tipo,
        project_status: projectStatus, ministry_government: r.min || null, institute: r.inst === "-" ? null : (r.inst || null), foundation: r.fund || null,
      }).eq("id", projectId);
    } else {
      const { data: created, error: createErr } = await admin.from("projects").insert({
        name: r.nome, normalized_name: normalizedName, search_text: normalize(`${r.nome} ${r.min} ${r.inst} ${r.fund}`),
        project_stage_id: projectStageId, stage_pending: stagePending, legacy_stage_code: FASES.has(r.tipo) ? null : r.tipo,
        project_status: projectStatus, hub: r.hub, ministry_government: r.min || null, institute: r.inst === "-" ? null : (r.inst || null), foundation: r.fund || null,
        origin: "google_sheets", provisional: false,
      }).select("id").single();
      if (createErr) { issues.push(`Erro ao criar projeto "${r.nome}": ${createErr.message}`); result.errors++; continue; }
      projectId = created.id;
    }

    const collectionStatusId = r.statusLabel ? (statusId.get(`${r.hub}::${r.statusLabel}`) ?? null) : null;
    if (r.statusLabel && !collectionStatusId) issues.push(`Aba "${r.sheetName}", linha ${r.rowIndex + 1}: etapa "${r.statusLabel}" não cadastrada em collection_status_catalog para o HUB ${r.hub}.`);

    const hash = await stableHash([r.tipo, r.hub, r.min, r.inst, r.fund, r.nome, r.plProjeto, r.plInnovatis, r.recProjeto, r.recInnovatis, r.statusLabel, r.motivo, r.acao, r.responsavel, r.prazo]);
    const legacyConsolidated = r.competence === "2026-07-01"; // Jul/2026 concentra vencidos até Jun/2026, por regra do negócio

    const { data: existingReceivable } = await admin.from("receivables").select("id, source_hash, source_version, sync_status").eq("id", r.idCobranca).maybeSingle();
    if (existingReceivable) {
      if (existingReceivable.source_hash === hash) { result.ignored++; continue; } // nada mudou
      await admin.from("receivables").update({
        planned_project: r.plProjeto ?? 0, planned_innovatis: r.plInnovatis ?? 0, received_project: r.recProjeto, received_innovatis: r.recInnovatis,
        collection_status_id: collectionStatusId, reason: r.motivo || null, action: r.acao || null, responsible_legacy_name: r.responsavel || null,
        source_hash: hash, source_top_row: r.rowIndex + 1, source_received_row: r.receivedRowIndex != null ? r.receivedRowIndex + 1 : null,
        source_version: existingReceivable.source_version + 1,
      }).eq("id", r.idCobranca);
      result.updated++;
    } else {
      const { error: insErr } = await admin.from("receivables").insert({
        id: r.idCobranca, project_id: projectId, competence: r.competence, legacy_consolidated: legacyConsolidated,
        planned_project: r.plProjeto ?? 0, planned_innovatis: r.plInnovatis ?? 0, received_project: r.recProjeto, received_innovatis: r.recInnovatis,
        collection_status_id: collectionStatusId, reason: r.motivo || null, action: r.acao || null, responsible_legacy_name: r.responsavel || null,
        origin: "google_sheets", provisional: false, source_type: "google_sheets", source_sheet_name: r.sheetName,
        source_top_row: r.rowIndex + 1, source_received_row: r.receivedRowIndex != null ? r.receivedRowIndex + 1 : null,
        source_hash: hash, sync_status: "synchronized",
      });
      if (insErr) { issues.push(`Erro ao criar recebível "${r.nome}" (${r.sheetName}): ${insErr.message}`); result.errors++; continue; }
      result.created++;
    }
  }

  await admin.from("sync_runs").update({
    finished_at: new Date().toISOString(), status: result.errors ? "partial" : "success",
    records_read: result.read, records_created: result.created, records_updated: result.updated,
    records_ignored: result.ignored, records_with_errors: result.errors, details: { issues },
  }).eq("id", runId);

  return json({ ...result, issues });
});
```

- [ ] **Passo 2: Rodar contra a cópia de teste**

```bash
curl -s -X POST "http://127.0.0.1:55321/functions/v1/import-google-sheets" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <TOKEN>"
```

Expected: `created: 159, updated: 0, errors: 0` (os 2 problemas de saldo do preview NÃO bloqueiam a importação — só o `preview` reporta issues de qualidade, o `import` grava do jeito que está na planilha).

- [ ] **Passo 3: Verificar no banco**

```sql
select count(*) from public.receivables where source_type = 'google_sheets';  -- 159
select count(*) from public.projects where origin = 'google_sheets';          -- bem menor que 159 (projetos se repetem entre meses)
```

- [ ] **Passo 4: Rodar de novo (idempotência — nada deveria mudar, hash igual)**

```bash
curl -s -X POST "http://127.0.0.1:55321/functions/v1/import-google-sheets" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <TOKEN>"
```

Expected: `created: 0, updated: 0, ignored: 159`

- [ ] **Passo 5: Commit**

```bash
git add supabase/functions/import-google-sheets/index.ts
git commit -m "feat: implementa import-google-sheets (upsert por ID_COBRANCA)"
```

---

## Task 7: Write-back (`update-receivable-operational`, `update-receivable-financial`)

**Files:**
- Create: `supabase/functions/_shared/writeback.ts`
- Modify: `supabase/functions/update-receivable-operational/index.ts`
- Modify: `supabase/functions/update-receivable-financial/index.ts`

Usa `source_top_row`/`source_received_row` (gravados na Task 6) pra escrever direto na célula certa, sem re-escanear a planilha. Nunca toca em N, O, Q (calculados).

- [ ] **Passo 1: Criar `supabase/functions/_shared/writeback.ts`**

```typescript
import { accessToken, sheetsValuesBatchUpdate, type GoogleConfig } from "./google.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const COL_STATUS = "I", COL_MOTIVO = "J", COL_ACAO = "K", COL_RESP = "L", COL_PRAZO = "M";
const COL_PL_PROJETO = "G", COL_PL_INNOVATIS = "H";

type AdminClient = ReturnType<typeof createClient>;

export async function writebackOperational(admin: AdminClient, cfg: GoogleConfig, receivableId: string, fields: {
  collection_status_id: string | null; responsible_legacy_name: string | null; operational_deadline: string | null; reason: string | null; action: string | null;
}) {
  const { data: r, error } = await admin.from("receivables").select("source_sheet_name, source_top_row").eq("id", receivableId).single();
  if (error || !r?.source_sheet_name || !r.source_top_row) throw new Error("Recebível sem vínculo com a planilha (source_sheet_name/source_top_row ausentes).");
  const statusLabel = fields.collection_status_id
    ? (await admin.from("collection_status_catalog").select("source_label").eq("id", fields.collection_status_id).single()).data?.source_label ?? ""
    : "";
  const token = await accessToken(cfg);
  await sheetsValuesBatchUpdate(cfg, token, [
    { range: `'${r.source_sheet_name}'!${COL_STATUS}${r.source_top_row}`, values: [[statusLabel]] },
    { range: `'${r.source_sheet_name}'!${COL_MOTIVO}${r.source_top_row}`, values: [[fields.reason ?? ""]] },
    { range: `'${r.source_sheet_name}'!${COL_ACAO}${r.source_top_row}`, values: [[fields.action ?? ""]] },
    { range: `'${r.source_sheet_name}'!${COL_RESP}${r.source_top_row}`, values: [[fields.responsible_legacy_name ?? ""]] },
    { range: `'${r.source_sheet_name}'!${COL_PRAZO}${r.source_top_row}`, values: [[fields.operational_deadline ?? ""]] },
  ]);
}

export async function writebackFinancial(admin: AdminClient, cfg: GoogleConfig, receivableId: string, fields: {
  planned_project: number; planned_innovatis: number; received_project: number; received_innovatis: number;
}) {
  const { data: r, error } = await admin.from("receivables").select("source_sheet_name, source_top_row, source_received_row").eq("id", receivableId).single();
  if (error || !r?.source_sheet_name || !r.source_top_row) throw new Error("Recebível sem vínculo com a planilha (source_sheet_name/source_top_row ausentes).");
  const token = await accessToken(cfg);
  const writes = [
    { range: `'${r.source_sheet_name}'!${COL_PL_PROJETO}${r.source_top_row}`, values: [[String(fields.planned_project)]] },
    { range: `'${r.source_sheet_name}'!${COL_PL_INNOVATIS}${r.source_top_row}`, values: [[String(fields.planned_innovatis)]] },
  ];
  if (r.source_received_row) {
    writes.push({ range: `'${r.source_sheet_name}'!${COL_PL_PROJETO}${r.source_received_row}`, values: [[String(fields.received_project)]] });
    writes.push({ range: `'${r.source_sheet_name}'!${COL_PL_INNOVATIS}${r.source_received_row}`, values: [[String(fields.received_innovatis)]] });
  }
  await sheetsValuesBatchUpdate(cfg, token, writes);
}
```

- [ ] **Passo 2: Implementar `supabase/functions/update-receivable-operational/index.ts`**

```typescript
// FASE 3 — update-receivable-operational
// Contrato: ver src/integrations/receivables-source/types.ts e docs/fase-3-google-sheets.md.
// Write-back: escreve colunas I-M da linha "prevista" (nunca N, O, Q). Falha vira sync_queue.
import { requireMasterAdmin } from "../_shared/auth.ts";
import { json, loadConfig } from "../_shared/google.ts";
import { writebackOperational } from "../_shared/writeback.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try { await requireMasterAdmin(req); } catch (e) { return json({ error: (e as Error).message }, 401); }
  const cfg = loadConfig();
  if ("missing" in cfg) return json({ error: `Configuração pendente: secrets ausentes (${cfg.missing.join(", ")})` }, 503);
  const body = await req.json();
  const { id, collection_status_id, responsible_legacy_name, operational_deadline, reason, action } = body;
  if (!id) return json({ error: "id obrigatório" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    await writebackOperational(admin, cfg, id, { collection_status_id, responsible_legacy_name, operational_deadline, reason, action });
    await admin.from("sync_queue").update({ status: "done", processed_at: new Date().toISOString() }).eq("receivable_id", id).eq("status", "pending").eq("operation", "writeback_operational");
    return json({ ok: true });
  } catch (e) {
    await admin.from("sync_queue").update({ status: "error", last_error: (e as Error).message, attempts: 1 }).eq("receivable_id", id).eq("status", "pending").eq("operation", "writeback_operational");
    return json({ error: (e as Error).message }, 500);
  }
});
```

- [ ] **Passo 3: Implementar `supabase/functions/update-receivable-financial/index.ts`** (mesmo padrão, campos financeiros)

```typescript
// FASE 3 — update-receivable-financial
// Contrato: ver src/integrations/receivables-source/types.ts e docs/fase-3-google-sheets.md.
// Write-back: escreve colunas G/H das linhas prevista e recebida. Falha vira sync_queue.
import { requireMasterAdmin } from "../_shared/auth.ts";
import { json, loadConfig } from "../_shared/google.ts";
import { writebackFinancial } from "../_shared/writeback.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try { await requireMasterAdmin(req); } catch (e) { return json({ error: (e as Error).message }, 401); }
  const cfg = loadConfig();
  if ("missing" in cfg) return json({ error: `Configuração pendente: secrets ausentes (${cfg.missing.join(", ")})` }, 503);
  const body = await req.json();
  const { id, planned_project, planned_innovatis, received_project, received_innovatis } = body;
  if (!id) return json({ error: "id obrigatório" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    await writebackFinancial(admin, cfg, id, { planned_project, planned_innovatis, received_project, received_innovatis });
    return json({ ok: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
```

- [ ] **Passo 4: Testar manualmente contra a cópia** — pegar o `id` de um recebível importado na Task 6 e:

```sql
select id, source_sheet_name, source_top_row from public.receivables limit 1;
```

```bash
curl -s -X POST "http://127.0.0.1:55321/functions/v1/update-receivable-operational" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"id":"<uuid-encontrado>","collection_status_id":null,"responsible_legacy_name":"Teste Write-back","operational_deadline":null,"reason":"Teste","action":"Teste"}'
```

Expected: `{"ok":true}` — e conferir na planilha de teste (aba/linha correspondente) que a coluna L mudou para "Teste Write-back".

- [ ] **Passo 5: Commit**

```bash
git add supabase/functions/_shared/writeback.ts supabase/functions/update-receivable-operational/index.ts supabase/functions/update-receivable-financial/index.ts
git commit -m "feat: implementa write-back operacional e financeiro pra planilha"
```

---

## Task 8: `process-sync-queue`

**Files:**
- Modify: `supabase/functions/process-sync-queue/index.ts`

Drena `sync_queue` (itens pendentes criados por `rpc_update_receivable_operational`), reusando o mesmo `writebackOperational` da Task 7.

- [ ] **Passo 1: Implementar**

```typescript
// FASE 3 — process-sync-queue
// Contrato: ver src/integrations/receivables-source/types.ts e docs/fase-3-google-sheets.md.
// Drena sync_queue (writeback_operational), no máximo 20 por chamada. Roda via cron externo ou manual.
import { requireMasterAdmin } from "../_shared/auth.ts";
import { json, loadConfig } from "../_shared/google.ts";
import { writebackOperational } from "../_shared/writeback.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try { await requireMasterAdmin(req); } catch (e) { return json({ error: (e as Error).message }, 401); }
  const cfg = loadConfig();
  if ("missing" in cfg) return json({ error: `Configuração pendente: secrets ausentes (${cfg.missing.join(", ")})` }, 503);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: pending } = await admin.from("sync_queue").select("*").eq("status", "pending").order("created_at").limit(20);

  let processed = 0, errors = 0;
  for (const item of pending ?? []) {
    await admin.from("sync_queue").update({ status: "processing" }).eq("id", item.id);
    try {
      const p = item.payload as Record<string, unknown>;
      await writebackOperational(admin, cfg, item.receivable_id, {
        collection_status_id: p.collection_status_id as string | null, responsible_legacy_name: p.responsible_legacy_name as string | null,
        operational_deadline: p.operational_deadline as string | null, reason: p.reason as string | null, action: p.action as string | null,
      });
      await admin.from("sync_queue").update({ status: "done", processed_at: new Date().toISOString() }).eq("id", item.id);
      processed++;
    } catch (e) {
      await admin.from("sync_queue").update({ status: "error", last_error: (e as Error).message, attempts: item.attempts + 1 }).eq("id", item.id);
      errors++;
    }
  }
  return json({ processed, errors, remaining: (pending?.length ?? 0) - processed - errors });
});
```

- [ ] **Passo 2: Testar** — editar um recebível via `salvarOperacional` (Server Action já existente) num recebível `source_type='google_sheets'`, confirmar que virou uma linha em `sync_queue` (`status='pending'`), depois:

```bash
curl -s -X POST "http://127.0.0.1:55321/functions/v1/process-sync-queue" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <TOKEN>"
```

Expected: `{"processed":1,"errors":0,"remaining":0}` e a célula correspondente atualizada na planilha de teste.

- [ ] **Passo 3: Commit**

```bash
git add supabase/functions/process-sync-queue/index.ts
git commit -m "feat: implementa process-sync-queue (drena write-back pendente)"
```

---

## Task 9: `synchronize-google-sheets`

**Files:**
- Modify: `supabase/functions/synchronize-google-sheets/index.ts`

Recalcula o hash de cada recebível já importado; se mudou na planilha e não há edição local pendente (`sync_status != 'pending'`), atualiza e audita como "Alteração externa"; se há edição local pendente, marca `conflict`.

- [ ] **Passo 1: Implementar**

```typescript
// FASE 3 — synchronize-google-sheets
// Contrato: ver src/integrations/receivables-source/types.ts e docs/fase-3-google-sheets.md.
// Recalcula source_hash; sem edição local pendente -> aplica mudança externa; com edição local
// pendente -> marca conflict (resolve-sync-conflict decide depois).
import { requireMasterAdmin } from "../_shared/auth.ts";
import { accessToken, json, loadConfig, sheetsGet, stableHash } from "../_shared/google.ts";
import { parseSheetRows, type RangeSheet } from "../_shared/sheetParser.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  let ctx;
  try { ctx = await requireMasterAdmin(req); } catch (e) { return json({ error: (e as Error).message }, 401); }
  const cfg = loadConfig();
  if ("missing" in cfg) return json({ error: `Configuração pendente: secrets ausentes (${cfg.missing.join(", ")})` }, 503);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: sheetsMap } = await admin.from("sheet_competence_map").select("sheet_name").eq("active", true);
  const { data: run } = await admin.from("sync_runs").insert({ type: "synchronize", started_by: ctx.user.id }).select("id").single();
  const runId = run!.id;
  const result = { runId, read: 0, created: 0, updated: 0, ignored: 0, errors: 0, conflicts: 0 };

  const token = await accessToken(cfg, "https://www.googleapis.com/auth/spreadsheets.readonly");
  for (const sm of sheetsMap ?? []) {
    let rowData: RangeSheet["data"];
    try {
      const range = `?ranges=${encodeURIComponent(`'${sm.sheet_name}'!A1:R2000`)}&fields=${encodeURIComponent("sheets(data.rowData.values(formattedValue))")}&includeGridData=true`;
      const res = await sheetsGet<{ sheets?: RangeSheet[] }>(cfg, token, range);
      rowData = res.sheets?.[0]?.data ?? [];
    } catch { result.errors++; continue; }
    const { projects } = parseSheetRows(rowData[0]?.rowData ?? []);

    for (const p of projects) {
      if (!p.idCobranca) continue;
      result.read++;
      const hash = await stableHash([p.tipo, p.hub, p.min, p.inst, p.fund, p.nome, p.plProjeto, p.plInnovatis, p.recProjeto, p.recInnovatis, p.statusLabel, p.motivo, p.acao, p.responsavel, p.prazo]);
      const { data: existing } = await admin.from("receivables").select("id, source_hash, sync_status, source_version").eq("id", p.idCobranca).maybeSingle();
      if (!existing) { result.ignored++; continue; } // linha nova — cabe ao import-google-sheets, não ao synchronize
      if (existing.source_hash === hash) { result.ignored++; continue; } // nada mudou

      if (existing.sync_status === "pending") {
        await admin.from("receivables").update({ sync_status: "conflict" }).eq("id", p.idCobranca);
        result.conflicts++;
        continue;
      }

      await admin.rpc("audit_ctx", { action: "external_change", metadata: { source: "google_sheets", sheet: sm.sheet_name } });
      await admin.from("receivables").update({
        planned_project: p.plProjeto ?? 0, planned_innovatis: p.plInnovatis ?? 0, received_project: p.recProjeto, received_innovatis: p.recInnovatis,
        reason: p.motivo || null, action: p.acao || null, responsible_legacy_name: p.responsavel || null,
        source_hash: hash, source_version: existing.source_version + 1, sync_status: "synchronized",
      }).eq("id", p.idCobranca);
      result.updated++;
    }
  }

  await admin.from("sync_runs").update({
    finished_at: new Date().toISOString(), status: result.errors ? "partial" : "success",
    records_read: result.read, records_updated: result.updated, records_ignored: result.ignored,
    records_with_errors: result.errors, conflicts: result.conflicts,
  }).eq("id", runId);

  return json(result);
});
```

- [ ] **Passo 2: Testar** — na planilha de TESTE, editar manualmente uma célula (ex: coluna J "Motivo" de um projeto) sem passar pela plataforma, depois:

```bash
curl -s -X POST "http://127.0.0.1:55321/functions/v1/synchronize-google-sheets" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <TOKEN>"
```

Expected: `updated: 1` e o campo `reason` do recebível correspondente refletindo o novo valor no Postgres.

- [ ] **Passo 3: Testar conflito** — editar um recebível pela plataforma (`salvarOperacional`, fica `sync_status='pending'` até o `process-sync-queue` rodar) E editar a MESMA linha na planilha antes do write-back acontecer, depois rodar `synchronize-google-sheets`. Expected: `conflicts: 1`, `sync_status` do recebível vira `conflict`.

- [ ] **Passo 4: Commit**

```bash
git add supabase/functions/synchronize-google-sheets/index.ts
git commit -m "feat: implementa synchronize-google-sheets (detecta mudanca externa e conflito)"
```

---

## Task 10: `resolve-sync-conflict`

**Files:**
- Modify: `supabase/functions/resolve-sync-conflict/index.ts`

Recebe `receivable_id` + `resolution` (`keep_platform` | `keep_sheet`). `keep_platform` força o `process-sync-queue` a reenviar o valor da plataforma; `keep_sheet` aceita o valor externo (mesmo caminho do `synchronize`).

- [ ] **Passo 1: Implementar**

```typescript
// FASE 3 — resolve-sync-conflict
// Contrato: ver src/integrations/receivables-source/types.ts e docs/fase-3-google-sheets.md.
// resolution: "keep_platform" reenfileira o write-back; "keep_sheet" aceita o valor da planilha.
import { requireMasterAdmin } from "../_shared/auth.ts";
import { accessToken, json, loadConfig, sheetsGet, stableHash } from "../_shared/google.ts";
import { parseSheetRows, type RangeSheet } from "../_shared/sheetParser.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try { await requireMasterAdmin(req); } catch (e) { return json({ error: (e as Error).message }, 401); }
  const cfg = loadConfig();
  if ("missing" in cfg) return json({ error: `Configuração pendente: secrets ausentes (${cfg.missing.join(", ")})` }, 503);
  const { receivable_id, resolution } = await req.json();
  if (!receivable_id || !["keep_platform", "keep_sheet"].includes(resolution)) return json({ error: "receivable_id e resolution ('keep_platform'|'keep_sheet') obrigatórios" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: r, error } = await admin.from("receivables").select("*").eq("id", receivable_id).single();
  if (error || !r) return json({ error: "Recebível não encontrado." }, 404);
  if (r.sync_status !== "conflict") return json({ error: "Este recebível não está em conflito." }, 400);

  if (resolution === "keep_platform") {
    await admin.from("sync_queue").insert({ receivable_id, operation: "writeback_operational", payload: {
      collection_status_id: r.collection_status_id, responsible_legacy_name: r.responsible_legacy_name,
      operational_deadline: r.operational_deadline, reason: r.reason, action: r.action, version: r.source_version,
    } });
    await admin.from("receivables").update({ sync_status: "pending" }).eq("id", receivable_id);
    return json({ ok: true, resolution, queued: true });
  }

  // keep_sheet: relê a linha atual da planilha e aplica, igual ao synchronize
  const token = await accessToken(cfg, "https://www.googleapis.com/auth/spreadsheets.readonly");
  const range = `?ranges=${encodeURIComponent(`'${r.source_sheet_name}'!A1:R2000`)}&fields=${encodeURIComponent("sheets(data.rowData.values(formattedValue))")}&includeGridData=true`;
  const res = await sheetsGet<{ sheets?: RangeSheet[] }>(cfg, token, range);
  const { projects } = parseSheetRows(res.sheets?.[0]?.data?.[0]?.rowData ?? []);
  const p = projects.find((x) => x.idCobranca === receivable_id);
  if (!p) return json({ error: "Linha não encontrada na planilha (ID_COBRANCA ausente)." }, 404);

  const hash = await stableHash([p.tipo, p.hub, p.min, p.inst, p.fund, p.nome, p.plProjeto, p.plInnovatis, p.recProjeto, p.recInnovatis, p.statusLabel, p.motivo, p.acao, p.responsavel, p.prazo]);
  await admin.rpc("audit_ctx", { action: "conflict_resolved_keep_sheet" });
  await admin.from("receivables").update({
    planned_project: p.plProjeto ?? 0, planned_innovatis: p.plInnovatis ?? 0, received_project: p.recProjeto, received_innovatis: p.recInnovatis,
    reason: p.motivo || null, action: p.acao || null, responsible_legacy_name: p.responsavel || null,
    source_hash: hash, source_version: r.source_version + 1, sync_status: "synchronized",
  }).eq("id", receivable_id);
  return json({ ok: true, resolution });
});
```

- [ ] **Passo 2: Testar** com o conflito gerado no Passo 3 da Task 9 — chamar com `resolution:"keep_sheet"` e depois (gerando outro conflito da mesma forma) com `resolution:"keep_platform"`, confirmar os dois caminhos.

- [ ] **Passo 3: Commit**

```bash
git add supabase/functions/resolve-sync-conflict/index.ts
git commit -m "feat: implementa resolve-sync-conflict (keep_platform / keep_sheet)"
```

---

## Task 11: Ligar o frontend

**Files:**
- Create: `src/services/syncActions.ts`
- Modify: `src/components/auditoria/sincronizacoes.tsx`
- Modify: `src/app/(app)/auditoria/page.tsx`

Os botões "Sincronizar agora"/"Tentar novamente" hoje são `disabled`. Liga via Server Actions (nunca supabase-js no componente, por regra do projeto).

- [ ] **Passo 1: Criar `src/services/syncActions.ts`**

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { exigirPapel } from "./authService";
import { receivablesSource } from "@/integrations/receivables-source";
import { createClient } from "@/lib/supabase/server";

export async function rodarPreview() {
  await exigirPapel("master_admin");
  try { return { ok: true as const, data: await receivablesSource.previewImport() }; }
  catch (e) { return { ok: false as const, erro: (e as Error).message }; }
}
export async function rodarImportacao() {
  await exigirPapel("master_admin");
  try { const data = await receivablesSource.importData(); revalidatePath("/auditoria"); return { ok: true as const, data }; }
  catch (e) { return { ok: false as const, erro: (e as Error).message }; }
}
export async function rodarSincronizacao() {
  await exigirPapel("master_admin");
  try { const data = await receivablesSource.synchronize(); revalidatePath("/auditoria"); return { ok: true as const, data }; }
  catch (e) { return { ok: false as const, erro: (e as Error).message }; }
}
export async function reprocessarFila() {
  await exigirPapel("master_admin");
  const s = await createClient();
  const { data, error } = await s.functions.invoke("process-sync-queue");
  if (error) return { ok: false as const, erro: error.message };
  revalidatePath("/auditoria");
  return { ok: true as const, data };
}
```

- [ ] **Passo 2: Modificar `src/components/auditoria/sincronizacoes.tsx`** para virar Client Component com os botões chamando as Server Actions (troca `disabled` por `onClick`, adiciona estado de loading simples):

```typescript
"use client";
import { useTransition } from "react";
import { Pendente } from "@/components/ui/basicos";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fmtDataHora } from "@/lib/format";
import type { SyncRun } from "@/types/domain";
import { rodarSincronizacao, reprocessarFila } from "@/services/syncActions";

const dur = (a: string, b: string | null) => (b ? `${Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000)}s` : "—");

export const Sincronizacoes = ({ runs, fila, fonte }: { runs: SyncRun[]; fila: number; fonte: { configured: boolean; healthy: boolean; message: string } }) => {
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-3">
      <div className="panel px-4 py-3">
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          <span className="font-semibold">Google Sheets</span>{fonte.configured ? <Badge tom={fonte.healthy ? "green" : "red"}>{fonte.healthy ? "Acessível" : "Erro"}</Badge> : <Pendente />}<span className="text-ink-muted">{fonte.message}</span>
          <span className="ml-auto text-ink-muted">Pendentes na fila: <b className="num">{fila}</b></span>
          <Button size="sm" disabled={pending || !fonte.healthy} onClick={() => startTransition(async () => { await rodarSincronizacao(); })}>Sincronizar agora</Button>
          <Button size="sm" variant="outline" disabled={pending || fila === 0} onClick={() => startTransition(async () => { await reprocessarFila(); })}>Tentar novamente</Button>
        </div>
        <p className="mt-2 text-[11.5px] text-ink-faint">Sincronização, importação e write-back são implementados nas Edge Functions da FASE 3 (health-check, preview, initialize, import, synchronize, process-sync-queue, resolve-sync-conflict). Secrets necessários: <code>GOOGLE_SERVICE_ACCOUNT_JSON</code>, <code>GOOGLE_SPREADSHEET_ID</code>.</p>
      </div>
      <div className="panel"><div className="panel-head"><span className="panel-title">Execuções</span></div>
        {runs.length === 0 ? <p className="px-4 py-8 text-center text-[13px] text-ink-faint">Nenhuma sincronização executada.</p> : <table className="tbl"><thead><tr><th>Tipo</th><th>Status</th><th>Início</th><th>Fim</th><th>Duração</th><th className="num">Lidos</th><th className="num">Criados</th><th className="num">Atualizados</th><th className="num">Ignorados</th><th className="num">Erros</th><th className="num">Conflitos</th><th>Erro</th></tr></thead><tbody>
          {runs.map((r) => <tr key={r.id}><td>{r.type}</td><td><Badge tom={r.status === "success" ? "green" : r.status === "error" ? "red" : "orange"}>{r.status}</Badge></td><td>{fmtDataHora(r.started_at)}</td><td>{fmtDataHora(r.finished_at)}</td><td>{dur(r.started_at, r.finished_at)}</td><td className="num">{r.records_read}</td><td className="num">{r.records_created}</td><td className="num">{r.records_updated}</td><td className="num">{r.records_ignored}</td><td className="num">{r.records_with_errors}</td><td className="num">{r.conflicts}</td><td className="max-w-[240px] truncate text-danger" title={r.error_message ?? ""}>{r.error_message ?? "—"}</td></tr>)}
        </tbody></table>}
      </div>
    </div>
  );
};
```

Nota: `initialize-google-sheets` e `import-google-sheets` **não** ganham botão aqui de propósito — são operações de setup/corte, feitas manualmente via curl (Task 5/6) ou por um botão futuro com confirmação explícita adicional, nunca no fluxo rotineiro de "Sincronizar agora".

- [ ] **Passo 3: Testar no navegador** — abrir `/auditoria?tab=sincronizacoes` logado como `admin@teste.local`, clicar "Sincronizar agora", confirmar que a tabela de Execuções ganha uma linha nova sem recarregar a página manualmente.

- [ ] **Passo 4: Commit**

```bash
git add src/services/syncActions.ts src/components/auditoria/sincronizacoes.tsx
git commit -m "feat: liga botoes de sincronizacao da FASE 3 no frontend"
```

---

## Task 12: Corte para a planilha real de produção

**Files:**
- Modify: `supabase/functions/.env` (troca `GOOGLE_SPREADSHEET_ID` de volta pra produção)

Só rodar depois que as Tasks 1–11 estiverem 100% verdes contra a planilha de teste (`1lW3SM1Z8avcmayqtwGgNclON548Br4ItlxiLmRnm_VA`). **O ID da planilha REAL de produção ainda não foi informado nesta sessão — obter com o usuário/time antes do Passo 4.**

- [ ] **Passo 1:** Confirmar com o time/gestor que pode rodar em produção agora (mesmo processo de aprovação já seguido pra criar a Service Account).
- [ ] **Passo 2:** Pegar o ID real da planilha de produção (trecho da URL entre `/d/` e `/edit`) e, nela, compartilhar `sheets-sync@gestaodecobrancas.iam.gserviceaccount.com` como **Editor** (hoje ela nem tem acesso nenhum à planilha real).
- [ ] **Passo 3:** Proteger a futura coluna técnica: Dados → Proteger planilhas e intervalos, ainda não dá pra proteger a coluna R especificamente antes dela existir — repetir este passo depois do Passo 5, restringindo edição só à Service Account (ou só a Master Admins, se a Service Account não puder ser alvo direto de uma regra de proteção — testar qual opção o Google oferece).
- [ ] **Passo 4:** Atualizar `supabase/functions/.env` com o ID real obtido no Passo 2:

```
GOOGLE_SPREADSHEET_ID=<id-real-de-producao>
```

- [ ] **Passo 5:** Reiniciar functions, rodar `initialize-google-sheets` (Task 5, Passo 2) contra produção agora.
- [ ] **Passo 6:** Proteger a coluna R recém-criada (voltar ao Passo 3).
- [ ] **Passo 7:** Rodar `import-google-sheets` (Task 6, Passo 2) contra produção.
- [ ] **Passo 8:** Reconciliação manual — comparar os totais por HUB/fase que a aba `Dashboard` mostra com os totais nas views (`v_receivables_enriched` agregada) — tolerância de R$ 0,01, sem corrigir silenciosamente nenhuma divergência encontrada (registrar como issue e decidir com o time).
- [ ] **Passo 9:** Decidir o destino da planilha de teste `1lW3SM1Z8avcmayqtwGgNclON548Br4ItlxiLmRnm_VA` (apagar ou manter como sandbox pra testes futuros).
- [ ] **Passo 10:** Commit final:

```bash
git add supabase/functions/.env
git commit -m "chore: aponta FASE 3 para a planilha de producao apos validacao completa"
```

(Nota: `supabase/functions/.env` está no `.gitignore` — este commit não deve gerar diff nenhum; o passo existe só como checklist de confirmação, não como ação de git real.)
