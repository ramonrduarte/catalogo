const express = require("express");
const axios   = require("axios");
const puppeteer = require("puppeteer");
const Database  = require("better-sqlite3");
const sharp     = require("sharp");
const path = require("path");
const fs   = require("fs");

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Banco de dados ───────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new Database(path.join(dataDir, "catalogo.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE, synced_at TEXT);
`);

function getSetting(key)        { return db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value; }
function setSetting(key, value) { db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").run(key, value); }

// ─── Settings API ─────────────────────────────────────────────────────────────
app.get("/api/settings", (_req, res) => {
  res.json({
    url_tray:      getSetting("url_tray")      || "",
    consumer_key:  getSetting("consumer_key")  || "",
    consumer_code: getSetting("consumer_code") || "",
    has_secret:  !!getSetting("consumer_secret"),
    has_refresh: !!getSetting("refresh_token"),
  });
});

app.post("/api/settings", (req, res) => {
  const { url_tray, consumer_key, consumer_secret, consumer_code, refresh_token } = req.body;
  if (url_tray)        setSetting("url_tray",       url_tray.trim());
  if (consumer_key)    setSetting("consumer_key",   consumer_key.trim());
  if (consumer_secret) setSetting("consumer_secret", consumer_secret.trim());
  if (consumer_code)   setSetting("consumer_code",  consumer_code.trim());
  if (refresh_token)   setSetting("refresh_token",  refresh_token.trim());
  res.json({ ok: true });
});

// ─── Tray Auth ────────────────────────────────────────────────────────────────
async function trayAuth(url_tray, params) {
  const resp = await axios.post(
    `https://${url_tray}/auth`,
    new URLSearchParams(params),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return resp.data;
}

// Obtém (ou renova) o access_token e persiste no banco.
// Tenta refresh_token primeiro; se falhar volta para autenticação via code.
async function ensureToken() {
  const url_tray        = getSetting("url_tray");
  const consumer_key    = getSetting("consumer_key");
  const consumer_secret = getSetting("consumer_secret");
  const consumer_code   = getSetting("consumer_code");
  const refresh_token   = getSetting("refresh_token");

  if (!url_tray || !consumer_key || !consumer_secret || !consumer_code) {
    throw new Error("Configurações incompletas. Acesse o menu de configurações.");
  }

  let data;
  try {
    const params = { consumer_key, consumer_secret, code: consumer_code };
    if (refresh_token) params.refresh_token = refresh_token;
    data = await trayAuth(url_tray, params);
  } catch (err) {
    // Refresh inválido — tenta só com code
    if (refresh_token && err.response?.status === 400) {
      console.warn("[TOKEN] refresh_token inválido, tentando com code...");
      setSetting("refresh_token", "");
      data = await trayAuth(url_tray, { consumer_key, consumer_secret, code: consumer_code });
    } else {
      throw err;
    }
  }

  const token = data.access_token || data.token;
  if (!token) throw new Error("Token não retornado: " + JSON.stringify(data));

  if (data.refresh_token) setSetting("refresh_token", data.refresh_token);
  setSetting("access_token", token);
  console.log("[TOKEN] renovado com sucesso");
  return token;
}

app.post("/api/tray/connect", async (req, res) => {
  try {
    const token = await ensureToken();
    res.json({ ok: true, token });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data || err.message;
    console.error("[CONNECT]", status, JSON.stringify(detail));
    res.status(status).json({ error: err.message, detail });
  }
});

// ─── Camada HTTP para Tray com auto-retry em 401 ─────────────────────────────
async function trayGet(url, params = {}) {
  let token = getSetting("access_token");

  const doRequest = (t) =>
    axios.get(url, { params: { ...params, access_token: t } });

  try {
    const resp = await doRequest(token);
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      console.warn("[TRAY] 401 recebido, renovando token...");
      token = await ensureToken();
      const resp = await doRequest(token);
      return resp.data;
    }
    throw err;
  }
}

// ─── Paginação Tray ───────────────────────────────────────────────────────────
// A API retorna: { paging: { total, page, limit }, <PascalCaseKey>: [...] }
async function fetchAllPages(baseUrl, extraParams = {}) {
  let page = 1;
  let totalPages = null;
  const all = [];

  do {
    const body = await trayGet(baseUrl, { ...extraParams, page, limit: 50 });

    // Detecta total de páginas na primeira resposta
    if (totalPages === null) {
      const paging = body.paging;
      if (!paging) throw new Error(`Sem paginação em ${baseUrl}: ${JSON.stringify(body).slice(0, 200)}`);
      const total = parseInt(paging.total, 10) || 0;
      const limit = parseInt(paging.limit, 10) || 50;
      totalPages = total > 0 ? Math.ceil(total / limit) : 1;
      console.log(`[PAGE] ${baseUrl.split("/").pop()} → total=${total} pages=${totalPages}`);
    }

    // Chave PascalCase contém o array de dados (Products, Variants, Categories…)
    const key = Object.keys(body).find((k) => /^[A-Z]/.test(k) && Array.isArray(body[k]));
    if (key) all.push(...body[key]);

    page++;
  } while (page <= totalPages);

  return all;
}

// ─── Debug: ver resposta bruta de qualquer endpoint Tray ─────────────────────
app.get("/api/debug-raw", async (req, res) => {
  const url_tray = getSetting("url_tray");
  const endpoint = req.query.endpoint || "categories";
  if (!url_tray) return res.status(400).json({ error: "Não configurado." });
  try {
    const body = await trayGet(`https://${url_tray}/${endpoint}`, { page: 1, limit: 5 });
    res.json({ keys: Object.keys(body), body });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ─── Tray: sincronizar categorias ────────────────────────────────────────────
app.post("/api/tray/sync-categorias", async (req, res) => {
  const url_tray = getSetting("url_tray");
  if (!url_tray) return res.status(400).json({ error: "Não configurado. Abra as configurações." });

  try {
    const raw = await fetchAllPages(`https://${url_tray}/categories`);
    console.log("[CAT] total bruto:", raw.length, "| primeiro:", JSON.stringify(raw[0]).slice(0, 200));

    const now = new Date().toISOString();
    db.prepare("DELETE FROM categories").run();
    const insert = db.prepare("INSERT OR IGNORE INTO categories(name, synced_at) VALUES(?,?)");

    let count = 0;
    for (const item of raw) {
      const cat = item?.Category;
      if (!cat) continue;
      // Apenas categorias principais (parent_id vazio, "0" ou 0)
      const parentId = cat.parent_id ?? cat.parent ?? "";
      if (parentId !== "" && parentId !== "0" && parentId !== 0) continue;
      const name = cat.name || cat.description;
      if (name) { insert.run(name.trim(), now); count++; }
    }

    res.json({ ok: true, count });
  } catch (err) {
    console.error("[SYNC-CAT]", err.message, err.response?.data);
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ─── Categorias salvas no banco ───────────────────────────────────────────────
app.get("/api/categorias", (_req, res) => {
  const rows = db.prepare("SELECT name FROM categories ORDER BY name").all();
  res.json({ categorias: rows.map((r) => r.name) });
});

// ─── Tray: buscar todos os produtos ──────────────────────────────────────────
async function buscarTodosProdutos(filtroCategoria) {
  const url_tray = getSetting("url_tray");
  const base     = `https://${url_tray}`;

  const [rawProdutos, rawVariantes] = await Promise.all([
    fetchAllPages(`${base}/products`),
    fetchAllPages(`${base}/products/variants`),
  ]);

  console.log(`[FETCH] ${rawProdutos.length} produtos brutos, ${rawVariantes.length} variantes brutas`);

  const produtos = rawProdutos
    .filter((p) => p?.Product && String(p.Product.has_variation) === "0" && String(p.Product.is_kit) === "0")
    .map((p) => mapProduto(p.Product));

  const variantes = rawVariantes
    .filter((v) => v?.Variant)
    .map((v) => mapVariante(v.Variant));

  console.log(`[FETCH] ${produtos.length} simples + ${variantes.length} variantes`);

  if (produtos.length > 0) {
    const first = rawProdutos.find((p) => p?.Product)?.Product;
    console.log(`[FETCH-SAMPLE] url="${first?.url?.http}" → categoria="${produtos[0].categoria}"`);
  }

  let todos = [...produtos, ...variantes];

  if (filtroCategoria && filtroCategoria !== "todas") {
    const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
    const filtroNorm = norm(filtroCategoria);
    todos = todos.filter((p) => norm(p.categoria) === filtroNorm);
    console.log(`[FETCH] após filtro "${filtroCategoria}": ${todos.length} itens`);
  }

  return todos;
}

app.post("/api/tray/produtos", async (req, res) => {
  const { categoria } = req.body;
  try {
    const produtos = await buscarTodosProdutos(categoria);
    res.json({ produtos });
  } catch (err) {
    console.error("[PRODUTOS]", err.message);
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ─── Redimensionar imagens externas para base64 ───────────────────────────────
// Substitui src="https://..." por data URIs JPEG 120×120 / 75% qualidade.
// Isso reduz drasticamente o tamanho do PDF sem perda visual perceptível.
async function inlinearImagens(html, maxSide = 150, quality = 75) {
  const imgRegex = /src="(https?:\/\/[^"]+)"/g;
  const urls = new Set();
  for (const m of html.matchAll(imgRegex)) urls.add(m[1]);

  const cache = {};
  await Promise.all([...urls].map(async (url) => {
    try {
      const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 12000 });
      const buf = await sharp(Buffer.from(resp.data))
        .resize(maxSide, maxSide, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .jpeg({ quality })
        .toBuffer();
      cache[url] = `data:image/jpeg;base64,${buf.toString("base64")}`;
    } catch (_) {
      cache[url] = url; // mantém original se falhar
    }
  }));

  return html.replace(/src="(https?:\/\/[^"]+)"/g, (_, url) => `src="${cache[url] || url}"`);
}

// ─── Gerar PDF ────────────────────────────────────────────────────────────────
app.post("/api/pdf", async (req, res) => {
  const { html } = req.body;
  let browser;
  const tmpFile = path.join(dataDir, `tmp_${Date.now()}.html`);
  try {
    // Reduz imagens antes de passar ao Puppeteer (principal causa do tamanho grande)
    const htmlOtimizado = await inlinearImagens(html);

    fs.writeFileSync(tmpFile, htmlOtimizado, "utf8");

    const opts = {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

    browser = await puppeteer.launch(opts);
    const page = await browser.newPage();

    const fileUrl = "file:///" + tmpFile.replace(/\\/g, "/");
    // networkidle0 não é necessário: imagens já estão inline (sem requests externos)
    await page.goto(fileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
    });

    res.set("Content-Type", "application/pdf");
    res.send(Buffer.from(pdf));
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
});

// ─── Helpers de mapeamento ────────────────────────────────────────────────────
function slugToTitle(slug) {
  return slug
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\./g, "").replace(/-/g, " ")
    .split(" ")
    .map((p, i) => {
      const lower = ["de","e","da","do","das","dos","para","a","o","em"];
      return (i > 0 && lower.includes(p.toLowerCase()))
        ? p.toLowerCase()
        : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    })
    .join(" ")
    .trim();
}

// URL Tray: https://dominio.com.br/[cat]/[sub]/[subsub]/produto
// split('/'): [0]="" [1]="" [2]="dominio.com.br" [3]=cat [4]=sub? [5]=subsub? [último]=produto
// O último segmento é sempre o slug do produto — nunca deve ser retornado como categoria.
function extrairSegmento(url, idx) {
  if (!url) return "";
  const parts = url.split("?")[0].split("/");
  const lastIdx = parts.length - 1; // índice do slug do produto
  if (idx >= lastIdx) return "";    // seria o produto, não uma categoria
  const seg = parts[idx];
  return seg ? slugToTitle(seg) : "";
}

function mapProduto(p) {
  const url = p.url?.http || "";
  return {
    codigo:          p.reference || "",
    preco:           parseFloat(p.price) || 0,
    imagem:          p.ProductImage?.[0]?.http || "",
    descricao:       p.name || "",
    categoria:       extrairSegmento(url, 3),
    subcategoria:    extrairSegmento(url, 4),
    subsubcategoria: extrairSegmento(url, 5),
  };
}

function mapVariante(v) {
  const url  = v.url?.http || "";
  const slug = url.split("/").pop()?.split("?")[0] || "";
  const sku  = v.Sku?.[0]?.value || "";
  const desc = slugToTitle(slug) + (sku ? " " + sku : "");
  return {
    codigo:          v.reference || "",
    preco:           parseFloat(v.price) || 0,
    imagem:          v.VariantImage?.[0]?.http || "",
    descricao:       desc.trim(),
    categoria:       extrairSegmento(url, 3),
    subcategoria:    extrairSegmento(url, 4),
    subsubcategoria: extrairSegmento(url, 5),
  };
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Catálogo em http://localhost:${PORT}`));
