'use strict';
const $ = (id) => document.getElementById(id);
const jobs = new Map();
const uploads = new Map();
let csrf = '', cursor = 0, settings = null, source = null, reconnectTimer = null, pollTimer = null;
let recording = null, micStarting = false, sseErrors = 0, fallback = false, pollDelay = 3000;
let lastHeartbeat = 0, syncing = false, activeUploads = 0, toastTimer, rendered = new Map();
let workerOnline = false, press = null, limitLatched = false;
let feedbackContext = null, alarmBuffer = null, alarmReady = null;
const alarmData = fetch('assets/limite-alcancado.wav').then((r) => { if (!r.ok) throw new Error('Aviso indisponível'); return r.arrayBuffer(); });
alarmData.catch(() => {});
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('audiocontinuo') : null;
const activeStates = new Set(['queued', 'normalizing', 'transcribing']);
const store = { get(key) { try { return localStorage.getItem('audiocontinuo.' + key); } catch { return null; } }, set(key, value) { try { localStorage.setItem('audiocontinuo.' + key, value); } catch {} } };
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
}
function element(tag, className, text) {
  const el = document.createElement(tag); if (className) el.className = className;
  if (text !== undefined) el.textContent = text; return el;
}
function announce(text) { $('announcer').textContent = text; }
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
function clock(seconds) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
function localTime(date) { return new Date(date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
function dateLabel(date) { return new Date(date).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function pending() { return [...jobs.values()].some((j) => activeStates.has(j.status)); }
function connection(text, online = true) { $('connection').lastElementChild.textContent = text; $('connection').dataset.status = online ? 'online' : 'offline'; }
function health(worker) {
  if (!worker) return;
  workerOnline = worker.online;
  if (worker.online) { $('service-notice').hidden = true; connection(fallback && pending() ? 'Atualização periódica' : 'Whisper disponível'); }
  else { connection('Worker indisponível', false); notice('O processamento está pausado. Os áudios enviados ficam guardados na fila e serão tratados quando o worker voltar.'); }
}
function notice(text) { $('service-notice').replaceChildren(document.createTextNode(text)); $('service-notice').hidden = false; }
async function api(path, options = {}) {
  const response = await fetch('api/' + path, { credentials: 'same-origin', cache: 'no-store', ...options });
  let data; try { data = await response.json(); } catch { throw new Error('O servidor retornou uma resposta inválida.'); }
  if (!response.ok) throw new Error(data.error || 'Não foi possível conectar ao servidor.');
  return data;
}
function applyModel() {
  const model = settings?.models.find((m) => m.slug === $('model').value);
  $('model-help').textContent = model?.description || 'Escolha um modelo instalado.';
  $('model-indicator').textContent = 'Whisper ' + (model?.label || '');
  store.set('model', $('model').value);
}
async function sync(initial = false) {
  if (syncing) return; syncing = true;
  try {
    const data = await api('bootstrap.php');
    if (csrf && csrf !== data.csrf) { jobs.clear(); rendered.clear(); $('messages').replaceChildren(); }
    csrf = data.csrf; cursor = Math.max(cursor, data.cursor); settings = data;
    if (initial || !$('model').options.length || $('model').disabled) {
      $('model').replaceChildren();
      for (const model of data.models) {
        const option = element('option', '', model.label + (model.available ? '' : ' · não instalado'));
        option.value = model.slug; option.disabled = !model.available; $('model').append(option);
      }
      const wanted = store.get('model') || 'small';
      $('model').value = data.models.some((m) => m.available && m.slug === wanted) ? wanted : data.models.find((m) => m.available)?.slug || '';
      $('model').disabled = !data.models.some((m) => m.available);
      const language = store.get('language');
      if ([...$('language').options].some((o) => o.value === language)) $('language').value = language;
      applyModel();
    }
    for (const job of data.jobs) jobs.set(job.id, job);
    $('load-more').hidden = !data.has_more;
    $('record').disabled = $('model').disabled;
    $('limits').textContent = `Trechos de até ${data.limits.chunk_seconds} s · fila de até ${Math.round(data.limits.queue_bytes / 1048576)} MiB`;
    updateBudget();
    health(data.worker); render(); track();
  } catch (e) {
    connection('Sem conexão', false); notice(e.message);
    const retry = element('button', 'text-button', 'Tentar novamente');
    retry.onclick = () => sync(true); $('service-notice').append(retry);
    if (!settings) $('empty-state').hidden = false;
  } finally { syncing = false; }
}
function render() {
  const scroller = $('conversation');
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const items = [];
  for (const job of jobs.values()) {
    items.push({ key: 'audio-' + job.id, time: job.created_at, type: 'audio', data: job, signature: JSON.stringify(job) });
    if (job.status === 'completed' || job.status === 'failed') items.push({ key: 'result-' + job.id, time: job.finished_at || job.created_at, type: 'result', data: job, signature: JSON.stringify(job) });
  }
  for (const upload of uploads.values()) items.push({ key: upload.id, time: upload.created, type: 'upload', data: upload, signature: `${upload.state}:${upload.progress}:${upload.error}` });
  items.sort((a, b) => new Date(a.time) - new Date(b.time) || a.key.localeCompare(b.key));
  const wanted = new Set(items.map((i) => i.key));
  for (const [key, entry] of rendered) if (!wanted.has(key)) { entry.node.remove(); rendered.delete(key); }
  let previous = null;
  for (const item of items) {
    let entry = rendered.get(item.key);
    if (!entry || entry.signature !== item.signature) {
      const node = item.type === 'result' ? resultMessage(item.data) : item.type === 'audio' ? audioMessage(item.data) : uploadMessage(item.data);
      if (entry) {
        const player = entry.node.querySelector('audio');
        const replacement = node.querySelector('audio');
        if (player && replacement) replacement.replaceWith(player);
        entry.node.replaceWith(node);
      }
      entry = { node, signature: item.signature }; rendered.set(item.key, entry);
    }
    const expected = previous ? previous.nextSibling : $('messages').firstChild;
    if (entry.node !== expected) $('messages').insertBefore(entry.node, expected);
    previous = entry.node;
  }
  $('empty-state').hidden = items.length > 0;
  const count = [...jobs.values()].filter((j) => activeStates.has(j.status)).length + [...uploads.values()].filter((u) => u.state !== 'failed').length;
  const complete = [...jobs.values()].filter((j) => j.status === 'completed').length;
  $('pending-count').textContent = count; $('completed-count').textContent = complete;
  $('queue-pill').dataset.active = count > 0;
  $('queue-pill').lastElementChild.textContent = count ? `${count} áudio${count > 1 ? 's' : ''} em andamento` : 'Fila livre';
  $('export').disabled = complete === 0;
  updateBudget();
  if (nearBottom) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
}
function audioMessage(job) {
  const root = element('article', 'message message-user'); root.dataset.jobId = job.id;
  const content = element('div', 'message-content');
  const caption = element('div', 'message-caption'); caption.append(element('strong', '', 'Você'), element('time', '', dateLabel(job.created_at)));
  const bubble = element('div', 'audio-bubble'); const top = element('div', 'audio-top');
  top.append(icon('wave'), element('span', '', `Trecho ${job.chunk_number} · #${job.id}`), element('span', 'audio-details', job.model_label + (job.duration_ms ? ' · ' + clock(job.duration_ms / 1000) : '')));
  bubble.append(top, element('p', 'audio-name', job.original_name));
  const player = document.createElement('audio'); player.controls = true; player.preload = 'none';
  player.src = 'api/audio.php?id=' + job.id; player.setAttribute('aria-label', 'Ouvir áudio ' + job.id);
  const statuses = { queued: 'Na fila · você pode continuar falando', normalizing: 'Preparando áudio ' + job.id,
    transcribing: 'Tratando áudio ' + job.id + '…', completed: 'Transcrição concluída', failed: 'Não foi possível tratar este áudio' };
  const status = element('div', 'job-status', job.error_message && job.status === 'queued' ? job.error_message : statuses[job.status]);
  status.dataset.state = job.status; bubble.append(player, status); content.append(caption, bubble); root.append(content); return root;
}
function resultMessage(job) {
  const root = element('article', 'message message-bot'); root.dataset.resultId = job.id;
  const avatar = element('span', 'avatar'); avatar.append(icon('wave'));
  const content = element('div', 'message-content'); const caption = element('div', 'message-caption');
  caption.append(element('strong', '', job.status === 'completed' ? `Áudio ${job.id} tratado` : `Áudio ${job.id} · falha no processamento`), element('time', '', dateLabel(job.finished_at || job.created_at)));
  const bubble = element('div', 'transcript-bubble' + (job.status === 'failed' ? ' error-bubble' : ''));
  bubble.append(element('p', 'transcript-text', job.status === 'failed' ? job.error_message || 'Ocorreu uma falha. Envie o áudio novamente.' : job.text || 'Nenhuma fala foi identificada neste áudio.'));
  if (job.status === 'completed') {
    const actions = element('div', 'transcript-actions');
    actions.append(element('span', '', job.model_label + ' · ' + ((job.processing_ms || 0) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' s de processamento'));
    const copy = element('button', 'text-button', 'Copiar texto'); copy.prepend(icon('copy'));
    copy.onclick = async () => { try { await navigator.clipboard.writeText(job.text || ''); toast('Texto copiado.'); } catch { toast('Não foi possível copiar. Selecione o texto e copie manualmente.'); } };
    actions.append(copy); bubble.append(actions);
  }
  content.append(caption, bubble); root.append(avatar, content); return root;
}
function uploadMessage(upload) {
  const root = element('article', 'message message-user'); const content = element('div', 'message-content');
  const caption = element('div', 'message-caption'); caption.append(element('strong', '', 'Você'), element('time', '', localTime(upload.created)));
  const bubble = element('div', 'audio-bubble'); const top = element('div', 'audio-top'); top.append(icon('upload'), element('span', '', `Trecho ${upload.chunkNumber}`));
  bubble.append(top, element('p', 'audio-name', upload.name));
  const label = upload.state === 'failed' ? upload.error : upload.state === 'waiting' ? 'Aguardando envio…' : upload.progress < 100 ? `Enviando ${upload.progress}% · a captura continua` : 'Confirmando recebimento no servidor…';
  const status = element('div', 'job-status', label); status.dataset.state = upload.state; bubble.append(status);
  if (upload.state === 'failed') {
    const actions = element('div', 'upload-actions');
    const retry = element('button', 'text-button', 'Reenviar'); retry.onclick = () => { upload.state = 'waiting'; pumpUploads(); render(); };
    const save = element('button', 'text-button', 'Salvar áudio'); save.onclick = () => download(upload.blob, upload.name);
    actions.append(retry, save); bubble.append(actions);
  }
  content.append(caption, bubble); root.append(content); return root;
}
function enqueue(blob, session, chunkNumber) {
  const id = crypto.randomUUID();
  uploads.set(id, { id, blob, name: `Trecho ${chunkNumber} - ${session.id.slice(0, 8)}.wav`,
    preferences: session.preferences, recordingId: session.id, chunkNumber,
    created: new Date().toISOString(), progress: 0, state: 'waiting' });
  render(); pumpUploads();
}
function pumpUploads() {
  if (!navigator.onLine) return;
  for (const upload of uploads.values()) {
    if (activeUploads >= 1 || upload.state === 'failed') break;
    if (upload.state === 'waiting') { activeUploads++; upload.state = 'sending'; sendUpload(upload); }
  }
}
function sendUpload(upload) {
  const form = new FormData(); form.append('audio', upload.blob, upload.name); form.append('request_id', upload.id);
  form.append('recording_id', upload.recordingId); form.append('chunk_number', upload.chunkNumber);
  form.append('model', upload.preferences.model); form.append('language', upload.preferences.language);
  const xhr = new XMLHttpRequest(); xhr.open('POST', 'api/upload.php'); xhr.setRequestHeader('X-CSRF-Token', csrf); xhr.timeout = 180000;
  let finished = false;
  const finish = (error, data, code) => {
    if (finished) return; finished = true; activeUploads--;
    if (error) { upload.state = 'failed'; upload.error = error; if (code === 'queue_limit') limitReached(); else endHold(); announce('Falha no envio. O áudio está disponível para reenviar ou salvar.'); }
    else { uploads.delete(upload.id); jobs.set(data.job.id, data.job); announce('Áudio ' + data.job.id + ' recebido.'); channel?.postMessage('changed'); }
    render(); track(); pumpUploads();
  };
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { upload.progress = Math.round(e.loaded / e.total * 100); render(); } };
  xhr.onload = () => { let data; try { data = JSON.parse(xhr.responseText); } catch { finish('O servidor não confirmou o envio. Tente reenviar.'); return; }
    if (xhr.status >= 200 && xhr.status < 300 && data.job) finish(null, data);
    else finish(data.error || 'Falha no envio. Tente novamente.', null, data.code); };
  xhr.onerror = () => finish('Sem conexão. Seu áudio continua aqui para reenviar ou salvar.');
  xhr.ontimeout = () => finish('O envio demorou demais. Tente reenviar; o áudio não será duplicado.');
  xhr.onabort = () => finish('O envio foi interrompido.'); xhr.send(form);
}
function preferences() { return { model: $('model').value, language: $('language').value }; }
function outstandingBytes() {
  const known = new Set([...jobs.values()].map((j) => j.request_id));
  let bytes = [...jobs.values()].filter((j) => activeStates.has(j.status)).reduce((n, j) => n + j.byte_size, 0);
  for (const upload of uploads.values()) if (!known.has(upload.id)) bytes += upload.blob.size;
  return bytes;
}
function captureBudget() { return Math.max(0, (settings?.limits.queue_bytes || 0) - outstandingBytes() - 4096); }
function updateBudget() {
  if (!settings) return;
  const bytes = outstandingBytes() + (recording?.capture.bufferedBytes || 0);
  const max = settings.limits.queue_bytes;
  $('queue-meter').max = max; $('queue-meter').value = Math.min(bytes, max);
  $('queue-size').textContent = `${(bytes / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} / ${(max / 1048576).toLocaleString('pt-BR')} MiB · ~${clock(bytes / 32000)}`;
  recording?.capture.setBudget();
}
function armFeedback() {
  try {
    if (!feedbackContext || feedbackContext.state === 'closed') feedbackContext = new AudioContext();
    const resumed = feedbackContext.resume();
    if (!alarmReady) alarmReady = alarmData.then((data) => feedbackContext.decodeAudioData(data.slice(0))).then((buffer) => { alarmBuffer = buffer; });
    return Promise.all([resumed, alarmReady]).catch(() => {});
  } catch { return Promise.resolve(); }
}
function limitReached() {
  endHold();
  if (limitLatched) return;
  limitLatched = true;
  $('limit-notice').hidden = false;
  announce('Limite de tempo alcançado.');
  armFeedback().then(() => {
    if (alarmBuffer && feedbackContext?.state === 'running') {
      const sound = feedbackContext.createBufferSource(); sound.buffer = alarmBuffer;
      sound.connect(feedbackContext.destination); sound.start();
    } else if ('speechSynthesis' in window) {
      const speech = new SpeechSynthesisUtterance('Limite de tempo alcançado.'); speech.lang = 'pt-BR'; speechSynthesis.speak(speech);
    }
  });
}
function beginHold(interaction) {
  if (press || recording || !settings || $('record').disabled) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) { toast('Abra em HTTPS e use um navegador com captura de áudio compatível.'); return; }
  if (!navigator.onLine) { toast('Reconecte à internet antes de falar.'); return; }
  if ([...uploads.values()].some((u) => u.state === 'failed')) { toast('Reenvie o trecho que falhou antes de começar outra gravação.'); return; }
  press = interaction; limitLatched = false; $('limit-notice').hidden = true; armFeedback();
  if (captureBudget() < 3244) { limitReached(); return; }
  const session = { id: crypto.randomUUID(), preferences: preferences(), capture: null };
  session.capture = new ContinuousCapture({
    chunkSeconds: settings.limits.chunk_seconds, budget: captureBudget,
    onStarted: () => {
      if (recording !== session || !press) { session.capture.stop(); return; }
      micStarting = false; $('recorder').classList.add('is-recording');
      $('record-label').textContent = 'Gravando e enviando em trechos';
      $('record-hint').textContent = 'Mantenha pressionado. Solte para encerrar a captura.';
      announce('Gravação contínua iniciada.');
    },
    onChunk: (blob, number) => enqueue(blob, session, number),
    onProgress: (data) => { if (recording !== session) return; $('timer').textContent = clock(data.frames / 16000); drawLevel(data.level); updateBudget(); },
    onError: (error) => toast(error.name === 'NotAllowedError' ? 'Permita o microfone e segure o botão novamente.' : 'Não foi possível manter a captura. Verifique o microfone.'),
    onStopped: (reason) => {
      if (recording !== session) return;
      if (reason === 'limit') limitReached();
      recording = null; micStarting = false; releasePress(); resetRecorder(); updateBudget();
    },
  });
  recording = session; micStarting = true;
  $('record').setAttribute('aria-pressed', 'true');
  $('record').replaceChildren(icon('mic'), document.createTextNode('Solte para parar'));
  $('record-label').textContent = 'Preparando microfone…';
  session.capture.start();
}
function releasePress() {
  const old = press; press = null;
  if (old?.pointerId !== undefined && $('record').hasPointerCapture(old.pointerId)) $('record').releasePointerCapture(old.pointerId);
  $('record').setAttribute('aria-pressed', 'false');
}
function endHold() {
  releasePress();
  if (!recording) return;
  $('record-label').textContent = 'Concluindo o último trecho…';
  $('recorder').classList.remove('is-recording');
  recording.capture.stop();
}
function resetRecorder() {
  $('recorder').classList.remove('is-recording'); $('record-label').textContent = 'Segure para começar';
  $('record-hint').textContent = 'Soltou, parou. O último trecho também é enviado.';
  $('timer').textContent = '00:00'; $('record').setAttribute('aria-pressed', 'false');
  $('record').replaceChildren(icon('mic'), document.createTextNode('Segure para falar')); idleWave();
}
function drawLevel(level = 0) {
  const ctx = $('waveform').getContext('2d'); ctx.clearRect(0, 0, 180, 40);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue(recording ? '--red' : '--muted'); ctx.lineWidth = 2;
  for (let x = 5; x < 180; x += 8) { const h = Math.min(18, 2 + level * 150 * (.5 + Math.abs(Math.sin(x)))); ctx.beginPath(); ctx.moveTo(x, 20 - h); ctx.lineTo(x, 20 + h); ctx.stroke(); }
}
function idleWave() { drawLevel(); }
function closeStream() { source?.close(); source = null; clearTimeout(reconnectTimer); reconnectTimer = null; }
function stopTracking() { closeStream(); clearTimeout(pollTimer); pollTimer = null; }
function consume(event) {
  cursor = Math.max(cursor, event.id); const old = jobs.get(event.job.id); jobs.set(event.job.id, event.job);
  if (event.job.status === 'completed' && old?.status !== 'completed') announce('Áudio ' + event.job.id + ' tratado. O texto está disponível.');
  render();
}
function track() {
  if (!pending() || document.hidden || !navigator.onLine) { stopTracking(); return; }
  if (fallback || !window.EventSource) { if (!pollTimer) pollTimer = setTimeout(poll, pollDelay); return; }
  if (source || reconnectTimer) return;
  source = new EventSource('api/events.php?after=' + cursor); lastHeartbeat = Date.now();
  source.addEventListener('job', (e) => { try { consume(JSON.parse(e.data)); lastHeartbeat = Date.now(); sseErrors = 0; if (!pending()) stopTracking(); } catch { streamFailure(); } });
  source.addEventListener('heartbeat', (e) => { try { health(JSON.parse(e.data).worker); lastHeartbeat = Date.now(); sseErrors = 0; } catch { streamFailure(); } });
  source.addEventListener('rotate', () => { closeStream(); if (pending()) reconnectTimer = setTimeout(() => { reconnectTimer = null; track(); }, 1000); });
  source.onerror = streamFailure;
}
function streamFailure() {
  closeStream(); sseErrors++;
  if (sseErrors >= 3) { fallback = true; pollDelay = 3000; if (workerOnline) connection('Atualização periódica'); track(); }
  else if (pending() && !document.hidden && navigator.onLine) reconnectTimer = setTimeout(() => { reconnectTimer = null; track(); }, Math.min(1500 * sseErrors, 5000));
}
async function poll() {
  pollTimer = null; if (!pending() || document.hidden || !navigator.onLine) return;
  try {
    const data = await api('events.php?transport=poll&after=' + cursor); data.events.forEach(consume); health(data.worker);
    pollDelay = data.events.length ? 3000 : Math.min(15000, pollDelay * 1.6);
  } catch { pollDelay = Math.min(30000, pollDelay * 2); connection('Reconectando', false); }
  track();
}
function download(blob, name) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
$('record').addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !event.isPrimary) return;
  event.preventDefault(); $('record').focus();
  beginHold({ pointerId: event.pointerId });
  if (press?.pointerId === event.pointerId) $('record').setPointerCapture(event.pointerId);
});
window.addEventListener('pointerup', (event) => { if (press?.pointerId === event.pointerId) endHold(); }, true);
window.addEventListener('pointercancel', (event) => { if (press?.pointerId === event.pointerId) endHold(); }, true);
$('record').addEventListener('lostpointercapture', (event) => { if (press?.pointerId === event.pointerId) endHold(); });
$('record').addEventListener('contextmenu', (event) => event.preventDefault());
$('record').addEventListener('keydown', (event) => {
  if (!['Space', 'Enter'].includes(event.code)) return;
  event.preventDefault(); if (!event.repeat) beginHold({ key: event.code });
});
window.addEventListener('keyup', (event) => { if (press?.key === event.code) { event.preventDefault(); endHold(); } });
window.addEventListener('blur', endHold);
$('model').onchange = applyModel; $('language').onchange = () => store.set('language', $('language').value);
$('chat-size').value = document.documentElement.dataset.chatSize || 'medium';
$('chat-size').onchange = () => {
  document.documentElement.dataset.chatSize = $('chat-size').value;
  store.set('chat-size', $('chat-size').value);
};
$('theme').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; store.set('theme', theme); themeLabel(); idleWave(); };
function themeLabel() { const dark = document.documentElement.dataset.theme === 'dark'; $('theme').replaceChildren(icon(dark ? 'sun' : 'moon')); $('theme').setAttribute('aria-label', dark ? 'Usar tema claro' : 'Usar tema escuro'); document.querySelector('meta[name=theme-color]').content = dark ? '#10141c' : '#f7f8fa'; }
$('settings-toggle').onclick = () => { const open = $('sidebar').classList.toggle('open'); $('settings-toggle').setAttribute('aria-expanded', open); if (open) $('model').focus(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { endHold(); $('sidebar').classList.remove('open'); $('settings-toggle').setAttribute('aria-expanded', false); } });
document.addEventListener('click', (e) => { if (!$('sidebar').contains(e.target) && !$('settings-toggle').contains(e.target)) { $('sidebar').classList.remove('open'); $('settings-toggle').setAttribute('aria-expanded', false); } });
$('export').onclick = () => { const text = [...jobs.values()].filter((j) => j.status === 'completed').sort((a, b) => a.id - b.id).map((j) => `Áudio ${j.id} · ${j.model_label} · ${dateLabel(j.created_at)}\n\n${j.text || '(Nenhuma fala identificada)'}`).join('\n\n--------------------\n\n'); download(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'audiocontinuo-transcricoes.txt'); };
$('load-more').onclick = async () => {
  $('load-more').disabled = true; const scroller = $('conversation'), height = scroller.scrollHeight;
  try { const data = await api('history.php?before=' + Math.min(...jobs.keys())); for (const job of data.jobs) jobs.set(job.id, job); $('load-more').hidden = !data.has_more; render(); requestAnimationFrame(() => { scroller.scrollTop += scroller.scrollHeight - height; }); }
  catch (e) { toast(e.message); } finally { $('load-more').disabled = false; }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) { endHold(); stopTracking(); } else { fallback = false; sseErrors = 0; sync(); } });
window.addEventListener('offline', () => { endHold(); stopTracking(); connection('Sem conexão', false); });
window.addEventListener('online', () => { fallback = false; sseErrors = 0; sync(); pumpUploads(); });
window.addEventListener('beforeunload', (e) => { if (recording || micStarting || uploads.size) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', () => { endHold(); stopTracking(); feedbackContext?.close().catch(() => {}); });
if (channel) channel.onmessage = () => { if (!document.hidden) sync(); };
setInterval(() => { if (source && Date.now() - lastHeartbeat > 20000) streamFailure(); }, 5000);
themeLabel(); idleWave(); sync(true);
