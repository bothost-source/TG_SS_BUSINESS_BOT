
const config = require('./config');
const db = require('./database');
const tg = require('./telegram');

const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { chatId: null, messageId: null, awaiting: null, data: {} });
  }
  return sessions.get(userId);
}

function resetAwaiting(session) {
  session.awaiting = null;
}

// ---------------------------------------------------------------------------
// BotUser tracking (for stats/broadcast) — every /start touches this.
// ---------------------------------------------------------------------------
async function touchBotUser(from) {
  await db.BotUser.findOneAndUpdate(
    { telegramId: from.id },
    {
      $set: {
        username: from.username || null,
        firstName: from.first_name || null,
        lastName: from.last_name || null,
        lastSeen: new Date(),
        blocked: false,
      },
      $setOnInsert: { firstSeen: new Date() },
    },
    { upsert: true }
  );
}

function isDeveloper(userId) {
  return config.DEVELOPER_ID !== null && userId === config.DEVELOPER_ID;
}

// ---------------------------------------------------------------------------
// Screen renderer shortcut bound to a session
// ---------------------------------------------------------------------------
async function show(bot, session, text, keyboard, format = 'html') {
  const messageId = await tg.renderScreen(bot, session.chatId, session.messageId, text, keyboard, format);
  session.messageId = messageId;
}

// ===========================================================================
// START / MAIN MENU
// ===========================================================================
async function handleStart(bot, msg, payload) {
  const from = msg.from;
  const session = getSession(from.id);
  session.chatId = msg.chat.id;
  session.messageId = null; // fresh conversation, start a new message
  session.awaiting = null;
  session.data = {};

  await touchBotUser(from);

  if (payload) {
    return startClientRatingFlow(bot, session, from, payload);
  }

  return showMainMenu(bot, session, from);
}

async function showMainMenu(bot, session, from) {
  resetAwaiting(session);
  const devLine = isDeveloper(from.id)
    ? '\n\nYou are recognized as the developer of this bot.'
    : '';

  const text =
    `<b>Welcome</b>\n\n` +
    `This bot collects verified client ratings and helps people find real ` +
    `service providers on Telegram. Business owners can publish honest, ` +
    `unfiltered client reviews, and anyone can search for a provider by ` +
    `service.${devLine}`;

  const keyboard = tg.mainMenuKeyboard();
  if (isDeveloper(from.id)) {
    keyboard.push([{ text: 'Developer Menu', callback_data: 'dev:menu' }]);
  }

  await show(bot, session, text, keyboard);
}

// ===========================================================================
// OWNER / PROVIDER SETUP  ("Create Your Business")
// ===========================================================================
async function getOrCreateOwner(from) {
  let owner = await db.Owner.findOne({ telegramId: from.id });
  if (!owner) {
    owner = await db.Owner.create({
      telegramId: from.id,
      username: from.username || null,
      firstName: from.first_name || null,
      lastName: from.last_name || null,
    });
  } else {
    owner.username = from.username || owner.username;
    owner.firstName = from.first_name || owner.firstName;
    owner.lastName = from.last_name || owner.lastName;
    owner.updatedAt = new Date();
    await owner.save();
  }
  return owner;
}

async function showSetupMenu(bot, session, from) {
  resetAwaiting(session);
  const owner = await getOrCreateOwner(from);
  const text =
    `<b>Business Setup</b>\n\n` +
    `Brand name: ${owner.brandName ? tg.escapeHtml(owner.brandName) : 'Not set'}\n` +
    `About: ${owner.about ? tg.escapeHtml(owner.about) : 'Not set'}\n` +
    `Profile picture: ${owner.profilePicture ? 'Set' : 'Not set'}\n` +
    `Services configured: ${owner.services.length}\n\n` +
    `Use the buttons below to complete your profile.`;

  const keyboard = [
    [{ text: 'Set Brand Name', callback_data: 'setup:brand' }],
    [{ text: 'Set About', callback_data: 'setup:about' }],
    [{ text: 'Set Profile Picture', callback_data: 'setup:photo' }],
    [{ text: 'My Services', callback_data: 'services:view' }],
    [{ text: 'My Destinations', callback_data: 'dest:view' }],
    [{ text: 'Generate Rating Link', callback_data: 'link:start' }],
    tg.backButton('menu:main'),
  ];

  await show(bot, session, text, keyboard);
}

async function promptSetupField(bot, session, field) {
  session.awaiting = `setup_${field}`;
  const label = field === 'brand' ? 'brand or business name' : 'short "about" description';
  const text = `Send the ${label} you want to use on your public profile.\n\nSend "-" to clear it.`;
  await show(bot, session, text, [tg.backButton('setup:start')]);
}

async function handleSetupTextInput(bot, session, from, text) {
  const field = session.awaiting.replace('setup_', ''); // 'brand' | 'about'
  const owner = await getOrCreateOwner(from);
  const value = text.trim() === '-' ? null : text.trim().slice(0, 500);

  if (field === 'brand') owner.brandName = value;
  if (field === 'about') owner.about = value;
  owner.updatedAt = new Date();
  await owner.save();

  resetAwaiting(session);
  await showSetupMenu(bot, session, from);
}

async function promptProfilePicture(bot, session) {
  session.awaiting = 'setup_photo';
  const text =
    `Send a photo to use as your public profile picture (optional).\n\n` +
    `Send "-" to skip, or to remove your current picture.`;
  await show(bot, session, text, [tg.backButton('setup:start')]);
}

async function handleSetupPhotoInput(bot, session, from, fileId) {
  const owner = await getOrCreateOwner(from);
  owner.profilePicture = fileId;
  owner.updatedAt = new Date();
  await owner.save();

  resetAwaiting(session);
  await showSetupMenu(bot, session, from);
}

async function handleSetupPhotoTextInput(bot, session, from, text) {
  if (text.trim() === '-') {
    const owner = await getOrCreateOwner(from);
    owner.profilePicture = null;
    owner.updatedAt = new Date();
    await owner.save();

    resetAwaiting(session);
    await showSetupMenu(bot, session, from);
    return;
  }
  // Any other text while a photo is expected -- re-show the prompt.
  await promptProfilePicture(bot, session);
}

// ===========================================================================
// SERVICES
// ===========================================================================
async function showServices(bot, session, from) {
  resetAwaiting(session);
  const owner = await getOrCreateOwner(from);
  let text = `<b>My Services</b>\n\n`;
  if (owner.services.length === 0) {
    text += `No services added yet.`;
  } else {
    text += owner.services.map((s) => `- ${tg.escapeHtml(s.name)}`).join('\n');
  }

  const keyboard = [];
  owner.services.forEach((s) => {
    keyboard.push([
      { text: s.name, callback_data: 'noop' },
      { text: 'Remove', callback_data: `services:remove:${s._id}` },
    ]);
  });
  keyboard.push([{ text: 'Add Service', callback_data: 'services:add' }]);
  keyboard.push(tg.backButton('setup:start'));

  await show(bot, session, text, keyboard);
}

async function promptAddService(bot, session) {
  session.awaiting = 'service_add';
  await show(bot, session, 'Send the name of the service you want to add (e.g. "Web Development").', [
    tg.backButton('services:view'),
  ]);
}

async function handleServiceAddInput(bot, session, from, text) {
  const owner = await getOrCreateOwner(from);
  const name = text.trim().slice(0, 80);
  if (name) {
    owner.services.push({ name });
    owner.updatedAt = new Date();
    await owner.save();
  }
  resetAwaiting(session);
  await showServices(bot, session, from);
}

async function removeService(bot, session, from, serviceId) {
  const owner = await getOrCreateOwner(from);
  owner.services = owner.services.filter((s) => String(s._id) !== serviceId);
  owner.updatedAt = new Date();
  await owner.save();
  await showServices(bot, session, from);
}

// ===========================================================================
// DESTINATIONS (groups / channels)
// ===========================================================================
async function showDestinations(bot, session, from) {
  const owner = await getOrCreateOwner(from);
  const destinations = await db.Destination.find({ ownerId: owner._id });

  let text = `<b>My Destinations</b>\n\n`;
  if (destinations.length === 0) {
    text += `No groups or channels connected yet.`;
  } else {
    text += destinations
      .map((d) => `- ${tg.escapeHtml(d.title || 'Untitled')} (${d.type})`)
      .join('\n');
  }
  text +=
    `\n\nTo connect a new destination:\n` +
    `1. Add this bot as an administrator to your group or channel.\n` +
    `2. Forward any message from that group or channel to this chat.`;

  const keyboard = [];
  destinations.forEach((d) => {
    keyboard.push([
      { text: `${d.title || 'Untitled'} (${d.type})`, callback_data: 'noop' },
      { text: 'Remove', callback_data: `dest:remove:${d._id}` },
    ]);
  });
  keyboard.push(tg.backButton('setup:start'));

  session.awaiting = 'add_destination';
  await show(bot, session, text, keyboard);
}

async function handleForwardedDestination(bot, session, from, forwardChat) {
  if (!forwardChat) return false;

  const type = forwardChat.type === 'channel' ? 'channel' : 'group';

  try {
    const member = await bot.api.getChatMember({ chat_id: forwardChat.id, user_id: from.id });
    if (!['administrator', 'creator'].includes(member.status)) {
      await show(
        bot,
        session,
        `You must be an administrator of that ${type} to connect it as a destination.`,
        [tg.backButton('dest:view')]
      );
      return true;
    }
  } catch (err) {
    await show(
      bot,
      session,
      `Could not verify your admin status there. Make sure the bot is also an ` +
        `administrator of that ${type}, then try forwarding a message again.`,
      [tg.backButton('dest:view')]
    );
    return true;
  }

  const owner = await getOrCreateOwner(from);
  const existing = await db.Destination.findOne({ ownerId: owner._id, chatId: forwardChat.id });
  if (!existing) {
    await db.Destination.create({
      ownerId: owner._id,
      chatId: forwardChat.id,
      type,
      title: forwardChat.title || null,
    });
  }

  resetAwaiting(session);
  await showDestinations(bot, session, from);
  return true;
}

async function removeDestination(bot, session, from, destId) {
  const owner = await getOrCreateOwner(from);
  await db.Destination.deleteOne({ _id: destId, ownerId: owner._id });
  await showDestinations(bot, session, from);
}

// ===========================================================================
// RATING LINK GENERATION
// ===========================================================================
async function startLinkWizard(bot, session, from) {
  const owner = await getOrCreateOwner(from);
  const destinations = await db.Destination.find({ ownerId: owner._id });

  if (destinations.length === 0) {
    await show(
      bot,
      session,
      `Connect at least one group or channel before generating a rating link.`,
      [tg.backButton('dest:view', 'Connect a Destination')]
    );
    return;
  }

  session.data.linkSelection = [];
  await renderLinkSelection(bot, session, destinations);
}

async function renderLinkSelection(bot, session, destinations) {
  const selected = session.data.linkSelection || [];
  const text =
    `<b>Generate Rating Link</b>\n\n` +
    `Select which destination(s) reviews from this link should publish to, ` +
    `then confirm.`;

  const keyboard = destinations.map((d) => {
    const isSelected = selected.includes(String(d._id));
    return [
      {
        text: `${isSelected ? '[x]' : '[ ]'} ${d.title || 'Untitled'} (${d.type})`,
        callback_data: `link:toggle:${d._id}`,
      },
    ];
  });
  keyboard.push([{ text: 'Confirm & Generate Link', callback_data: 'link:confirm' }]);
  keyboard.push(tg.backButton('setup:start'));

  await show(bot, session, text, keyboard);
}

async function toggleLinkDestination(bot, session, from, destId) {
  const owner = await getOrCreateOwner(from);
  const destinations = await db.Destination.find({ ownerId: owner._id });
  const selection = session.data.linkSelection || [];
  const idx = selection.indexOf(destId);
  if (idx >= 0) selection.splice(idx, 1);
  else selection.push(destId);
  session.data.linkSelection = selection;
  await renderLinkSelection(bot, session, destinations);
}

async function confirmLinkGeneration(bot, session, from) {
  const owner = await getOrCreateOwner(from);
  const selection = session.data.linkSelection || [];

  if (selection.length === 0) {
    const destinations = await db.Destination.find({ ownerId: owner._id });
    await renderLinkSelection(bot, session, destinations);
    return;
  }

  const link = await db.RatingLink.create({
    token: tg.generateToken(),
    ownerId: owner._id,
    destinationIds: selection,
  });

  session.data.linkSelection = null;
  const url = tg.ratingDeepLink(link.token);

  const text =
    `<b>Rating Link Created</b>\n\n` +
    `Share this link with your client:\n${tg.escapeHtml(url)}\n\n` +
    `Any review submitted through it will publish automatically to the ` +
    `destination(s) you selected.`;

  await show(bot, session, text, [tg.backButton('setup:start')]);
}

// ===========================================================================
// CLIENT RATING FLOW (entered via a secure deep-link token)
// ===========================================================================
async function startClientRatingFlow(bot, session, from, token) {
  const link = await db.RatingLink.findOne({ token, active: true });
  if (!link) {
    await show(bot, session, `This rating link is invalid or has expired.`, null);
    return;
  }

  const owner = await db.Owner.findById(link.ownerId);
  if (!owner) {
    await show(bot, session, `This rating link is no longer valid.`, null);
    return;
  }

  session.data.review = {
    ratingLinkId: String(link._id),
    ownerId: String(owner._id),
    destinationIds: link.destinationIds.map(String),
    serviceName: null,
    projectName: null,
    projectDescription: null,
    reviewText: null,
    rating: 0,
    proofMedia: [],
  };

  const brandOrName = owner.brandName || tg.displayName(owner);
  const text =
    `<b>You are reviewing ${tg.escapeHtml(brandOrName)}</b>\n\n` +
    `You'll be asked to pick a service, describe the project, share your ` +
    `experience, and give a star rating. Your review publishes automatically ` +
    `once you confirm — there is no approval step.`;

  await show(bot, session, text, [[{ text: 'Start', callback_data: 'rate:begin' }]]);
}

async function showServiceSelection(bot, session) {
  const owner = await db.Owner.findById(session.data.review.ownerId);
  const keyboard = owner.services.map((s) => [
    { text: s.name, callback_data: `rate:service:${s._id}` },
  ]);
  keyboard.push([{ text: 'Other', callback_data: 'rate:service:other' }]);

  await show(bot, session, `Which service or project was this for?`, keyboard);
}

async function selectService(bot, session, serviceId) {
  const owner = await db.Owner.findById(session.data.review.ownerId);
  const service = owner.services.id(serviceId);
  session.data.review.serviceName = service ? service.name : 'Other';
  await promptProjectName(bot, session);
}

async function promptCustomService(bot, session) {
  session.awaiting = 'rate_service_custom';
  await show(bot, session, `Type the name of the service or project.`, null);
}

async function handleCustomServiceInput(bot, session, text) {
  session.data.review.serviceName = text.trim().slice(0, 120);
  resetAwaiting(session);
  await promptProjectName(bot, session);
}

async function promptProjectName(bot, session) {
  session.awaiting = 'rate_project_name';
  await show(bot, session, `What would you like to call this project? (short title)`, null);
}

async function handleProjectNameInput(bot, session, text) {
  session.data.review.projectName = text.trim().slice(0, 120);
  session.awaiting = 'rate_project_desc';
  await show(bot, session, `Briefly describe the project you received.`, null);
}

async function handleProjectDescInput(bot, session, text) {
  session.data.review.projectDescription = text.trim().slice(0, 800);
  session.awaiting = 'rate_experience';
  await show(bot, session, `How was your experience working with this person or business?`, null);
}

async function handleExperienceInput(bot, session, text) {
  session.data.review.reviewText = text.trim().slice(0, 2000);
  resetAwaiting(session);
  await showStarSelection(bot, session);
}

async function showStarSelection(bot, session) {
  const selected = session.data.review.rating || 0;
  await show(bot, session, `Give a rating from 1 to 5 stars.`, tg.starKeyboard(selected));
}

async function setStar(bot, session, value) {
  session.data.review.rating = value;
  await showStarSelection(bot, session);
}

async function confirmStar(bot, session) {
  if (!session.data.review.rating) {
    await showStarSelection(bot, session);
    return;
  }
  await showProofPrompt(bot, session);
}

async function showProofPrompt(bot, session) {
  const count = session.data.review.proofMedia.length;
  const text =
    `Add pictures as proof of the work (optional). ${count} added so far. ` +
    `Send a photo to add another, or continue.`;
  await show(bot, session, text, [
    [{ text: 'Skip / Continue', callback_data: 'rate:proof:done' }],
  ]);
}

async function handleProofPhoto(bot, session, fileId) {
  if (session.data.review.proofMedia.length >= config.MAX_PROOF_IMAGES) {
    await showProofPrompt(bot, session);
    return;
  }
  session.data.review.proofMedia.push(fileId);
  await showProofPrompt(bot, session);
}

async function showReviewPreview(bot, session, from) {
  const r = session.data.review;
  const owner = await db.Owner.findById(r.ownerId);
  const brandOrName = owner.brandName || tg.displayName(owner);

  const text =
    `<b>Review Preview</b>\n\n` +
    `Reviewing: ${tg.escapeHtml(brandOrName)}\n` +
    `Service: ${tg.escapeHtml(r.serviceName)}\n` +
    `Project: ${tg.escapeHtml(r.projectName)}\n` +
    `Description: ${tg.escapeHtml(r.projectDescription)}\n` +
    `Rating: ${r.rating} / 5 stars\n` +
    `Experience: ${tg.escapeHtml(r.reviewText)}\n` +
    `Proof images: ${r.proofMedia.length}\n\n` +
    `This cannot be edited by the business owner after publishing.`;

  const keyboard = [
    [{ text: 'Confirm & Publish', callback_data: 'rate:confirm' }],
    [{ text: 'Edit', callback_data: 'rate:edit' }],
    [{ text: 'Cancel', callback_data: 'rate:cancel' }],
  ];

  await show(bot, session, text, keyboard);
}

async function cancelReview(bot, session) {
  session.data.review = null;
  resetAwaiting(session);
  await show(bot, session, `Review cancelled. Nothing was published.`, null);
}

async function publishReview(bot, session, from) {
  const r = session.data.review;
  if (!r) return;

  // Persist as 'confirmed' first, then atomically flip to 'published' so a
  // double tap on Confirm can never publish the same review twice.
  const review = await db.Review.create({
    ownerId: r.ownerId,
    ratingLinkId: r.ratingLinkId,
    destinationIds: r.destinationIds,
    clientId: from.id,
    clientUsername: from.username || null,
    clientFirstName: from.first_name || null,
    clientLastName: from.last_name || null,
    serviceName: r.serviceName,
    projectName: r.projectName,
    projectDescription: r.projectDescription,
    rating: r.rating,
    reviewText: r.reviewText,
    proofMedia: r.proofMedia,
    status: 'confirmed',
    confirmedAt: new Date(),
  });

  const claimed = await db.Review.findOneAndUpdate(
    { _id: review._id, status: 'confirmed' },
    { $set: { status: 'published', publishedAt: new Date() } }
  );
  if (!claimed) return; // already published somehow — duplicate protection

  const owner = await db.Owner.findByIdAndUpdate(
    r.ownerId,
    {
      $inc: { ratingCount: 1, ratingSum: r.rating, reviewCount: 1 },
    },
    { new: true }
  );

  const destinations = await db.Destination.find({ _id: { $in: r.destinationIds } });

  const clientEntity = {
    telegramId: from.id,
    username: from.username || null,
    firstName: from.first_name || null,
    lastName: from.last_name || null,
  };
  const brandOrName = owner.brandName || tg.displayName(owner);

  const publicText =
    `<b>Client Review</b>\n\n` +
    `Client: ${tg.mentionHtml(clientEntity)}\n` +
    `Service: ${tg.escapeHtml(r.serviceName)}\n` +
    `Project: ${tg.escapeHtml(r.projectName)}\n` +
    (r.projectDescription ? `Description: ${tg.escapeHtml(r.projectDescription)}\n` : '') +
    `Rating: ${r.rating} / 5 stars\n` +
    `Experience: ${tg.escapeHtml(r.reviewText)}\n` +
    (r.proofMedia.length ? `Proof: attached below\n` : '') +
    `\nOwner: ${tg.mentionHtml(owner)}\n` +
    (owner.brandName ? `Brand: ${tg.escapeHtml(owner.brandName)}\n` : '');

  const publishKeyboard = [[tg.profileButton(owner, 'Start a Project With Me')]];

  for (const dest of destinations) {
    try {
      // rich_message currently only applies to sendMessage/editMessageText,
      // not to photo captions, so proof images are attached as their own
      // follow-up media rather than a plain-caption photo.
      await bot.api.sendRichMessage({
        chat_id: dest.chatId,
        rich_message: tg.richMessage(publicText),
        reply_markup: { inline_keyboard: publishKeyboard },
      });
      if (r.proofMedia.length === 1) {
        await bot.api.sendPhoto({ chat_id: dest.chatId, photo: r.proofMedia[0] });
      } else if (r.proofMedia.length > 1) {
        await bot.api.sendMediaGroup({
          chat_id: dest.chatId,
          media: r.proofMedia.slice(0, 10).map((fileId) => ({ type: 'photo', media: fileId })),
        });
      }
    } catch (err) {
      console.error(`Failed to publish review to destination ${dest._id}:`, err.message);
    }
  }

  session.data.review = null;
  resetAwaiting(session);

  const thankYouText =
    `Thank you for working with ${tg.escapeHtml(brandOrName)} and for taking the ` +
    `time to share your experience.\n\n` +
    `We appreciate your feedback and look forward to working with you again on ` +
    `your next project.`;

  await show(bot, session, thankYouText, [tg.backButton('menu:main', 'Back to Main Menu')]);
}

// ===========================================================================
// FEEDBACK (to developer, not to a business owner)
// ===========================================================================
async function promptFeedback(bot, session) {
  session.awaiting = 'feedback_text';
  await show(
    bot,
    session,
    `Your message goes directly to the developer of this bot — not to any ` +
      `business owner. What would you like to say?`,
    [tg.backButton('menu:main')]
  );
}

async function handleFeedbackInput(bot, session, from, text) {
  await db.Feedback.create({
    telegramId: from.id,
    username: from.username || null,
    firstName: from.first_name || null,
    message: text.trim().slice(0, 2000),
  });

  resetAwaiting(session);

  if (config.DEVELOPER_ID) {
    try {
      const senderEntity = {
        telegramId: from.id,
        username: from.username || null,
        firstName: from.first_name || null,
        lastName: from.last_name || null,
      };
      await bot.api.sendRichMessage({
        chat_id: config.DEVELOPER_ID,
        rich_message: tg.richMessage(
          `<b>New Feedback</b>\n\nFrom: ${tg.mentionHtml(senderEntity)}\n\n${tg.escapeHtml(text.trim())}`
        ),
      });
    } catch (err) {
      console.error('Failed to forward feedback to developer:', err.message);
    }
  }

  await show(bot, session, `Thank you — your feedback has been sent to the developer.`, [
    tg.backButton('menu:main', 'Back to Main Menu'),
  ]);
}

async function showDeveloperContact(bot, session) {
  const text = `Contact the developer of this bot using the button below.`;
  const keyboard = [];
  if (config.DEVELOPER_USERNAME) {
    keyboard.push([{ text: 'Contact Developer', url: `https://t.me/${config.DEVELOPER_USERNAME}` }]);
  } else {
    keyboard.push([{ text: 'Contact Developer (not configured)', callback_data: 'noop' }]);
  }
  keyboard.push(tg.backButton('menu:main'));
  await show(bot, session, text, keyboard);
}

// ===========================================================================
// DEVELOPER MENU
// ===========================================================================
async function showDeveloperMenu(bot, session) {
  await show(bot, session, `<b>Developer Menu</b>`, tg.developerMenuKeyboard());
}

async function showDeveloperStats(bot, session) {
  const [users, owners, groups, channels, reviews] = await Promise.all([
    db.BotUser.countDocuments(),
    db.Owner.countDocuments(),
    db.Destination.countDocuments({ type: 'group' }),
    db.Destination.countDocuments({ type: 'channel' }),
    db.Review.countDocuments({ status: 'published' }),
  ]);

  const text =
    `<b>Statistics</b>\n\n` +
    `Users: ${users}\n` +
    `Provider profiles: ${owners}\n` +
    `Groups: ${groups}\n` +
    `Channels: ${channels}\n` +
    `Published reviews: ${reviews}`;

  await show(bot, session, text, [tg.backButton('dev:menu')]);
}

async function showDeveloperFeedbackInbox(bot, session) {
  const items = await db.Feedback.find().sort({ createdAt: -1 }).limit(10);
  let text = `<b>Recent Feedback</b>\n\n`;
  if (items.length === 0) {
    text += `No feedback yet.`;
  } else {
    text += items
      .map((f) => {
        const who = f.username ? `@${f.username}` : f.firstName || 'Unknown user';
        return `From ${tg.escapeHtml(who)}:\n${tg.escapeHtml(f.message)}`;
      })
      .join('\n\n');
  }
  await show(bot, session, text, [tg.backButton('dev:menu')]);
}

async function showDeveloperProfile(bot, session) {
  const text =
    `<b>Developer Profile</b>\n\n` +
    `Name: ${tg.escapeHtml(config.DEVELOPER_DISPLAY_NAME)}\n` +
    `Username: ${config.DEVELOPER_USERNAME ? '@' + tg.escapeHtml(config.DEVELOPER_USERNAME) : 'Not set'}`;
  await show(bot, session, text, [tg.backButton('dev:menu')]);
}

async function promptBroadcast(bot, session) {
  session.awaiting = 'broadcast_text';
  await show(bot, session, `Send the message you want to broadcast to all bot users.`, [
    tg.backButton('dev:menu'),
  ]);
}

async function handleBroadcastInput(bot, session, text) {
  session.data.broadcastText = text.trim().slice(0, 4000);
  resetAwaiting(session);

  const count = await db.BotUser.countDocuments({ blocked: false });
  const preview =
    `<b>Broadcast Preview</b>\n\n${tg.escapeHtml(session.data.broadcastText)}\n\n` +
    `This will be sent to approximately ${count} users. Confirm?`;

  await show(bot, session, preview, [
    [{ text: 'Send Broadcast', callback_data: 'dev:broadcast:confirm' }],
    [{ text: 'Cancel', callback_data: 'dev:broadcast:cancel' }],
  ]);
}

async function confirmBroadcast(bot, session) {
  const text = session.data.broadcastText;
  if (!text) {
    await showDeveloperMenu(bot, session);
    return;
  }

  const users = await db.BotUser.find({ blocked: false });
  let success = 0;
  let failed = 0;

  for (const user of users) {
    try {
      await bot.api.sendRichMessage({
        chat_id: user.telegramId,
        rich_message: tg.richMessage(tg.escapeHtml(text)),
      });
      success++;
    } catch (err) {
      failed++;
      await db.BotUser.updateOne({ _id: user._id }, { $set: { blocked: true } });
    }
  }

  session.data.broadcastText = null;

  const summary =
    `<b>Broadcast Complete</b>\n\n` +
    `Total recipients: ${users.length}\n` +
    `Successful: ${success}\n` +
    `Failed / blocked: ${failed}`;

  await show(bot, session, summary, [tg.backButton('dev:menu')]);
}

async function cancelBroadcast(bot, session) {
  session.data.broadcastText = null;
  await showDeveloperMenu(bot, session);
}

// ===========================================================================
// DISCOVERY / MARKETPLACE SEARCH
// ===========================================================================
async function promptDiscoverySearch(bot, session) {
  session.awaiting = 'discover_query';
  await show(bot, session, `What kind of service are you looking for?`, [
    tg.backButton('menu:main'),
  ]);
}

async function runDiscoverySearch(bot, session, from, query) {
  resetAwaiting(session);
  const q = query.trim().slice(0, 200);

  const owners = await db.Owner.aggregate([
    { $match: { 'services.name': { $regex: q, $options: 'i' } } },
    {
      $addFields: {
        avgRating: { $cond: [{ $gt: ['$ratingCount', 0] }, { $divide: ['$ratingSum', '$ratingCount'] }, 0] },
      },
    },
    { $sort: { avgRating: -1, reviewCount: -1 } },
    { $limit: 25 },
  ]);

  session.data.discovery = { query: q, results: owners, index: 0 };

  if (owners.length === 0) {
    await showDeveloperFallback(bot, session, q);
    return;
  }

  await renderDiscoveryProfile(bot, session);
}

async function showDeveloperFallback(bot, session, query) {
  const text =
    `No registered provider matches "${tg.escapeHtml(query)}" yet.\n\n` +
    `You're welcome to reach out to the developer below — they can point you ` +
    `in the right direction or let you know if this service gets added.`;

  const keyboard = [];
  if (config.DEVELOPER_USERNAME) {
    keyboard.push([{ text: 'Contact Developer', url: `https://t.me/${config.DEVELOPER_USERNAME}` }]);
  } else {
    keyboard.push([{ text: 'Contact Developer (not configured)', callback_data: 'noop' }]);
  }
  keyboard.push(tg.backButton('menu:main'));

  await show(bot, session, text, keyboard);
}

async function renderDiscoveryProfile(bot, session) {
  const { results, index } = session.data.discovery;
  const owner = results[index];

  const avg = owner.ratingCount ? (owner.ratingSum / owner.ratingCount).toFixed(1) : 'No ratings yet';
  const services = (owner.services || []).map((s) => s.name).join(', ') || 'Not listed';
  const brandOrName = owner.brandName || `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || 'Provider';
  const about = owner.about || 'Not provided';

  const service = tg.escapeMarkdown(services);
  const brand = tg.escapeMarkdown(brandOrName);
  const aboutCell = tg.escapeMarkdown(about);

  const text =
    `| Service | Brand | About |\n` +
    `| --- | --- | --- |\n` +
    `| ${service} | ${brand} | ${aboutCell} |\n\n` +
    `Average rating: ${avg}${owner.ratingCount ? ` (${owner.reviewCount} reviews)` : ''}\n\n` +
    `Result ${index + 1} of ${results.length}`;

  const keyboard = [];
  const navRow = [];
  if (index > 0) navRow.push({ text: 'Previous', callback_data: 'discover:prev' });
  if (index < results.length - 1) navRow.push({ text: 'Next', callback_data: 'discover:next' });
  if (navRow.length) keyboard.push(navRow);

  keyboard.push([{ text: 'View Reviews', callback_data: 'discover:reviews' }]);
  keyboard.push([tg.profileButton(owner, 'Contact / Start a Project')]);
  keyboard.push(tg.backButton('menu:main'));

  await show(bot, session, text, keyboard, 'markdown');
}

async function discoveryNav(bot, session, direction) {
  const disc = session.data.discovery;
  if (!disc) return;
  disc.index = Math.max(0, Math.min(disc.results.length - 1, disc.index + direction));
  await renderDiscoveryProfile(bot, session);
}

const REVIEWS_PAGE_SIZE = 5;

function buildReviewQuery(ownerId, filter) {
  const query = { ownerId, status: 'published' };
  if (filter.rating) {
    query.rating = filter.rating;
  }
  if (filter.keyword) {
    const rx = { $regex: filter.keyword, $options: 'i' };
    query.$or = [{ reviewText: rx }, { serviceName: rx }, { projectName: rx }];
  }
  return query;
}

// Entry point from a provider profile: reset any previous filter/page state.
async function showDiscoveryReviews(bot, session) {
  const disc = session.data.discovery;
  if (!disc) return;
  disc.reviewFilter = { rating: null, keyword: null };
  disc.reviewPage = 0;
  await renderDiscoveryReviews(bot, session);
}

async function renderDiscoveryReviews(bot, session) {
  const disc = session.data.discovery;
  if (!disc) return;
  const owner = disc.results[disc.index];
  const filter = disc.reviewFilter || (disc.reviewFilter = { rating: null, keyword: null });
  const page = disc.reviewPage || 0;

  const query = buildReviewQuery(owner._id, filter);
  const total = await db.Review.countDocuments(query);
  const reviews = await db.Review.find(query)
    .sort({ publishedAt: -1 })
    .skip(page * REVIEWS_PAGE_SIZE)
    .limit(REVIEWS_PAGE_SIZE);

  const activeFilters = [];
  if (filter.rating) activeFilters.push(`${filter.rating} / 5 stars`);
  if (filter.keyword) activeFilters.push(`"${filter.keyword}"`);
  const filterLine = activeFilters.length ? `Filtered by: ${tg.escapeHtml(activeFilters.join(', '))}\n\n` : '';

  let text = `<b>Reviews</b>\n\n${filterLine}`;
  if (total === 0) {
    text += activeFilters.length ? `No reviews match this filter.` : `No published reviews yet.`;
  } else {
    text +=
      reviews
        .map((r) => `${r.rating} / 5 stars — ${tg.escapeHtml(r.serviceName)}\n${tg.escapeHtml(r.reviewText)}`)
        .join('\n\n') + `\n\nShowing ${page * REVIEWS_PAGE_SIZE + 1}-${page * REVIEWS_PAGE_SIZE + reviews.length} of ${total}`;
  }

  const keyboard = [];

  const pageRow = [];
  if (page > 0) pageRow.push({ text: 'Previous Page', callback_data: 'discover:reviews:page:prev' });
  if ((page + 1) * REVIEWS_PAGE_SIZE < total) pageRow.push({ text: 'Next Page', callback_data: 'discover:reviews:page:next' });
  if (pageRow.length) keyboard.push(pageRow);

  const starRow = [1, 2, 3, 4, 5].map((n) => ({
    text: filter.rating === n ? `[${n}]` : `${n}`,
    callback_data: `discover:reviews:filter:rating:${n}`,
  }));
  keyboard.push(starRow);

  keyboard.push([{ text: 'Search Keyword', callback_data: 'discover:reviews:filter:keyword' }]);
  if (activeFilters.length) {
    keyboard.push([{ text: 'Clear Filters', callback_data: 'discover:reviews:filter:clear' }]);
  }

  keyboard.push(tg.backButton('discover:back-to-profile'));

  await show(bot, session, text, keyboard);
}

async function setReviewRatingFilter(bot, session, rating) {
  const disc = session.data.discovery;
  if (!disc) return;
  const filter = disc.reviewFilter || (disc.reviewFilter = { rating: null, keyword: null });
  filter.rating = filter.rating === rating ? null : rating; // tap again to clear that star
  disc.reviewPage = 0;
  await renderDiscoveryReviews(bot, session);
}

async function promptReviewKeyword(bot, session) {
  session.awaiting = 'discover_review_keyword';
  await show(bot, session, `Search these reviews by keyword (service, project, or review text).`, [
    tg.backButton('discover:reviews:back'),
  ]);
}

async function handleReviewKeywordInput(bot, session, text) {
  const disc = session.data.discovery;
  if (!disc) return;
  const filter = disc.reviewFilter || (disc.reviewFilter = { rating: null, keyword: null });
  filter.keyword = text.trim().slice(0, 200) || null;
  disc.reviewPage = 0;
  resetAwaiting(session);
  await renderDiscoveryReviews(bot, session);
}

async function clearReviewFilters(bot, session) {
  const disc = session.data.discovery;
  if (!disc) return;
  disc.reviewFilter = { rating: null, keyword: null };
  disc.reviewPage = 0;
  await renderDiscoveryReviews(bot, session);
}

async function reviewsPageNav(bot, session, direction) {
  const disc = session.data.discovery;
  if (!disc) return;
  disc.reviewPage = Math.max(0, (disc.reviewPage || 0) + direction);
  await renderDiscoveryReviews(bot, session);
}

module.exports = {
  sessions,
  getSession,
  resetAwaiting,
  touchBotUser,
  isDeveloper,
  show,
  handleStart,
  showMainMenu,
  getOrCreateOwner,
  showSetupMenu,
  promptSetupField,
  handleSetupTextInput,
  promptProfilePicture,
  handleSetupPhotoInput,
  handleSetupPhotoTextInput,
  showServices,
  promptAddService,
  handleServiceAddInput,
  removeService,
  showDestinations,
  handleForwardedDestination,
  removeDestination,
  startLinkWizard,
  toggleLinkDestination,
  confirmLinkGeneration,
  startClientRatingFlow,
  showServiceSelection,
  selectService,
  promptCustomService,
  handleCustomServiceInput,
  promptProjectName,
  handleProjectNameInput,
  handleProjectDescInput,
  handleExperienceInput,
  showStarSelection,
  setStar,
  confirmStar,
  showProofPrompt,
  handleProofPhoto,
  showReviewPreview,
  cancelReview,
  publishReview,
  promptFeedback,
  handleFeedbackInput,
  showDeveloperContact,
  showDeveloperMenu,
  showDeveloperStats,
  showDeveloperFeedbackInbox,
  showDeveloperProfile,
  promptBroadcast,
  handleBroadcastInput,
  confirmBroadcast,
  cancelBroadcast,
  promptDiscoverySearch,
  runDiscoverySearch,
  renderDiscoveryProfile,
  discoveryNav,
  showDiscoveryReviews,
  renderDiscoveryReviews,
  setReviewRatingFilter,
  promptReviewKeyword,
  handleReviewKeywordInput,
  clearReviewFilters,
  reviewsPageNav,
};
