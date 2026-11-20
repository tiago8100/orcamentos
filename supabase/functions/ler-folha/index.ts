// Orçamentos Auto — função do servidor (no Supabase chama-se "quick-processor")
// 1) Leitura das folhas: envia o pedido da app ao Gemini com a chave guardada no segredo GEMINI_API_KEY.
// 2) Gestão de utilizadores (só administradores): criar, repor password, desativar, reativar e eliminar.
// As chaves nunca chegam aos telemóveis.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
const URL_SB = Deno.env.get("SUPABASE_URL")!;

// Chave de serviço (só existe no servidor)
function serviceKey(): string {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  try { const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return all.default ?? Object.values(all)[0] ?? ""; }
  catch { return ""; }
}
function svcHeaders(): Record<string, string> {
  const k = serviceKey();
  const h: Record<string, string> = { apikey: k, "Content-Type": "application/json" };
  if (!k.startsWith("sb_")) h.Authorization = `Bearer ${k}`;   // chave antiga (JWT)
  return h;
}

async function adminAction(callerId: string, p: Record<string, unknown>) {
  if (!serviceKey()) return json({ error: { message: "Falta a chave de serviço no servidor." } }, 500);
  // quem pede tem de ser administrador ativo
  const pr = await fetch(`${URL_SB}/rest/v1/perfis?id=eq.${callerId}&select=papel,ativo`, { headers: svcHeaders() });
  const me = pr.ok ? (await pr.json())?.[0] : null;
  if (!me || me.papel !== "admin" || me.ativo === false) return json({ error: { message: "Só um administrador pode gerir utilizadores." } }, 403);

  const action = String(p.action);
  const id = p.id ? String(p.id).replace(/[^a-f0-9-]/gi, "") : "";
  if ((action === "desativar" || action === "eliminar") && id === callerId) return json({ error: { message: action === "eliminar" ? "Não te podes eliminar a ti próprio." : "Não te podes desativar a ti próprio." } }, 400);

  if (action === "criar") {
    const email = String(p.email ?? "").trim(), password = String(p.password ?? ""), nome = String(p.nome ?? "").trim();
    if (!email || password.length < 6) return json({ error: { message: "Indica o email e uma password com pelo menos 6 caracteres." } }, 400);
    const r = await fetch(`${URL_SB}/auth/v1/admin/users`, { method: "POST", headers: svcHeaders(),
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { nome: nome || email.split("@")[0] } }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: { message: /already|exists|registered/i.test(JSON.stringify(j)) ? "Já existe um utilizador com esse email." : (j.msg || j.message || "Não foi possível criar o utilizador.") } }, r.status);
    return json({ id: j.id ?? j.user?.id });
  }
  if (!id) return json({ error: { message: "Falta o utilizador." } }, 400);
  if (action === "password") {
    const password = String(p.password ?? "");
    if (password.length < 6) return json({ error: { message: "A password tem de ter pelo menos 6 caracteres." } }, 400);
    const r = await fetch(`${URL_SB}/auth/v1/admin/users/${id}`, { method: "PUT", headers: svcHeaders(), body: JSON.stringify({ password }) });
    return r.ok ? json({ ok: true }) : json({ error: { message: "Não foi possível mudar a password." } }, r.status);
  }
  if (action === "desativar" || action === "reativar") {
    const ativo = action === "reativar";
    const r = await fetch(`${URL_SB}/auth/v1/admin/users/${id}`, { method: "PUT", headers: svcHeaders(),
      body: JSON.stringify({ ban_duration: ativo ? "none" : "876000h" }) });
    if (!r.ok) return json({ error: { message: "Não foi possível alterar o acesso." } }, r.status);
    await fetch(`${URL_SB}/rest/v1/perfis?id=eq.${id}`, { method: "PATCH", headers: svcHeaders(), body: JSON.stringify({ ativo }) });
    return json({ ok: true, ativo });
  }
  if (action === "eliminar") {
    const destino = p.destino ? String(p.destino).replace(/[^a-f0-9-]/gi, "") : null;
    // 1. orçamentos: passam para outro utilizador ou são apagados
    const r1 = await fetch(`${URL_SB}/rest/v1/rpc/eliminar_utilizador`, { method: "POST", headers: svcHeaders(),
      body: JSON.stringify({ alvo: id, destino }) });
    const res = await r1.json().catch(() => ({}));
    if (!r1.ok) return json({ error: { message: res.message || "Não foi possível tratar os orçamentos deste utilizador." } }, r1.status);
    // 2. fotos e exportações
    const fich: string[] = res.ficheiros ?? [];
    for (let i = 0; i < fich.length; i += 500) {
      await fetch(`${URL_SB}/storage/v1/object/fotos`, { method: "DELETE", headers: svcHeaders(),
        body: JSON.stringify({ prefixes: fich.slice(i, i + 500) }) });
    }
    // 3. a conta (o perfil e as partilhas saem com ela)
    const r3 = await fetch(`${URL_SB}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: svcHeaders() });
    if (!r3.ok) return json({ error: { message: "Os orçamentos foram tratados, mas não foi possível apagar a conta. Tenta outra vez." } }, r3.status);
    return json({ ok: true, orcamentos: res.orcamentos ?? 0, ficheiros: fich.length });
  }
  return json({ error: { message: "Ação desconhecida." } }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: { message: "Método não permitido" } }, 405);

  // 1. Só utilizadores com sessão iniciada
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const apikey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const r0 = await fetch(`${URL_SB}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey } });
  const user = r0.ok ? await r0.json() : null;
  if (!user?.id) return json({ error: { message: "Sessão inválida. Entra outra vez na app." } }, 401);

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: { message: "Pedido inválido" } }, 400); }

  // 2. Gestão de utilizadores
  if (payload.action) return adminAction(user.id, payload);

  // 3. Leitura da folha pelo Gemini
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: { message: "Falta configurar o segredo GEMINI_API_KEY no Supabase." } }, 500);
  const model = String(payload.model || "gemini-flash-latest").replace(/^models\//, "").replace(/[^a-zA-Z0-9.\-]/g, "");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(payload.body ?? {}),
  });
  return json(await r.text(), r.status);
});
