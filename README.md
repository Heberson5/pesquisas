# Pesquisa de Satisfação (NPS) — plataforma multiempresa

Plataforma de pesquisa de satisfação para **tablets em modo quiosque** e **QR Code**, com **painel administrativo** e análise de **NPS**, para **várias empresas** no mesmo servidor.

- **Multiempresa:** cada empresa enxerga só os próprios dados (unidades, pesquisas, respostas, usuários, configurações, auditoria). Contatos de clientes são criptografados com uma **chave própria de cada empresa**.
- **Painel Master:** cadastro de empresas com consulta automática do CNPJ (BrasilAPI, com ReceitaWS de reserva; só CNPJ **ativo** e sem duplicidade), convite do administrador por e-mail, suspender/reativar/cancelar (com motivo; cancelar exige senha + 2FA), prorrogar teste, exclusão definitiva (apaga dados e chave), configurações gerais (marca, autocadastro, 2FA, e-mail/WhatsApp padrão), **saúde e capacidade do servidor** com aviso por e-mail a 70%/90% e auditoria da plataforma.
- **Planos e limites:** o Master define preço, limites (unidades, tablets, usuários, pesquisas, respostas/mês) e recursos (PowerPoint, WhatsApp, webhook). Cadastros além do limite são recusados com explicação; **respostas de clientes nunca são recusadas** — a 80% e 100% do mês o administrador e o Master recebem aviso. O administrador vê o uso em "Plano e uso".
- **Faturamento (Mercado Pago):** assinatura mensal no **cartão** feita pelo próprio administrador (o cartão é cadastrado na página do Mercado Pago); **PIX/boleto** só gerado pelo Master, na hora ou automático (7 dias antes do vencimento, por e-mail). Fim do teste grátis sem assinatura → painel limitado ao pagamento (pop-up). Fatura vencida → "em atraso" com aviso; **no fim do 5º dia útil** (sem fins de semana e feriados nacionais) → suspensão: painel só com a tela de pagamento e tablets/QR param. Pagou, volta na hora. Notificações validadas por assinatura (x-signature) e sempre conferidas na API.
- **Autocadastro** (desligado por padrão): a empresa se cadastra pelo site e começa o teste grátis.
- **Perfis:** **Master** (dono da plataforma: vê a lista de empresas e entra em uma delas por até 2 h, com motivo registrado na auditoria) → **Administrador** (tudo dentro da própria empresa, inclusive excluir respostas) → **Gestor** (as unidades dele; o Administrador pode liberar permissões extras: criar unidades, cadastrar gestores, LGPD, auditoria).

- **Painel:** `/admin` — NPS geral/por filial/por pergunta, respostas, exportação CSV, pesquisas, filiais, tablets, usuários, auditoria.
- **Configurações:** logo, favicon, ícone do app, cores, ícones do menu e estilo das respostas (números coloridos, carinhas coloridas, estrelas, corações…).
- **PowerPoint:** relatório com gráficos nativos, logo e cores da empresa.
- **Casos:** cada nota de 0 a 6 vira um caso para tratar; alerta por e-mail, webhook ou WhatsApp.
- **Segurança:** 2FA, recuperação de senha, LGPD (consentimento, criptografia, retenção, pedidos do titular).
- **Coleta:** tablet em modo quiosque e QR Code por filial, perguntas condicionais, campanhas agendadas, PT/EN/ES.
- **Fuso horário por filial:** o horário de funcionamento vale no fuso do tablet (modo automático) ou num fuso fixo escolhido na filial; a empresa é a reserva. Vale também para campanhas, alerta de tablet sem sinal e e-mails.
- **E-mail e WhatsApp pelo painel:** Configurações → E-mail e WhatsApp (SMTP com provedores prontos, API oficial da Meta, teste de conexão e fila de envios). Senhas e tokens ficam criptografados e nunca voltam à tela; o servidor SMTP precisa ser público (bloqueia rede interna). Cada pessoa pode cadastrar o próprio WhatsApp em Minha conta.
- **Auditoria em português:** cada ação vira uma frase (quem, o quê, onde), com filtros por tipo, busca e destaque do que merece atenção.
- **Localização das respostas (QR Code):** o cliente pode autorizar a localização; o sistema grava cidade (município do IBGE mais próximo), UF e região, com o ponto arredondado a ~1 km. Tudo offline, sem serviços externos; o ponto é apagado pela política de retenção e a cidade/UF ficam só como estatística. Aparece em Respostas, no filtro por estado, no quadro "Origem das respostas" e no CSV. Nos tablets o local é a cidade da filial.
- **Tablet:** `/kiosk` — sem login; ativado uma vez com código gerado no painel; respostas sempre gravadas na filial do tablet.

```bash
npm install
npm run create-master  -- voce@seudominio.com.br "Seu Nome"          # dono da plataforma
npm run create-company -- "Nome da Empresa" --cnpj 00000000000000    # primeira empresa
npm run create-admin   -- admin@empresa.com.br "Nome" --empresa nome-da-empresa
npm start          # http://127.0.0.1:3000/admin
npm test           # 139 testes (segurança, isolamento entre empresas, migração)
npm run seed:demo  # demonstração: Master + 2 empresas (nunca em produção)
```

**Atualizando uma instalação de empresa única:** ao subir esta versão, o banco é migrado sozinho — os dados atuais viram a **empresa nº 1**, os usuários atuais continuam como Administradores/Gestores dela e os contatos são regravados com a chave da empresa. Faça um backup antes e crie o seu Master com `create-master`.

Requer Node.js 22.13+.

| Documento | Para quê |
|---|---|
| [docs/DEPLOY.md](docs/DEPLOY.md) | Colocar no ar na VPS (Docker, HTTPS, backup) |
| [docs/INSTALACAO-TABLET.md](docs/INSTALACAO-TABLET.md) | Instalar e travar os tablets nas filiais |
| [docs/PLANEJAMENTO.md](docs/PLANEJAMENTO.md) | Arquitetura, segurança e testes |

## Telas

| Tablet | Painel |
|---|---|
| ![Números coloridos](docs/screenshots/31-numeros-coloridos-nps.png) | ![Visão geral](docs/screenshots/20-painel-novo.png) |
| ![Carinhas coloridas](docs/screenshots/32-carinhas-coloridas-nps.png) | ![Ícones das respostas](docs/screenshots/24-config-icones-respostas.png) |
