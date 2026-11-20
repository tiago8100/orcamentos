// Orçamentos Auto — função "ler-folha"
// Recebe o pedido da app, confirma que vem de um utilizador com sessão iniciada
// e envia-o ao Gemini com a chave guardada no segredo GEMINI_API_KEY.
// A chave nunca chega aos telemóveis.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: { message: "Método não permitido" } }, 405);

  // 1. Só utilizadores com sessão iniciada
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return json({ error: { message: "Sessão inválida. Entra outra vez na app." } }, 401);

  // 2. Chave do Gemini (segredo do projeto)
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: { message: "Falta configurar o segredo GEMINI_API_KEY no Supabase." } }, 500);

  // 3. Reencaminhar para o Gemini
  let payload: { model?: string; body?: unknown };
  try { payload = await req.json(); } catch { return json({ error: { message: "Pedido inválido" } }, 400); }
  const model = String(payload.model || "gemini-flash-latest").replace(/^models\//, "").replace(/[^a-zA-Z0-9.\-]/g, "");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(payload.body ?? {}),
  });
  return json(await r.text(), r.status);
});
