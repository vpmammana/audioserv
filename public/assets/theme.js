(() => {
  let saved, chatSize;
  try {
    saved = localStorage.getItem('audioserv.theme');
    chatSize = localStorage.getItem('audioserv.chat-size');
  } catch {}
  document.documentElement.dataset.theme = saved === 'dark' || saved === 'light' ? saved :
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.chatSize = ['small', 'medium', 'large', 'xlarge'].includes(chatSize) ? chatSize : 'medium';
})();
