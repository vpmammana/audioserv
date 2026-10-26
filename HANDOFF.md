# Handoff do AudioServ

O aplicativo está implantado e o escopo solicitado foi concluído: gravação no navegador, uploads independentes do processamento, fila MySQL, transcrição local na GPU, respostas identificadas no chat, seleção de modelo, temas e ajuste do tamanho da letra. Este documento orienta a continuidade do desenvolvimento e a operação da instalação existente.

Última conferência em **26/10/2026**, fuso **America/Bahia (UTC−03)**: endereço público respondendo HTTP 200, worker ativo e sem reinicializações automáticas registradas pelo systemd. O diagnóstico encontrou somente tarefas concluídas naquele momento. A documentação completa de instalação e arquitetura está no [README](README.md).

## Repositório e implantação

| Item | Estado ou localização |
| --- | --- |
| Site | https://host.simserv.com.br/audioserv/ |
| GitHub | https://github.com/vpmammana/audioserv |
| Branch | `main`, acompanhando `origin/main` |
| Base funcional entregue | `8686dabae9f813d49e64ad11ed30eb4396705ff9` |
| Pasta do projeto | `/home/victor/audioserv` |
| Raiz pública | `/home/victor/audioserv/public` |
| Banco principal | `audioserv`, MySQL nativo 8.0.46 |
| Aplicação | PHP 8.3 e JavaScript sem frameworks |
| Serviço permanente | `audioserv-worker.service`, habilitado no systemd |
| Configuração Apache | `/etc/apache2/conf-available/audioserv.conf` |
| Unidade systemd | `/etc/systemd/system/audioserv-worker.service` |
| Configuração privada | `config/local.php`, fora do Git |

**Esta pasta também é a implantação em produção.** Alterações em `public/` e nos endpoints PHP passam a ser servidas pelo Apache. O HTML usa versões de CSS e JavaScript baseadas em `filemtime` para atualizar os arquivos no cache do navegador e do Cloudflare. O worker é um processo PHP persistente: alterações no código que ele carrega ou na configuração exigem reinício do serviço.

O instalador foi executado pelo usuário e a publicação está concluída. Não é necessário reinstalar para continuar o desenvolvimento. Operações administrativas do Apache e do systemd exigem autenticação `sudo`.

## Funcionalidades entregues

- Gravação por `MediaRecorder`, liberação do microfone ao parar e upload automático. É possível começar outra gravação enquanto os envios e transcrições anteriores continuam.
- Upload de arquivos, identificação numérica atribuída pelo servidor e estados de recebimento, fila, preparação, transcrição, conclusão e falha.
- Resultados no chat com o mesmo número do áudio, reprodução do original, cópia e exportação das transcrições carregadas.
- Modelos Small e Large v3 disponíveis; idioma português por padrão e opção de detecção automática. Modelo e idioma são capturados no início de cada gravação.
- Temas claro e escuro, layout responsivo e histórico associado ao cookie do navegador.
- Menu **Preferências → Tamanho da letra do chat**, com 14, 16, 18 e 20 px. O padrão é 16 px também no celular. A preferência fica em `localStorage`, chave `audioserv.chat-size`, e é restaurada por `assets/theme.js` antes da renderização. O CSS usa `data-chat-size` e `--chat-font-size`.

## Fluxo e arquivos principais

O navegador envia o áudio por POST. O endpoint armazena o original fora da raiz pública e cria a tarefa em uma transação, retornando HTTP 202. Um worker PHP consome os trabalhos disponíveis por ordem de chegada, normaliza o áudio com FFmpeg e executa o Whisper. Texto e segmentos são persistidos no MySQL, e os eventos chegam ao navegador por SSE. A fila ativa fica vazia quando as tarefas terminam, preservando os registros do histórico.

| Arquivo | Responsabilidade |
| --- | --- |
| `public/index.php` | Página, menu, cabeçalhos de segurança e versões dos assets |
| `public/assets/app.js` | Gravação, uploads, chat, SSE, polling de reserva e preferências |
| `public/assets/app.css`, `theme.js` | Aparência, responsividade, tema e tamanho da fonte |
| `public/api/bootstrap.php` | Identidade anônima, configuração inicial, histórico e cursor consistente |
| `public/api/upload.php` | Validação, limites, idempotência e inclusão na fila |
| `public/api/events.php` | SSE e consultas de reserva pelo cursor |
| `public/api/audio.php`, `history.php` | Áudio com suporte a Range e histórico paginado, limitados ao dispositivo |
| `app/bootstrap.php` | Configuração, PDO, cookie, CSRF, acesso aos dados e eventos |
| `app/worker.php` | Processos filhos, leases, recuperação, transcrição e persistência |
| `bin/worker.php` | Loop permanente, exclusão mútua e integração com sinais do sistema |
| `database/schema.sql` | Esquema normalizado e catálogo de modelos |
| `bin/install-lamp.sh`, `install-database.php` | Provisionamento do LAMP e serviço |
| `bin/doctor.php` | Diagnóstico operacional sem exibir credenciais ou transcrições |

Há apenas um consumidor da fila por banco, protegido por `flock` e `GET_LOCK`. A propriedade de cada tarefa é renovada por lease; trabalhos interrompidos são recuperados após expiração, com até três tentativas. Mudanças de estado e seus eventos são transacionais. Escritas bloqueiam o dispositivo antes de inserir eventos, preservando a ordem de confirmação do cursor para uploads concorrentes. Preserve essa ordem ao modificar a fila.

## Decisões de arquitetura

**Atualizações por SSE.** O fluxo precisa de avisos do servidor enquanto os uploads seguem por HTTP; não foi necessário implantar WebSocket. A conexão só permanece aberta com tarefas pendentes e a aba visível. Heartbeats ocorrem a cada 8 segundos e a conexão é renovada a cada 25 segundos. Eventos usam cursor e `Last-Event-ID`.

Após três falhas de SSE, o navegador faz consultas com intervalo crescente de 3 a 15 segundos, chegando a 30 segundos em erros de rede. Quando a fila termina, encerra as consultas. O endpoint SSE ainda ocupa um processo PHP e consulta eventos no MySQL a cada 750 ms; o worker consulta a fila a cada 2 segundos quando ocioso. Essa capacidade deve ser considerada antes de aumentar significativamente a audiência.

**Whisper existente no servidor.** Foi reutilizado `/home/victor/whisper.cpp/build/bin/whisper-cli`, compilado com CUDA. A GPU é uma **NVIDIA GeForce RTX 5070 de 12 GB**. Não havia daemon Whisper ativo no início; o serviço permanente criado é o worker PHP, que inicia o executável a cada tarefa. Portanto, a ausência de um processo Whisper no `nvidia-smi` quando a fila está vazia é esperada.

Os modelos usados são `/home/victor/whisper.cpp/models/ggml-small.bin` e `ggml-large-v3.bin`. O catálogo também contempla Tiny, Base, Medium e Large v3 Turbo, habilitados no menu apenas quando os respectivos arquivos GGML estiverem disponíveis. O modelo é recarregado por tarefa e o worker de produção executa uma transcrição por vez na GPU. Python é necessário somente para os testes.

**Identidade preparada para autenticação futura.** O banco separa `users`, `client_devices`, `audio_files`, `whisper_models`, `transcription_jobs`, `transcriptions`, `transcription_segments`, `job_events` e `worker_heartbeats`. Dispositivos podem ser associados a usuários no futuro. Os endpoints atuais autorizam pelo dispositivo, sem login.

O cookie contém um token aleatório; no banco fica seu HMAC-SHA-256. O cookie usa `HttpOnly`, `SameSite=Lax`, caminho `/audioserv/` e `Secure` obrigatório na configuração pública, inclusive com HTTPS terminado no Cloudflare. São identificadores pseudônimos. A chave secreta deve ser preservada para manter o acesso dos cookies existentes.

## Diagnóstico e manutenção

```bash
cd /home/victor/audioserv
git status --short --branch
php bin/doctor.php
systemctl status audioserv-worker --no-pager
curl -I https://host.simserv.com.br/audioserv/
```

Para examinar logs e aplicar uma alteração no worker:

```bash
sudo journalctl -u audioserv-worker -n 50 --no-pager
sudo systemctl restart audioserv-worker
php bin/doctor.php
```

`config/local.php` contém as credenciais e a chave da instalação. O arquivo tem modo 640 e grupo `www-data`; `var/` tem modo 2770. `.gitignore` exclui a configuração privada e todo o conteúdo de `var/`, exceto `.gitkeep`. Os originais ficam em `var/uploads`, e os intermediários em `var/work`. Um backup recuperável precisa do banco, dos originais e da configuração privada. Não inclua esses dados em commits.

## Testes realizados e ambiente de QA

Os testes concluídos na implementação cobriram transcrição real com Small e Large v3 na GPU, FIFO, uploads simultâneos, reenvios sem duplicação, SSE e retomada por cursor, isolamento entre dispositivos, CSRF, áudio com Range, recuperação de tarefas interrompidas, limite de tentativas e rejeição de arquivo corrompido.

Os testes de navegador cobriram gravações consecutivas com microfone simulado, seleção de modelo por gravação, histórico após recarga, temas, celular, cópia, exportação, recuperação de upload e fallback para polling com parada quando ocioso. Após o ajuste de fonte, foram verificados os quatro tamanhos no site público, a persistência da preferência, o tamanho no celular e a ausência de erros JavaScript ou transbordamento horizontal.

Na implantação principal, os áudios de teste **10001 e 10002** retornaram transcrições reais via SSE pelo domínio público, usando um dispositivo de teste separado. Também foram verificados o cookie Secure, o contexto HTTPS para microfone e a inacessibilidade da configuração privada pela URL pública.

O ambiente de QA está **parado**, com os arquivos em `var/qa`. O container `audioserv-qa-mysql` já existe; para reutilizá-lo, use `docker start`, evitando conflito de nome com outro `docker run`. Ele usa MySQL 8 em `127.0.0.1:33079`, banco `audioserv_test`. O Apache de teste usa `127.0.0.1:8096`.

```bash
cd /home/victor/audioserv
docker start audioserv-qa-mysql
# Aguarde o MySQL ficar pronto e confira a configuração de teste.
AUDIOSERV_CONFIG="$PWD/var/qa/config.php" php bin/doctor.php
apache2 -f "$PWD/var/qa/apache/httpd.conf" -DFOREGROUND
```

Em outro terminal:

```bash
cd /home/victor/audioserv
/home/victor/venvs/qbr_llm/bin/python3 tests/integration.py
/home/victor/venvs/qbr_llm/bin/python3 tests/browser.py
```

Os testes controlam seus próprios workers na base isolada e compartilham a GPU física com a produção; execute-os quando houver capacidade disponível. As dependências `requests`, `pymysql`, Playwright e Chromium já estão presentes nesse ambiente Python. Capturas e logs ficam em `var/qa`. A preparação de um ambiente novo e o encerramento dos recursos estão descritos no README.

## Limites e continuidade

Os padrões são 100 MB e 20 minutos por áudio, oito tarefas pendentes, 40 envios por hora e 2 GB armazenados por dispositivo. Os limites por cookie não substituem autenticação ou limitação na borda para uma audiência maior.

Autenticação e PWA completo são evoluções futuras mencionadas pelo usuário. A estrutura de dados foi preparada, mas ainda não existem login, service worker ou fila de uploads em IndexedDB. Um áudio confirmado pelo servidor continua em processamento com a página fechada; um envio que falhou fica somente na memória da aba, com opções de reenviar e salvar.

Originais e transcrições têm retenção indefinida nesta versão. A política de exclusão e a automação dos backups ainda precisam ser definidas. Intermediários são removidos no término normal, mas um encerramento forçado pode deixar arquivos órfãos. O conteúdo transcrito mantém o idioma do áudio; tradução entre idiomas não foi implementada.

Não há solicitação funcional pendente nesta conversa. Para retomar o trabalho, confirme o estado atual com os comandos de diagnóstico, leia o pedido novo e preserve os arquivos privados e os registros já existentes. A documentação de handoff é publicada em um commit posterior à base funcional indicada acima.
