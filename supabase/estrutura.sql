-- =====================================================================
-- Orçamentos Auto — estrutura da base de dados (Supabase)
-- Correr no Supabase: SQL Editor → New query → colar tudo → Run
-- Pode ser corrido outra vez sem perder dados (atualiza a estrutura e as regras).
-- =====================================================================

-- ---------- 1. Perfis de utilizador ----------------------------------
create table if not exists public.perfis (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  nome       text,
  papel      text not null default 'utilizador' check (papel in ('admin','utilizador')),
  criado_em  timestamptz not null default now()
);
alter table public.perfis add column if not exists ativo boolean not null default true;

-- É administrador?
create or replace function public.e_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfis where id = auth.uid() and papel = 'admin');
$$;

-- Cada utilizador novo recebe um perfil. O PRIMEIRO fica administrador.
create or replace function public.novo_utilizador() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into perfis (id, email, nome, papel)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'nome', split_part(new.email, '@', 1)),
          case when exists (select 1 from perfis where papel = 'admin') then 'utilizador' else 'admin' end);
  return new;
end $$;
drop trigger if exists ao_criar_utilizador on auth.users;
create trigger ao_criar_utilizador after insert on auth.users
  for each row execute function public.novo_utilizador();

-- Só um administrador muda perfis; ninguém muda id/email por aqui.
create or replace function public.perfis_regras() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.papel is distinct from old.papel and not e_admin() then
    raise exception 'Só um administrador pode mudar perfis.';
  end if;
  if new.id <> old.id or new.email is distinct from old.email then
    raise exception 'Alteração não permitida.';
  end if;
  return new;
end $$;
drop trigger if exists perfis_regras on public.perfis;
create trigger perfis_regras before update on public.perfis
  for each row execute function public.perfis_regras();

alter table public.perfis enable row level security;
drop policy if exists "ver perfis" on public.perfis;
create policy "ver perfis" on public.perfis for select to authenticated using (true);
drop policy if exists "alterar perfis" on public.perfis;
create policy "alterar perfis" on public.perfis for update to authenticated
  using (id = auth.uid() or e_admin()) with check (id = auth.uid() or e_admin());

-- ---------- 2. Orçamentos --------------------------------------------
create table if not exists public.orcamentos (
  id                  uuid primary key default gen_random_uuid(),
  dados               jsonb not null default '{}'::jsonb,   -- oficina, viatura, peças, mão de obra, etc.
  fotos               text[] not null default '{}',         -- caminhos no armazenamento "fotos"
  data                date,
  matricula           text,
  validado            boolean not null default false,
  estado              text not null default 'orcamento' check (estado in ('orcamento','aprovado','pago')),
  validado_em         timestamptz, validado_por        uuid references public.perfis(id),
  aprovado_em         timestamptz, aprovado_por        uuid references public.perfis(id),
  pago_em             date,        pago_registado_por  uuid references public.perfis(id),
  criado_em           timestamptz not null default now(),
  criado_por          uuid references public.perfis(id),
  atualizado_em       timestamptz not null default now(),
  atualizado_por      uuid references public.perfis(id)
);
alter table public.orcamentos add column if not exists teste boolean not null default false;            -- dados de teste (só administradores)
alter table public.orcamentos add column if not exists partilhado_todos boolean not null default false; -- visível a todos os utilizadores
create index if not exists orcamentos_data on public.orcamentos (data);
create index if not exists orcamentos_criado_por on public.orcamentos (criado_por);
create index if not exists orcamentos_matricula on public.orcamentos (matricula);

-- Histórico: quem fez o quê e quando
create table if not exists public.historico (
  id            bigint generated always as identity primary key,
  orcamento_id  uuid not null references public.orcamentos(id) on delete cascade,
  acao          text not null,
  por           uuid references public.perfis(id),
  em            timestamptz not null default now()
);
create index if not exists historico_orcamento on public.historico (orcamento_id);

-- Partilhas: com quem cada orçamento é partilhado
create table if not exists public.partilhas (
  orcamento_id   uuid not null references public.orcamentos(id) on delete cascade,
  utilizador_id  uuid not null references public.perfis(id) on delete cascade,
  primary key (orcamento_id, utilizador_id)
);
create or replace function public.e_dono(orc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from orcamentos where id = orc and criado_por = auth.uid());
$$;
alter table public.partilhas enable row level security;
drop policy if exists "ver partilhas" on public.partilhas;
create policy "ver partilhas" on public.partilhas for select to authenticated using (true);
drop policy if exists "criar partilhas" on public.partilhas;
create policy "criar partilhas" on public.partilhas for insert to authenticated with check (e_admin() or e_dono(orcamento_id));
drop policy if exists "apagar partilhas" on public.partilhas;
create policy "apagar partilhas" on public.partilhas for delete to authenticated using (e_admin() or e_dono(orcamento_id));

-- Regras do fluxo: A validar → Validado → Aprovado → Pago (+ Reabrir só pelo administrador)
create or replace function public.orc_regras() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ant text; nov text; adm boolean := e_admin(); acao text;
begin
  -- operações internas do servidor (ex.: eliminar um utilizador e passar os orçamentos para outro)
  if current_setting('orcamentos.sistema', true) = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    new.criado_por := auth.uid(); new.criado_em := now();
    new.atualizado_por := auth.uid(); new.atualizado_em := now();
    new.validado := false; new.estado := 'orcamento';
    new.teste := coalesce(new.teste,false) and adm;   -- só administradores criam dados de teste
    new.validado_em := null; new.validado_por := null;
    new.aprovado_em := null; new.aprovado_por := null;
    new.pago_em := null; new.pago_registado_por := null;
    return new;
  end if;

  ant := case when old.estado = 'pago' then 'pago' when old.estado = 'aprovado' then 'aprovado'
              when old.validado then 'validado' else 'a validar' end;
  nov := case when new.estado = 'pago' then 'pago' when new.estado = 'aprovado' then 'aprovado'
              when new.validado then 'validado' else 'a validar' end;

  if ant <> nov then
    acao := case
      when ant = 'a validar' and nov = 'validado'            then 'validou'
      when ant = 'validado'  and nov = 'aprovado'  and adm   then 'aprovou'
      when ant = 'aprovado'  and nov = 'pago'      and adm   then 'marcou como pago'
      when ant = 'pago'      and nov = 'aprovado'  and adm   then 'reabriu (pago → aprovado)'
      when ant = 'aprovado'  and nov = 'validado'  and adm   then 'reabriu (aprovado → validado)'
      when ant = 'validado'  and nov = 'a validar' and adm   then 'reabriu (validado → a validar)'
      else null end;
    if acao is null then
      raise exception 'Sem permissão para passar de "%" para "%".', ant, nov;
    end if;
    -- só uma mudança de estado de cada vez; os dados não mudam ao mesmo tempo
    new.dados := old.dados; new.fotos := old.fotos; new.data := old.data; new.matricula := old.matricula;
    -- carimbos automáticos (não podem ser forjados pela app)
    new.validado_em := old.validado_em; new.validado_por := old.validado_por;
    new.aprovado_em := old.aprovado_em; new.aprovado_por := old.aprovado_por;
    if nov = 'validado' and ant = 'a validar' then new.validado_em := now(); new.validado_por := auth.uid(); end if;
    if nov = 'aprovado' and ant = 'validado'  then new.aprovado_em := now(); new.aprovado_por := auth.uid(); end if;
    if nov = 'pago' then
      new.pago_registado_por := auth.uid();
      if new.pago_em is null then new.pago_em := current_date; end if;
    else
      new.pago_em := null; new.pago_registado_por := null;
    end if;
    if ant = 'aprovado' and nov = 'validado' then new.aprovado_em := null; new.aprovado_por := null; end if;
    if nov = 'a validar' then new.validado_em := null; new.validado_por := null; end if;
    insert into historico (orcamento_id, acao, por) values (new.id, acao, auth.uid());
  else
    -- (exceção: o administrador pode apagar as fotos de orçamentos fechados, na limpeza de dados antigos)
    if ant <> 'a validar' and (new.dados is distinct from old.dados
                               or (new.fotos is distinct from old.fotos and not (adm and cardinality(new.fotos) = 0))
                               or new.data is distinct from old.data or new.matricula is distinct from old.matricula) then
      raise exception 'Orçamento bloqueado (%). Reabre-o para alterar.', ant;
    end if;
    new.validado_em := old.validado_em; new.validado_por := old.validado_por;
    new.aprovado_em := old.aprovado_em; new.aprovado_por := old.aprovado_por;
    new.pago_em := old.pago_em; new.pago_registado_por := old.pago_registado_por;
  end if;

  new.criado_por := old.criado_por; new.criado_em := old.criado_em; new.teste := old.teste;
  new.atualizado_em := now(); new.atualizado_por := auth.uid();
  return new;
end $$;
drop trigger if exists orc_regras on public.orcamentos;
create trigger orc_regras before insert or update on public.orcamentos
  for each row execute function public.orc_regras();

create or replace function public.orc_criado() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into historico (orcamento_id, acao, por) values (new.id, 'criou', auth.uid());
  return new;
end $$;
drop trigger if exists orc_criado on public.orcamentos;
create trigger orc_criado after insert on public.orcamentos
  for each row execute function public.orc_criado();

alter table public.orcamentos enable row level security;
drop policy if exists "ver orcamentos" on public.orcamentos;
create policy "ver orcamentos" on public.orcamentos for select to authenticated using (
  e_admin()
  or (not teste and (criado_por = auth.uid() or partilhado_todos
      or exists (select 1 from public.partilhas p where p.orcamento_id = orcamentos.id and p.utilizador_id = auth.uid())))
);
drop policy if exists "criar orcamentos" on public.orcamentos;
create policy "criar orcamentos" on public.orcamentos for insert to authenticated with check (true);
drop policy if exists "alterar orcamentos" on public.orcamentos;
create policy "alterar orcamentos" on public.orcamentos for update to authenticated
  using (e_admin() or criado_por = auth.uid()) with check (e_admin() or criado_por = auth.uid());
-- Apagar: pagos só pelo administrador e só se tiverem mais de 1 ano (limpeza);
--         outros: administrador, ou quem criou enquanto ainda está "a validar".
drop policy if exists "apagar orcamentos" on public.orcamentos;
create policy "apagar orcamentos" on public.orcamentos for delete to authenticated using (
  (teste and e_admin())
  or (estado = 'pago' and e_admin() and coalesce(data, criado_em::date) < current_date - interval '1 year')
  or (estado <> 'pago' and (e_admin() or (criado_por = auth.uid() and not validado and estado = 'orcamento')))
);

alter table public.historico enable row level security;
drop policy if exists "ver historico" on public.historico;
create policy "ver historico" on public.historico for select to authenticated
  using (exists (select 1 from public.orcamentos o where o.id = historico.orcamento_id));

-- ---------- 3. Memória de viaturas (matrícula → marca/modelo) ----------
create table if not exists public.viaturas (
  matricula       text primary key,
  marca           text,
  modelo          text,
  atualizado_em   timestamptz not null default now(),
  atualizado_por  uuid references public.perfis(id) default auth.uid()
);
alter table public.viaturas enable row level security;
drop policy if exists "ver viaturas" on public.viaturas;
create policy "ver viaturas" on public.viaturas for select to authenticated using (true);
drop policy if exists "criar viaturas" on public.viaturas;
create policy "criar viaturas" on public.viaturas for insert to authenticated with check (true);
drop policy if exists "alterar viaturas" on public.viaturas;
create policy "alterar viaturas" on public.viaturas for update to authenticated using (true) with check (true);

-- ---------- 4. Fotos (armazenamento privado) -------------------------
insert into storage.buckets (id, name, public) values ('fotos', 'fotos', false) on conflict (id) do nothing;
drop policy if exists "ver fotos" on storage.objects;
create policy "ver fotos" on storage.objects for select to authenticated using (bucket_id = 'fotos' and (
  e_admin() or owner_id = auth.uid()::text
  or (name not like 'exportacoes/%' and exists (select 1 from public.orcamentos o where o.id::text = split_part(name, '/', 1)))));
drop policy if exists "enviar fotos" on storage.objects;
create policy "enviar fotos" on storage.objects for insert to authenticated with check (bucket_id = 'fotos');
drop policy if exists "apagar fotos" on storage.objects;
create policy "apagar fotos" on storage.objects for delete to authenticated using (bucket_id = 'fotos' and (
  e_admin() or owner_id = auth.uid()::text
  or (name not like 'exportacoes/%' and exists (select 1 from public.orcamentos o where o.id::text = split_part(name, '/', 1) and o.criado_por = auth.uid()))));

-- ---------- 5. Espaço usado (para o indicador na app) -----------------
create or replace function public.espaco_usado() returns json
language sql stable security definer set search_path = public, storage as $$
  select json_build_object(
    'base_dados_bytes', pg_database_size(current_database()),
    'fotos_bytes', coalesce((select sum((metadata->>'size')::bigint) from storage.objects where bucket_id = 'fotos'), 0)
  );
$$;
revoke all on function public.espaco_usado() from public, anon;
grant execute on function public.espaco_usado() to authenticated;

-- ---------- 6. Acesso pela API (só utilizadores com sessão iniciada) ---
grant usage on schema public to authenticated;
grant select, update                 on public.perfis     to authenticated;
grant select, insert, update, delete on public.orcamentos to authenticated;
grant select                         on public.historico  to authenticated;
grant select, insert, update         on public.viaturas   to authenticated;
grant select, insert, delete         on public.partilhas  to authenticated;
revoke all on public.perfis, public.orcamentos, public.historico, public.viaturas, public.partilhas from anon;

-- ---------- 7. Eliminar utilizadores (só pelo servidor, a pedido de um administrador) ----------
-- Guarda o nome de quem foi eliminado, para o histórico continuar a mostrar quem validou/aprovou/pagou.
create table if not exists public.ex_utilizadores (
  id            uuid primary key,
  nome          text,
  email         text,
  eliminado_em  timestamptz not null default now()
);
alter table public.ex_utilizadores enable row level security;
drop policy if exists "ver ex utilizadores" on public.ex_utilizadores;
create policy "ver ex utilizadores" on public.ex_utilizadores for select to authenticated using (true);
grant select on public.ex_utilizadores to authenticated;
revoke all on public.ex_utilizadores from anon;

-- Os carimbos (validado/aprovado/pago/atualizado por, histórico, viaturas) deixam de depender do perfil existir.
alter table public.orcamentos drop constraint if exists orcamentos_validado_por_fkey;
alter table public.orcamentos drop constraint if exists orcamentos_aprovado_por_fkey;
alter table public.orcamentos drop constraint if exists orcamentos_pago_registado_por_fkey;
alter table public.orcamentos drop constraint if exists orcamentos_atualizado_por_fkey;
alter table public.historico  drop constraint if exists historico_por_fkey;
alter table public.viaturas   drop constraint if exists viaturas_atualizado_por_fkey;

-- destino = null → apaga os orçamentos do utilizador; destino = outro utilizador → passam a ser dele.
-- Devolve os ficheiros a apagar do armazenamento (a função do servidor apaga-os e depois apaga a conta).
create or replace function public.eliminar_utilizador(alvo uuid, destino uuid default null) returns json
language plpgsql security definer set search_path = public, storage as $$
declare
  n_alvo text; e_alvo text; n_dest text; n int := 0; fich text[] := '{}';
begin
  select coalesce(nome, email), email into n_alvo, e_alvo from perfis where id = alvo;
  if n_alvo is null then raise exception 'Esse utilizador não existe.'; end if;
  if destino is not null then
    if destino = alvo then raise exception 'Escolhe outro utilizador para receber os orçamentos.'; end if;
    select coalesce(nome, email) into n_dest from perfis where id = destino and ativo;
    if n_dest is null then raise exception 'O utilizador que vai receber os orçamentos não existe ou está desativado.'; end if;
  end if;

  perform set_config('orcamentos.sistema', 'on', true);
  insert into ex_utilizadores (id, nome, email) values (alvo, n_alvo, e_alvo)
    on conflict (id) do update set nome = excluded.nome, email = excluded.email, eliminado_em = now();

  if destino is not null then
    insert into historico (orcamento_id, acao, por)
      select id, 'passou de ' || n_alvo || ' para ' || n_dest || ' (utilizador eliminado)', null from orcamentos where criado_por = alvo;
    update orcamentos set criado_por = destino where criado_por = alvo;
    get diagnostics n = row_count;
    -- já não faz sentido partilhar com o próprio dono
    delete from partilhas p using orcamentos o where p.orcamento_id = o.id and o.criado_por = destino and p.utilizador_id = destino;
  else
    select coalesce(array_agg(name), '{}') into fich from storage.objects
      where bucket_id = 'fotos' and name not like 'exportacoes/%'
        and split_part(name, '/', 1) in (select id::text from orcamentos where criado_por = alvo);
    delete from orcamentos where criado_por = alvo;
    get diagnostics n = row_count;
  end if;
  -- exportações de Excel feitas por esse utilizador
  fich := fich || coalesce((select array_agg(name) from storage.objects
            where bucket_id = 'fotos' and name like 'exportacoes/%' and owner_id = alvo::text), '{}');
  return json_build_object('orcamentos', n, 'ficheiros', fich, 'nome', n_alvo, 'destino', n_dest);
end $$;
revoke all on function public.eliminar_utilizador(uuid, uuid) from public, anon, authenticated;
grant execute on function public.eliminar_utilizador(uuid, uuid) to service_role;
