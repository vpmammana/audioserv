<?php
declare(strict_types=1);
header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header('Permissions-Policy: microphone=(self), camera=(), geolocation=()');
header('Cache-Control: no-cache');
?>
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#f7f8fa">
  <meta name="description" content="Grave, envie e transforme sua voz em texto com Whisper no seu servidor.">
  <title>Áudio Contínuo · Pressione e fale</title>
  <link rel="icon" href="assets/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="assets/app.css?v=<?= filemtime(__DIR__ . '/assets/app.css') ?>">
  <script src="assets/theme.js?v=<?= filemtime(__DIR__ . '/assets/theme.js') ?>"></script>
  <script src="assets/capture.js?v=<?= filemtime(__DIR__ . '/assets/capture.js') ?>" data-worklet="assets/capture-worklet.js?v=<?= filemtime(__DIR__ . '/assets/capture-worklet.js') ?>" defer></script>
  <script src="assets/app.js?v=<?= filemtime(__DIR__ . '/assets/app.js') ?>" defer></script>
</head>
<body>
<svg class="svg-library" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <symbol id="i-wave" viewBox="0 0 24 24"><path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4"/></symbol>
  <symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></symbol>
  <symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></symbol>
  <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24"><path d="M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z"/></symbol>
  <symbol id="i-settings" viewBox="0 0 24 24"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/></symbol>
  <symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></symbol>
  <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
  <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M12 19V5m-6 6 6-6 6 6"/></symbol>
  <symbol id="i-file" viewBox="0 0 24 24"><path d="M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8m-8 4h6"/></symbol>
</svg>
<div class="app-shell">
  <aside class="sidebar" id="sidebar" aria-label="Menu e preferências">
    <a class="brand" href="./" aria-label="Áudio Contínuo início"><span class="brand-icon"><svg><use href="#i-wave"/></svg></span><span>áudio<span class="brand-light">contínuo</span><small>PRESSIONE E FALE</small></span></a>
    <div class="workspace-label">SEU ESPAÇO</div>
    <div class="nav-active"><svg><use href="#i-wave"/></svg> Estúdio <span class="nav-dot"></span></div>
    <div class="sidebar-divider"></div>
    <div class="settings-title"><span>PREFERÊNCIAS</span><svg><use href="#i-settings"/></svg></div>
    <label for="model">Modelo Whisper</label>
    <select id="model" disabled><option>Carregando modelos…</option></select>
    <p class="field-help" id="model-help">Escolha o equilíbrio entre velocidade e precisão.</p>
    <label for="language">Idioma do áudio</label>
    <select id="language"><option value="pt">Português</option><option value="auto">Detectar automaticamente</option><option value="en">Inglês</option><option value="es">Espanhol</option><option value="fr">Francês</option><option value="de">Alemão</option><option value="it">Italiano</option></select>
    <p class="field-help">O texto mantém o idioma da gravação.</p>
    <label for="chat-size">Tamanho da letra do chat</label>
    <select id="chat-size" aria-describedby="chat-size-help"><option value="small">Pequena · 14 px</option><option value="medium" selected>Média · 16 px</option><option value="large">Grande · 18 px</option><option value="xlarge">Muito grande · 20 px</option></select>
    <p class="field-help" id="chat-size-help">Ajuste a leitura. Sua escolha fica salva neste navegador.</p>
    <div class="sidebar-divider"></div>
    <div class="session-summary"><span>NESTE DISPOSITIVO</span><div><strong id="completed-count">0</strong><span>transcrições carregadas</span></div><div><strong id="pending-count">0</strong><span>áudios em andamento</span></div></div>
    <button id="export" class="text-button export" disabled><svg><use href="#i-file"/></svg> Exportar transcrições</button>
    <div class="sidebar-bottom"><span class="privacy-mark"><svg><use href="#i-check"/></svg> Processado no seu servidor</span><p>Seu histórico fica associado a este navegador. Limpar os cookies remove o acesso a ele.</p></div>
  </aside>
  <main class="main">
    <header class="topbar"><div class="breadcrumb">Seu espaço <span>/</span> <strong>Estúdio</strong></div><div class="header-actions"><span class="connection" id="connection"><i></i><span>Conectando</span></span><button class="icon-button" id="theme" aria-label="Alternar tema" title="Alternar tema"><svg><use href="#i-moon"/></svg></button><button class="icon-button mobile-settings" id="settings-toggle" aria-expanded="false" aria-controls="sidebar" aria-label="Abrir preferências"><svg><use href="#i-settings"/></svg></button></div></header>
    <section class="studio-header"><div><div class="eyebrow">SUA VOZ, TRECHO A TRECHO</div><h1>Pressione. Fale. Solte<span>.</span></h1><p>Segure o botão para falar. Os trechos viram texto enquanto você continua.</p></div><span class="queue-pill" id="queue-pill"><span class="live-dot"></span><span>Fila livre</span></span></section>
    <div id="service-notice" class="notice" role="status" hidden></div>
    <div id="limit-notice" class="notice limit-notice" role="alert" hidden>Limite de tempo alcançado. Aguarde a fila diminuir para falar novamente.</div>
    <section class="conversation" id="conversation" aria-label="Áudios e transcrições">
      <button class="history-button" id="load-more" hidden>Carregar áudios anteriores</button>
      <div class="empty-state" id="empty-state"><div class="voice-orbit"><svg><use href="#i-wave"/></svg><span class="orbit-dot"></span></div><span class="empty-kicker">SEU WALKIE-TALKIE DE TEXTO</span><h2>Uma conversa contínua.<br>Uma ideia de cada vez.</h2><p>Enquanto você segura, o áudio é enviado em trechos.<br>Ao soltar, a captura para e o último trecho é concluído.</p><div class="steps"><span><b>1</b> Segure</span><i></i><span><b>2</b> Fale</span><i></i><span><b>3</b> Leia o texto</span></div></div>
      <div id="messages" class="messages"></div>
    </section>
    <footer class="composer-area">
      <div class="queue-capacity"><div><label for="queue-meter">Áudio aguardando transcrição</label><span id="queue-size">0 / 4 MiB</span></div><progress id="queue-meter" max="4194304" value="0"></progress></div>
      <div class="recorder" id="recorder"><div class="record-info"><span class="mic-badge"><svg><use href="#i-mic"/></svg></span><div><strong id="record-label">Segure para começar</strong><span id="record-hint">Soltou, parou. O último trecho também é enviado.</span></div></div><div class="record-wave"><canvas id="waveform" width="180" height="40" aria-hidden="true"></canvas><time id="timer">00:00</time></div><button class="record-button" id="record" aria-pressed="false" aria-describedby="record-hint" disabled><svg><use href="#i-mic"/></svg><span>Segure para falar</span></button></div>
      <div class="composer-meta"><span id="limits">Trechos de até 10 s · fila de até 4 MiB</span><span class="keyboard-help">Teclado: segure Espaço ou Enter no botão</span><span class="model-indicator" id="model-indicator">Whisper</span></div>
    </footer>
  </main>
</div>
<div class="toast" id="toast" role="status" hidden></div>
<div id="announcer" class="sr-only" role="status" aria-live="polite"></div>
<noscript>Ative o JavaScript para gravar e acompanhar suas transcrições.</noscript>
</body>
</html>
