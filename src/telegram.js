const LONG_POLL_SECONDS = 30;

// Errors never include the request URL, because it contains the bot token.
export function createTelegram({ token, baseUrl = 'https://api.telegram.org' }) {
  async function post(method, request, timeoutMs) {
    const response = await fetch(`${baseUrl}/bot${token}/${method}`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      ...request,
    });
    const answer = await response.json();
    if (!answer.ok) throw new Error(`Telegram ${method}: ${answer.error_code} ${answer.description}`);
    return answer.result;
  }

  const call = (method, params, timeoutMs = 30000) => post(method, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }, timeoutMs);

  return {
    sendPhoto: (chatId, png, caption, extra = {}) => {
      const form = new FormData();
      form.set('chat_id', String(chatId));
      form.set('photo', new Blob([png], { type: 'image/png' }), 'schedule.png');
      if (caption) {
        form.set('caption', caption);
        form.set('parse_mode', 'HTML');
      }
      if (extra.reply_markup) form.set('reply_markup', JSON.stringify(extra.reply_markup));
      return post('sendPhoto', { body: form }, 60000);
    },
    getMe: () => call('getMe', {}),
    getUpdates: (offset) => call(
      'getUpdates',
      { offset, timeout: LONG_POLL_SECONDS, allowed_updates: ['message', 'callback_query'] },
      (LONG_POLL_SECONDS + 15) * 1000,
    ),
    sendMessage: (chatId, text, extra = {}) => call('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra,
    }),
    answerCallbackQuery: (id) => call('answerCallbackQuery', { callback_query_id: id }),
    setMyCommands: (commands) => call('setMyCommands', { commands }),
  };
}
