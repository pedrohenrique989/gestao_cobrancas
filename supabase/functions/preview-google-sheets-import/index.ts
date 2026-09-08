// FASE 3 — preview-google-sheets-import
// Contrato: ver src/integrations/receivables-source/types.ts e docs/fase-3-google-sheets.md.
// Dry-run: lê as abas ativas de sheet_competence_map, aplica o parser de 2 linhas por projeto,
// classifica fase e conta IDs presentes/ausentes/duplicados. Não escreve nada.
import { requireMasterAdmin } from "../_shared/auth.ts";
import { accessToken, json, loadConfig, sheetsGet } from "../_shared/google.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

interface CellRow { values?: { formattedValue?: string }[] }
interface RangeSheet { data?: { rowData?: CellRow[] }[] }

const COL = { tipo: 0, hub: 1, min: 2, inst: 3, fund: 4, nome: 5, plProjeto: 6, plInnovatis: 7,
  status: 8, motivo: 9, acao: 10, responsavel: 11, prazo: 12, arProjeto: 13, arInnovatis: 14, flag: 15, statusCalc: 16, idCobranca: 17 };
const FASES = new Set(["A", "B", "C", "D"]);

function cell(row: CellRow | undefined, idx: number): string {
  return row?.values?.[idx]?.formattedValue?.trim() ?? "";
}
function isBlankRow(row: CellRow | undefined): boolean {
  return !row?.values?.some((v) => v.formattedValue?.trim());
}
function parseBRL(s: string): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

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

    let sheet: RangeSheet | undefined;
    try {
      const range = `?ranges=${encodeURIComponent(`'${sm.sheet_name}'!A1:R2000`)}&fields=${encodeURIComponent("sheets(data.rowData.values(formattedValue))")}&includeGridData=true`;
      const res = await sheetsGet<{ sheets?: RangeSheet[] }>(cfg, token, range);
      sheet = res.sheets?.[0];
    } catch (e) {
      result.issues.push(`Aba "${sm.sheet_name}": falha ao ler (${(e as Error).message}).`);
      continue;
    }
    const rows = sheet?.data?.[0]?.rowData ?? [];

    // Linha 0 é o cabeçalho. Cada projeto ocupa 1 linha "prevista" (Tipo preenchido) + opcionalmente
    // 1 linha "recebida" logo abaixo (sem Tipo; pode vir em branco quando nada foi recebido ainda).
    // O bloco de totais no fim da aba (coluna Fundação = "TOTAL A/B/C") encerra a leitura da aba.
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (isBlankRow(row)) continue;
      const tipo = cell(row, COL.tipo);
      if (!tipo) {
        if (cell(row, COL.fund).toUpperCase().startsWith("TOTAL")) break;
        result.issues.push(`Aba "${sm.sheet_name}", linha ${i + 1}: sem Tipo e fora de um par esperado — ignorada.`);
        continue;
      }

      const plProjeto = parseBRL(cell(row, COL.plProjeto));
      const plInnovatis = parseBRL(cell(row, COL.plInnovatis));
      const arProjetoPlanilha = parseBRL(cell(row, COL.arProjeto));
      const idCobranca = cell(row, COL.idCobranca);

      let recProjeto = 0, recInnovatis = 0;
      const next = rows[i + 1];
      if (next && !isBlankRow(next) && !cell(next, COL.tipo) && !cell(next, COL.fund).toUpperCase().startsWith("TOTAL")) {
        recProjeto = parseBRL(cell(next, COL.plProjeto)) ?? 0;
        recInnovatis = parseBRL(cell(next, COL.plInnovatis)) ?? 0;
        i++; // consome a linha de recebido
      }

      if (FASES.has(tipo) || mappedCodes.has(tipo)) result.stagesFound[tipo] = (result.stagesFound[tipo] ?? 0) + 1;
      else unmapped.set(tipo, (unmapped.get(tipo) ?? 0) + 1);

      if (plProjeto != null && arProjetoPlanilha != null) {
        const saldoCalculado = Math.max(plProjeto - recProjeto, 0);
        if (Math.abs(saldoCalculado - arProjetoPlanilha) > 0.01) {
          const nome = cell(row, COL.nome) || "sem nome";
          result.issues.push(`Aba "${sm.sheet_name}", linha ${i + 1} (${nome}): saldo da planilha (R$ ${arProjetoPlanilha.toFixed(2)}) diverge do calculado (R$ ${saldoCalculado.toFixed(2)}).`);
        }
      }

      if (idCobranca) { result.idsPresent++; idCounts.set(idCobranca, (idCounts.get(idCobranca) ?? 0) + 1); }
      else result.idsMissing++;
      result.receivables++;
    }
  }

  for (const [code, count] of unmapped) result.issues.push(`Código de fase não mapeado "${code}": ${count} ocorrência(s). Cadastre em legacy_code_mapping.`);
  for (const count of idCounts.values()) if (count > 1) result.duplicates += count - 1;

  return json(result);
});
