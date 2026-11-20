# Orçamentos Auto

App para o telemóvel: fotografa um orçamento de oficina, o Gemini (plano gratuito) lê-o e a app mostra as peças, a mão de obra e os totais. Avisa quando as somas não batem certo com a folha e guarda tudo no telemóvel. Dá para exportar em CSV para o Excel.

## 1. Chave gratuita do Gemini
1. Vai a https://aistudio.google.com/apikey e entra com a tua conta Google.
2. Carrega em "Create API key" e copia a chave (começa por `AIza…`).

## 2. Pôr a app online (grátis, GitHub Pages)
1. Em github.com, cria um repositório novo, por exemplo `orcamentos`.
2. Carrega em "Add file → Upload files" e envia todos os ficheiros desta pasta.
3. Vai a Settings → Pages → Branch: `main` / `(root)` → Save.
4. Passado um minuto, a app fica em `https://<o-teu-utilizador>.github.io/orcamentos/`.

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
