// services/payments/index.js — provider-agnostic entry point.
// To add another gateway, implement { createCheckout, verifyRedirect, verifyWebhook, parseWebhook }
// in a sibling file and register it here.
const safepay = require('./safepay');

const providers = { safepay };

module.exports = {
  get: (id = 'safepay') => providers[id] || safepay,
  providers,
};
