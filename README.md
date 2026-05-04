# Gerador de Catálogo — Tray Commerce

Sistema web local que conecta à API da Tray, busca produtos e gera catálogos em PDF em três formatos diferentes. Substitui um fluxo N8N anterior.

---

## Como o sistema funciona (visão geral)

```
Navegador (interface)
    │
    ├─► Configurações (chaves da API Tray) ──► SQLite (banco local)
    │
    ├─► Sincronizar Categorias ──► API Tray /categories ──► SQLite
    │
    └─► Gerar Catálogo
            │
            ├─► API Tray /products        ─┐
            ├─► API Tray /products/variants ├─► filtra ──► monta HTML
            │                              ─┘
            └─► Puppeteer (Chromium)
                    │
                    ├─► baixa e redimensiona imagens (sharp)
                    └─► gera PDF ──► download no navegador
```

---

## Estrutura de arquivos

```
catalogo/
├── server.js          ← backend Node.js/Express (toda a lógica da API)
├── public/
│   ├── index.html     ← interface do usuário
│   ├── app.js         ← lógica do frontend (geração de HTML dos catálogos)
│   └── style.css      ← estilos
├── data/              ← criado automaticamente; contém o banco SQLite
│   └── catalogo.db
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## Banco de dados (SQLite)

O arquivo `data/catalogo.db` é criado automaticamente na primeira execução e tem duas tabelas:

| Tabela       | O que guarda                                                     |
|--------------|------------------------------------------------------------------|
| `settings`   | Chave/valor: URL da loja, consumer_key, consumer_secret, code, access_token, refresh_token |
| `categories` | Lista de categorias principais sincronizadas da Tray             |

As credenciais da API **nunca aparecem na tela** — são gravadas no banco e acessadas só pelo servidor.

---

## Autenticação com a Tray (OAuth2)

A Tray usa um fluxo OAuth2 simplificado com quatro parâmetros enviados via POST form-urlencoded:

```
POST https://{url_loja}/auth
Content-Type: application/x-www-form-urlencoded

consumer_key=...&consumer_secret=...&code=...&refresh_token=...
```

| Campo           | O que é                                                              |
|-----------------|----------------------------------------------------------------------|
| `consumer_key`  | Identificador do app no painel da Tray                               |
| `consumer_secret` | Senha do app                                                       |
| `code`          | Código de instalação permanente do app na loja (não expira)          |
| `refresh_token` | Token de renovação (gerado na primeira autenticação bem-sucedida)    |

**Fluxo de token:**

1. Primeira conexão: envia `consumer_key + consumer_secret + code` → recebe `access_token` + `refresh_token`
2. Conexões seguintes: envia os quatro campos juntos → recebe novos tokens
3. Se o `refresh_token` estiver inválido/expirado, o sistema tenta automaticamente só com `code`
4. Todo `access_token` tem validade curta (~2h); o sistema detecta o erro **401** e renova automaticamente sem intervenção do usuário

---

## Busca de produtos e paginação

A Tray retorna os dados paginados. Cada resposta tem este formato:

```json
{
  "paging": { "total": 350, "page": 1, "limit": 50 },
  "Products": [ {...}, {...} ]
}
```

O sistema calcula `totalPáginas = ceil(total / limit)` e repete as requisições até buscar tudo. São feitas **duas buscas em paralelo**:

- `/products` → produtos simples (sem variação, sem kit)
- `/products/variants` → variantes (ex: tamanho G, M, P de um mesmo produto)

**Filtro aplicado nos produtos simples:**
```
has_variation === "0"  (não tem variações — o produto é único)
is_kit === "0"         (não é um kit de produtos)
```

---

## Como a categoria é extraída

A Tray não retorna o nome da categoria diretamente no produto. A categoria é lida a partir da **URL do produto**:

```
https://adrofecha.com.br / ferramentas-e-acessorios / parafusos / sextavados / parafuso-m8
                            [índice 3 = categoria]    [índice 4]  [índice 5]   [produto]
```

O último segmento da URL é sempre o slug do produto — é ignorado. Os anteriores são categoria, subcategoria e subsubcategoria. O slug é convertido para título legível (ex: `ferramentas-e-acessorios` → `Ferramentas e Acessórios`).

---

## Tipos de catálogo

Toda a geração de HTML acontece no **navegador** (`public/app.js`). O servidor só converte o HTML final em PDF.

| Tipo         | Layout                                                   |
|--------------|----------------------------------------------------------|
| Com Preço    | Tabela: Código, Descrição, Preço (R$), Imagem            |
| Sem Preço    | Tabela: Código, Descrição, Imagem                        |
| Cards        | Grade 3 colunas × 4 linhas por página (12 cards/página) |

Os itens são agrupados por **Categoria → Subcategoria → Subsubcategoria** e ordenados alfabeticamente por descrição dentro de cada grupo.

---

## Geração do PDF

O fluxo no servidor para gerar cada PDF:

1. Recebe o HTML gerado pelo browser via POST `/api/pdf`
2. **Redimensiona as imagens**: baixa cada imagem da CDN da Tray, redimensiona para 150×150px JPEG a 75% de qualidade usando `sharp` e converte para base64 inline — isso reduz o tamanho do PDF de ~50 MB para ~2–5 MB
3. Salva o HTML otimizado em um arquivo temporário em `data/tmp_*.html`
4. Abre o Chromium via Puppeteer, navega para o arquivo via `file:///`
5. Gera o PDF A4 com margens e retorna como binário
6. Apaga o arquivo temporário

---

## Instalação local (desenvolvimento)

**Pré-requisitos:** Node.js 18+ instalado

```bash
git clone https://github.com/ramonrduarte/catalogo.git
cd catalogo
npm install
node server.js
# Acesse http://localhost:3000
```

---

## Instalação via Docker / Portainer

### Variáveis de ambiente

| Variável                    | Padrão                   | Descrição                                     |
|-----------------------------|--------------------------|-----------------------------------------------|
| `PORT`                      | `3000`                   | Porta em que o servidor escuta                |
| `NODE_ENV`                  | `production`             | Modo de execução                              |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium`      | Caminho do Chromium (já definido no Dockerfile) |

As credenciais da Tray (consumer_key, secret, etc.) **não são variáveis de ambiente** — são configuradas pela interface web e salvas no banco SQLite persistido no volume.

### Via Portainer (Stack)

1. No Portainer, acesse **Stacks → Add Stack**
2. Cole o conteúdo do `docker-compose.yml` abaixo:

```yaml
services:
  catalogo:
    image: ghcr.io/ramonrduarte/catalogo:latest
    container_name: catalogo-tray
    ports:
      - "3000:3000"
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - PORT=3000
    volumes:
      - catalogo_data:/app/data

volumes:
  catalogo_data:
    driver: local
```

3. Clique em **Deploy the stack**
4. Acesse `http://<ip-do-servidor>:3000`
5. Clique na engrenagem ⚙ e configure as credenciais da Tray
6. Clique em **Conectar à Tray**
7. Clique em **Sincronizar categorias**
8. Pronto — gere seus catálogos

### Build local e push (para atualizar a imagem)

```bash
docker build -t ghcr.io/ramonrduarte/catalogo:latest .
docker push ghcr.io/ramonrduarte/catalogo:latest
```

---

## Endpoints da API interna

| Método | Rota                        | Descrição                                      |
|--------|-----------------------------|------------------------------------------------|
| GET    | `/api/settings`             | Retorna configurações salvas (sem expor secrets) |
| POST   | `/api/settings`             | Salva configurações da API                     |
| POST   | `/api/tray/connect`         | Obtém/renova o access_token da Tray            |
| POST   | `/api/tray/sync-categorias` | Busca categorias da Tray e salva no banco       |
| GET    | `/api/categorias`           | Lista categorias salvas no banco               |
| POST   | `/api/tray/produtos`        | Busca todos os produtos (com filtro opcional)  |
| POST   | `/api/pdf`                  | Converte HTML em PDF via Puppeteer             |
| GET    | `/api/debug-raw`            | Debug: resposta bruta de qualquer endpoint Tray |

---

## Dependências principais

| Pacote          | Para que serve                                          |
|-----------------|---------------------------------------------------------|
| `express`       | Servidor HTTP e roteamento                              |
| `axios`         | Requisições HTTP para a API da Tray                     |
| `better-sqlite3`| Banco de dados local (credenciais e categorias)         |
| `puppeteer`     | Controla o Chromium para gerar PDFs                     |
| `sharp`         | Redimensiona imagens para reduzir tamanho do PDF        |
