'use strict';
// Notas de versão e manual do usuário, separados por perfil e permissão.
// O FILTRO É FEITO AQUI NO SERVIDOR: cada pessoa só recebe (texto e imagens) o que pode fazer no sistema.
// Um gestor nunca recebe as páginas de configurações, faturamento ou do Master — nem as imagens delas.
//
// audience: { roles: [...] } e/ou { perm: 'x' } (permissão necessária). Master vê tudo.
// Imagens: manual/img/<arquivo> (geradas por scripts/manual-screenshots.js com dados de demonstração).

const VERSION = '2.0.0';

const VERSIONS = [
  {
    version: '2.0.0', date: '2026-10-14', title: 'Plataforma para várias empresas',
    items: [
      { text: 'Novo perfil Master: lista de empresas, cadastro com consulta automática do CNPJ, planos, faturas, saúde do servidor e auditoria da plataforma.', audience: { roles: ['master'] } },
      { text: 'Entrar numa empresa para dar suporte exige um motivo, dura até 2 horas e fica registrado na auditoria dela.', audience: { roles: ['master'] } },
      { text: 'Faturamento pelo Mercado Pago: assinatura no cartão feita pelo administrador; PIX/boleto gerado pelo Master; suspensão automática no fim do 5º dia útil após o vencimento.', audience: { roles: ['master'] } },
      { text: 'Avisos de capacidade do servidor (70% e 90%) por e-mail, para crescer antes de virar problema.', audience: { roles: ['master'] } },
      { text: 'Chaves de acesso (passkeys) e rotação da chave mestra; a auditoria agora detecta alterações feitas fora do sistema.', audience: { roles: ['master'] } },
      { text: 'Cada empresa vê só os próprios dados, com criptografia própria para os contatos dos clientes.', audience: { roles: ['admin'] } },
      { text: 'Permissões liberáveis para gestores: criar unidades, cadastrar gestores, pedidos LGPD e auditoria das próprias unidades.', audience: { perm: 'users.manage' } },
      { text: 'Nova tela "Plano e uso" e "Faturamento": acompanhe os limites do plano, assine no cartão e veja as faturas.', audience: { perm: 'settings.manage' } },
      { text: 'Convite por e-mail: cadastre um usuário e ele mesmo cria a senha pelo link.', audience: { perm: 'users.gestores' } },
      { text: 'Gestor agora pode criar e editar pesquisas (as usadas só nas unidades dele), editar as próprias unidades, ativar o QR Code e agendar campanhas.', audience: { roles: ['gestor', 'admin'] } },
      { text: 'Exclusão em lote de respostas e exclusão de dados pessoais (LGPD) agora pedem a sua senha (e o código do 2FA, se ativo).', audience: { perm: 'responses.delete' } },
      { text: '"Minha conta" mostra os aparelhos conectados (com opção de encerrar) e você recebe um e-mail quando a conta é acessada de um aparelho novo.', audience: {} },
      { text: 'Chaves de acesso (passkeys): entre com a digital, o rosto ou o PIN do aparelho, à prova de sites falsos.', audience: {} },
      { text: 'Novo menu "Manual e novidades", com o passo a passo de tudo o que o seu perfil pode fazer.', audience: {} },
      { text: '"Filiais" passaram a se chamar "Unidades".', audience: { roles: ['gestor', 'admin'] } },
    ],
  },
  {
    version: '1.5.0', date: '2026-10-10', title: 'Localização, dispositivos e fuso por unidade',
    items: [
      { text: 'Respostas pelo QR Code mostram cidade, estado e região (quando o cliente autoriza) e o tipo de aparelho.', audience: { perm: 'dashboard.view' } },
      { text: 'O horário de funcionamento de cada unidade vale no fuso do tablet (automático) ou num fuso fixo.', audience: { perm: 'branches.edit' } },
      { text: 'Auditoria em português simples, com filtros e destaque do que merece atenção.', audience: { perm: 'audit.view' } },
      { text: 'E-mail (SMTP) e WhatsApp configurados pelo painel, com senha e token criptografados.', audience: { perm: 'settings.manage' } },
    ],
  },
];

const IMG = (file, caption) => ({ file, caption });
const SECTIONS = [
  // ---------------------------------------------------------------- todos
  { id: 'primeiro-acesso', group: 'Primeiros passos', title: 'Primeiro acesso e segurança da conta', audience: {},
    intro: 'Seu acesso é pessoal. Use uma senha forte e ative a verificação em duas etapas (2FA).',
    steps: ['Entre com o seu e-mail e senha (ou crie a senha pelo link do convite que chegou por e-mail).',
      'Em "Minha conta", clique em "Ativar 2FA", leia o QR Code com o Google Authenticator ou Microsoft Authenticator e digite o código de 6 dígitos.',
      'Guarde os códigos de recuperação em local seguro: eles servem se você perder o celular.',
      'Opcional: cadastre uma chave de acesso (passkey) para entrar com a digital/rosto do aparelho.',
      'Em "Aparelhos conectados" você vê onde a sua conta está aberta e pode encerrar o que não reconhecer.'],
    images: [IMG('conta.jpg', 'Minha conta: 2FA, notificações, aparelhos conectados e chaves de acesso')],
    tips: ['Recebeu um e-mail de "novo acesso" que não foi você? Troque a senha na hora: isso encerra todas as sessões.'] },

  // ---------------------------------------------------------------- análise
  { id: 'painel', group: 'Análise', title: 'Visão geral (NPS)', audience: { perm: 'dashboard.view' },
    intro: 'O NPS mostra o quanto os clientes recomendam a empresa: % de promotores (notas 9 e 10) menos % de detratores (0 a 6).',
    steps: ['Escolha o período, a unidade, a pesquisa, o canal (tablet ou QR Code) e o estado do cliente nos filtros do topo.',
      'Veja o NPS geral, a evolução por dia, a distribuição das notas, o ranking das unidades com as metas e os comentários.',
      'Use "CSV" para levar as respostas a uma planilha.'],
    images: [IMG('painel.jpg', 'Visão geral com filtros, NPS e gráficos')] },
  { id: 'relatorio', group: 'Análise', title: 'Relatório em PowerPoint', audience: { perm: 'responses.export' },
    steps: ['Na Visão geral, ajuste os filtros e clique em "Exportar PowerPoint".', 'O arquivo vem com gráficos editáveis, logo e cores da empresa.',
      'Para receber toda segunda-feira por e-mail, marque "Relatório semanal" em Minha conta.'],
    tips: ['Se o botão avisar que o recurso não faz parte do plano, fale com o administrador.'] },
  { id: 'respostas', group: 'Análise', title: 'Respostas', audience: { perm: 'dashboard.view' },
    steps: ['Em "Respostas" você vê cada avaliação: data, unidade, local (QR Code), aparelho e as respostas.', 'Os mesmos filtros da Visão geral valem aqui.'],
    images: [IMG('respostas.jpg', 'Lista de respostas com localização e aparelho')] },
  { id: 'excluir-respostas', group: 'Análise', title: 'Excluir respostas (testes)', audience: { perm: 'responses.delete' },
    steps: ['Para uma resposta: botão de lixeira na linha.', 'Para limpar testes: filtre o período/unidade e use "Excluir todas as filtradas", digite EXCLUIR e confirme com a sua senha (e o código do 2FA).'],
    tips: ['Não tem como desfazer. Tudo fica na auditoria.'] },
  { id: 'casos', group: 'Análise', title: 'Casos de clientes insatisfeitos', audience: { perm: 'cases.manage' },
    intro: 'Toda nota de 0 a 6 abre um caso, e os responsáveis pela unidade são avisados.',
    steps: ['Abra "Casos" e clique no caso para ver as respostas e, se o cliente autorizou, o contato dele.',
      'Mude a situação (Em contato, Resolvido, Sem retorno) e registre o que foi feito.', 'Use "Só os meus" para ver os casos atribuídos a você.'],
    images: [IMG('casos.jpg', 'Casos pendentes e detalhes do atendimento')],
    tips: ['Ver o contato do cliente fica registrado na auditoria (LGPD).'] },

  // ---------------------------------------------------------------- coleta
  { id: 'pesquisas', group: 'Coleta', title: 'Criar e editar pesquisas', audience: { perm: 'surveys.manage' },
    steps: ['Em "Pesquisas", clique em "Nova pesquisa" (ou "Duplicar" para partir de uma existente).',
      'Escreva as perguntas, escolha o tipo (NPS, escala, escolha, sim/não, texto) e marque qual é a de NPS.',
      'Use "Mostrar somente se" para perguntas condicionais e ative inglês/espanhol se quiser.',
      'Salve e escolha a pesquisa na unidade (tela Unidades).'],
    images: [IMG('pesquisa-editor.jpg', 'Editor de pesquisa')],
    tips: ['Gestor só altera pesquisas usadas apenas nas unidades dele; nas demais, use "Duplicar".'] },
  { id: 'campanhas', group: 'Coleta', title: 'Campanhas agendadas', audience: { perm: 'schedules.manage' },
    steps: ['Em "Pesquisas" → "Agendar campanha", escolha a pesquisa, a unidade e o período.', 'Durante o período a campanha substitui a pesquisa padrão; depois tudo volta sozinho.'] },
  { id: 'unidades', group: 'Coleta', title: 'Unidades, horário e QR Code', audience: { perm: 'branches.edit' },
    steps: ['Em "Unidades", clique em "Editar" para ajustar nome, meta de NPS, e-mails/WhatsApp de alerta, fuso e horário de funcionamento.',
      'Escolha na lista a pesquisa que os tablets da unidade exibem.',
      'Botão "QR Code": ative o link público e imprima o cartaz para o cliente responder pelo celular.'],
    images: [IMG('unidades.jpg', 'Unidades com pesquisa, meta e QR Code')] },
  { id: 'criar-unidade', group: 'Coleta', title: 'Criar unidades', audience: { perm: 'branches.create' },
    steps: ['Em "Unidades", clique em "Nova unidade", informe código e nome e salve.', 'Se você é gestor, passa a ser responsável pela unidade criada.'],
    tips: ['O plano da empresa pode limitar a quantidade de unidades ativas.'] },
  { id: 'tablets', group: 'Coleta', title: 'Instalar e ativar um tablet', audience: { perm: 'devices.manage' },
    steps: ['Em "Tablets", clique em "Novo tablet", escolha a unidade e anote o código de 8 letras (vale 15 minutos).',
      'No tablet, abra o endereço do painel com /kiosk e digite o código.', 'Siga o "Guia de instalação" para travar o tablet no modo quiosque.',
      'Tablet perdido? Clique em "Revogar".'],
    images: [IMG('tablets.jpg', 'Tablets e código de ativação')] },

  // ---------------------------------------------------------------- administração
  { id: 'gestores', group: 'Administração', title: 'Cadastrar gestores das suas unidades', audience: { perm: 'users.gestores' },
    steps: ['Em "Usuários", clique em "Novo usuário", informe nome e e-mail e marque as unidades.', 'Deixe "Enviar convite por e-mail" marcado: a pessoa cria a própria senha.'],
    images: [IMG('usuario.jpg', 'Cadastro de usuário com unidades e permissões')] },
  { id: 'usuarios', group: 'Administração', title: 'Usuários, perfis e permissões', audience: { perm: 'users.manage' },
    steps: ['Administrador vê e altera tudo da empresa; Gestor vê só as unidades marcadas.',
      'Ao editar um gestor, libere permissões extras: criar unidades, cadastrar gestores, pedidos LGPD e auditoria das unidades dele.',
      'Desativar um usuário encerra as sessões dele na hora. "Resetar 2FA" serve para quem perdeu o celular.'],
    images: [IMG('usuario.jpg', 'Permissões extras do gestor')],
    tips: ['Excluir respostas e mexer nas configurações nunca podem ser liberados para gestor.'] },
  { id: 'lgpd', group: 'Administração', title: 'Pedidos do titular (LGPD)', audience: { perm: 'privacy.manage' },
    steps: ['Localize pelo telefone ou e-mail informado pelo cliente.', '"Exportar dados" gera o arquivo para entregar ao cliente.',
      '"Excluir dados" apaga nome, contato e comentários (as notas ficam anônimas); confirme com a sua senha.'],
    images: [IMG('lgpd.jpg', 'Pedido do titular')] },
  { id: 'auditoria', group: 'Administração', title: 'Auditoria', audience: { perm: 'audit.view' },
    steps: ['Mostra quem fez o quê, quando e de onde, em português.', 'Filtre por tipo ou busque por pessoa/palavra; marque "só o que merece atenção".',
      'O selo "Registros íntegros" confirma que ninguém alterou o histórico por fora do sistema.'],
    images: [IMG('auditoria.jpg', 'Auditoria em português')] },
  { id: 'configuracoes', group: 'Administração', title: 'Configurações da empresa', audience: { perm: 'settings.manage' },
    steps: ['Identidade visual: logo, cores, ícones e estilo das respostas.', 'Alertas e relatórios: destinatários, webhook, modelo do WhatsApp, relatório semanal.',
      'E-mail e WhatsApp: use os da sua empresa (opcional; sem eles, vale o padrão da plataforma).', 'Segurança e LGPD: 2FA obrigatório, prazos de guarda e aviso de privacidade.'],
    images: [IMG('configuracoes.jpg', 'Configurações da empresa')] },
  { id: 'plano-faturamento', group: 'Administração', title: 'Plano, uso e faturamento', audience: { perm: 'settings.manage' },
    steps: ['"Plano e uso" mostra quanto do plano está em uso (unidades, tablets, usuários, pesquisas e respostas do mês).',
      '"Faturamento": clique em "Assinar com cartão" e cadastre o cartão na página segura do Mercado Pago; a cobrança passa a ser automática.',
      'Se a cobrança for por PIX/boleto, as faturas aparecem com o botão "Pagar" e também chegam por e-mail.'],
    images: [IMG('plano.jpg', 'Plano e uso'), IMG('faturamento.jpg', 'Faturamento')],
    tips: ['Fatura vencida: tudo continua funcionando com um aviso até o fim do 5º dia útil; depois disso o painel fica só com a tela de pagamento e os tablets param. Pagou, volta na hora.',
      'Respostas de clientes nunca são recusadas por limite do plano: você recebe um aviso a 80% e 100%.'] },

  // ---------------------------------------------------------------- Master
  { id: 'master-empresas', group: 'Master', title: 'Empresas: cadastro, situação e suporte', audience: { roles: ['master'] },
    steps: ['"Nova empresa": digite o CNPJ e clique em "Consultar"; os dados vêm da Receita. Só é aceito CNPJ ATIVO e que ainda não esteja cadastrado.',
      'Informe o administrador: ele recebe um convite por e-mail para criar a senha.',
      'Na ficha: plano, cobrança, administradores, suspender/ativar (com motivo), prorrogar teste, cancelar (senha + 2FA) e exclusão definitiva.',
      '"Entrar" abre a empresa por até 2 horas para dar suporte; informe o motivo (fica na auditoria dela).'],
    images: [IMG('master-empresas.jpg', 'Lista de empresas'), IMG('master-ficha.jpg', 'Ficha da empresa')] },
  { id: 'master-planos', group: 'Master', title: 'Planos e faturas', audience: { roles: ['master'] },
    steps: ['"Planos": preço, limites (em branco = sem limite) e recursos de cada plano.', '"Faturas": todas as cobranças, com filtro de vencidas.',
      'Na ficha da empresa, escolha cartão (padrão) ou PIX/boleto, o dia do vencimento e se o PIX/boleto é enviado automaticamente.'],
    images: [IMG('master-planos.jpg', 'Planos')] },
  { id: 'master-plataforma', group: 'Master', title: 'Configurações gerais, Mercado Pago e saúde', audience: { roles: ['master'] },
    steps: ['Configurações gerais: marca da plataforma, autocadastro de empresas, 2FA, limites de capacidade, e-mail/WhatsApp padrão e credenciais do Mercado Pago.',
      'Saúde da plataforma: disco, banco, respostas por dia, tablets e memória. A 70% e 90% de um limite, você recebe um e-mail com o que fazer.',
      'Auditoria da plataforma: suas ações e a verificação de integridade de todas as empresas.'],
    images: [IMG('master-saude.jpg', 'Saúde da plataforma')] },
];

// Quem pode ver o quê.
function allowed(user, audience = {}) {
  if (user.role === 'master') return true;
  if (audience.roles && !audience.roles.includes(user.role)) return false;
  if (audience.perm && !user.can(audience.perm)) return false;
  return true;
}

function forUser(user) {
  const sections = SECTIONS.filter((s) => allowed(user, s.audience))
    .map(({ audience: _a, images = [], ...s }) => ({ ...s, images: images.map((i) => ({ url: `/api/admin/manual/img/${i.file}`, caption: i.caption })) }));
  const versions = VERSIONS.map((v) => ({ ...v, items: v.items.filter((i) => allowed(user, i.audience)).map((i) => i.text) })).filter((v) => v.items.length);
  return { version: VERSION, versions, sections };
}

// Imagem só sai se pertencer a uma seção que a pessoa pode ver. Devolve o nome que está na lista (ou null).
function allowedImage(user, file) {
  for (const s of SECTIONS) {
    if (!allowed(user, s.audience)) continue;
    const img = (s.images || []).find((i) => i.file === file);
    if (img) return img.file;
  }
  return null;
}
const imageAllowed = (user, file) => allowedImage(user, file) !== null;

module.exports = { VERSION, VERSIONS, SECTIONS, forUser, imageAllowed, allowedImage, allowed };
