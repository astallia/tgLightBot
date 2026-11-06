const LONG_POLL_SECONDS = 30;

// Errors never include the request URL, because it contains the bot token.
export function createTelegram({ token, baseUrl = 'https://api.telegram.org' }) {
  async function call(method, params, timeoutMs = 30000) {
    const response = await fetch(`${baseUrl}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = await response.json();
    if (!answer.ok) throw new Error(`Telegram ${method}: ${answer.error_code} ${answer.description}`);
    return answer.result;
  }

  return {
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
