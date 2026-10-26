# Handoff do Áudio Contínuo

Variante do AudioServ criada em 26/10/2026 para gravar enquanto o usuário mantém um botão pressionado, enviar o áudio em trechos e receber transcrições conforme ficam prontas. O projeto está em `/srv/audiocontinuo`, clonado do commit `7eb9b32` de `https://github.com/vpmammana/audioserv.git`, na branch local `audiocontinuo`. O remoto `origin` ainda aponta para o repositório de origem; esta variante não foi enviada à branch `main` do AudioServ.

Destino de implantação: https://host.simserv.com.br/audiocontinuo/. A instalação no LAMP usa `sudo bash bin/install-lamp.sh`, banco `audiocontinuo`, cookie `audiocontinuo_device` e serviço `audiocontinuo-worker`. A configuração privada é gerada no novo clone, sem copiar credenciais nem dados do aplicativo original. Consulte o [README](README.md) para operação e testes.

## Comportamento implementado

- Mouse, toque e Espaço/Enter com foco no botão iniciam a captura ao pressionar e a encerram ao soltar. Captura de ponteiro garante a soltura mesmo fora do botão.
- Permissão de microfone que chega depois da soltura não inicia gravação tardia. Cancelamento, perda de foco, aba oculta e perda de rede encerram a captura.
- `AudioWorklet` mantém a captura contínua e gera PCM mono a 16 kHz. Cada trecho vira WAV independente, validado pelo PHP antes de entrar na fila.
- Cortes oportunistas em pausas após seis segundos; máximo de dez segundos por padrão. O último fragmento de pelo menos 100 ms é enviado uma vez ao soltar. Fragmentos capturados anteriormente podem terminar seu upload depois da soltura; tarefas já aceitas continuam sendo transcritas.
- UUID de gravação e sequência do trecho são armazenados em `audio_files`. O envio é sequencial e idempotente; o servidor rejeita lacunas na sequência.
- Limite por dispositivo de 4 MiB, aproximadamente 131 segundos pendentes. O limite global desta instalação é 32 MiB. A tabela `queue_admission` serializa a admissão e evita que uploads concorrentes ultrapassem o limite.
- O limite local soma arquivos ainda em processamento, uploads não confirmados e captura em memória. O worklet contabiliza também buffers enviados à interface mas ainda não reconhecidos, limitando memória se a interface travar.
- Ao atingir o limite, a captura para e o botão é liberado, com aviso visual e falado “Limite de tempo alcançado”. O aviso WAV é local, gerado com eSpeak NG; seu contexto de áudio é habilitado pelo gesto inicial. O usuário precisa de nova pressão para reiniciar.
- Temas, letras de 14–20 px, modelos, histórico, reprodução, cópia, exportação e SSE com fallback foram preservados.

## Componentes para continuidade

| Arquivo | Função |
| --- | --- |
| `public/assets/capture-worklet.js` | Captura, reamostragem, cortes, orçamento de bytes e mensagens de progresso |
| `public/assets/capture.js` | Ciclo de vida do microfone, cancelamento, worklet e geração de WAV |
| `public/assets/app.js` | Gestos de pressionar/soltar, fila local, orçamento, aviso sonoro e chat |
| `public/assets/limite-alcancado.wav` | Aviso falado em português |
| `public/index.php`, `public/assets/app.css` | Interface de gravação contínua e medidor da fila |
| `public/api/upload.php` | WAV canônico, ordem, idempotência e limites transacionais |
| `database/schema.sql` | Colunas de gravação/trecho e trava de admissão, além do esquema herdado |
| `app/worker.php`, `bin/worker.php` | Fila persistente, Whisper CUDA, recuperação e systemd |
| `config/example.php` | Limites padrão e configuração exclusiva da variante |

O backend continua em PHP; Python serve apenas para testes. O `whisper-cli` e os modelos Small/Large v3 vêm de `/home/victor/whisper.cpp`. Cada instalação tem um worker próprio, mas ambas compartilham a RTX 5070 de 12 GB; considere a carga conjunta ao testar ou aumentar a audiência.

## Verificação concluída

`node tests/worklet.cjs` passou com continuidade a 16/44,1/48 kHz, trechos independentes, fragmento final e limite rígido de memória. `tests/integration.py` passou com WAV/CSRF, ordem, idempotência concorrente, isolamento, GPU real Small/Large v3, FIFO, SSE, quotas concorrentes e globais e recuperação de lease. `tests/browser.py` passou com soltura antes da permissão, envio enquanto pressionado, soltura fora do botão, fragmento final, teclado, toque, foco, responsividade e aviso falado único no limite.

QA usa `var/qa`, banco `audiocontinuo_test`, container `audiocontinuo-qa-mysql`, MySQL em `127.0.0.1:33080` e Apache em `127.0.0.1:8098`. O container já foi criado; para reutilizar, use `docker start`. Os testes iniciam seus próprios workers da base isolada. Configuração e arquivos de teste ficam fora do Git.

## Operação e limites

```bash
cd /srv/audiocontinuo
php bin/doctor.php
systemctl status audiocontinuo-worker --no-pager
sudo journalctl -u audiocontinuo-worker -n 50 --no-pager
```

O clone é o diretório servido quando o Alias é instalado. Alterações no frontend usam versões por `filemtime`; mudanças no worker PHP precisam de `sudo systemctl restart audiocontinuo-worker`. Não aplique este esquema no banco do AudioServ original.

O limite de 4 MiB mede acúmulo, não duração máxima da fala. Arquivos concluídos deixam de consumir essa quota, mas permanecem no histórico, sujeito ao limite de armazenamento de 2 GiB por dispositivo. Retenção automática, autenticação e PWA offline são evoluções futuras. Uploads que falham permanecem apenas na memória da aba, com reenvio ou salvamento; uma falha interrompe a captura. Cortes forçados e trechos curtos podem afetar palavras e contexto da transcrição. O aviso sonoro depende do som habilitado no dispositivo.
