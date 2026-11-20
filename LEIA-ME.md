# Orçamentos Auto

App para o telemóvel: fotografa um orçamento de oficina, o Gemini (plano gratuito) lê-o e a app mostra as peças, a mão de obra e os totais. Avisa quando as somas não batem certo com a folha e guarda tudo no telemóvel. Dá para exportar em CSV para o Excel.

## 1. Chave gratuita do Gemini
1. Vai a https://aistudio.google.com/apikey e entra com a tua conta Google.
2. Carrega em "Create API key" e copia a chave (começa por `AIza…`).

## 2. Pôr a app online (grátis, GitHub Pages)

**A) Criar o repositório**
1. Em github.com, carrega no **+** (canto superior direito) e escolhe **New repository**.
2. Em *Repository name* escreve `orcamentos`.
3. Escolhe **Public**. O GitHub Pages grátis só funciona com repositórios públicos.
4. Carrega em **Create repository**.

**B) Enviar os ficheiros**
1. Na página do repositório, carrega no link **uploading an existing file**, ou em **Add file → Upload files**.
2. Abre a pasta `orcamentos-app` no computador, seleciona **os ficheiros que estão lá dentro** (index.html, sw.js, manifest.webmanifest, os 3 ícones .png e o LEIA-ME.md) e arrasta-os para a página.
   - ⚠️ Arrasta os ficheiros e não a pasta. O `index.html` tem de ficar logo na raiz do repositório.
3. Em baixo, carrega no botão verde **Commit changes**.

**C) Ligar o GitHub Pages**
1. No topo do repositório, carrega no separador **⚙️ Settings**. É o último separador, à direita de *Code, Issues, Pull requests…*
2. No menu da esquerda, na secção *Code and automation*, carrega em **Pages**.
3. Em **Build and deployment**:
   - *Source*: deixa **Deploy from a branch**.
   - *Branch*: no primeiro menu (diz *None*), escolhe **main**. No segundo, deixa **/ (root)**.
   - Carrega em **Save**.
4. Espera 1 a 2 minutos e atualiza a página (F5). Aparece no topo **"Your site is live at https://<o-teu-utilizador>.github.io/orcamentos/"**, com o botão **Visit site**.
5. É esse endereço que abres no telemóvel.

Se o link der erro 404, espera mais um minuto. Se continuar, confirma que o `index.html` aparece na lista de ficheiros do repositório e não dentro de uma pasta.

Alternativa sem conta GitHub: em https://app.netlify.com/drop, arrasta esta pasta para a página.

## 3. Instalar no Android
1. Abre o endereço no Chrome do telemóvel.
2. No menu ⋮, escolhe "Instalar app" (ou "Adicionar ao ecrã principal").
3. Abre a app, vai a ⚙️ Definições e cola a chave do Gemini.

## Notas
- O modelo predefinido é `gemini-flash-latest`. Se o Google o mudar, troca-o nas Definições.
- A chave fica guardada só no telemóvel. Para mais segurança, restringe a chave ao teu endereço do GitHub Pages na Google Cloud Console (APIs & Services → Credentials → Website restrictions).
- No plano gratuito, o Google pode usar as imagens enviadas para melhorar os seus produtos.
- Os dados ficam só no telemóvel. Usa "Cópia de segurança" nas Definições de vez em quando.
