// models/PortfolioImage.js — images for portfolio projects. Kept out of the user document so profiles
// stay small; served publicly with long cache headers.
const mongoose = require('mongoose');

const PortfolioImageSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:  { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'], required: true },
  size:  { type: Number, required: true },
  data:  { type: Buffer, required: true, select: false },
}, { timestamps: true });

module.exports = mongoose.model('PortfolioImage', PortfolioImageSchema);
