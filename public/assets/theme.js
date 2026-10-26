(() => {
  let saved, chatSize;
  try {
    saved = localStorage.getItem('audiocontinuo.theme');
    chatSize = localStorage.getItem('audiocontinuo.chat-size');
  } catch {}
  document.documentElement.dataset.theme = saved === 'dark' || saved === 'light' ? saved :
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.chatSize = ['small', 'medium', 'large', 'xlarge'].includes(chatSize) ? chatSize : 'medium';
})();
