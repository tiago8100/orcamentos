// Orçamentos Auto — função do servidor (no Supabase chama-se "quick-processor")
// 1) Leitura das folhas: envia o pedido da app ao Gemini (segredo GEMINI_API_KEY).
//    Se o Gemini estiver ocupado, usa a Mistral como reserva (segredo MISTRAL_API_KEY, opcional).
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

  // 3. Leitura da folha: Gemini; se estiver ocupado, Mistral como reserva (se houver a chave MISTRAL_API_KEY)
  const fornecedor = String(payload.fornecedor || "auto");
  const temMistral = !!Deno.env.get("MISTRAL_API_KEY");
  if (fornecedor === "mistral") {
    if (!temMistral) return json({ error: { message: "Falta configurar o segredo MISTRAL_API_KEY no Supabase." } }, 500);
    return lerMistral(payload.body as GemBody);
  }
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key && !temMistral) return json({ error: { message: "Falta configurar o segredo GEMINI_API_KEY no Supabase." } }, 500);
  let gStatus = 503, gText = '{"error":{"message":"Sem chave do Gemini"}}';
  if (key) {
    const model = String(payload.model || "gemini-flash-latest").replace(/^models\//, "").replace(/[^a-zA-Z0-9.\-]/g, "");
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(payload.body ?? {}),
      });
      gStatus = r.status; gText = await r.text();
    } catch (e) { gStatus = 503; gText = JSON.stringify({ error: { message: "Sem ligação ao Gemini: " + e } }); }
  }
  const passageiro = [429, 500, 502, 503, 504].includes(gStatus);
  if (passageiro && temMistral && fornecedor !== "gemini") {
    const m = await lerMistral(payload.body as GemBody);
    if (m.ok) return m;
    const mj = await m.json().catch(() => ({}));
    return json({ error: { message: "O Gemini e a Mistral (reserva) estão ocupados neste momento. " + (mj?.error?.message ?? "") } }, gStatus);
  }
  return json(gText, gStatus);
});

/* ---------- Mistral (reserva) ---------- */
type GemPart = { text?: string; inline_data?: { mime_type: string; data: string }; inlineData?: { mimeType: string; data: string } };
type GemBody = { contents?: { parts?: GemPart[] }[]; generationConfig?: { responseSchema?: unknown; temperature?: number } };

// O esquema do Gemini (OBJECT, STRING, nullable…) passa para JSON Schema normal.
function paraJsonSchema(s: any): any {
  if (!s || typeof s !== "object") return s;
  const out: any = {};
  const t = s.type ? String(s.type).toLowerCase() : undefined;
  if (t) out.type = s.nullable ? [t, "null"] : t;
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, paraJsonSchema(v)]));
  if (s.required) out.required = s.required;
  if (s.items) out.items = paraJsonSchema(s.items);
  if (t === "object") out.additionalProperties = false;
  return out;
}

async function lerMistral(body: GemBody): Promise<Response> {
  const key = Deno.env.get("MISTRAL_API_KEY")!;
  const parts = body?.contents?.[0]?.parts ?? [];
  const texto = parts.filter((p) => p.text).map((p) => p.text).join("\n");
  const imagens = parts.filter((p) => p.inline_data || p.inlineData).map((p) => {
    const d = p.inline_data ? { m: p.inline_data.mime_type, b: p.inline_data.data } : { m: p.inlineData!.mimeType, b: p.inlineData!.data };
    return { type: "image_url", image_url: `data:${d.m};base64,${d.b}` };
  });
  const schema = paraJsonSchema(body?.generationConfig?.responseSchema);
  const prompt = texto + (schema ? "\n\nResponde só com um objeto JSON que siga este esquema:\n" + JSON.stringify(schema) : "");
  const modelos = (Deno.env.get("MISTRAL_MODEL") || "mistral-medium-latest,mistral-small-latest").split(",").map((x) => x.trim()).filter(Boolean);
  let ult = { status: 503, text: "" };
  for (const modelo of modelos) {
    for (const rf of schema ? [{ type: "json_schema", json_schema: { name: "orcamento", schema, strict: false } }, { type: "json_object" }] : [{ type: "json_object" }]) {
      let r: Response;
      try {
        r = await fetch("https://api.mistral.ai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: modelo, temperature: 0, response_format: rf,
            messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...imagens] }] }),
        });
      } catch (e) { ult = { status: 503, text: "Sem ligação à Mistral: " + e }; break; }
      const t = await r.text();
      if (r.ok) {
        const j = JSON.parse(t);
        let out = String(j.choices?.[0]?.message?.content ?? "");
        out = out.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
        // devolve no mesmo formato do Gemini, para a app não ter de mudar
        return json({ candidates: [{ content: { parts: [{ text: out }] }, finishReason: j.choices?.[0]?.finish_reason }],
          modelVersion: `${j.model || modelo} (Mistral, reserva)`, usageMetadata: {} });
      }
      ult = { status: r.status, text: t };
      if (r.status === 401) return json({ error: { message: "A chave da Mistral (MISTRAL_API_KEY) não é válida." } }, 500);
      if (r.status !== 400 && r.status !== 422) break;   // formato não aceite → tenta o seguinte; outro erro → muda de modelo
    }
  }
  let msg = ult.text; try { const e = JSON.parse(ult.text); msg = e.message || e.error?.message || msg; } catch { /* texto */ }
  return json({ error: { message: "Mistral: " + String(msg).slice(0, 300) } }, ult.status >= 400 ? ult.status : 503);
}
