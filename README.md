# AudioServ

Gravação e upload assíncronos, transcrição local com Whisper na GPU e respostas em formato de chat. Aplicativo PHP 8.3 + JavaScript sem frameworks, usando Apache, MySQL 8 e o `whisper.cpp` já instalado neste servidor. Python é usado somente nos testes automatizados.

Endereço de implantação: **https://host.simserv.com.br/audioserv/**. Instalado no LAMP deste servidor em 26/10/2026; os passos abaixo permitem reinstalar a configuração.

Validação concluída: MySQL nativo 8.0.46, Apache/PHP 8.3, worker systemd ativo e transcrições reais dos dois modelos recebidas por SSE pelo domínio público. Os envios de teste receberam os números 10001 e 10002 e pertencem a um dispositivo de teste separado. Gravação pelo navegador, temas, interface móvel e recuperação de falhas passaram nos testes automatizados. A instância isolada de QA foi parada após a validação; o serviço principal permanece ativo.

## Instalar no LAMP existente

```bash
cd /home/victor/audioserv
sudo bash bin/install-lamp.sh
php bin/doctor.php
```

O instalador precisa de `sudo` porque cria uma base e um usuário exclusivos no MySQL principal, instala `/etc/apache2/conf-available/audioserv.conf`, recarrega o Apache e ativa `audioserv-worker.service`. Não modifica bancos de outros projetos. Recusa um banco/usuário homônimo pré-existente sem configuração explícita. As credenciais aleatórias ficam em `config/local.php`, fora da raiz web e ignoradas pelo Git. Uma segunda execução reutiliza a configuração.

Requer o login administrativo local `root` do MySQL por socket, disponível por `sudo` neste tipo de instalação. Se o administrador usa outra forma de autenticação, provisione a base manualmente, aplique `database/schema.sql` e adapte `config/local.php` a partir do exemplo. O instalador verifica o login da aplicação antes de ativar o Apache.

A raiz pública é **somente `public/`**. Nunca publique a pasta do projeto inteira. O Alias `/audioserv/` usa o Apache existente, inclusive o domínio configurado. Certificado HTTPS e encaminhamento do domínio permanecem sob a configuração do servidor. O microfone exige HTTPS, com a exceção de `localhost`/loopback para desenvolvimento.

Para parar e retomar o processamento:

```bash
sudo systemctl stop audioserv-worker
sudo systemctl start audioserv-worker
sudo systemctl status audioserv-worker
sudo journalctl -u audioserv-worker -n 50 --no-pager
```

Os uploads são aceitos mesmo com o worker parado; o aplicativo informa que a fila está pausada. O systemd reinicia o processo em caso de falha. A conta do worker é a proprietária deste projeto, com grupo `www-data`; suas escritas ficam limitadas à pasta `var/` pelo serviço. FFmpeg e Whisper são processos filhos controlados pelo worker, com timeout.

## Fluxo

1. JavaScript usa `getUserMedia` e `MediaRecorder`. Ao parar, libera o microfone e inicia o upload; uma nova gravação pode começar imediatamente. Modelo e idioma são capturados no início de cada gravação.
2. `POST api/upload.php` valida limites, CSRF, formato e modelo; guarda o arquivo fora da raiz pública e cria a tarefa em uma transação. Responde HTTP 202 com um número, como `10001`.
3. O worker PHP consome a fila por ordem de chegada. FFmpeg extrai/normaliza o áudio para WAV mono de 16 kHz. O Whisper executa a transcrição com o modelo escolhido e CUDA. Só uma tarefa ocupa a GPU por vez.
4. Texto, idioma, duração de processamento e segmentos com timestamps são gravados no MySQL. A tarefa sai da fila ativa ao mudar para `completed`/`failed`; seu registro permanece para o histórico.
5. O navegador recebe eventos por SSE e acrescenta uma resposta “Áudio 10001 tratado”. Os retornos têm o mesmo identificador do envio; novos uploads independem do processamento em curso.

O SHA-256 do conteúdo serve para integridade. Reenvios usam uma chave UUID por solicitação, única por dispositivo: se a resposta HTTP se perder, reenviar não cria outra tarefa. Dois envios intencionais do mesmo conteúdo continuam sendo dois áudios distintos.

## SSE, polling e WebSocket

Não há servidor WebSocket. `EventSource` recebe eventos em uma conexão HTTP unidirecional; uploads usam POSTs separados. Isso atende ao fluxo pedido e é mais simples de operar no LAMP. [Documentação do SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).

- A conexão existe apenas enquanto há áudios pendentes e a aba está visível. É encerrada com a fila vazia, aba oculta, perda de rede ou saída da página.
- O servidor envia heartbeat a cada 8 segundos e renova a conexão a cada 25 segundos. O cursor persistente e `Last-Event-ID` permitem recuperar eventos após desconexão. Recarregar a página restaura o histórico do banco.
- Três falhas de SSE acionam consultas HTTP com intervalo crescente de 3 a 15 segundos; erros de rede elevam o intervalo até 30 segundos. As consultas param quando os trabalhos terminam. Ao reabrir a aba ou recuperar a rede, o cliente tenta SSE novamente.
- **SSE ainda ocupa um processo PHP/Apache por conexão aberta.** Além disso, este endpoint consulta eventos indexados no MySQL a cada 750 ms; o worker consulta a fila a cada 2 s quando ocioso. Não é uma arquitetura sem consultas internas. Ela reduz as requisições HTTP do navegador e dispensa a infraestrutura de WebSocket.
- Para dezenas de usuários simultâneos, monitore `MaxRequestWorkers`, conexões MySQL e o tempo da GPU. Para centenas/milhares, considere um serviço dedicado de eventos e um broker de notificações. Em HTTP/1.1, navegadores limitam conexões simultâneas por domínio; prefira HTTP/2 no acesso público e evite muitas abas ativas.
- Não são usadas sessões nativas PHP bloqueantes; uploads e SSE não disputam o lock de `session_start()`.

## Modelos e GPU

Verificado neste servidor em 26/10/2026: **NVIDIA GeForce RTX 5070, 12 GB**, driver 595.84; `whisper.cpp` compilado com CUDA, em `/home/victor/whisper.cpp/build/bin/whisper-cli`. Não havia serviço Whisper ativo no início. Testes reais confirmaram `using CUDA0 backend` com `small` e `large-v3`.

| Modelo | Disponibilidade inicial | Uso |
| --- | --- | --- |
| `small` | Instalado, padrão | Equilíbrio entre velocidade e precisão |
| `large-v3` | Instalado | Modelo maior, processamento mais demorado |
| `tiny`, `base`, `medium`, `large-v3-turbo` | Menu desabilitado até instalação | Opções adicionais |

O menu só permite selecionar arquivos legíveis no diretório configurado. Para instalar um modelo adicional, use o downloader da instalação existente, por exemplo:

```bash
cd /home/victor/whisper.cpp
bash models/download-ggml-model.sh base
```

Recarregue a página após o download. Configurações ficam em `config/local.php`; consulte `config/example.php`. O worker carrega o modelo novamente por tarefa; isso facilita alternar modelos sem manter vários na VRAM, com custo de carregamento. O áudio de exemplo de 11 s levou aproximadamente 0,8 s no Small e 3,4 s no Large v3 dentro do CLI, incluindo o carregamento, nesta máquina; não é uma garantia de desempenho para outros áudios. [Whisper.cpp](https://github.com/ggml-org/whisper.cpp).

O serviço transcreve no idioma de origem. Não faz tradução entre idiomas. O idioma pode ser fixado ou detectado automaticamente. Áudios sem fala e ruído podem produzir erros do modelo; o texto é exibido como transcrição sem revisão humana.

## Banco, identidade e evolução para autenticação

`database/schema.sql` usa chaves estrangeiras e índices. Entidades:

- `users`: identidade futura; UUID público, email e hash de senha opcionais. Nenhum login implementado nesta versão.
- `client_devices`: cookie aleatório por navegador, com vínculo opcional a `users`, expiração e revogação.
- `audio_files`: proprietário, UUID de envio, chave do arquivo, MIME, tamanho, hash e duração.
- `whisper_models`: catálogo de modelos.
- `transcription_jobs`: fila, modelo, idioma, estados, tentativas e lease de execução.
- `transcriptions` e `transcription_segments`: resultado e trechos temporizados, em tabelas separadas.
- `job_events`: mudanças de estado ordenadas por cursor.
- `worker_heartbeats`: estado recente do processamento.

O cookie tem 256 bits aleatórios, `HttpOnly`, `SameSite=Lax`, duração de um ano e caminho restrito ao aplicativo. A configuração pública usa `cookie_secure=true`, mantendo `Secure` inclusive quando o HTTPS termina no proxy Cloudflare. Somente o ambiente de teste HTTP local desativa essa opção. No banco fica **HMAC-SHA-256**, nunca o token bruto. Não há coleta de IP ou impressão digital pelo aplicativo; os logs gerais do Apache/proxy seguem a política já existente do servidor.

Esses identificadores são **pseudônimos**, não anonimização irreversível. Os próprios áudios, nomes de arquivos e textos podem conter identificação. Apagar cookies ou usar outro navegador remove o acesso ao histórico anterior, mas não apaga seus registros do servidor.

Uma futura autenticação pode associar um dispositivo a `users`, criar sessões autenticadas/renovação de tokens e permitir histórico por usuário. A vinculação deve ser explícita, com rotação/revogação de credenciais e verificação de propriedade. Um futuro PWA pode acrescentar manifest, service worker e armazenamento de envios em IndexedDB; esta versão não promete funcionamento offline ou captura em segundo plano. Um upload que falha permanece na memória da aba, com botões para reenviar ou salvar o arquivo. Fechar/recarregar a aba antes da confirmação pode perdê-lo; o navegador é avisado por `beforeunload`.

## Limites, persistência e operação

Padrões: 100 MB, 20 minutos por áudio, oito tarefas pendentes e 40 envios por hora por dispositivo; armazenamento de 2 GB por dispositivo. São limites de uso por cookie, não proteção contra alguém que crie vários cookies. A necessidade de login/limitação na borda depende da audiência do serviço.

O worker renova leases a cada 5 s. Uma tarefa abandonada pode ser recuperada após 90 s; são permitidas três tentativas para interrupções/falhas transitórias. Áudio inválido e duração excedida são erros definitivos. Modelos indisponíveis são rejeitados. Falhas de GPU não são silenciosamente convertidas em processamento por CPU.

Originais ficam em `var/uploads`; intermediários em `var/work` são removidos ao terminar normalmente. Originais e transcrições são mantidos por tempo indeterminado nesta versão: defina uma política de retenção e backup antes de acumular dados reais. Um encerramento forçado pode deixar intermediários órfãos, que podem ser removidos com o worker parado. Faça backup do banco, de `var/uploads` e da chave de `config/local.php`; perder a chave invalida o acesso dos cookies existentes.

## Verificação isolada

Os testes não usam o banco principal. Usam Apache/PHP instalados, um container MySQL 8 de nome `audioserv-qa-mysql` na porta loopback 33079, porta HTTP loopback 8096 e configuração em `var/qa`.

```bash
php tests/prepare-local.php
docker run -d --name audioserv-qa-mysql \
  --env-file "$PWD/var/qa/mysql.env" -p 127.0.0.1:33079:3306 \
  mysql:8.0 --max-connections=40 --innodb-buffer-pool-size=64M
# Aguarde o MySQL ficar pronto.
AUDIOSERV_CONFIG="$PWD/var/qa/config.php" php -r \
  'require "app/bootstrap.php"; db()->exec(file_get_contents("database/schema.sql"));'
apache2 -f "$PWD/var/qa/apache/httpd.conf" -DFOREGROUND
# Em outro terminal, usando o ambiente Python já disponível neste servidor:
/home/victor/venvs/qbr_llm/bin/python3 tests/integration.py
/home/victor/venvs/qbr_llm/bin/python3 tests/browser.py
```

Os testes Python precisam de `requests`, `pymysql`, `playwright` e Chromium do Playwright, já presentes no ambiente acima. Os testes iniciam e param seus próprios workers; não deixe outro worker conectado à base de teste. Capturas de interface ficam em `var/qa/`.

Cobertura: transcrição real de dois modelos na GPU, gravações consecutivas com microfone simulado, envios simultâneos, UUID idempotente, SSE e retomada por cursor, fallback para polling e parada quando ocioso, CSRF, isolamento de dispositivos, reprodução com Range, recuperação de leases, limite de tentativas, arquivo corrompido, persistência do tema, layout móvel, cópia e exportação.

Ao terminar os testes, pare somente os recursos desta aplicação:

```bash
apache2 -f "$PWD/var/qa/apache/httpd.conf" -k stop
docker stop audioserv-qa-mysql
```
