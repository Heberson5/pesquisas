# Segurança e operação da plataforma

Guia para manter a plataforma segura e no ar. Os itens marcados com **(você)** dependem de configuração fora do sistema (DNS, Cloudflare, provedor de e-mail, contrato).

## 1. O que o sistema já faz sozinho

| Proteção | Como funciona |
|---|---|
| Separação entre empresas | Toda consulta filtra pela empresa em uso. Um teste automático percorre o código e falha se aparecer consulta sem esse filtro. |
| Criptografia por empresa | Contatos de clientes e segredos (senha do e-mail, token do WhatsApp) usam uma chave própria de cada empresa. Os dados de uma empresa não abrem com a chave de outra. |
| 2FA e chaves de acesso | Código de 6 dígitos (TOTP) e *passkeys* (WebAuthn). A passkey só funciona no endereço verdadeiro do painel, por isso protege contra sites falsos. O 2FA é obrigatório para o Master e, por padrão, para os administradores. |
| Ações sensíveis | Cancelar ou excluir empresa, cancelar assinatura, excluir respostas em lote e excluir dados do titular (LGPD) pedem a senha e, se o 2FA estiver ativo, o código. |
| Aviso de acesso novo | Login de um navegador ou rede nunca vistos nos últimos 90 dias gera um e-mail. Em "Minha conta" a pessoa vê os aparelhos conectados e pode encerrar sessões. |
| Auditoria à prova de adulteração | Cada registro guarda o resumo (SHA-256) do anterior. Alterar ou apagar um registro direto no banco quebra a corrente, e a tela de auditoria acusa. O Master verifica todas as empresas em "Auditoria da plataforma". |
| Master auditado | Entrar numa empresa exige motivo, dura no máximo 2 horas e fica na auditoria dela com o selo "Master". |
| Pagamentos | As notificações do Mercado Pago têm a assinatura conferida e as antigas são recusadas. A baixa é sempre conferida na API do Mercado Pago (valor e moeda). Cada evento é processado uma única vez. |
| Backups | Cópia diária sem parar o sistema, incluindo as mídias de cada empresa. Com `BACKUP_PASSPHRASE`, o banco sai criptografado (AES-256-GCM). |
| CI | Testes de segurança, `npm audit`, CodeQL (análise do código) e Trivy (vulnerabilidades da imagem Docker) a cada envio. |

## 2. Rotação da chave mestra (APP_SECRET)
Faça a rotação se houver suspeita de vazamento do `.env`, ou periodicamente:
1. Faça um backup.
2. Gere a nova chave: `openssl rand -base64 48`.
3. No `.env`, coloque `APP_SECRET=<nova>` e `APP_SECRET_PREVIOUS=<antiga>`, depois reinicie. Tudo continua funcionando, porque a chave antiga só é usada para leitura.
4. Rode `docker compose exec app node scripts/rotate-secret.js`. O script regrava tudo com a chave nova. Se algum dado não abrir, o script não altera nada.
5. Peça aos usuários para gerar novos códigos de recuperação do 2FA (Minha conta). Depois disso, remova `APP_SECRET_PREVIOUS`.
6. Avise as empresas que usam webhook: a assinatura do webhook de cada empresa muda.

## 3. Backups fora do servidor **(você)**
1. Defina `BACKUP_PASSPHRASE` (mínimo de 16 caracteres) no `.env` e guarde essa frase **fora do servidor**, por exemplo num gerenciador de senhas.
2. Envie a pasta `backups/` para fora do servidor todos os dias. Exemplo com o `rclone` (Google Drive, OneDrive, S3, Backblaze B2):
   ```bash
   # crontab -e  (todo dia às 04:00)
   0 4 * * * rclone copy /opt/pesquisa/backups remoto:pesquisa-backups --max-age 48h
   ```
3. Teste a restauração uma vez por mês:
   `BACKUP_PASSPHRASE=... node scripts/restore-backup.js backups/pesquisa-AAAAMMDD-HHMMSS.db.enc /tmp/teste.db`

## 4. Cloudflare na frente do servidor **(você)**
- Aponte o DNS para a Cloudflare com o proxy ligado (nuvem laranja). Use SSL/TLS no modo **Full (strict)**.
- Ligue as regras gerenciadas do WAF e a proteção contra DDoS. Crie uma regra de *rate limiting* para `/api/admin/login` (ex.: 20 por minuto por IP).
- No servidor, aceite conexões nas portas 80/443 **só dos IPs da Cloudflare** (firewall) e defina `TRUST_PROXY=1`.
- Com o Caddy, use o cabeçalho `CF-Connecting-IP` como IP real (veja `deploy/Caddyfile`).
- Não coloque cache da Cloudflare em `/api/*`, `/admin/*` e `/r/*`.

## 5. E-mail confiável: SPF, DKIM e DMARC **(você)**
Sem esses registros, os convites, alertas e faturas tendem a cair no spam. No DNS do domínio remetente:
- **SPF** (TXT em `@`): `v=spf1 include:_spf.google.com ~all`. Troque o `include` pelo do seu provedor (Microsoft 365: `include:spf.protection.outlook.com`; Brevo, SES etc. informam o deles).
- **DKIM**: ative no painel do provedor de e-mail e publique o registro TXT/CNAME que ele gerar.
- **DMARC** (TXT em `_dmarc`): comece com `v=DMARC1; p=none; rua=mailto:dmarc@seudominio.com.br`. Depois de algumas semanas sem problemas, mude para `p=quarantine`.

## 6. Monitoramento **(você)**
- **No ar:** cadastre `https://pesquisa.sauberlich.com.br/healthz` num monitor externo (UptimeRobot, Better Stack, Freshping), com alerta por e-mail ou WhatsApp.
- **Capacidade:** o próprio sistema avisa os Masters por e-mail a 70% e 90% de cada limite (Painel Master → Saúde da plataforma).
- **Logs:** `docker compose logs -f app`. Os erros internos aparecem com data e rota, sem dados pessoais.
- **Integridade:** confira "Auditoria da plataforma" uma vez por semana. O selo verde indica que nenhuma corrente foi quebrada.

## 7. Homologação (staging)
Use `docker-compose.staging.yml` para testar cada versão antes da produção, com banco, chaves e credenciais **de teste** do Mercado Pago (`TEST-…`) separados. O passo a passo está no começo do arquivo.

## 8. Crescimento (quando o aviso de capacidade chegar)
1. Antes: aumente CPU/memória/disco da VPS (o mais simples).
2. Banco acima do limite ou muitas respostas por dia: migre para PostgreSQL. O código já isola cada empresa pela coluna `company_id`, e as migrações são numeradas.
3. Muitas empresas: separe em dois servidores ou ative endereços por empresa (o endereço curto `slug` de cada empresa já existe).

## 9. Itens jurídicos **(você + advogado)**
Termos de uso, política de privacidade, contrato de tratamento de dados (DPA) com as empresas clientes, encarregado de dados (DPO) e emissão de nota fiscal de serviço (NFS-e) não são feitos pelo sistema.
