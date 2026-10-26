# Áudio Contínuo

Walkie-talkie de transcrição: segure o botão para gravar e enviar trechos à fila do Whisper; solte para encerrar a captura e fechar o último trecho. As transcrições chegam pelo chat conforme ficam prontas. O aplicativo usa PHP, JavaScript, Apache, MySQL e o `whisper.cpp` com CUDA já instalado neste servidor.

Este projeto foi clonado de [vpmammana/audioserv](https://github.com/vpmammana/audioserv), commit `7eb9b32`, para **`/srv/audiocontinuo`**, branch local **`audiocontinuo`**. A instalação tem banco, diretório de dados, cookie e serviço próprios. O AudioServ original continua em `/home/victor/audioserv`.

Destino: **https://host.simserv.com.br/audiocontinuo/**. Veja também [HANDOFF.md](HANDOFF.md).

## Uso

1. Abra a página por HTTPS e escolha o modelo e o idioma.
2. Pressione e mantenha o botão **Segure para falar**. Na primeira utilização, permita o microfone; se a permissão interromper o gesto, segure novamente.
3. Continue segurando: trechos de até 10 segundos são enviados automaticamente, sem reiniciar o microfone. Cada trecho recebe um número, e o texto aparece assim que o Whisper o concluir.
4. Solte para parar. O último trecho parcial é enviado uma vez; trechos capturados anteriormente que já estavam em envio continuam até a confirmação. As tarefas aceitas pelo servidor terminam normalmente.

Funciona com mouse, toque e, com o botão focado, mantendo Espaço ou Enter. Soltar fora do botão, cancelamento do toque, perda de foco, ocultação da aba ou perda da rede encerram a captura. Ela não reinicia sozinha quando o foco ou a conexão voltam. Esta versão opera em primeiro plano.

Temas claro/escuro, letras de 14 a 20 px, histórico, reprodução, cópia e exportação foram preservados. O menu mantém os modelos Small e Large v3 disponíveis neste servidor. A gravação usa o modelo e o idioma selecionados no momento em que o botão foi pressionado.

## Limite da fila

O limite inicial é **4 MiB (4.194.304 bytes) por dispositivo**, somando arquivos pendentes no servidor, envios locais ainda não confirmados e áudio em captura. O servidor aplica seu limite de forma transacional, incluindo múltiplas abas do mesmo dispositivo. A captura também tem um limite local para evitar crescimento ilimitado de memória.

Os trechos usam WAV PCM mono de 16 kHz e 16 bits:

```text
16.000 amostras/s × 2 bytes = 32.000 bytes/s
10 segundos = 320.000 bytes de áudio + 44 bytes de cabeçalho
4.194.304 / 32.000 ≈ 131 segundos ≈ 2 minutos e 11 segundos pendentes
```

É um limite de **acúmulo**, não da duração total da fala. Se o Whisper acompanhar a gravação, a fila esvazia e é possível continuar segurando. Ao atingir o limite, o botão é liberado automaticamente, o microfone é encerrado e aparece e toca **“Limite de tempo alcançado”**. É necessário soltar e pressionar novamente para iniciar outra gravação.

O aviso usa `public/assets/limite-alcancado.wav`, sintetizado localmente em português com eSpeak NG. Seu contexto de áudio é habilitado durante o gesto inicial. O navegador usa síntese de voz como alternativa se o arquivo não puder ser reproduzido. Som depende de saída de áudio habilitada no dispositivo.

Padrões adicionais em `config/example.php`, substituíveis em `config/local.php`:

| Parâmetro | Valor |
| --- | --- |
| `chunk_seconds` | 10 s; o capturador aceita de 1 a 15 s |
| `queue_bytes_per_device` | 4 MiB |
| `queue_bytes_global` | 32 MiB para toda a instalação |
| `max_duration_seconds` | 15 s por arquivo recebido |
| `max_pending_per_device` | 160 tarefas, proteção para muitos trechos curtos |
| `max_uploads_per_hour` | 1.200 trechos por dispositivo |
| `max_storage_per_device` | 2 GiB de originais armazenados |

As tarefas concluídas e as falhas definitivas deixam de consumir o orçamento da fila, mas os originais permanecem no histórico. A política de retenção e os backups precisam ser definidos para uso prolongado. Os limites por cookie não substituem autenticação para uma audiência maior.

## Captura e processamento

`AudioWorklet` captura continuamente, converte a entrada para PCM de 16 kHz e produz blocos independentes. Os blocos são encapsulados como WAV com cabeçalho próprio. Isso evita depender de partes WebM de `MediaRecorder(timeslice)`, que [não precisam ser reproduzíveis individualmente segundo a especificação](https://www.w3.org/TR/mediastream-recording/).

A divisão procura uma pausa de aproximadamente 350 ms após seis segundos de áudio e, na ausência dela, corta no limite de dez segundos. Os trechos são contíguos, sem sobreposição ou descarte de amostras na divisão normal. Um fragmento final menor que 100 ms é descartado. Um corte forçado pode dividir uma palavra; a precisão da transcrição continua dependente do modelo, do ruído e do contexto.

A fila local envia um trecho por vez, preservando a ordem. Cada gravação tem UUID próprio e cada trecho tem número sequencial. O servidor valida WAV, limites, CSRF, identidade, número do trecho anterior e idempotência antes de aceitar a tarefa. Ao perder a confirmação HTTP, reenviar o mesmo trecho recupera a tarefa existente. Uma falha interrompe a captura e conserva os fragmentos na memória da aba para reenviar ou salvar. Fechar a aba antes da confirmação pode perder esses fragmentos.

Um worker PHP normaliza cada arquivo com FFmpeg, executa `whisper-cli` na GPU e salva texto e segmentos no MySQL. As respostas usam SSE; polling adaptativo continua como alternativa em caso de falha de SSE e para quando não há tarefas pendentes. Tarefas interrompidas são recuperadas por lease e têm até três tentativas. Só um worker consome esta fila por vez.

O novo aplicativo e o AudioServ original compartilham a GPU física e os arquivos dos modelos, mas usam filas e workers separados. O limite global de 32 MiB se aplica à base `audiocontinuo`; ele não soma a fila do AudioServ. Considere a carga conjunta ao escolher modelos e iniciar testes.

## Instalação no LAMP

```bash
cd /srv/audiocontinuo
sudo bash bin/install-lamp.sh
php bin/doctor.php
```

O instalador cria o banco e o usuário MySQL `audiocontinuo`, gera novas credenciais e chave em `config/local.php`, instala o Alias `/audiocontinuo/` no Apache e habilita `audiocontinuo-worker.service`. Requer o administrador MySQL local por socket e `sudo` para os arquivos do sistema. Uma base homônima pré-existente exige configuração explícita; o esquema desta variante deve ser aplicado a uma base própria.

Arquivos de implantação:

- `/etc/apache2/conf-available/audiocontinuo.conf` publica somente `/srv/audiocontinuo/public`.
- `/etc/systemd/system/audiocontinuo-worker.service` executa o worker como proprietário do projeto, com grupo `www-data` e escrita limitada a `var/`.
- `config/local.php` fica fora do Git e da raiz pública; contém as credenciais e a chave HMAC.
- `var/uploads` contém originais, `var/work` contém intermediários; `var/` fica fora do Git.

O cookie `audiocontinuo_device` é HttpOnly, SameSite=Lax, Secure na instalação pública e restrito a `/audiocontinuo/`. O banco guarda seu HMAC, não o token bruto. A base mantém a estrutura de usuários futuros do AudioServ; login e PWA offline ainda não foram implementados.

```bash
systemctl status audiocontinuo-worker --no-pager
sudo journalctl -u audiocontinuo-worker -n 50 --no-pager
sudo systemctl restart audiocontinuo-worker
```

Alterações em arquivos servidos pelo Apache entram na página; o HTML usa `filemtime` para versionar CSS, JavaScript e o worklet. Alterações no código PHP do worker ou em sua configuração precisam de reinício do serviço. Preserve o banco, os originais e a chave secreta nos backups.

## Testes

A instância isolada usa `var/qa/config.php`, banco `audiocontinuo_test`, MySQL em `127.0.0.1:33080` e Apache em `127.0.0.1:8098`. Não usa a base principal. Os testes compartilham a GPU física com as aplicações.

```bash
php tests/prepare-local.php
# Primeira criação; se já existe, use docker start audiocontinuo-qa-mysql.
docker run -d --name audiocontinuo-qa-mysql \
  --env-file "$PWD/var/qa/mysql.env" -p 127.0.0.1:33080:3306 \
  mysql:8.0 --max-connections=40 --innodb-buffer-pool-size=64M
# Após o MySQL ficar pronto:
AUDIOCONTINUO_CONFIG="$PWD/var/qa/config.php" php -r \
  'require "app/bootstrap.php"; db()->exec(file_get_contents("database/schema.sql"));'
apache2 -f "$PWD/var/qa/apache/httpd.conf" -DFOREGROUND
```

Em outro terminal:

```bash
cd /srv/audiocontinuo
node tests/worklet.cjs
/home/victor/venvs/qbr_llm/bin/python3 tests/integration.py
/home/victor/venvs/qbr_llm/bin/python3 tests/browser.py
```

As ferramentas Python `requests`, `pymysql`, Playwright e Chromium já estão disponíveis no ambiente acima. O worklet é testado com entradas a 16, 44,1 e 48 kHz, continuidade de amostras, fragmento final e memória limitada mesmo se a interface travar. A integração testa os dois modelos reais, ordem e idempotência, isolamento, SSE, limites concorrentes por dispositivo e globais e recuperação. O navegador testa autorização tardia do microfone, captura durante pressão, soltura fora do botão, teclado, toque, perda de foco e parada com aviso visual e falado.

Para encerrar o ambiente de teste:

```bash
apache2 -f "$PWD/var/qa/apache/httpd.conf" -k stop
docker stop audiocontinuo-qa-mysql
```
