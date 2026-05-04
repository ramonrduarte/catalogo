const el  = (id) => document.getElementById(id);
const show = (id) => (el(id).style.display = "");
const hide = (id) => (el(id).style.display = "none");

function setStatus(id, msg, type = "info") {
  const s = el(id);
  s.textContent = msg;
  s.className = `status ${type}`;
}

function setProgress(pct, msg) {
  el("progress-bar").style.width = `${pct}%`;
  el("progress-msg").textContent = msg;
}

async function api(url, body) {
  const r = await fetch(url, {
    method: body !== undefined ? "POST" : "GET",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    const detail = err.detail ? " — " + JSON.stringify(err.detail) : "";
    throw new Error((err.error || r.statusText) + detail);
  }
  return r;
}

// ─── Modal de configurações ───────────────────────────────────────────────────
el("btn-settings").addEventListener("click", openSettings);
el("btn-close-settings").addEventListener("click", closeSettings);
el("overlay-settings").addEventListener("click", closeSettings);

async function openSettings() {
  show("modal-settings");
  try {
    const r = await api("/api/settings");
    const d = await r.json();
    el("s-url").value     = d.url_tray     || "";
    el("s-key").value     = d.consumer_key || "";
    el("s-code").value    = d.consumer_code || "";
    el("s-refresh").value = "";  // refresh não é retornado por segurança
    if (d.has_secret)  el("s-secret").placeholder  = "••••• (salvo)";
    if (d.has_refresh) el("s-refresh").placeholder = "••••• (salvo)";
  } catch (_) {}
}

function closeSettings() { hide("modal-settings"); }

el("btn-save-settings").addEventListener("click", async () => {
  const body = {
    url_tray:       el("s-url").value.trim(),
    consumer_key:   el("s-key").value.trim(),
    consumer_secret: el("s-secret").value.trim(),
    consumer_code:  el("s-code").value.trim(),
    refresh_token:  el("s-refresh").value.trim(),
  };
  try {
    await api("/api/settings", body);
    setStatus("status-connect", "Configurações salvas.", "ok");
  } catch (err) {
    setStatus("status-connect", "Erro: " + err.message, "error");
  }
});

el("btn-connect").addEventListener("click", async () => {
  el("btn-connect").disabled = true;
  setStatus("status-connect", "Conectando...", "info");
  try {
    const r = await api("/api/tray/connect", {});
    const d = await r.json();
    setStatus("status-connect", "✔ Conectado!", "ok");
    setStatus("status-connect-main", "✔ Conectado com a Tray", "ok");
    closeSettings();
    await carregarCategorias();
  } catch (err) {
    setStatus("status-connect", "Erro: " + err.message, "error");
  } finally {
    el("btn-connect").disabled = false;
  }
});

// ─── Categorias ───────────────────────────────────────────────────────────────
async function carregarCategorias() {
  const r = await api("/api/categorias");
  const { categorias } = await r.json();
  const sel = el("categoria");
  sel.innerHTML = '<option value="todas">Todas</option>';
  for (const cat of categorias) {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    sel.appendChild(opt);
  }
}

el("btn-sync").addEventListener("click", async () => {
  el("btn-sync").disabled = true;
  setStatus("status-connect-main", "Sincronizando categorias...", "info");
  try {
    const r = await api("/api/tray/sync-categorias", {});
    const d = await r.json();
    setStatus("status-connect-main", `✔ ${d.count} categorias sincronizadas`, "ok");
    await carregarCategorias();
  } catch (err) {
    setStatus("status-connect-main", "Erro: " + err.message, "error");
  } finally {
    el("btn-sync").disabled = false;
  }
});

// ─── Gerar catálogo ───────────────────────────────────────────────────────────
el("btn-gerar").addEventListener("click", async () => {
  const tipo      = el("tipo").value;
  const categoria = el("categoria").value;

  el("btn-gerar").disabled = true;
  hide("section-resultado");
  show("progress-area");
  setProgress(5, "Buscando produtos na Tray...");

  try {
    const r = await api("/api/tray/produtos", { categoria });
    const { produtos } = await r.json();
    setProgress(40, `${produtos.length} produtos carregados. Montando HTML...`);

    if (!produtos.length) {
      setProgress(100, "Nenhum produto encontrado para o filtro selecionado.");
      el("btn-gerar").disabled = false;
      return;
    }

    const htmlPorCategoria = gerarHTMLs(produtos, tipo);
    setProgress(65, "Gerando PDFs...");

    const catalogos = [];
    for (let i = 0; i < htmlPorCategoria.length; i++) {
      const { categoria: cat, html } = htmlPorCategoria[i];
      setProgress(65 + Math.round((i / htmlPorCategoria.length) * 30), `PDF: ${cat}...`);
      const pr = await api("/api/pdf", { html });
      const blob = await pr.blob();
      catalogos.push({ categoria: cat, html, blob });
    }

    setProgress(100, "Concluído!");
    setTimeout(() => hide("progress-area"), 1500);
    renderResultados(catalogos);
    show("section-resultado");
  } catch (err) {
    setProgress(0, "Erro: " + err.message);
  } finally {
    el("btn-gerar").disabled = false;
  }
});

// ─── Resultado ────────────────────────────────────────────────────────────────
function renderResultados(catalogos) {
  const lista = el("lista-catalogos");
  lista.innerHTML = "";
  for (let i = 0; i < catalogos.length; i++) {
    const { categoria, blob, html } = catalogos[i];
    const url = URL.createObjectURL(blob);
    const item = document.createElement("div");
    item.className = "catalogo-item";
    item.innerHTML = `
      <span class="catalogo-nome">${categoria}</span>
      <div class="catalogo-actions">
        <a class="btn-download" href="${url}" download="${categoria}.pdf">&#11015; Baixar PDF</a>
      </div>`;
    lista.appendChild(item);
  }
}

// ─── Geradores de HTML ────────────────────────────────────────────────────────
function gerarHTMLs(produtos, tipo) {
  const porCategoria = agruparPor(produtos, "categoria");
  return Object.entries(porCategoria).map(([cat, itens]) => ({
    categoria: cat,
    html: tipo === "com-preco" ? htmlComPreco(cat, itens)
        : tipo === "sem-preco" ? htmlSemPreco(cat, itens)
        : htmlCards(cat, itens),
  }));
}

function agruparPor(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key] || "Sem Categoria";
    (acc[k] = acc[k] || []).push(item);
    return acc;
  }, {});
}

function ordenar(arr) {
  return [...arr].sort((a, b) => a.descricao.localeCompare(b.descricao, "pt-BR"));
}

const CSS_TABLE = `
  *{box-sizing:border-box}
  body{font-family:Arial,sans-serif;margin:0;padding:20px;color:#1a202c}
  h2{background:#004080;color:#fff;padding:10px 14px;font-size:19px;margin:0 0 14px;
     border-radius:3px;page-break-after:avoid;break-after:avoid}
  h3{color:#004080;font-size:13px;font-weight:700;margin:20px 0 0;
     padding-bottom:3px;border-bottom:2px solid #004080;
     page-break-after:avoid;break-after:avoid}
  h4{font-style:italic;color:#555;font-size:11px;margin:2px 0 0;
     page-break-after:avoid;break-after:avoid}
  table{width:100%;border-collapse:collapse;font-size:11px;
        margin-top:5px;margin-bottom:18px;table-layout:fixed}
  col.c-cod{width:82px}
  col.c-pre{width:88px}
  col.c-img{width:100px}
  th{background:#e6eef7;color:#004080;font-weight:700;text-align:left;
     border:1px solid #c5d5e8;padding:6px 8px}
  td{border:1px solid #dde5ef;padding:5px 8px;vertical-align:middle;
     overflow:hidden;word-break:break-word}
  tr:nth-child(even) td{background:#f5f8fc}
  td.td-img{text-align:center;padding:4px;border-left:1px solid #c5d5e8}
  td img{max-width:88px;max-height:84px;object-fit:contain;
         display:block;margin:0 auto}
  tr{page-break-inside:avoid;break-inside:avoid}
  /* Mantém cabeçalho de seção junto com o início da tabela */
  h3+table,h4+table{page-break-before:avoid;break-before:avoid;margin-top:4px}
`;

// colgroup garante larguras de coluna idênticas em todas as tabelas
function colgroup(ncols) {
  if (ncols === 3) return `<colgroup><col class="c-cod"><col><col class="c-img"></colgroup>`;
  return `<colgroup><col class="c-cod"><col><col class="c-pre"><col class="c-img"></colgroup>`;
}

function buildTable(headers, rows) {
  const ths = headers.map((h) => `<th>${h}</th>`).join("");
  const trs = rows.map((r) =>
    `<tr>${r.map((c, i) => `<td${i === r.length - 1 ? ' class="td-img"' : ""}>${c}</td>`).join("")}</tr>`
  ).join("");
  return `<table>${colgroup(headers.length)}<thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

// Tabela única por seção — colunas sempre alinhadas, sem artefatos visuais.
// Orphan-prevention: CSS break-after:avoid em h3/h4 + break-before:avoid na tabela.
function tableSection(itens, headers, rowFn) {
  const grupos = agruparPor(itens, "subcategoria");
  let out = "";
  for (const [sub, grupo] of Object.entries(grupos)) {
    const subSubs = agruparPor(grupo, "subsubcategoria");
    for (const [subsub, lista] of Object.entries(subSubs)) {
      const sorted = ordenar(lista);
      if (!sorted.length) continue;
      if (sub && sub !== "Sem Categoria")       out += `<h3>${sub}</h3>`;
      if (subsub && subsub !== "Sem Categoria")  out += `<h4>${subsub}</h4>`;
      out += buildTable(headers, sorted.map(rowFn));
    }
  }
  return out;
}

function htmlComPreco(cat, itens) {
  const rows = tableSection(itens,
    ["Código", "Descrição", "Preço (R$)", "Imagem"],
    (p) => [
      p.codigo, p.descricao,
      Number(p.preco).toLocaleString("pt-BR", { minimumFractionDigits: 2 }),
      `<img src="${p.imagem}" alt=""/>`,
    ]
  );
  return `<html><head><meta charset="UTF-8"><style>${CSS_TABLE}</style></head><body><h2>${cat}</h2>${rows}</body></html>`;
}

function htmlSemPreco(cat, itens) {
  const rows = tableSection(itens,
    ["Código", "Descrição", "Imagem"],
    (p) => [p.codigo, p.descricao, `<img src="${p.imagem}" alt=""/>`]
  );
  return `<html><head><meta charset="UTF-8"><style>${CSS_TABLE}</style></head><body><h2>${cat}</h2>${rows}</body></html>`;
}

// Cards: 3 por coluna, CSS controla quebra de página (sem contagem manual)
function htmlCards(cat, itens) {
  const CSS = `
    body{font-family:Arial,sans-serif;margin:20px;padding:0}
    h2{background:#004080;color:#fff;padding:10px 14px;font-size:20px;margin:0 0 16px;
       page-break-after:avoid;break-after:avoid}
    h3{color:#004080;font-size:15px;margin:20px 0 2px;
       page-break-after:avoid;break-after:avoid}
    h4{font-style:italic;color:#666;font-size:12px;margin:2px 0 6px;
       page-break-after:avoid;break-after:avoid}
    .row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px;
         page-break-inside:avoid;break-inside:avoid}
    .card{border:1px solid #ccc;border-radius:5px;padding:8px;text-align:center;background:#fafafa}
    .card img{max-width:100%;max-height:130px;object-fit:contain;margin-bottom:6px}
    .cod{font-weight:700;font-size:12px;margin-bottom:3px}
    .desc{font-size:11px;color:#333}
    /* Wrapper que mantém o cabeçalho colado à primeira linha de cards */
    .secao{page-break-inside:avoid;break-inside:avoid}
  `;

  const grupos = agruparPor(itens, "subcategoria");
  let content = "";

  for (const [sub, grupo] of Object.entries(grupos)) {
    const subSubs = agruparPor(grupo, "subsubcategoria");
    for (const [subsub, lista] of Object.entries(subSubs)) {
      const sorted = ordenar(lista);
      if (!sorted.length) continue;

      // Monta todas as linhas de 3 cards
      const buildRow = (chunk) => {
        const cells = chunk.map((p) =>
          `<div class="card"><img src="${p.imagem}" alt=""/><div class="cod">${p.codigo}</div><div class="desc">${p.descricao}</div></div>`
        ).join("");
        const pad = Array(3 - chunk.length).fill(`<div class="card" style="border:none;background:none"></div>`).join("");
        return `<div class="row">${cells}${pad}</div>`;
      };

      let headerHtml = "";
      if (sub && sub !== "Sem Categoria")       headerHtml += `<h3>${sub}</h3>`;
      if (subsub && subsub !== "Sem Categoria")  headerHtml += `<h4>${subsub}</h4>`;

      // Primeira linha junto com o cabeçalho: nunca ficam separados
      content += `<div class="secao">${headerHtml}${buildRow(sorted.slice(0, 3))}</div>`;

      // Linhas restantes fluem normalmente; CSS evita quebra dentro de cada linha
      for (let i = 3; i < sorted.length; i += 3) {
        content += buildRow(sorted.slice(i, i + 3));
      }
    }
  }

  return `<html><head><style>${CSS}</style></head><body><h2>${cat}</h2>${content}</body></html>`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
carregarCategorias();
