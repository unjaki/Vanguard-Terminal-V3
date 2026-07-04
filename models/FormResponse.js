const mongoose = require('mongoose');

const formResponseSchema = new mongoose.Schema({
    formType: { type: String, required: true }, // 'pilot' or 'gsmc'
    responses: { type: Object, required: true }, // Key-value pairs of form questions/answers
    submittedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('FormResponse', formResponseSchema);
