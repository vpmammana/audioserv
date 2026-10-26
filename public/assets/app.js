'use strict';
const $ = (id) => document.getElementById(id);
const jobs = new Map();
const uploads = new Map();
let csrf = '', cursor = 0, settings = null, source = null, reconnectTimer = null, pollTimer = null;
let recording = null, micStarting = false, sseErrors = 0, fallback = false, pollDelay = 3000;
let lastHeartbeat = 0, syncing = false, activeUploads = 0, toastTimer, rendered = new Map();
let workerOnline = false;
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('audioserv') : null;
const activeStates = new Set(['queued', 'normalizing', 'transcribing']);
const store = { get(key) { try { return localStorage.getItem('audioserv.' + key); } catch { return null; } }, set(key, value) { try { localStorage.setItem('audioserv.' + key, value); } catch {} } };
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
    $('choose-file').disabled = $('model').disabled;
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
  if (nearBottom) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
}
function audioMessage(job) {
  const root = element('article', 'message message-user'); root.dataset.jobId = job.id;
  const content = element('div', 'message-content');
  const caption = element('div', 'message-caption'); caption.append(element('strong', '', 'Você'), element('time', '', dateLabel(job.created_at)));
  const bubble = element('div', 'audio-bubble'); const top = element('div', 'audio-top');
  top.append(icon('wave'), element('span', '', 'Áudio ' + job.id), element('span', 'audio-details', job.model_label + (job.duration_ms ? ' · ' + clock(job.duration_ms / 1000) : '')));
  bubble.append(top, element('p', 'audio-name', job.original_name));
  const player = document.createElement('audio'); player.controls = true; player.preload = 'none';
  player.src = 'api/audio.php?id=' + job.id; player.setAttribute('aria-label', 'Ouvir áudio ' + job.id);
  const statuses = { queued: 'Na fila · você já pode gravar outro', normalizing: 'Preparando áudio ' + job.id,
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
  const bubble = element('div', 'audio-bubble'); const top = element('div', 'audio-top'); top.append(icon('upload'), element('span', '', 'Novo áudio'));
  bubble.append(top, element('p', 'audio-name', upload.name));
  const label = upload.state === 'failed' ? upload.error : upload.state === 'waiting' ? 'Aguardando envio…' : upload.progress < 100 ? `Enviando ${upload.progress}% · pode gravar outro` : 'Confirmando recebimento no servidor…';
  const status = element('div', 'job-status', label); status.dataset.state = upload.state; bubble.append(status);
  if (upload.state === 'failed') {
    const actions = element('div', 'upload-actions');
    const retry = element('button', 'text-button', 'Reenviar'); retry.onclick = () => { upload.state = 'waiting'; pumpUploads(); render(); };
    const save = element('button', 'text-button', 'Salvar áudio'); save.onclick = () => download(upload.blob, upload.name);
    actions.append(retry, save); bubble.append(actions);
  }
  content.append(caption, bubble); root.append(content); return root;
}
function enqueue(blob, name, preferences) {
  if (blob.size > settings.limits.bytes) { toast('O arquivo ultrapassa o limite de 100 MB.'); return; }
  if (blob.size < 128) { toast('O áudio está vazio ou é curto demais.'); return; }
  const id = crypto.randomUUID();
  uploads.set(id, { id, blob, name, preferences, created: new Date().toISOString(), progress: 0, state: 'waiting' });
  render(); pumpUploads();
}
function pumpUploads() {
  if (!navigator.onLine) return;
  for (const upload of uploads.values()) {
    if (activeUploads >= 2) break;
    if (upload.state === 'waiting') { activeUploads++; upload.state = 'sending'; sendUpload(upload); }
  }
}
function sendUpload(upload) {
  const form = new FormData(); form.append('audio', upload.blob, upload.name); form.append('request_id', upload.id);
  form.append('model', upload.preferences.model); form.append('language', upload.preferences.language);
  const xhr = new XMLHttpRequest(); xhr.open('POST', 'api/upload.php'); xhr.setRequestHeader('X-CSRF-Token', csrf); xhr.timeout = 180000;
  let finished = false;
  const finish = (error, data) => {
    if (finished) return; finished = true; activeUploads--;
    if (error) { upload.state = 'failed'; upload.error = error; announce('Falha no envio. O áudio está disponível para reenviar ou salvar.'); }
    else { uploads.delete(upload.id); jobs.set(data.job.id, data.job); announce('Áudio ' + data.job.id + ' recebido.'); channel?.postMessage('changed'); }
    render(); track(); pumpUploads();
  };
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { upload.progress = Math.round(e.loaded / e.total * 100); render(); } };
  xhr.onload = () => { let data; try { data = JSON.parse(xhr.responseText); } catch { finish('O servidor não confirmou o envio. Tente reenviar.'); return; }
    if (xhr.status >= 200 && xhr.status < 300 && data.job) finish(null, data);
    else finish(data.error || 'Falha no envio. Tente novamente.'); };
  xhr.onerror = () => finish('Sem conexão. Seu áudio continua aqui para reenviar ou salvar.');
  xhr.ontimeout = () => finish('O envio demorou demais. Tente reenviar; o áudio não será duplicado.');
  xhr.onabort = () => finish('O envio foi interrompido.'); xhr.send(form);
}
function preferences() { return { model: $('model').value, language: $('language').value }; }
async function startRecording() {
  if (micStarting) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { toast('Abra a página por HTTPS ou localhost para usar o microfone.'); return; }
  if (!window.MediaRecorder) { toast('Este navegador não permite gravação. Você pode enviar um arquivo.'); return; }
  micStarting = true; $('record').disabled = true; $('record-label').textContent = 'Aguardando permissão do microfone…';
  let stream;
  try {
    const prefs = preferences();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 96000 } : undefined);
    const session = { recorder, stream, chunks: [], size: 0, started: performance.now(), preferences: prefs, context: null, frame: null };
    recording = session;
    recorder.ondataavailable = (e) => { if (e.data.size) { session.chunks.push(e.data); session.size += e.data.size; if (session.size >= settings.limits.bytes - 1024 * 1024 && recorder.state === 'recording') stopRecording(); } };
    recorder.onerror = () => { toast('A gravação foi interrompida. Tentaremos enviar o trecho capturado.'); if (recorder.state !== 'inactive') recorder.stop(); else finalizeRecording(session); };
    recorder.onstop = () => finalizeRecording(session);
    stream.getAudioTracks().forEach((track) => { track.onended = () => { if (recorder.state === 'recording') stopRecording(); }; });
    recorder.start(1000);
    session.interval = setInterval(() => { const elapsed = (performance.now() - session.started) / 1000; $('timer').textContent = clock(elapsed); if (elapsed >= settings.limits.seconds) { toast('Limite de tempo atingido. Enviando áudio.'); stopRecording(); } }, 250);
    $('recorder').classList.add('is-recording'); $('record-label').textContent = 'Gravando sua voz'; $('record-hint').textContent = 'Ao parar, o áudio é enviado automaticamente.';
    $('record').replaceChildren(icon('upload'), document.createTextNode('Parar e enviar'));
    try {
      session.context = new AudioContext(); const analyser = session.context.createAnalyser(); analyser.fftSize = 256;
      session.context.createMediaStreamSource(stream).connect(analyser); session.analyser = analyser; drawWave(session);
    } catch { /* Recording remains available when visualisation is unsupported. */ }
    announce('Gravação iniciada.');
  } catch (e) {
    stream?.getTracks().forEach((track) => track.stop()); recording = null; resetRecorder();
    toast(e.name === 'NotAllowedError' ? 'Permita o acesso ao microfone nas configurações do navegador.' : e.name === 'NotFoundError' ? 'Nenhum microfone foi encontrado.' : 'Não foi possível iniciar a gravação. Você pode enviar um arquivo.');
  } finally { micStarting = false; $('record').disabled = false; }
}
function stopRecording() { if (recording?.recorder.state === 'recording') { $('record').disabled = true; recording.recorder.stop(); } }
function finalizeRecording(session) {
  if (session.finished) return; session.finished = true;
  clearInterval(session.interval); cancelAnimationFrame(session.frame); session.stream.getTracks().forEach((track) => track.stop()); session.context?.close().catch(() => {});
  const type = session.recorder.mimeType || session.chunks[0]?.type || 'audio/webm';
  const blob = new Blob(session.chunks, { type }); const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
  recording = null; resetRecorder();
  enqueue(blob, 'Gravação ' + new Date().toLocaleString('pt-BR').replaceAll('/', '-') + '.' + ext, session.preferences);
}
function resetRecorder() {
  $('recorder').classList.remove('is-recording'); $('record-label').textContent = 'Tudo pronto para gravar'; $('record-hint').textContent = 'Seu microfone só é ativado ao começar.';
  $('timer').textContent = '00:00'; $('record').replaceChildren(icon('mic'), document.createTextNode('Começar gravação')); $('record').disabled = false; idleWave();
}
function idleWave() { const ctx = $('waveform').getContext('2d'); ctx.clearRect(0, 0, 180, 40); ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted'); ctx.lineWidth = 2; for (let x = 5; x < 180; x += 8) { ctx.beginPath(); ctx.moveTo(x, 18); ctx.lineTo(x, 22); ctx.stroke(); } }
function drawWave(session) {
  if (recording !== session) return;
  const bytes = new Uint8Array(session.analyser.frequencyBinCount); session.analyser.getByteTimeDomainData(bytes);
  const ctx = $('waveform').getContext('2d'); ctx.clearRect(0, 0, 180, 40); ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--red'); ctx.lineWidth = 2; ctx.beginPath();
  bytes.forEach((v, i) => { const x = i / bytes.length * 180; const y = v / 255 * 40; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); session.frame = requestAnimationFrame(() => drawWave(session));
}
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
$('record').onclick = () => recording ? stopRecording() : startRecording();
$('choose-file').onclick = () => $('file').click();
$('file').onchange = () => { for (const file of $('file').files) enqueue(file, file.name, preferences()); $('file').value = ''; };
$('model').onchange = applyModel; $('language').onchange = () => store.set('language', $('language').value);
$('chat-size').value = document.documentElement.dataset.chatSize || 'medium';
$('chat-size').onchange = () => {
  document.documentElement.dataset.chatSize = $('chat-size').value;
  store.set('chat-size', $('chat-size').value);
};
$('theme').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; store.set('theme', theme); themeLabel(); idleWave(); };
function themeLabel() { const dark = document.documentElement.dataset.theme === 'dark'; $('theme').replaceChildren(icon(dark ? 'sun' : 'moon')); $('theme').setAttribute('aria-label', dark ? 'Usar tema claro' : 'Usar tema escuro'); document.querySelector('meta[name=theme-color]').content = dark ? '#10141c' : '#f7f8fa'; }
$('settings-toggle').onclick = () => { const open = $('sidebar').classList.toggle('open'); $('settings-toggle').setAttribute('aria-expanded', open); if (open) $('model').focus(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('sidebar').classList.remove('open'); $('settings-toggle').setAttribute('aria-expanded', false); } });
document.addEventListener('click', (e) => { if (!$('sidebar').contains(e.target) && !$('settings-toggle').contains(e.target)) { $('sidebar').classList.remove('open'); $('settings-toggle').setAttribute('aria-expanded', false); } });
$('export').onclick = () => { const text = [...jobs.values()].filter((j) => j.status === 'completed').sort((a, b) => a.id - b.id).map((j) => `Áudio ${j.id} · ${j.model_label} · ${dateLabel(j.created_at)}\n\n${j.text || '(Nenhuma fala identificada)'}`).join('\n\n--------------------\n\n'); download(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'audioserv-transcricoes.txt'); };
$('load-more').onclick = async () => {
  $('load-more').disabled = true; const scroller = $('conversation'), height = scroller.scrollHeight;
  try { const data = await api('history.php?before=' + Math.min(...jobs.keys())); for (const job of data.jobs) jobs.set(job.id, job); $('load-more').hidden = !data.has_more; render(); requestAnimationFrame(() => { scroller.scrollTop += scroller.scrollHeight - height; }); }
  catch (e) { toast(e.message); } finally { $('load-more').disabled = false; }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) stopTracking(); else { fallback = false; sseErrors = 0; sync(); } });
window.addEventListener('offline', () => { stopTracking(); connection('Sem conexão', false); });
window.addEventListener('online', () => { fallback = false; sseErrors = 0; sync(); pumpUploads(); });
window.addEventListener('beforeunload', (e) => { if (recording || micStarting || uploads.size) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', stopTracking);
if (channel) channel.onmessage = () => { if (!document.hidden) sync(); };
setInterval(() => { if (source && Date.now() - lastHeartbeat > 20000) streamFailure(); }, 5000);
themeLabel(); idleWave(); sync(true);
