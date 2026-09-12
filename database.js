// sololy built by loner technology
const mongoose = require('mongoose');
const config = require('./config');

const serviceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
  },
  { _id: true }
);

const ownerSchema = new mongoose.Schema(
  {
    telegramId: { type: Number, required: true, unique: true, index: true }, // internal only
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    brandName: { type: String, default: null },
    about: { type: String, default: null },
    services: { type: [serviceSchema], default: [] },
    ratingCount: { type: Number, default: 0 },
    ratingSum: { type: Number, default: 0 }, // avg = ratingSum / ratingCount
    reviewCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'owners' }
);

ownerSchema.virtual('averageRating').get(function () {
  if (!this.ratingCount) return 0;
  return this.ratingSum / this.ratingCount;
});

const Owner = mongoose.model('Owner', ownerSchema);

// ---------------------------------------------------------------------------
// Destination: a group or channel an owner has connected.
// ---------------------------------------------------------------------------
const destinationSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: true, index: true },
    chatId: { type: Number, required: true }, // internal only, never shown publicly
    type: { type: String, enum: ['group', 'channel'], required: true },
    title: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'destinations' }
);

const Destination = mongoose.model('Destination', destinationSchema);

// ---------------------------------------------------------------------------
// RatingLink: a secure token tied to one owner and one-or-more destinations.
// ---------------------------------------------------------------------------
const ratingLinkSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: true, index: true },
    destinationIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Destination' }],
    label: { type: String, default: null }, // e.g. "Group A link"
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'rating_links' }
);

const RatingLink = mongoose.model('RatingLink', ratingLinkSchema);

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------
const reviewSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: true, index: true },
    ratingLinkId: { type: mongoose.Schema.Types.ObjectId, ref: 'RatingLink', required: true },
    destinationIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Destination' }],

    clientId: { type: Number, required: true }, // internal only
    clientUsername: { type: String, default: null },
    clientFirstName: { type: String, default: null },
    clientLastName: { type: String, default: null },

    serviceName: { type: String, default: null },
    projectName: { type: String, default: null },
    projectDescription: { type: String, default: null },

    rating: { type: Number, min: 1, max: 5, default: null },
    reviewText: { type: String, default: null },
    proofMedia: [{ type: String }], // Telegram file_ids

    status: {
      type: String,
      enum: ['draft', 'awaiting_confirmation', 'confirmed', 'published', 'cancelled', 'failed'],
      default: 'draft',
      index: true,
    },

    createdAt: { type: Date, default: Date.now },
    confirmedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
  },
  { collection: 'reviews' }
);

const Review = mongoose.model('Review', reviewSchema);

// ---------------------------------------------------------------------------
// BotUser: every distinct Telegram user who has started the bot (for stats
// and broadcast; not the same thing as an Owner/provider).
// ---------------------------------------------------------------------------
const botUserSchema = new mongoose.Schema(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    blocked: { type: Boolean, default: false }, // set true if a broadcast send fails
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
  },
  { collection: 'bot_users' }
);

const BotUser = mongoose.model('BotUser', botUserSchema);

// ---------------------------------------------------------------------------
// Feedback: sent by any normal user directly to the developer.
// ---------------------------------------------------------------------------
const feedbackSchema = new mongoose.Schema(
  {
    telegramId: { type: Number, required: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    message: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'feedback' }
);

const Feedback = mongoose.model('Feedback', feedbackSchema);

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
async function connect() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.MONGODB_URI);
  console.log('Connected to MongoDB');
}

module.exports = {
  connect,
  Owner,
  Destination,
  RatingLink,
  Review,
  BotUser,
  Feedback,
};
