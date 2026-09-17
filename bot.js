// built sololy by loner tech
const express = require('express');
const mongoose = require('mongoose');
const config = require('./config');
const db = require('./database');
const tg = require('./telegram');
const flows = require('./flows');

async function main() {
  await db.connect();
  const bot = tg.createBot();

  // -------------------------------------------------------------------
  // /start [payload]
  // -------------------------------------------------------------------
  bot.hears(/^\/start(?:\s+(.+))?$/, async (ctx) => {
    try {
      const payload = ctx.match && ctx.match[1] ? ctx.match[1].trim() : null;
      await flows.handleStart(bot, ctx.message, payload);
    } catch (err) {
      console.error('Error in /start:', err);
    }
  });

  // -------------------------------------------------------------------
  // Inline queries: typing "@yourbotusername" in any chat shows a
  // "Create Business Profile" result. Tapping it sends a message with a
  // button that deep-links back into this bot at /start setup, which
  // flows.handleStart needs to route to the setup:start flow (see note
  // below the file).
  // -------------------------------------------------------------------
  bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery;
    try {
      const results = [tg.createBusinessInlineResult()];
      await tg.answerInlineQuery(bot, query.id, results);
    } catch (err) {
      console.error('Error handling inline_query:', err);
    }
  });

  // -------------------------------------------------------------------
  // Callback queries (all inline button presses)
  // -------------------------------------------------------------------
  bot.on('callback_query', async (ctx) => {
    const query = ctx.callbackQuery;
    const from = query.from;
    const session = flows.getSession(from.id);
    session.chatId = query.message.chat.id;
    session.messageId = query.message.message_id;
    const data = query.data;

    try {
      await ctx.answerCallbackQuery({}).catch(() => {});
      await routeCallback(bot, session, from, data);
    } catch (err) {
      console.error('Error handling callback:', data, err);
      try {
        const detail = String(err && err.message ? err.message : err).slice(0, 300);
        await flows.show(bot, session, `Something went wrong:\n${tg.escapeHtml(detail)}`, [
          tg.backButton('menu:main'),
        ]);
      } catch (_) {
        // if even the error message fails to send, there's nothing more we can do
      }
    }
  });

  async function routeCallback(bot, session, from, data) {
    if (data === 'noop') return;

    if (data === 'menu:main') return flows.showMainMenu(bot, session, from);
    if (data === 'about:view') {
      return flows.show(
        bot,
        session,
        `<b>How It Works</b>\n\n` +
          `Business owners create a profile, add their services, connect a ` +
          `group or channel, and generate a unique rating link to share with ` +
          `clients. Clients rate through that link and the review publishes ` +
          `automatically — owners cannot approve or reject individual reviews. ` +
          `Anyone can also search for a provider by service without a link.`,
        [tg.backButton('menu:main')]
      );
    }

    // Owner setup
    if (data === 'setup:start') return flows.showSetupMenu(bot, session, from);
    if (data === 'profile:view') return flows.showSetupMenu(bot, session, from);
    if (data === 'setup:brand') return flows.promptSetupField(bot, session, 'brand');
    if (data === 'setup:about') return flows.promptSetupField(bot, session, 'about');
    if (data === 'setup:photo') return flows.promptProfilePicture(bot, session);

    // Services
    if (data === 'services:view') return flows.showServices(bot, session, from);
    if (data === 'services:add') return flows.promptAddService(bot, session);
    if (data.startsWith('services:remove:')) {
      return flows.removeService(bot, session, from, data.split(':')[2]);
    }

    // Destinations
    if (data === 'dest:view') return flows.showDestinations(bot, session, from);
    if (data.startsWith('dest:remove:')) {
      return flows.removeDestination(bot, session, from, data.split(':')[2]);
    }

    // Rating link generation
    if (data === 'link:start') return flows.startLinkWizard(bot, session, from);
    if (data.startsWith('link:toggle:')) {
      return flows.toggleLinkDestination(bot, session, from, data.split(':')[2]);
    }
    if (data === 'link:confirm') return flows.confirmLinkGeneration(bot, session, from);

    // Client rating flow
    if (data === 'rate:begin') return flows.showServiceSelection(bot, session);
    if (data.startsWith('rate:service:')) {
      const id = data.split(':')[2];
      if (id === 'other') return flows.promptCustomService(bot, session);
      return flows.selectService(bot, session, id);
    }
    if (data.startsWith('rate:star:')) {
      const val = data.split(':')[2];
      if (val === 'confirm') return flows.confirmStar(bot, session);
      return flows.setStar(bot, session, Number(val));
    }
    if (data === 'rate:proof:done') return flows.showReviewPreview(bot, session, from);
    if (data === 'rate:confirm') return flows.publishReview(bot, session, from);
    if (data === 'rate:edit') return flows.showServiceSelection(bot, session);
    if (data === 'rate:cancel') return flows.cancelReview(bot, session);

    // Feedback / developer contact
    if (data === 'feedback:start') return flows.promptFeedback(bot, session);
    if (data === 'developer:contact') return flows.showDeveloperContact(bot, session);

    // Developer menu
    if (data === 'dev:menu') {
      if (!flows.isDeveloper(from.id)) return;
      return flows.showDeveloperMenu(bot, session);
    }
    if (data === 'dev:stats') return flows.isDeveloper(from.id) && flows.showDeveloperStats(bot, session);
    if (data === 'dev:feedback') return flows.isDeveloper(from.id) && flows.showDeveloperFeedbackInbox(bot, session);
    if (data === 'dev:profile') return flows.isDeveloper(from.id) && flows.showDeveloperProfile(bot, session);
    if (data === 'dev:broadcast') return flows.isDeveloper(from.id) && flows.promptBroadcast(bot, session);
    if (data === 'dev:broadcast:confirm') return flows.isDeveloper(from.id) && flows.confirmBroadcast(bot, session);
    if (data === 'dev:broadcast:cancel') return flows.isDeveloper(from.id) && flows.cancelBroadcast(bot, session);

    // Discovery
    if (data === 'discover:start') return flows.promptDiscoverySearch(bot, session);
    if (data === 'discover:prev') return flows.discoveryNav(bot, session, -1);
    if (data === 'discover:next') return flows.discoveryNav(bot, session, 1);
    if (data === 'discover:reviews') return flows.showDiscoveryReviews(bot, session);
    if (data === 'discover:back-to-profile') return flows.renderDiscoveryProfile(bot, session);
    if (data === 'discover:reviews:back') return flows.renderDiscoveryReviews(bot, session);
    if (data === 'discover:reviews:page:prev') return flows.reviewsPageNav(bot, session, -1);
    if (data === 'discover:reviews:page:next') return flows.reviewsPageNav(bot, session, 1);
    if (data.startsWith('discover:reviews:filter:rating:')) {
      return flows.setReviewRatingFilter(bot, session, Number(data.split(':')[4]));
    }
    if (data === 'discover:reviews:filter:keyword') return flows.promptReviewKeyword(bot, session);
    if (data === 'discover:reviews:filter:clear') return flows.clearReviewFilters(bot, session);
  }

  // -------------------------------------------------------------------
  // Plain messages: wizard text inputs, proof photos, forwarded
  // destination-verification messages. Wizards only run in private chats.
  // -------------------------------------------------------------------
  bot.on('message', async (ctx) => {
    const msg = ctx.message;
    if (!msg || !msg.from || msg.from.is_bot) return;
    if (msg.text && msg.text.startsWith('/start')) return; // handled by hears() above
    if (msg.chat.type !== 'private') return;

    const from = msg.from;
    const session = flows.getSession(from.id);
    session.chatId = msg.chat.id;

    try {
      const origin = msg.forward_origin;
      if (session.awaiting === 'add_destination' && origin && (origin.type === 'channel' || origin.type === 'chat')) {
        return await flows.handleForwardedDestination(bot, session, from, origin.chat);
      }
      if (session.awaiting === 'add_destination' && origin && origin.type === 'user') {
        return await flows.show(
          bot,
          session,
          `That forwarded message doesn't carry a chat reference (only the ` +
            `sender is identifiable). Forward a channel post instead, or have ` +
            `an admin forward it anonymously from the group.`,
          [tg.backButton('dest:view')]
        );
      }

      if (msg.photo) {
        if (session.awaiting === 'setup_photo') {
          const best = msg.photo[msg.photo.length - 1];
          return await flows.handleSetupPhotoInput(bot, session, from, best.file_id);
        }
        if (session.data.review && session.awaiting === null) {
          const best = msg.photo[msg.photo.length - 1];
          return await flows.handleProofPhoto(bot, session, best.file_id);
        }
        return;
      }

      if (!msg.text) return;
      const text = msg.text;

      switch (session.awaiting) {
        case 'setup_brand':
        case 'setup_about':
          return await flows.handleSetupTextInput(bot, session, from, text);
        case 'setup_photo':
          return await flows.handleSetupPhotoTextInput(bot, session, from, text);
        case 'service_add':
          return await flows.handleServiceAddInput(bot, session, from, text);
        case 'rate_service_custom':
          return await flows.handleCustomServiceInput(bot, session, text);
        case 'rate_project_name':
          return await flows.handleProjectNameInput(bot, session, text);
        case 'rate_project_desc':
          return await flows.handleProjectDescInput(bot, session, text);
        case 'rate_experience':
          return await flows.handleExperienceInput(bot, session, text);
        case 'feedback_text':
          return await flows.handleFeedbackInput(bot, session, from, text);
        case 'discover_query':
          return await flows.runDiscoverySearch(bot, session, from, text);
        case 'discover_review_keyword':
          return await flows.handleReviewKeywordInput(bot, session, text);
        case 'broadcast_text':
          if (flows.isDeveloper(from.id)) {
            return await flows.handleBroadcastInput(bot, session, text);
          }
          return;
        default:
          return; // no wizard active — ignore free text
      }
    } catch (err) {
      console.error('Error handling message:', err);
      try {
        const detail = String(err && err.message ? err.message : err).slice(0, 300);
        await flows.show(bot, session, `Something went wrong:\n${tg.escapeHtml(detail)}`, [
          tg.backButton('menu:main'),
        ]);
      } catch (_) {
        // if even the error message fails to send, there's nothing more we can do
      }
    }
  });

  // -------------------------------------------------------------------
  // HTTP server: always runs, in both polling and webhook mode, so Render
  // sees a bound port and services like UptimeRobot have something to ping.
  // -------------------------------------------------------------------
  const app = express();
  app.use(express.json());

  const startedAt = Date.now();

  app.get('/health', (req, res) => {
    const dbConnected = mongoose.connection.readyState === 1; // 1 = connected
    const healthy = dbConnected;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      mongodb: dbConnected ? 'connected' : 'disconnected',
      mode: config.MODE === 'webhook' ? 'webhook' : 'polling',
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  // -------------------------------------------------------------------
  // Start receiving updates
  // -------------------------------------------------------------------
  if (config.MODE === 'webhook') {
    if (!config.WEBHOOK_URL) {
      console.error('MODE=webhook requires WEBHOOK_URL to be set.');
      process.exit(1);
    }
    const path = `/bot${config.BOT_TOKEN}`;
    app.post(path, (req, res) => {
      bot.handleUpdate(req.body);
      res.sendStatus(200);
    });
    await bot.api.setWebhook({ url: `${config.WEBHOOK_URL}${path}` });
    console.log('Bot running in webhook mode.');
  } else {
    bot.startPolling();
    console.log('Bot running in polling mode.');
  }

  app.listen(config.PORT, () => console.log(`HTTP server listening on port ${config.PORT} (health check at /health)`));

  console.log('loner tech Rating bot is up.');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
