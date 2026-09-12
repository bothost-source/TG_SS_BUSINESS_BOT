// built sololy by loner tech
const { Bot } = require('node-telegram-bot-api');
const crypto = require('crypto');
const config = require('./config');

function createBot() {
  const bot = new Bot(config.BOT_TOKEN);
  bot.catch((err) => console.error('Unhandled bot error:', err));
  return bot;
}

// -- Secure token generation --------------------------------------------
function generateToken() {
  return crypto.randomBytes(config.TOKEN_BYTES).toString('hex');
}

function ratingDeepLink(token) {
  return `https://t.me/${config.BOT_USERNAME}?start=${token}`;
}

function displayName(entity) {
  if (entity.brandName) return entity.brandName;
  const first = entity.firstName || entity.username || 'User';
  const last = entity.lastName ? ` ${entity.lastName}` : '';
  return `${first}${last}`;
}

function profileButton(entity, label) {
  if (entity.username) {
    return { text: label, url: `https://t.me/${entity.username}` };
  }
 
  return { text: `${label} (no public username)`, callback_data: 'noop' };
}

function mentionHtml(entity) {
  const name = escapeHtml(displayName(entity));
  if (entity.username) {
    return `<a href="https://t.me/${entity.username}">@${escapeHtml(entity.username)}</a>`;
  }
  return `<a href="tg://user?id=${entity.telegramId}">${name}</a>`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function richMessage(html) {
  return { html };
}

function richMessageMarkdown(markdown) {
  return { markdown };
}

function escapeMarkdown(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/([|\\`*_[\]])/g, '\\$1');
}

async function renderScreen(bot, chatId, messageId, text, keyboard, format = 'html') {
  const reply_markup = keyboard ? { inline_keyboard: keyboard } : undefined;
  const rich_message = format === 'markdown' ? richMessageMarkdown(text) : richMessage(text);

  if (messageId) {
    try {
      const result = await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        rich_message,
        reply_markup,
      });

      return typeof result === 'object' && result.message_id ? result.message_id : messageId;
    } catch (err) {
      const msg = (err && err.message) || '';
      if (msg.includes('message is not modified')) {
        return messageId;
      }
      // Message may have been a photo/media message, or deleted -- fall
      // through and send a fresh rich message instead.
    }
  }

  const sent = await bot.api.sendRichMessage({
    chat_id: chatId,
    rich_message,
    reply_markup,
  });
  return sent.message_id;
}

// -- Keyboard builders -----------------------------------------------------
function mainMenuKeyboard() {
  return [
    [{ text: 'Search for a Service', callback_data: 'discover:start' }],
    [{ text: 'Create Your Business', callback_data: 'setup:start' }],
    [{ text: 'My Profile', callback_data: 'profile:view' }, { text: 'My Services', callback_data: 'services:view' }],
    [{ text: 'How It Works', callback_data: 'about:view' }, { text: 'Feedback', callback_data: 'feedback:start' }],
    [{ text: 'Developer', callback_data: 'developer:contact' }],
  ];
}

function developerMenuKeyboard() {
  return [
    [{ text: 'Statistics', callback_data: 'dev:stats' }],
    [{ text: 'Broadcast', callback_data: 'dev:broadcast' }],
    [{ text: 'Feedback Inbox', callback_data: 'dev:feedback' }],
    [{ text: 'Developer Profile', callback_data: 'dev:profile' }],
    [{ text: 'Back to Main Menu', callback_data: 'menu:main' }],
  ];
}

function backButton(callbackData, label = 'Back') {
  return [{ text: label, callback_data: callbackData }];
}

function starKeyboard(selected) {
  const row = [];
  for (let i = 1; i <= 5; i++) {
    row.push({
      text: i <= selected ? `[${i}] Selected` : `${i}`,
      callback_data: `rate:star:${i}`,
    });
  }
  return [row, [{ text: 'Continue', callback_data: 'rate:star:confirm' }]];
}

module.exports = {
  createBot,
  generateToken,
  ratingDeepLink,
  displayName,
  profileButton,
  mentionHtml,
  escapeHtml,
  richMessage,
  richMessageMarkdown,
  escapeMarkdown,
  renderScreen,
  mainMenuKeyboard,
  developerMenuKeyboard,
  backButton,
  starKeyboard,
};
