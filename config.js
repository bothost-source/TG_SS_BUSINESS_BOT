// sololy built by loner tech
require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const config = {
  // Core Telegram bot credentials
  BOT_TOKEN: required('BOT_TOKEN'),
  BOT_USERNAME: required('BOT_USERNAME'), // without @, used to build deep links

  // Database
  MONGODB_URI: required('MONGODB_URI'),

  // Developer / admin identity (never shown publicly as a numeric id)
  DEVELOPER_ID: process.env.DEVELOPER_ID ? Number(process.env.DEVELOPER_ID) : null,
  DEVELOPER_USERNAME: process.env.DEVELOPER_USERNAME || null,
  DEVELOPER_DISPLAY_NAME: process.env.DEVELOPER_DISPLAY_NAME || 'The Developer',

  // Deployment mode: 'polling' (default, easiest) or 'webhook'
  MODE: process.env.MODE || 'polling',
  WEBHOOK_URL: process.env.WEBHOOK_URL || null, // e.g. https://yourdomain.com
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,

  // Misc
  MAX_PROOF_IMAGES: 5,
  TOKEN_BYTES: 16, // secure rating-link token length (raw bytes, hex-encoded)
};

module.exports = config;
